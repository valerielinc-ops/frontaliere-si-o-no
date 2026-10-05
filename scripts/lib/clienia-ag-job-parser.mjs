#!/usr/bin/env node
/**
 * Clienia AG (Privatklinikgruppe Psychiatrie) job parser.
 *
 * Largest private psychiatric clinic group in German-speaking Switzerland:
 *   - Privatklinik Bellevue, Pfäffikon ZH
 *   - Klinik Schlössli, Oetwil am See ZH
 *   - Praxen Tagesklinik Zürich + Wetzikon
 *
 * Public career site: https://www.clienia.ch/de/jobs-karriere/jobs/
 * Listing API:       https://www.clienia.ch/wp-json/wp/v2/jobs?per_page=100 (WP REST)
 * Detail pages:      https://www.clienia.ch/de/jobs-karriere/jobs/{slug}/
 *
 * The WP REST listing returns clean JSON with id/slug/link/title/date.
 * `content.rendered` is empty (the page is built with Elementor at render
 * time), so each detail page is scraped for the «Ihre Aufgaben» / «Ihr
 * Profil» / «Unser Angebot» content blocks via a text-region heuristic.
 */
import { wordpressPublicationDateFields } from './wordpress-publication-date.mjs';
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, warnIfListingAtCap, fetchJson } from './crawler-template.mjs';
import {
  fetchHtml,
  decodeEntities,
  normalizeSpace,
  htmlToText,
  locateTagByAttribute,
  extractBalancedTagBlock,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
} from './hospital-custom-html-helpers.mjs';

export const CLIENIA_AG_KEY = 'clienia-ag';
export const CLIENIA_AG_COMPANY_NAME = 'Clienia AG';
export const CLIENIA_AG_COMPANY_DOMAIN = 'clienia.ch';

const LISTING_PAGE_CAP = 100;
const API_URL = `https://www.clienia.ch/wp-json/wp/v2/jobs?per_page=${LISTING_PAGE_CAP}&_fields=id,slug,link,title,date,location`;
const POLITE_DELAY_MS = 250;

export function isCleniaAgJob(job) {
  const url = String(job?.url || '').toLowerCase();
  return job?.companyKey === CLIENIA_AG_KEY || url.includes('clienia.ch');
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'clienia.ch' || host.endsWith('.clienia.ch');
  } catch {
    return false;
  }
}

/**
 * The vacancy as the detail page lays it out (JetEngine + JetTabs on
 * Elementor): the dynamic fields above the tabs — the group paragraph, the
 * role paragraph, «Arbeitsort ist …» — then the «Stellenbeschrieb» tab
 * (`data-tab="1"`) with tasks, profile, offer and contact. The «Code …»
 * reference field is not text of the ad.
 *
 * The older heading search is kept as the fallback for a page without that
 * layout. It knew only the formal headings («Ihre Aufgaben», «Ihr Profil»),
 * so on the pages written in the du-form («Deine Aufgaben», «Dein Profil»)
 * its first hit was «Unser Angebot» and it published the offer and the
 * contact line alone — fachperson-rechnungswesen on 2026-09-29, 609 chars
 * against 2 001 on the page (issue 5253).
 */
export function extractCleniaDetailContent(html) {
  if (!html) return '';
  const fromTabs = extractCleniaTabbedContent(html);
  if (fromTabs) return fromTabs;
  const startMatch = html.search(/(?:Ihre|Deine) Aufgaben|(?:Ihr|Dein) Profil|Unser Angebot|Pflegen/i);
  if (startMatch < 0) return '';
  const slice = html.slice(startMatch, startMatch + 8000);
  // Stop at the next big Elementor column outside the content section
  const stopIdx = slice.search(/<div class="elementor-column elementor-col-50 elementor-top-column/);
  const window = stopIdx > 100 ? slice.slice(0, stopIdx) : slice;
  let text = normalizeSpace(decodeEntities(window
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/(?:p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' '),
  ));
  // Truncate at first inline JS widget signature (Elementor pages embed
  // tracking/share widgets like `function emailLink() { var url = ... }`
  // that survive HTML strip and trip validate:jobs-quality).
  const fnIdx = text.search(/(?:^|\s)function\s+\w+\s*\([^)]*\)\s*\{/);
  if (fnIdx > 50) text = text.slice(0, fnIdx).trimEnd();
  const varIdx = text.search(/(?:^|\s)var\s+\w+\s*=\s*(?:window|document)\./);
  if (varIdx > 50) text = text.slice(0, varIdx).trimEnd();
  // Drop trailing boilerplate "Arbeiten bei Clienia – Ihre Vorteile auf einen Blick…" if present
  const trimAt = text.indexOf('Arbeiten bei Clienia');
  return trimAt > 50 ? normalizeSpace(text.slice(0, trimAt)) : text;
}

function extractCleniaTabbedContent(html) {
  const panel = locateTagByAttribute(html, 'data-tab="1"[^>]*role="tabpanel"', { skipVoidTags: true });
  if (!panel) return '';
  const body = htmlToText(extractBalancedTagBlock(panel.rest, panel.tagName, 40000));
  if (body.length < 100) return '';
  const panelAt = html.length - panel.rest.length;
  const intro = [...html.slice(0, panelAt).matchAll(/class="jet-listing-dynamic-field__content"\s*>([\s\S]*?)<\/div>/g)]
    .map((match) => htmlToText(match[1]))
    .filter((text) => text && !/^Code\s+[\d.]+$/i.test(text));
  return [...intro, body]
    .join('\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Uses the shared fetchJson() (crawler-template.mjs): retries transient
// failures (5xx/429, network blips, and a 200-but-non-JSON WAF "challenge"
// body — the same class of intermittent block that broke the Bucher + Suter
// WP REST listing, #4247) via exponential backoff instead of hard-failing
// the whole crawler on one blip.
function fetchAllListings() {
  return fetchJson(API_URL, { label: 'Clienia AG wp-json job-listings' });
}

export async function fetchAllCleniaAgJobs() {
  console.log(`🏥 Fetching ${CLIENIA_AG_COMPANY_NAME} jobs`);
  console.log(`   API: ${API_URL}\n`);
  const listings = await fetchAllListings();
  if (!Array.isArray(listings) || listings.length === 0) {
    console.warn('⚠️  WP REST returned no Clienia jobs.');
    return [];
  }
  console.log(`  ✓ ${listings.length} jobs from WP REST`);
  warnIfListingAtCap({ label: 'Clienia AG WP REST listing', count: listings.length, cap: LISTING_PAGE_CAP });
  console.log(`  📄 Fetching detail pages for rich descriptions...`);

  const jobs = [];
  let detailHits = 0;
  for (const item of listings) {
    const url = String(item?.link || '').trim();
    const title = normalizeSpace(decodeEntities(String(item?.title?.rendered || '')));
    if (!url || !title || title.length < 5) continue;

    let detailContent = '';
    try {
      const html = await fetchHtml(url);
      detailContent = extractCleniaDetailContent(html);
      if (detailContent) detailHits++;
    } catch (err) {
      console.warn(`  ⚠️  detail fetch failed ${url}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, POLITE_DELAY_MS));

    // The page's own group paragraph now opens `detailContent`; the fixed
    // blurb below only stands in when the detail page could not be read.
    const description = detailContent
      || 'Clienia AG — grösste Privatklinikgruppe für Psychiatrie und Psychotherapie der Deutschschweiz. Standorte: Privatklinik Bellevue (Pfäffikon ZH), Klinik Schlössli (Oetwil am See ZH), Tagesklinik Zürich, Tagesklinik Wetzikon.';

    // Determine canton: most Clienia sites are ZH; fall back to ZH if no signal
    const sourceLang = detectLang(description || title, 'de');
    const jobSlug = slugify(`${title} ${CLIENIA_AG_KEY} zurich`);
    const urlHash = createHash('sha1').update(url).digest('hex').slice(0, 12);
    const publication = wordpressPublicationDateFields(item);

    jobs.push({
      id: `${CLIENIA_AG_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: CLIENIA_AG_COMPANY_NAME,
      companyKey: CLIENIA_AG_KEY,
      companyDomain: CLIENIA_AG_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      // Newly-discovered jobs ship with source-locale-only fields. The shared
      // AI-localization step clears this flag when it fills the remaining 3
      // locales; if it can't, `translate-pending.yml` picks the job up.
      needsRetranslation: true,
      location: 'Pfäffikon ZH',
      canton: 'ZH',
      url,
      source: 'Clienia AG Dedicated Parser (WP REST + Elementor detail)',
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: 'Pfäffikon',
      addressRegion: 'ZH',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: '8330',
      category: detectHealthcareCategory(title),
      contract: 'full-time',
      employmentType: detectHealthcareEmploymentType(title),
      experienceLevel: detectHealthcareExperienceLevel(title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      ...publication,
      applyUrl: url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }
  console.log(`📋 Total ${CLIENIA_AG_COMPANY_NAME} jobs discovered: ${jobs.length} (${detailHits}/${listings.length} with rich detail content)`);
  return jobs;
}
