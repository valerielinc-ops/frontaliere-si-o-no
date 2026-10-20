#!/usr/bin/env node
/**
 * Stiftung BACHTELEN — Grenchen (SO).
 *
 * Special-education + residential treatment foundation for children and
 * young adults in the canton of Solothurn (Kindertagesstätten, Tagesschulen,
 * Wohnangebote, individuelle Förderung, Therapie & Beratung).
 *
 * Public career site: https://www.bachtelen.ch/arbeiten-bei-uns/
 *
 * The old WP Job Manager endpoint was removed when the site moved its jobs to
 * the custom `stelle` post type. We use that post type's REST endpoint for
 * full descriptions and the public career page for the location shown on each
 * listing card.
 *
 * Each job record carries content.rendered (HTML body), title.rendered, date,
 * and link. The public page supplies the location card field; published posts
 * are the active jobs, so no `_filled` filter is needed.
 *
 * Source language is German. Jobs default to Grenchen (SO) — HQ — but we
 * read the listing-card location when present to derive city + canton via
 * target config.
 */
import { sourcePostingDateCandidatesFields } from './source-posting-date.mjs';
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, warnIfListingAtCap, fetchHtml, fetchJson } from './crawler-template.mjs';
import {
  decodeEntities,
  normalizeSpace,
  htmlToText,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
} from './hospital-custom-html-helpers.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

export const BACHTELEN_KEY = 'bachtelen';
export const BACHTELEN_COMPANY_NAME = 'Stiftung Bachtelen';
export const BACHTELEN_COMPANY_DOMAIN = 'bachtelen.ch';

const LISTING_PAGE_CAP = 50;
const API_URL = `https://www.bachtelen.ch/wp-json/wp/v2/stelle?per_page=${LISTING_PAGE_CAP}&status=publish`;
const PUBLIC_CAREER_URL = 'https://www.bachtelen.ch/arbeiten-bei-uns/';

const DEFAULT_CITY = 'Grenchen';
const DEFAULT_CANTON = 'SO';
const DEFAULT_POSTAL = '2540';

export function isBachtelenJob(job) {
  const url = String(job?.url || '').toLowerCase();
  const key = String(job?.companyKey || '').toLowerCase();
  const company = String(job?.company || '').toLowerCase();
  return (
    key === BACHTELEN_KEY ||
    url.includes('bachtelen.ch') ||
    company.includes('bachtelen')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'bachtelen.ch' || host.endsWith('.bachtelen.ch');
  } catch {
    return false;
  }
}

// Uses the shared fetchJson() (crawler-template.mjs): retries transient
// failures (5xx/429, network blips, and a 200-but-non-JSON WAF "challenge"
// body — the same class of intermittent block that broke the Bucher + Suter
// WP REST listing, #4247) via exponential backoff instead of hard-failing
// the whole crawler on one blip. Site-specific headers (Accept/Referer) are
// preserved as-is via `options.headers`.
function fetchBachtelenListingJson(url, timeoutMs = 20000) {
  return fetchJson(url, {
    timeoutMs,
    label: 'Bachtelen wp-json stelle',
    headers: {
      Accept: 'application/json,text/html;q=0.9,*/*;q=0.5',
      'Accept-Language': 'de-CH,de;q=0.9,en;q=0.5',
      Referer: PUBLIC_CAREER_URL,
    },
  });
}

function fetchBachtelenCareerPage(timeoutMs = 20000) {
  return fetchHtml(PUBLIC_CAREER_URL, {
    timeoutMs,
    label: 'Bachtelen public career page',
    headers: {
      Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
      'Accept-Language': 'de-CH,de;q=0.9,en;q=0.5',
    },
  });
}

function normalizeBachtelenUrl(rawUrl = '') {
  try {
    const url = new URL(String(rawUrl || ''), PUBLIC_CAREER_URL);
    url.hash = '';
    url.search = '';
    return url.toString();
  } catch {
    return '';
  }
}

/**
 * Read the location shown in the current Elementor listing cards.
 *
 * The card markup is deliberately scoped to `.job-details`: the page also
 * contains many unrelated links and headings, and a global link scrape would
 * accidentally treat navigation or contact links as jobs. The first text
 * field is the workload; the second is the location.
 */
export function parseBachtelenListingPage(html = '') {
  const locationsByUrl = new Map();
  const cardRe = /<div\b[^>]*class=["'][^"']*\bjob-details\b[^"']*["'][^>]*>([\s\S]*?)<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi;
  const fieldRe = /<div\b[^>]*class=["'][^"']*\btext_20\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi;

  for (const match of String(html || '').matchAll(cardRe)) {
    const fields = [...match[1].matchAll(fieldRe)]
      .map((field) => normalizeSpace(htmlToText(field[1])))
      .filter(Boolean);
    const location = fields[1] || '';
    const url = normalizeBachtelenUrl(decodeEntities(match[2]));
    if (url && location) locationsByUrl.set(url, location);
  }

  return locationsByUrl;
}

function pickLocationHints(rawLocation = '') {
  const loc = String(rawLocation || '').trim();
  if (!loc) return { city: DEFAULT_CITY, canton: DEFAULT_CANTON, postal: DEFAULT_POSTAL };
  const inferred = inferSwissTargetCanton(loc);
  if (inferred) return { city: loc, canton: inferred, postal: '' };
  return { city: loc || DEFAULT_CITY, canton: DEFAULT_CANTON, postal: '' };
}

export async function fetchAllBachtelenJobs() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  console.log(`🏫 Fetching ${BACHTELEN_COMPANY_NAME} jobs`);
  console.log(`   Source: ${API_URL} (WP REST stelle)\n`);

  let records;
  try {
    records = await fetchBachtelenListingJson(API_URL, timeoutMs);
  } catch (err) {
    throw new Error(`Failed to fetch Bachtelen WP REST stelle: ${err?.message || err}`);
  }
  if (!Array.isArray(records)) {
    console.warn('⚠️ Unexpected response shape from Bachtelen WP REST.');
    return [];
  }

  let locationsByUrl = new Map();
  try {
    const listingHtml = await fetchBachtelenCareerPage(timeoutMs);
    locationsByUrl = parseBachtelenListingPage(listingHtml);
  } catch (err) {
    // The REST feed still contains the full detail pages. If the presentation
    // page is temporarily unavailable, retain the jobs with the HQ fallback
    // rather than turning a layout outage into a crawler-wide failure.
    console.warn(`⚠️ Could not read Bachtelen listing locations: ${err?.message || err}`);
  }

  console.log(`  📋 ${records.length} job listings from WP REST stelle\n`);
  warnIfListingAtCap({ label: 'Bachtelen WP REST stelle listing', count: records.length, cap: LISTING_PAGE_CAP });
  const jobs = [];

  for (const rec of records) {
    try {
      const meta = rec?.meta || {};
      // WordPress date_gmt is publication in UTC; modified_gmt is unrelated.
      const publishedGmt = typeof rec?.date_gmt === 'string' ? rec.date_gmt.trim() : '';
      const publication = sourcePostingDateCandidatesFields([publishedGmt, `${publishedGmt}Z`, rec?.date]);

      const title = normalizeSpace(decodeEntities(String(rec?.title?.rendered || '').replace(/<[^>]+>/g, '')));
      const url = String(rec?.link || '');
      if (!title || !url) continue;

      const rawLocation = locationsByUrl.get(normalizeBachtelenUrl(url)) || '';
      const hints = pickLocationHints(rawLocation);

      const bodyHtml = String(rec?.content?.rendered || '');
      const bodyText = htmlToText(bodyHtml);
      const description = [
        bodyText,
        '',
        `${BACHTELEN_COMPANY_NAME} — Sonder- und sozialpädagogische Stiftung im Kanton Solothurn.`,
      ].filter(Boolean).join('\n').trim();

      const haystack = `${title} ${bodyText}`;
      const sourceLang = detectLang(description || title, 'de');
      const jobSlug = slugify(`${title} ${BACHTELEN_KEY} ${hints.city}`);
      const urlHash = createHash('sha1').update(url).digest('hex').slice(0, 12);

      jobs.push({
        id: `${BACHTELEN_KEY}-${urlHash}`,
        slug: jobSlug,
        slugByLocale: { [sourceLang]: jobSlug },
        company: BACHTELEN_COMPANY_NAME,
        companyKey: BACHTELEN_KEY,
        companyDomain: BACHTELEN_COMPANY_DOMAIN,
        title,
        titleByLocale: { [sourceLang]: title },
        description,
        descriptionByLocale: { [sourceLang]: description },
        // Newly-discovered jobs ship source-locale-only; AI step clears this
        // flag once it fills the 3 remaining locales, otherwise the
        // translate-pending workflow picks them up.
        needsRetranslation: true,
        location: hints.city,
        canton: hints.canton,
        url,
        source: 'Bachtelen Dedicated Parser (WP REST stelle)',
        sourceLang,
        crawledAt: new Date().toISOString(),
        addressLocality: hints.city,
        addressRegion: hints.canton,
        addressCountry: 'CH',
        country: 'CH',
        postalCode: hints.postal || DEFAULT_POSTAL,
        category: detectHealthcareCategory(haystack),
        contract: detectHealthcareEmploymentType(haystack) === 'PART_TIME' ? 'part-time' : 'full-time',
        employmentType: detectHealthcareEmploymentType(haystack),
        experienceLevel: detectHealthcareExperienceLevel(haystack),
        sector: 'Sociale / Educazione',
        currency: 'CHF',
        featured: Number(meta?._featured) === 1,
        ...publication,
        applyUrl: url,
        requirements: [],
        requirementsByLocale: { [sourceLang]: [] },
      });
      console.log(`  ✅ ${title.substring(0, 70)} → ${hints.city} (${hints.canton})`);
    } catch (err) {
      console.warn(`  ⚠️ Skip job ${rec?.id || '?'}: ${err?.message || err}`);
    }
  }

  console.log(`\n📋 Total ${BACHTELEN_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
