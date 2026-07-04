#!/usr/bin/env node
/**
 * Valiant Bank AG job parser — Prospective.ch "Career Center" HTML listing
 * + per-job schema.org/JobPosting JSON-LD detail page.
 *
 * DISCOVERY CORRECTION: campaign discovery tagged Valiant as "jobs.ch
 * (feed)" / ATS "Custom (jobs.ch affiliate)". That tag is WRONG — verified
 * live against https://www.valiant.ch/en/ueber-valiant/arbeiten-bei-valiant-offene-stellen,
 * which links to https://jobs.valiant.ch/?lang=de. That page is NOT
 * jobs.ch at all: it serves `/careercenter/1000394/assets/js/valiant-careercenter.js`
 * and `/public/v1/careercenter/1000394/` — a Prospective.ch (Aequivital AG)
 * "Career Center" white-label career site, tenant id 1000394. Apply links
 * on job detail pages forward to
 * `https://atsconnector.prospective.ch/successfactors/EMEA_PREMIUM/ValiantP/de/apply?...`,
 * confirming the true application backend is SAP SuccessFactors (tenant
 * ValiantP) fronted entirely by Prospective's public career-site + connector
 * — no jobs.ch/jobup.ch involvement anywhere in the pipeline.
 *
 * NOT the same product as `prospective-ch-job-parser-common.mjs`'s shared
 * factory: that factory targets Prospective's *other* product line, the
 * `ohws.prospective.ch/public/v1/medium/{id}/jobs` JSON API (confirmed live:
 * medium 1000394 returns HTTP 400, wrong ID namespace). Valiant's "Career
 * Center" product only exposes a server-rendered HTML listing (no JSON
 * listing API), so listings are scraped from that HTML, then per-job detail
 * pages are parsed via the shared `jsonld-jobposting.mjs` schema.org
 * extractor (same JobPosting JSON-LD shape as the Refline boards).
 *
 * Live verified (2026-07-04):
 *   - Listing: https://jobs.valiant.ch/public/v1/careercenter/1000394/?lang=de&limit=100
 *     → 28 unique job detail URLs (`limit` hidden form field defaults to 10;
 *     100 returns the full set, confirmed stable at limit=200 too).
 *   - All 4 locale variants (`lang=de|fr|it|en`) return the IDENTICAL 28
 *     GUIDs — job content is NOT translated per locale, only page chrome.
 *     Source language is per-posting (mostly German; French for
 *     Neuchâtel/Jura/Vaud branch postings) — detected per job, not fixed.
 *   - Detail pages carry real per-branch `jobLocation` (confirmed across
 *     ~10 cantons: BE, ZH, AG, SG, FR, LU, VD, NE, JU) — NOT a single HQ
 *     fallback stamped on every posting. HQ (Bundesplatz 4, 3001 Bern, BE)
 *     is used only as a last-resort fallback when no location data exists.
 *   - Reliability quirk: on a cold cache hit, Prospective occasionally
 *     serves un-expanded edge-template placeholders instead of real content
 *     (e.g. `"description":"<<ccr:7d429fda1836,html,447B>>"` in one
 *     observed cold fetch). A retry after a short delay returned fully
 *     resolved real HTML both times this was probed. `fetchDetailLdSafe()`
 *     below detects the `<<ccr:` placeholder pattern and retries before
 *     falling back to skipping the job (never indexes placeholder text).
 *
 * Exports the 4 functions used by the crawler template:
 *   - fetchAllValiantBankJobs() — Fetch and parse all Swiss jobs
 *   - isValiantBankJob()        — Match jobs belonging to this company
 *   - isTrustedDomain()         — Validate URLs belong to this company
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, fetchHtml } from './crawler-template.mjs';
import { extractJobPostingLd, jobPostingAddress, jobPostingDescriptionText } from './jsonld-jobposting.mjs';
import { normalizeCantonCode, inferAnyCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const VALIANT_BANK_KEY = 'valiant-bank';
export const VALIANT_BANK_COMPANY_NAME = 'Valiant Bank AG';
export const VALIANT_BANK_COMPANY_DOMAIN = 'valiant.ch';

const CAREERCENTER_TENANT = '1000394';
const LISTING_URL = `https://jobs.valiant.ch/public/v1/careercenter/${CAREERCENTER_TENANT}/?lang=de&limit=100`;
const CAREER_URL = 'https://www.valiant.ch/en/ueber-valiant/arbeiten-bei-valiant-offene-stellen';
const SECTOR = 'Banche / Servizi Finanziari';

/* HQ fallback: Bundesplatz 4, 3001 Bern (Valiant Bank AG registered head office). */
const HQ = {
  city: 'Bern',
  canton: 'BE',
  postalCode: '3001',
  streetAddress: 'Bundesplatz 4',
};

const CCR_PLACEHOLDER_RE = /<<ccr:/;

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

export function isValiantBankJob(job) {
  const key = normalize(job?.companyKey || '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === VALIANT_BANK_KEY ||
    company === normalize(VALIANT_BANK_COMPANY_NAME) ||
    company.includes('valiant') ||
    url.includes('valiant.ch')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'valiant.ch' || host.endsWith('.valiant.ch')) return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Category / Experience Detection ──────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(digital banking|e-banking|mobile banking)/.test(t)) return 'Digital Banking';
  if (/\b(privatkunden|geschäftskunden|privat- und|conseiller|clientèle)/.test(t)) return 'Kundenberatung';
  if (/\b(vermögensberat|anlage|anlegen|vorsorge|finanzplan)/.test(t)) return 'Anlageberatung';
  if (/\b(kredit|hypothek|finanzier)/.test(t)) return 'Kreditgeschäft';
  if (/\b(compliance|risk|risiko|recht|legal)/.test(t)) return 'Compliance & Risk';
  if (/\b(it|informatik|software|entwickl|développeur)/.test(t)) return 'IT';
  if (/\b(hr|personal|human resources)/.test(t)) return 'Risorse Umane';
  if (/\b(lehrstelle|lernend|praktik|stage|apprenti)/.test(t)) return 'Formazione';
  if (/\b(rechnungswesen|buchhaltung|finance|comptab)/.test(t)) return 'Finanza & Contabilità';
  if (/\b(marketing|kommunikation|communication)/.test(t)) return 'Marketing';
  if (/\b(unternehmensnachfolge|firmenkunden)/.test(t)) return 'Firmenkundengeschäft';
  return 'Banca';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(lehrstelle|lernend|praktik|stage|apprenti|einsteiger)/.test(t)) return 'intern';
  if (/\b(junior)/.test(t)) return 'junior';
  if (/\b(senior|leiter|leiterin|head|director|verantwort|responsab)/.test(t)) return 'senior';
  return 'mid';
}

/* ── Employment Type ───────────────────────────────────────── */

const KNOWN_EMPLOYMENT_TYPES = new Set([
  'FULL_TIME', 'PART_TIME', 'CONTRACTOR', 'TEMPORARY', 'INTERN', 'VOLUNTEER', 'PER_DIEM', 'OTHER',
]);

function resolveEmploymentType(ldEmploymentType) {
  const raw = Array.isArray(ldEmploymentType) ? ldEmploymentType[0] : ldEmploymentType;
  const t = normalizeSpace(raw || '').toUpperCase();
  if (KNOWN_EMPLOYMENT_TYPES.has(t)) return t;
  return 'FULL_TIME';
}

/* ── Listing scrape (Prospective "Career Center" has no JSON API) ──── */

/**
 * Scrape job detail URLs + titles out of the server-rendered Career Center
 * HTML listing. Returns an array of `{ url, title }`.
 */
function parseListingHtml(html) {
  const results = [];
  const seen = new Set();
  const rx = /<a class="job job-\d+"\s+href="(https:\/\/jobs\.valiant\.ch\/offene-stellen\/[^"]+)"\s+title="([^"]*)"/g;
  let m;
  while ((m = rx.exec(html))) {
    const url = m[1];
    const title = normalizeSpace(m[2].replace(/&amp;/g, '&').replace(/&#039;/g, "'"));
    if (seen.has(url)) continue;
    seen.add(url);
    results.push({ url, title });
  }
  return results;
}

/**
 * Fetch a job detail page and extract its JobPosting JSON-LD, retrying
 * once if Prospective serves an un-expanded edge-template placeholder
 * (`<<ccr:...>>`) instead of real content (observed live on a cold cache
 * hit — see module docblock). Never returns/propagates placeholder text.
 */
async function fetchDetailLdSafe(url, { attempts = 3, delayMs = 1200 } = {}) {
  let lastHtml = '';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const html = await fetchHtml(url, { label: 'Valiant Career Center detail page' });
    lastHtml = html;
    const ld = extractJobPostingLd(html);
    const raw = JSON.stringify(ld || '');
    if (ld && !CCR_PLACEHOLDER_RE.test(raw)) {
      return ld;
    }
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  console.warn(`⚠️ ${url} kept returning placeholder/empty JSON-LD after ${attempts} attempts — skipping.`);
  void lastHtml;
  return null;
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

/**
 * Fetch all Valiant Bank AG jobs. Returns an array of ParsedJob objects
 * (source-locale only — other locales are filled by the AI localization
 * step and translate-pending pipeline).
 */
export async function fetchAllValiantBankJobs() {
  console.log(`🔍 Fetching ${VALIANT_BANK_COMPANY_NAME} jobs`);
  console.log(`   Source: ${CAREER_URL}`);
  console.log(`   Listing: ${LISTING_URL} (Prospective Career Center, tenant ${CAREERCENTER_TENANT})\n`);

  const listingHtml = await fetchHtml(LISTING_URL, { label: 'Valiant Career Center listing' });
  const listings = parseListingHtml(listingHtml);

  if (!listings.length) {
    console.warn('⚠️ No job listings found.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  const seenSlugs = new Set();

  for (const listing of listings) {
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    let ld = null;
    try {
      ld = await fetchDetailLdSafe(listing.url);
    } catch (err) {
      console.warn(`⚠️ Failed to fetch detail for ${listing.url}: ${err?.message || err}`);
    }
    if (!ld) continue;

    const addr = jobPostingAddress(ld);
    const place = addr.addressLocality || '';
    const canton =
      normalizeCantonCode(addr.addressRegion) ||
      inferAnyCanton(place) ||
      inferAnyCanton(addr.addressRegion) ||
      HQ.canton;
    const isHqCity = !!place && place.toLowerCase() === HQ.city.toLowerCase();

    const descriptionHtml = [ld.description, ld.responsibilities, ld.qualifications]
      .filter(Boolean)
      .join('\n');
    const descriptionText = jobPostingDescriptionText(descriptionHtml);
    const description = descriptionText || `${title} presso ${VALIANT_BANK_COMPANY_NAME} a ${place || HQ.city}.`;
    const sourceLang = detectLang(descriptionText || title, 'de');

    const urlHash = createHash('sha1').update(listing.url).digest('hex').slice(0, 12);

    // Some postings share title+location (e.g. multiple identical-headcount
    // branch openings) — disambiguate in-run collisions with a short id
    // suffix so both jobs keep a stable, unique slug instead of colliding.
    let jobSlug = slugify(`${title} valiant ${place || HQ.city}`);
    if (seenSlugs.has(jobSlug)) {
      jobSlug = slugify(`${title} valiant ${place || HQ.city} ${urlHash.slice(0, 6)}`);
    }
    seenSlugs.add(jobSlug);

    const employmentType = resolveEmploymentType(ld.employmentType);
    const postedDate = (ld.datePosted && String(ld.datePosted).slice(0, 10))
      || new Date().toISOString().split('T')[0];

    const hiringOrganizationName = ld.hiringOrganization?.name || VALIANT_BANK_COMPANY_NAME;

    const job = {
      // ── Required fields ──
      id: `${VALIANT_BANK_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: VALIANT_BANK_COMPANY_NAME,
      companyKey: VALIANT_BANK_KEY,
      companyDomain: VALIANT_BANK_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location: place || HQ.city,
      canton,
      url: listing.url,
      source: `${VALIANT_BANK_COMPANY_NAME} Dedicated Parser (Prospective Career Center ${CAREERCENTER_TENANT}, JSON-LD)`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: place || HQ.city,
      addressRegion: canton,
      streetAddress: addr.streetAddress || (isHqCity ? HQ.streetAddress : ''),
      postalCode: addr.postalCode || (isHqCity ? HQ.postalCode : ''),
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: listing.url,
      hiringOrganizationName,
      needsRetranslation: true,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total ${VALIANT_BANK_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

export { parseListingHtml, fetchDetailLdSafe, resolveEmploymentType, detectCategory, detectExperienceLevel };
