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
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import {
  fetchHtml,
  decodeEntities,
  normalizeSpace,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
} from './hospital-custom-html-helpers.mjs';

export const CLIENIA_AG_KEY = 'clienia-ag';
export const CLIENIA_AG_COMPANY_NAME = 'Clienia AG';
export const CLIENIA_AG_COMPANY_DOMAIN = 'clienia.ch';

const API_URL = 'https://www.clienia.ch/wp-json/wp/v2/jobs?per_page=100&_fields=id,slug,link,title,date,location';
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
 * Pull the «Ihre Aufgaben» / «Ihr Profil» / «Unser Angebot» content from
 * an Elementor-rendered detail page. Falls back to the first 1500 chars
 * of stripped text if section headings are missing.
 */
export function extractCleniaDetailContent(html) {
  if (!html) return '';
  // The 3 known headings appear inline; cut from the first one to the next major Elementor column boundary.
  const startMatch = html.search(/Ihre Aufgaben|Ihr Profil|Unser Angebot|Pflegen/i);
  if (startMatch < 0) return '';
  const slice = html.slice(startMatch, startMatch + 8000);
  // Stop at the next big Elementor column outside the content section
  const stopIdx = slice.search(/<div class="elementor-column elementor-col-50 elementor-top-column/);
  const window = stopIdx > 100 ? slice.slice(0, stopIdx) : slice;
  const text = normalizeSpace(decodeEntities(window
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/(?:p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' '),
  ));
  // Drop trailing boilerplate "Arbeiten bei Clienia – Ihre Vorteile auf einen Blick…" if present
  const trimAt = text.indexOf('Arbeiten bei Clienia');
  return trimAt > 50 ? normalizeSpace(text.slice(0, trimAt)) : text;
}

async function fetchAllListings() {
  const res = await fetch(API_URL, {
    headers: { Accept: 'application/json', 'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${API_URL}`);
  return await res.json();
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
  console.log(`  📄 Fetching detail pages for rich descriptions...`);

  const todayIso = new Date().toISOString().slice(0, 10);
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

    const description = [
      detailContent,
      'Clienia AG — grösste Privatklinikgruppe für Psychiatrie und Psychotherapie der Deutschschweiz. Standorte: Privatklinik Bellevue (Pfäffikon ZH), Klinik Schlössli (Oetwil am See ZH), Tagesklinik Zürich, Tagesklinik Wetzikon.',
    ].filter(Boolean).join('\n\n');

    // Determine canton: most Clienia sites are ZH; fall back to ZH if no signal
    const sourceLang = detectLang(description || title, 'de');
    const jobSlug = slugify(`${title} ${CLIENIA_AG_KEY} zurich`);
    const urlHash = createHash('sha1').update(url).digest('hex').slice(0, 12);
    const postedDate = (() => {
      const d = new Date(item?.date || '');
      return Number.isNaN(d.getTime()) ? todayIso : d.toISOString().slice(0, 10);
    })();

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
      postedDate,
      applyUrl: url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }
  console.log(`📋 Total ${CLIENIA_AG_COMPANY_NAME} jobs discovered: ${jobs.length} (${detailHits}/${listings.length} with rich detail content)`);
  return jobs;
}
