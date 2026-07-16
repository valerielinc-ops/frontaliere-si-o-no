#!/usr/bin/env node
/**
 * Stiftung BACHTELEN — Grenchen (SO).
 *
 * Special-education + residential treatment foundation for children and
 * young adults in the canton of Solothurn (Kindertagesstätten, Tagesschulen,
 * Wohnangebote, individuelle Förderung, Therapie & Beratung).
 *
 * Public career site: https://www.bachtelen.ch/arbeiten-bei-uns/offene-stellen/
 *
 * The page uses the WordPress "WP Job Manager" plugin with AJAX rendering.
 * Instead of scraping the rendered HTML we hit the WP REST endpoint directly:
 *   https://www.bachtelen.ch/wp-json/wp/v2/job-listings?per_page=50
 *
 * Each job carries meta:
 *   _job_location, _application (email), _company_name, _featured, _filled
 *   content.rendered (HTML body), title.rendered, link
 *
 * Source language is German. Jobs default to Grenchen (SO) — HQ — but we
 * read _job_location when present to derive city + canton via target config.
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, warnIfListingAtCap, fetchJson } from './crawler-template.mjs';
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
const API_URL = `https://www.bachtelen.ch/wp-json/wp/v2/job-listings?per_page=${LISTING_PAGE_CAP}`;
const PUBLIC_CAREER_URL = 'https://www.bachtelen.ch/arbeiten-bei-uns/offene-stellen/';

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
    label: 'Bachtelen wp-json job-listings',
    headers: {
      Accept: 'application/json,text/html;q=0.9,*/*;q=0.5',
      'Accept-Language': 'de-CH,de;q=0.9,en;q=0.5',
      Referer: PUBLIC_CAREER_URL,
    },
  });
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
  console.log(`   Source: ${API_URL} (WP REST)\n`);

  let records;
  try {
    records = await fetchBachtelenListingJson(API_URL, timeoutMs);
  } catch (err) {
    throw new Error(`Failed to fetch Bachtelen WP REST: ${err?.message || err}`);
  }
  if (!Array.isArray(records)) {
    console.warn('⚠️ Unexpected response shape from Bachtelen WP REST.');
    return [];
  }

  console.log(`  📋 ${records.length} job listings from WP REST\n`);
  warnIfListingAtCap({ label: 'Bachtelen WP REST listing', count: records.length, cap: LISTING_PAGE_CAP });
  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];

  for (const rec of records) {
    try {
      const meta = rec?.meta || {};
      if (Number(meta?._filled) === 1) continue; // skip filled jobs

      const title = normalizeSpace(decodeEntities(String(rec?.title?.rendered || '').replace(/<[^>]+>/g, '')));
      const url = String(rec?.link || '');
      if (!title || !url) continue;

      const rawLocation = String(meta?._job_location || '').trim();
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
        source: 'Bachtelen Dedicated Parser (WP REST job-listings)',
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
        postedDate: rec?.date ? String(rec.date).slice(0, 10) : todayIso,
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
