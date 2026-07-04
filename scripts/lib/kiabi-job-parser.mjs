#!/usr/bin/env node
/**
 * Kiabi Suisse job parser — SmartRecruiters (tenant "KIABI") API.
 *
 * ATS discovery (issue #3337 lists Kiabi Suisse as "Custom", source
 * kiabi.com/fr/recrutement — WRONG, same mislabeling pattern as several
 * other rows in this backlog):
 *   1. `www.kiabi.com/fr/recrutement` and `www.kiabishop.com/*` are both
 *      bot-gated (403 for curl + browser UA + WebFetch alike — Akamai/CF-style
 *      wall, "Please enable JS and disable any ad blocker" shell served
 *      instead of content) so no ATS fingerprint is visible in static HTML.
 *   2. A live careers portal DOES exist and is publicly reachable:
 *      `careers.smartrecruiters.com/KIABI/france` — this is SmartRecruiters,
 *      the SAME ATS already consumed by `staubli-job-parser.mjs` /
 *      `migros-hq-job-parser.mjs` via the shared client
 *      (`./ats-clients/smartrecruiters-client.mjs`).
 *   3. Confirmed against the public, unauthenticated SmartRecruiters REST API
 *      directly: `GET https://api.smartrecruiters.com/v1/companies/KIABI/postings`
 *      returns `totalFound: 272` postings across the whole Kiabi group
 *      (FR/PT/ES/IT/CN/HK/KH/IN/CH), confirming tenant id "KIABI" (case-
 *      sensitive, per SR convention) publishes group-wide, including the new
 *      Swiss subsidiary. As of 2026-07 exactly ONE `country: "ch"` posting is
 *      live (Fribourg store, `customField` "Brands" = "Kiabi Suisse"),
 *      consistent with Kiabi Suisse having only just entered the market
 *      (two stores opened April 2026 — see HQ note below).
 *   4. `robots.txt` on both kiabi.com and kiabishop.com carries only generic
 *      e-commerce disallow rules (search/cart/facet params) — no ATS-specific
 *      disallow pattern, no iframe, no `<meta name="ATS">` tag found (page
 *      itself never rendered past the JS-required shell for an unauthenticated
 *      fetch, so this is a corroborating absence rather than a positive
 *      finding).
 *   → Conclusion: "Custom" is WRONG. Real ATS = SmartRecruiters (tenant
 *     "KIABI"), same shared client as Stäubli/Migros HQ. No bespoke fetch/parse
 *     code needed — this file only owns Kiabi-specific concerns (Switzerland
 *     filter, HQ-vs-store address gating, canton inference, category/contract
 *     detection).
 *
 * Source: https://api.smartrecruiters.com/v1/companies/KIABI/postings?locationCountryCodes=ch
 * Public posting URLs: https://jobs.smartrecruiters.com/KIABI/{id}-{slug}
 *
 * ── Legal entity / HQ note (verified 2026-07, 3 independent sources) ──
 * Kiabi Suisse SA (UID/CHE-442.567.929) IS a separate Swiss legal entity —
 * incorporated 04.03.2025, entered in the Vaud commercial register
 * 11.03.2025. Its registered legal seat is:
 *
 *     Rue de Bourg 16, 1003 Lausanne (VD)
 *
 * confirmed independently via (1) Moneyhouse company record
 * (moneyhouse.ch/en/company/kiabi-suisse-sa-15144748841 — "Rue de Bourg
 * 16-18, c/o LEGAL INSIGHTS Sàrl, 1003 Lausanne") and (2) local.ch, which
 * itself sources the entry from the FOSC (Feuille officielle suisse du
 * commerce / Swiss official gazette of commerce) — both agree on the street,
 * postal code and city.
 *
 * IMPORTANT: this registered address is a pure legal domiciliation at a
 * fiduciary/law firm ("c/o LEGAL INSIGHTS Sàrl") — it is NOT an operational
 * site; no Kiabi employees work there. Kiabi Suisse's actual retail
 * operations are its two physical stores, both opened April 2026:
 * Fribourg-Sud (Centre Fribourg Sud, Villars-sur-Glâne, canton FR) and Marin
 * Centre (Marin-Epagnier, canton NE). Because of this, `resolveAddress()`
 * below NEVER uses the Lausanne street address as a generic Swiss fallback —
 * it is gated on the resolved city text literally matching "Lausanne" (same
 * discipline as `rieter-job-parser.mjs`'s Winterthur gate / canton-code jump
 * would be wrong here since Lausanne is VD and the live stores are FR/NE, but
 * the city-text gate is kept as the primary, non-bypassable check per
 * AGENTS.md). In practice this means Fribourg/Neuchâtel-area store postings
 * carry NO fabricated street address (safe empty default, same as the
 * Rieter/Bräcker non-HQ case) unless SmartRecruiters itself supplies one.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllKiabiJobs()   — Fetch and parse all Swiss jobs
 *   - isKiabiJob()          — Match jobs belonging to this company
 *   - isTrustedDomain()     — Validate URLs belong to this company
 *   - slugify() / stripHtml() — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang, guessCategory, normalizeContract } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferAnyCanton } from './target-swiss-locations.mjs';
import {
  fetchSmartRecruitersJobs,
  SmartRecruitersApiError,
} from './ats-clients/smartrecruiters-client.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const KIABI_KEY = 'kiabi';
export const KIABI_COMPANY_NAME = 'Kiabi Suisse';
export const KIABI_COMPANY_DOMAIN = 'kiabi.com';

const SR_TENANT = 'KIABI';
const CAREER_URL = 'https://www.kiabi.com/fr/recrutement';

/* ── HQ fallback (legal domiciliation ONLY, not an operational site) ── */
// Rue de Bourg 16, 1003 Lausanne (VD) — Kiabi Suisse SA's registered legal
// seat (Moneyhouse CHE-442.567.929 + local.ch/FOSC, cross-checked). A
// fiduciary/law-firm domiciliation address, no employees on site. Gated
// strictly on the resolved city textually matching "Lausanne" in
// resolveAddress() below — the two live stores (Fribourg, Marin-Epagnier NE)
// must NEVER inherit this address just because Kiabi Suisse SA is
// headquartered (on paper) in the same country/canton family.
const HQ = {
  city: 'Lausanne',
  canton: 'VD',
  postalCode: '1003',
  streetAddress: 'Rue de Bourg 16',
  region: 'Vaud',
};

const SECTOR = 'Retail / Abbigliamento';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Kiabi Suisse.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isKiabiJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === KIABI_KEY ||
    key.startsWith('kiabi') ||
    company.includes('kiabi') ||
    url.includes('kiabi.com') ||
    url.includes('kiabishop.com') ||
    url.includes('smartrecruiters.com/kiabi')
  );
}

/**
 * Validate that a URL belongs to Kiabi's own domains OR the SmartRecruiters
 * ATS hosts that actually serve the postings (api/jobs/careers.smartrecruiters.com).
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'kiabi.com' || host.endsWith('.kiabi.com')) return true;
    if (host === 'kiabishop.com' || host.endsWith('.kiabishop.com')) return true;
    if (host === 'smartrecruiters.com' || host.endsWith('.smartrecruiters.com')) return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Experience / Employment Detection ─────────────────────── */

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr|etudiant|étudiant|student)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|manager|leader)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

/**
 * Pick the best city / postal code / street / region from a raw
 * SmartRecruiters posting location, falling back to the documented Lausanne
 * legal-seat address ONLY when the resolved city text itself matches
 * "Lausanne" (city-gated, never canton-only — see HQ note above). This is
 * the exact discipline that stops a Fribourg or Marin-Epagnier (NE) store
 * posting from incorrectly inheriting a fabricated street address just
 * because Kiabi Suisse SA's paper registered seat happens to be in the same
 * country.
 *
 * Exported so tests exercise this exact gate instead of a duplicated regex.
 *
 * @param {{ city?: string, fullLocation?: string, postalCode?: string, address?: string, region?: string }} [rawLoc]
 * @returns {{ city: string, postalCode: string, streetAddress: string, region: string }}
 */
export function resolveAddress(rawLoc = {}) {
  const city = normalizeSpace(rawLoc.city || rawLoc.fullLocation || '') || HQ.city;
  const postalCode = normalizeSpace(rawLoc.postalCode || '');
  // SmartRecruiters' `location.address` field is free-text entered by the
  // recruiter and, for Kiabi's real live Fribourg posting, is simply the
  // city name typed again ("Fribourg") rather than an actual street — a
  // duplicate-as-street value is not a real address any more than a blank
  // one is, so treat it the same as "no street address" (safe default,
  // never fabricate/mislabel).
  const rawAddress = normalizeSpace(rawLoc.address || '');
  const streetAddress = (rawAddress && rawAddress.toLowerCase() !== city.toLowerCase()) ? rawAddress : '';
  const region = normalizeSpace(rawLoc.region || '');
  const isLausanneHq = /lausanne/i.test(city);

  return {
    city,
    postalCode: postalCode || (isLausanneHq ? HQ.postalCode : ''),
    streetAddress: streetAddress || (isLausanneHq ? HQ.streetAddress : ''),
    region,
  };
}

/**
 * Fetch the Switzerland-only Kiabi postings from the SmartRecruiters API
 * (tenant "KIABI", country=ch). Returns an array of raw listing objects
 * {title, location, url, postedAt, description, jobReqId, rawLocation}.
 */
async function fetchJobListings() {
  console.log(`   Fetching SmartRecruiters tenant "${SR_TENANT}" (country=ch)`);
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;

  const listings = [];
  try {
    for await (const job of fetchSmartRecruitersJobs(SR_TENANT, {
      company: KIABI_COMPANY_NAME,
      locationCountryCodes: ['ch'],
      fetchDetail: true,
      timeoutMs,
    })) {
      const raw = job.rawPosting || {};
      listings.push({
        title: job.title,
        location: job.location,
        url: job.applyUrl,
        postedAt: job.postedAt,
        description: job.descriptionHtml || '',
        jobReqId: job.jobReqId || raw.id || '',
        rawLocation: raw.location || {},
        employmentLabel: raw?.typeOfEmployment?.label || '',
      });
    }
  } catch (err) {
    console.warn(`⚠️ SmartRecruiters fetch failed: ${err?.message || err}`);
    throw err;
  }

  return listings;
}

/**
 * Fetch all Kiabi Suisse jobs (Switzerland only — the SmartRecruiters tenant
 * is group-wide, spanning FR/PT/ES/IT/CN/HK/KH/IN too, so the
 * `locationCountryCodes: ['ch']` filter passed to the shared client is what
 * scopes this crawler down to the Swiss subsidiary).
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllKiabiJobs() {
  console.log(`🔍 Fetching ${KIABI_COMPANY_NAME} jobs`);
  console.log(`   Source: ${CAREER_URL} (SmartRecruiters tenant "${SR_TENANT}")\n`);

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  const seen = new Set();
  for (const listing of listings) {
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    const { city, postalCode, streetAddress, region } = resolveAddress(listing.rawLocation);
    // Prefer the clean resolved `city` over the shared SmartRecruiters
    // client's `listing.location` (= `fullLocation || city`): SR's
    // `fullLocation` is often a sparse "{city}, , Switzerland" string (empty
    // region left as a stray double-comma) — showing that verbatim on a job
    // card is worse than the plain city name. Falls back to the raw
    // `listing.location` only when resolveAddress had no city at all, then
    // to the HQ city as last resort.
    const location = normalizeSpace(city || listing.location || HQ.city);
    // Nationwide check (all 26 cantons): Kiabi Suisse is a brand-new entrant
    // whose store footprint may grow beyond the two currently-live cantons
    // (FR, NE), so this deliberately does not restrict to a fixed canton set
    // the way an established single-site HQ crawler would.
    const canton =
      inferAnyCanton(location) ||
      inferAnyCanton(`${city} ${region}`) ||
      HQ.canton;

    const descriptionHtml = listing.description || '';
    const descriptionText = stripHtml(descriptionHtml);
    const publicUrl = listing.url || CAREER_URL;
    if (seen.has(publicUrl)) continue;
    seen.add(publicUrl);

    const description = descriptionText || `${title} chez ${KIABI_COMPANY_NAME} à ${location}.`;
    const sourceLang = detectLang(descriptionText || title, 'fr');
    const jobSlug = slugify(`${title} kiabi ${location}`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const employmentType = detectEmploymentType(listing.employmentLabel || title);
    const contract = normalizeContract(listing.employmentLabel || '', title, description);
    const postedDate = (listing.postedAt && String(listing.postedAt).slice(0, 10))
      || new Date().toISOString().split('T')[0];

    const job = {
      // ── Required fields ──
      id: `${KIABI_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: KIABI_COMPANY_NAME,
      companyKey: KIABI_KEY,
      companyDomain: KIABI_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton,
      url: publicUrl,
      source: 'Kiabi Suisse Dedicated Parser (SmartRecruiters)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: city || location,
      addressRegion: region || canton,
      streetAddress,
      postalCode,
      addressCountry: 'CH',
      country: 'CH',
      category: guessCategory(title, description),
      contract,
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: publicUrl,
      jobReqId: listing.jobReqId || null,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total ${KIABI_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
