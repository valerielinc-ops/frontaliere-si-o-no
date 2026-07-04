#!/usr/bin/env node
/**
 * Hornbach Baumarkt job parser — "job-shop" (TalentsConnect) Typesense-backed
 * SPA, Switzerland tenant.
 *
 * ATS discovery (issue #3337 lists Hornbach as "Custom" — WRONG, same
 * mislabel pattern seen elsewhere in this backlog):
 *
 *   1. https://www.hornbach.ch is fronted by Fastly's "Client Challenge"
 *      bot-protection (blocks default HTTP clients); the CH-specific careers
 *      entry point instead redirects to a DEDICATED subdomain,
 *      https://jobs.hornbach.ch, which is NOT behind that challenge.
 *   2. jobs.hornbach.ch is a Nuxt3 SPA. Its JS bundle references a Sentry DSN
 *      on host `jobshop.services` and ships strings identifying the vendor
 *      platform as "job-shop" / "JobShop" (product of TalentsConnect) — a
 *      multi-tenant Swiss SaaS career-site builder, NOT the classic
 *      German-group-wide SuccessFactors Career Site Builder portal Hornbach
 *      also runs at the legacy `jobs.hornbach.com` (confirmed there via
 *      `rmkcdn.successfactors.com` CDN assets, "jobs2web" platform strings,
 *      and the classic SF-CSB robots.txt disallow pattern) — that legacy
 *      portal does NOT surface Switzerland-specific postings at all (only
 *      AT/RO locale links were observed there).
 *   3. The job-shop SPA itself doesn't render markup server-side worth
 *      scraping; it calls a first-party JSON API backed by Typesense:
 *        a. `GET https://api.my-job-shop.com/api/offer/v1/search/api-key
 *            ?filter=backoffice_vanity:ch` with header `X-Tenant-Id: hornbach`
 *           returns a short-lived, SCOPED (search-only, tenant+vanity+status
 *           filter baked in server-side) Typesense API key.
 *        b. `POST https://api.my-job-shop.com/api/typesense/multi_search
 *            ?x-typesense-api-key=<key>` with a `collection: "offers"` search
 *           (confirmed empirically — "jobs"/"vacancies"/"career_offers"/
 *           "job_offers"/"offer" all 401, only "offers" is authorized by the
 *           scoped key) returns the full Swiss job document set. The scoped
 *           key's baked-in filter (`tenant_id:=hornbach && backoffice_vanity
 *           :=ch && status:=ACTIVE`) already restricts hits to active CH
 *           postings (32 observed live 2026-07).
 *   4. Actual application submission still routes through SuccessFactors
 *      (`application_url` fields point at `career5.successfactors.eu`) — so
 *      SuccessFactors is the underlying recruiting-workflow ATS, but
 *      job-shop/TalentsConnect is the public-facing listing/search layer
 *      this crawler must query, since it is what jobs.hornbach.ch actually
 *      renders from.
 *   5. `robots.txt` on jobs.hornbach.ch is wide open (no disallow rules,
 *      only a sitemap directive) — no ATS-fingerprint signal there (unlike
 *      the legacy jobs.hornbach.com SF-CSB robots.txt, which does have the
 *      classic pattern).
 *
 * None of `scripts/lib/ats-clients/*` (csod, greenhouse, lever, personio,
 * smartrecruiters, successfactors, workday) implements the job-shop/
 * TalentsConnect Typesense flow, so this bespoke parser is justified. Shared
 * utilities are still reused where they fit: `fetchJson`/`slugify`/
 * `normalizeSpace`/`stripHtml` from `./crawler-template.mjs`,
 * `detectLang`/`guessCategory`/`normalizeContract`/`decodeHtmlEntities` from
 * `./dedicated-crawler-common.mjs`, `inferSwissTargetCanton` from
 * `./target-swiss-locations.mjs`.
 *
 * Source URLs:
 *   Public site: https://jobs.hornbach.ch (Nuxt3 SPA, no server-rendered
 *                job markup — data is fetched client-side from the API below)
 *   API key:     https://api.my-job-shop.com/api/offer/v1/search/api-key
 *                ?filter=backoffice_vanity:ch  (header X-Tenant-Id: hornbach)
 *   Search:      https://api.my-job-shop.com/api/typesense/multi_search
 *                ?x-typesense-api-key={key}  (collection "offers")
 *
 * Hornbach operates in several European countries on the same job-shop
 * platform; the scoped API key's own `backoffice_vanity:=ch` filter already
 * restricts results to the Swiss tenant vanity, but `country` is defensively
 * re-checked per document at assembly time in case any non-CH record ever
 * leaks through (e.g. a cross-border posting tagged CH-vanity but a
 * different `country` value).
 *
 * HQ verified via 3 independent sources (2026-07):
 *   - Own Impressum (jobs.hornbach.ch/impressum): "HORNBACH Baumarkt
 *     (Schweiz) AG / Schellenrain 9 / CH-6210 Sursee / Sitz: Oberkirch /
 *     MwSt-Nummer: CHE-101.079.884".
 *   - Zefix (Swiss commercial register REST API): name "Hornbach Baumarkt
 *     (Schweiz) AG", uid "CHE101079884", legalSeat "Oberkirch" — exact match.
 *   - Moneyhouse: "Hornbach Baumarkt (Schweiz) AG — Schellenrain 9 | 6210
 *     Sursee" — exact match.
 * Some stores/postings sit in OTHER cities across Switzerland (Hornbach runs
 * multiple Swiss branches), so `resolveAddress()` below is the HQ-fallback
 * ONLY, and is gated on the resolved city text actually matching Sursee
 * (never applied canton-wide) — a Luzern-canton-but-different-city posting
 * (e.g. "Luzern Littau", same canton LU as the Sursee HQ) must NOT inherit
 * the Schellenrain 9 street address.
 */
import { createHash } from 'node:crypto';
import { fetchJson, slugify, normalizeSpace, stripHtml } from './crawler-template.mjs';
import { detectLang, guessCategory, normalizeContract, decodeHtmlEntities } from './dedicated-crawler-common.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const HORNBACH_KEY = 'hornbach';
export const HORNBACH_COMPANY_NAME = 'Hornbach';
export const HORNBACH_COMPANY_DOMAIN = 'hornbach.ch';

const TENANT_ID = 'hornbach';
const API_BASE = 'https://api.my-job-shop.com';
const API_KEY_URL = `${API_BASE}/api/offer/v1/search/api-key?filter=backoffice_vanity:ch`;
const MULTI_SEARCH_URL = `${API_BASE}/api/typesense/multi_search`;
const SEARCH_COLLECTION = 'offers';

const SECTOR = 'Retail / Bricolage e Giardinaggio';

/** HQ fallback — HORNBACH Baumarkt (Schweiz) AG, Schellenrain 9, 6210 Sursee
 * (LU). Verified via the company's own Impressum, cross-checked against
 * Zefix (uid CHE-101.079.884, legal seat Oberkirch LU) and Moneyhouse. */
const HQ = {
  city: 'Sursee',
  canton: 'LU',
  postalCode: '6210',
  streetAddress: 'Schellenrain 9',
  region: 'Luzern',
};

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function cleanText(value = '') {
  return normalizeSpace(decodeHtmlEntities(stripHtml(String(value || ''))));
}

/**
 * Resolve the best city / postal code / street address for a job, falling
 * back to the documented Sursee HQ ONLY when the resolved city text itself
 * matches Sursee (city-gated, never canton-only) — this is what stops a
 * same-canton (LU) but different-city posting, e.g. "Luzern Littau", from
 * incorrectly inheriting the Schellenrain 9 street address just because it
 * shares canton LU with the HQ.
 *
 * Exported so tests exercise this exact gate instead of a duplicated regex.
 *
 * @param {{ city?: string, postalCode?: string, streetAddress?: string }} [raw]
 * @returns {{ city: string, postalCode: string, streetAddress: string }}
 */
export function resolveAddress(raw = {}) {
  const city = normalizeSpace(raw.city || '') || HQ.city;
  const isSurseeHq = /sursee/i.test(city);
  return {
    city,
    postalCode: normalizeSpace(raw.postalCode || '') || (isSurseeHq ? HQ.postalCode : ''),
    streetAddress: normalizeSpace(raw.streetAddress || '') || (isSurseeHq ? HQ.streetAddress : ''),
  };
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Hornbach.
 */
export function isHornbachJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === HORNBACH_KEY ||
    key.startsWith('hornbach') ||
    company.includes('hornbach') ||
    url.includes('hornbach.ch') ||
    url.includes('hornbach.com')
  );
}

/**
 * Validate a URL belongs to one of Hornbach's own domains (the modern
 * job-shop CH site jobs.hornbach.ch, or the general hornbach.ch/.com
 * corporate domains — including the legacy jobs.hornbach.com SF-CSB portal,
 * which is still Hornbach's own domain even though it isn't the CH source
 * this crawler queries).
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    return (
      host === 'hornbach.ch' || host.endsWith('.hornbach.ch') ||
      host === 'hornbach.com' || host.endsWith('.hornbach.com')
    );
  } catch {
    return false;
  }
}

/* ── Field extraction (pure, testable) ────────────────────── */

/**
 * Extract a 2-letter Swiss canton code out of the `custom_filter_4` facet
 * value, formatted by the source as `"{CantonName} ({Code})"` (e.g.
 * `"Schwyz (SZ)"`, `"Luzern (LU)"`).
 *
 * @param {string[]} [customFilter4]
 * @returns {string} 2-letter uppercase canton code, or '' if not parseable.
 */
export function extractCantonCode(customFilter4 = []) {
  const first = Array.isArray(customFilter4) ? customFilter4[0] : '';
  const match = String(first || '').match(/\(([A-Z]{2})\)/);
  return match ? match[1] : '';
}

/**
 * Check whether a Typesense `country` facet array denotes Switzerland.
 * Defensive re-check: the scoped API key's own `backoffice_vanity:=ch`
 * filter already restricts results to the CH tenant, but this guards
 * against any record whose `country` value disagrees (cross-border /
 * mis-tagged posting) from ever being ingested as a Swiss job.
 *
 * @param {string[]} [countryArr]
 * @returns {boolean}
 */
export function isSwissCountryArray(countryArr = []) {
  if (!Array.isArray(countryArr)) return false;
  return countryArr.some((c) => /schweiz|switzerland|suisse|svizzera/i.test(String(c || '')));
}

/**
 * Resolve street/postalCode/city out of a Typesense offer document,
 * preferring the structured `location_objects[0]` fields (street/zip/city)
 * over regex-parsing the free-text `full_address[0]` string (e.g.
 * "Thorenbergstrasse 49, 6014 Luzern Littau").
 *
 * @param {Record<string, unknown>} document
 * @returns {{ street: string, postalCode: string, city: string }}
 */
export function parseHornbachLocation(document = {}) {
  const locObj = Array.isArray(document?.location_objects) ? document.location_objects[0] : null;
  if (locObj && typeof locObj === 'object') {
    const street = normalizeSpace(String(locObj.street || ''));
    const postalCode = normalizeSpace(String(locObj.zip || ''));
    const city = normalizeSpace(String(locObj.city || ''));
    if (street || postalCode || city) return { street, postalCode, city };
  }

  const fullAddress = Array.isArray(document?.full_address) ? document.full_address[0] : '';
  const match = String(fullAddress || '').match(/^(.*?),\s*(\d{4,5})\s+(.+)$/);
  if (match) {
    return {
      street: normalizeSpace(match[1]),
      postalCode: normalizeSpace(match[2]),
      city: normalizeSpace(match[3]),
    };
  }

  const location = Array.isArray(document?.location) ? document.location[0] : '';
  return { street: '', postalCode: '', city: normalizeSpace(String(location || '')) };
}

/**
 * Build the job description out of the (mostly-optional) rich-text sections
 * of a Typesense offer document. `introduction` is the primary content
 * field observed live; `description`/`expectation`/`offering`/`about`/
 * `additional`/`benefits`/`contact_text` are frequently empty strings and
 * are only appended when non-empty.
 *
 * @param {Record<string, unknown>} document
 * @returns {string}
 */
export function buildHornbachDescription(document = {}) {
  const sectionKeys = [
    'introduction', 'description', 'expectation', 'offering',
    'about', 'additional', 'benefits', 'contact_text',
  ];
  const parts = [];
  for (const key of sectionKeys) {
    const text = cleanText(document?.[key]);
    if (text && text.length > 3) parts.push(text);
  }
  const departments = Array.isArray(document?.department) ? document.department.filter(Boolean) : [];
  if (departments.length) parts.push(`Bereich: ${departments.join(', ')}`);
  return parts.join('\n\n');
}

/**
 * Resolve the ISO (YYYY-MM-DD) posted date out of a Typesense offer
 * document. Handles both an ISO-ish `create_date` string and a numeric
 * `create_date_timestamp` (seconds or milliseconds — disambiguated by
 * magnitude), falling back to today when neither parses.
 *
 * @param {Record<string, unknown>} document
 * @returns {string}
 */
export function resolveHornbachPostedDate(document = {}) {
  const raw = document?.create_date;
  if (raw) {
    const d = new Date(String(raw));
    if (!Number.isNaN(d.getTime())) return d.toISOString().split('T')[0];
  }
  const ts = document?.create_date_timestamp;
  if (typeof ts === 'number' && ts > 0) {
    const ms = ts > 1e12 ? ts : ts * 1000;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d.toISOString().split('T')[0];
  }
  return new Date().toISOString().split('T')[0];
}

/**
 * Resolve the schema.org `employmentType` value, preferring the source's
 * own typed `schema_values.working_time_types[0]` (already schema.org-
 * shaped, e.g. "FULL_TIME"/"PART_TIME") and falling back to the free-text
 * `schedule` facet (e.g. "Vollzeit"/"Teilzeit") via the shared
 * `normalizeContract` classifier.
 *
 * @param {Record<string, unknown>} document
 * @param {string} title
 * @param {string} description
 * @returns {{ employmentType: string, contract: string }}
 */
export function resolveHornbachEmploymentType(document = {}, title = '', description = '') {
  const typed = Array.isArray(document?.schema_values?.working_time_types)
    ? document.schema_values.working_time_types[0]
    : '';
  if (typed === 'FULL_TIME' || typed === 'PART_TIME') {
    return { employmentType: typed, contract: typed === 'PART_TIME' ? 'part-time' : 'full-time' };
  }
  const scheduleText = Array.isArray(document?.schedule) ? document.schedule.join(' ') : '';
  const contract = normalizeContract(scheduleText, title, description);
  return { employmentType: contract === 'part-time' ? 'PART_TIME' : 'FULL_TIME', contract };
}

/**
 * Parse a single raw Typesense `offers` document into the normalized field
 * set this crawler needs. Pure/synchronous and defensive against missing
 * fields, so it is fully unit-testable without any network access.
 *
 * @param {Record<string, unknown>} document
 * @returns {{
 *   externalId: string, title: string, titleSlug: string, url: string,
 *   applyUrl: string, description: string, city: string, postalCode: string,
 *   streetAddress: string, cantonCode: string, employmentType: string,
 *   contract: string, postedDate: string,
 * }}
 */
export function parseHornbachOffer(document = {}) {
  const title = cleanText(document?.title);
  const { street, postalCode, city } = parseHornbachLocation(document);
  const description = buildHornbachDescription(document);
  const { employmentType, contract } = resolveHornbachEmploymentType(document, title, description);
  const cantonCode = extractCantonCode(document?.custom_filter_4);
  const externalId = String(document?.external_id || document?.offer_uuid || '').trim();

  return {
    externalId,
    title,
    titleSlug: normalizeSpace(String(document?.title_slug || '')),
    url: normalizeSpace(String(document?.url || '')),
    applyUrl: normalizeSpace(String(document?.application_url || document?.url || '')),
    description,
    city,
    postalCode,
    streetAddress: street,
    cantonCode,
    employmentType,
    contract,
    postedDate: resolveHornbachPostedDate(document),
  };
}

/* ── Fetch + Assemble ──────────────────────────────────────── */

/**
 * Fetch the short-lived, scoped (search-only, tenant+vanity+status filter
 * baked in server-side) Typesense API key for the Hornbach CH tenant.
 *
 * @returns {Promise<string>}
 */
export async function fetchHornbachSearchApiKey() {
  const res = await fetchJson(API_KEY_URL, {
    method: 'GET',
    headers: { 'X-Tenant-Id': TENANT_ID },
  });
  const key = res?.key;
  if (!key || typeof key !== 'string') {
    throw new Error('Hornbach: no Typesense API key returned by job-shop search/api-key endpoint');
  }
  return key;
}

/**
 * Run the Typesense `multi_search` query against the `offers` collection
 * using the scoped API key, returning the raw hit documents.
 *
 * @param {string} apiKey
 * @param {number} [perPage]
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function fetchHornbachOfferDocuments(apiKey, perPage = 250) {
  const url = `${MULTI_SEARCH_URL}?x-typesense-api-key=${encodeURIComponent(apiKey)}`;
  const res = await fetchJson(url, {
    method: 'POST',
    body: {
      searches: [
        {
          collection: SEARCH_COLLECTION,
          q: '*',
          query_by: 'title',
          per_page: perPage,
          exclude_fields: 'title_embed',
        },
      ],
    },
  });
  const hits = res?.results?.[0]?.hits;
  if (!Array.isArray(hits)) return [];
  return hits.map((hit) => hit?.document).filter(Boolean);
}

/**
 * Fetch all Hornbach jobs (Switzerland only — the scoped API key's
 * `backoffice_vanity:=ch` filter already restricts to the CH tenant, and
 * `isSwissCountryArray` re-checks the `country` facet defensively).
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled by the
 * AI localization step and translate-pending pipeline.
 */
export async function fetchAllHornbachJobs() {
  console.log(`🔍 Fetching ${HORNBACH_COMPANY_NAME} jobs`);
  console.log(`   Source: ${MULTI_SEARCH_URL} (job-shop/TalentsConnect, Typesense "offers")\n`);

  let apiKey;
  try {
    apiKey = await fetchHornbachSearchApiKey();
  } catch (err) {
    console.warn(`⚠️ Hornbach API key fetch failed: ${err?.message || err}`);
    throw err;
  }

  let documents;
  try {
    documents = await fetchHornbachOfferDocuments(apiKey);
  } catch (err) {
    console.warn(`⚠️ Hornbach Typesense search failed: ${err?.message || err}`);
    throw err;
  }

  const swissDocuments = documents.filter((doc) => isSwissCountryArray(doc?.country));
  if (!swissDocuments.length) {
    console.warn('⚠️ No Switzerland-located openings parsed from Hornbach job-shop search.');
    return [];
  }
  console.log(`  📋 Switzerland listings found: ${swissDocuments.length}`);

  const jobs = [];
  const seen = new Set();

  for (const document of swissDocuments) {
    const parsed = parseHornbachOffer(document);
    if (!parsed.title || parsed.title.length < 3) continue;
    if (!parsed.url || seen.has(parsed.url)) continue;
    seen.add(parsed.url);

    const { city, postalCode, streetAddress } = resolveAddress({
      city: parsed.city,
      postalCode: parsed.postalCode,
      streetAddress: parsed.streetAddress,
    });
    const location = parsed.city || city;
    const canton = parsed.cantonCode || inferSwissTargetCanton(location) || inferSwissTargetCanton(city) || HQ.canton;

    const description = parsed.description || `${parsed.title} — ${HORNBACH_COMPANY_NAME} (${location}).`;
    const sourceLang = detectLang(description || parsed.title, 'de');
    const jobSlug = slugify(`${parsed.title} hornbach ${location}`);
    const urlHash = createHash('sha1').update(parsed.url).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `${HORNBACH_KEY}-${parsed.externalId || urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: HORNBACH_COMPANY_NAME,
      companyKey: HORNBACH_KEY,
      companyDomain: HORNBACH_COMPANY_DOMAIN,
      title: parsed.title,
      titleByLocale: { [sourceLang]: parsed.title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton,
      url: parsed.url,
      source: 'Hornbach Dedicated Parser (job-shop/Typesense)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: city || location,
      addressRegion: canton === HQ.canton ? HQ.region : canton,
      streetAddress,
      postalCode,
      addressCountry: 'CH',
      country: 'CH',
      category: guessCategory(parsed.title, description),
      contract: parsed.contract,
      employmentType: parsed.employmentType,
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate: parsed.postedDate,
      applyUrl: parsed.applyUrl || parsed.url,
      jobReqId: parsed.externalId || null,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total ${HORNBACH_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
