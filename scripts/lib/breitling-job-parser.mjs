#!/usr/bin/env node
/**
 * Breitling SA job parser — SAP SuccessFactors "Unify" (Jobs2Web)
 * client-rendered career portal.
 *
 * Breitling SA is a Swiss luxury watchmaker headquartered in
 * Grenchen (SO) since 1884. Career portal: https://careers.breitling.com/
 *
 * ATS discovery note: the tracking table listed the ATS as "n.d."
 * (not determined). Live discovery found a SAP SuccessFactors
 * Recruiting Marketing ("Jobs2Web") site running the newer "Unify"
 * template — distinct in shape from BOTH other SuccessFactors
 * flavors already in this codebase:
 *   - the "html-jobreq" CSB flavor (server-rendered `/search/?startrow=`
 *     HTML tables) used by successfactors-shared-job-parser-common.mjs
 *   - the "RMK" JSON-REST-with-publishable-key flavor used by Geberit
 * Unify instead exposes an undocumented client-side JSON search API
 * on the tenant's own vanity host (found by reading the minified
 * front-end bundle j2w.searchResultsUnify.min.js /
 * j2w.searchManager.min.js):
 *   POST https://careers.breitling.com/services/recruiting/v1/jobs
 *   Content-Type: application/json
 *   body: { keywords, locale, location, pageNumber, sortBy: "recent" }
 * `location: "Switzerland"` narrows results server-side to the CH
 * subset (verified: 19 records vs. 55 global, across 2 pages of 10).
 * Response shape: { jobSearchResult: [{ response: {...} }], totalJobs }.
 *
 * Detail page URL is ID-driven, NOT the raw `unifiedUrlTitle`/`urlTitle`
 * slug: the front-end href-builder is literally
 *   "/job/" + (unifiedStandardTitle || "untitled") + "/" + id + "-" + locale
 * (hyphen-joined `{id}-{locale}` suffix, NO trailing slash — the sibling
 * CSB flavor's `/job/{slug}/{jobId}/` trailing-slash pattern returns an
 * empty SPA shell here). Verified empirically that only the `{id}-{locale}`
 * suffix drives routing (a nonsense title text still resolves correctly),
 * so this parser builds the path segment via the shared `slugify()`
 * helper rather than replicating the site's own encoding.
 *
 * Detail pages are server-rendered with PARTIAL schema.org JobPosting
 * microdata — only `itemprop="title"` and `itemprop="description"`
 * are present (no date/location/employer microdata). Crucially the
 * description is split across THREE separate
 * `<span itemprop="description">` blocks (intro/mission, contribution
 * & requirements, employer info) that must all be concatenated —
 * extracting only the first match (as the sibling CSB factory's
 * single-match `readItempropBlock` does) would silently drop ~70% of
 * the content. This shape mismatch is why this parser is self-contained
 * rather than reusing `createSuccessFactorsParser()`.
 *
 * All 19 CH search hits use `supportedLocales: ['en_GB']` (source
 * language English), including one French-titled posting
 * ("Spécialiste Payroll") — detectLang() is applied per-job as a
 * safety net. One hit (id 540, "Talent Pool #Squadonamission") is a
 * generic multi-location talent-pool placeholder, not a real opening,
 * and is skipped (same convention as other dedicated crawlers'
 * spontaneous-application placeholders).
 *
 * Location data quality gap: the Zurich boutique's `jobLocationShort`
 * literally has the CANTON CODE ("ZH") in the city field (e.g.
 * "ZH, CHE, 8002"), not a city name — a small canton→city fallback
 * table handles the cantons actually seen (ZH, SO, BE, GE, NE).
 * `postalCode`/`streetAddress` are left empty (safe default, no
 * fabrication) for locations where the source genuinely omits them
 * (e.g. the Bern boutique) except for Grenchen HQ, where the real
 * verified street address is used as a fallback.
 *
 * Exports 4 functions required by the crawler template:
 * - fetchAllBreitlingJobs() — Fetch and parse all Swiss jobs
 * - isBreitlingJob() — Match jobs belonging to this company
 * - isTrustedDomain() — Validate URLs belong to this company
 * - slugify() / stripHtml() — Re-exported from crawler-template.mjs
 * Plus parseLocation(), exported for direct unit testing of the
 * jobLocationShort parsing contract (see tests/breitling-crawler.test.ts).
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton, normalizeCantonCode } from './target-swiss-locations.mjs';
import { fetchHtml, decodeEntities, normalizeSpace as normalizeSpaceRaw } from './hospital-custom-html-helpers.mjs';

export const BREITLING_KEY = 'breitling';
export const BREITLING_COMPANY_NAME = 'Breitling';
export const BREITLING_COMPANY_DOMAIN = 'breitling.com';

const CAREER_URL = 'https://careers.breitling.com/';
const SEARCH_API_URL = 'https://careers.breitling.com/services/recruiting/v1/jobs';
const LOCALE = 'en_GB';
const PAGE_SIZE = 10;

const SECTOR = 'Orologeria di lusso (manifattura svizzera)';

// Verified real HQ address (Léon Breitling-Strasse 2, 2540 Grenchen) —
// used ONLY as a fallback for Grenchen postings that omit the postal
// code/street in the source data. Never applied to other cities.
const HQ = {
  city: 'Grenchen',
  canton: 'SO',
  postalCode: '2540',
  streetAddress: 'Léon Breitling-Strasse 2',
  region: 'Solothurn',
};

// Data-quality fallback: the Zurich record's "city" field is literally
// the canton code, not a place name. Keyed on canton code, only for
// cantons actually observed in Breitling's CH listings.
const CANTON_CITY_FALLBACK = {
  ZH: 'Zürich',
  BE: 'Bern',
  GE: 'Genève',
  SO: 'Grenchen',
  NE: 'La Chaux-de-Fonds',
};

const MIN_DESCRIPTION_WORDS = 30;

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return normalizeSpaceRaw ? normalizeSpaceRaw(s) : String(s || '').replace(/\s+/g, ' ').trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Breitling. Used by the template to
 * filter this company's jobs out of the global dataset.
 *
 * NOTE (collision guard): Bucherer (a Swiss watch/jewellery
 * RETAILER) sells Breitling watches and mentions the brand name in
 * its own boilerplate company-description text, but Bucherer's
 * parser always sets `company: 'Bucherer'` literally — never
 * 'Breitling' — so a `company` field match here cannot collide with
 * it. We deliberately do NOT match on free-text description content,
 * only on company/companyKey/url, to keep that guarantee intact.
 */
export function isBreitlingJob(job) {
  const key = normalize(job?.companyKey || '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  if (key === BREITLING_KEY) return true;
  if (company === 'breitling' || /\bbreitling\b/.test(company)) return true;
  if (url.includes('careers.breitling.com')) return true;

  try {
    const host = new URL(job?.url || '').hostname.toLowerCase();
    if (host === 'breitling.com' || host.endsWith('.breitling.com')) return true;
  } catch {
    // ignore invalid URL
  }

  return false;
}

/**
 * Validate that a URL belongs to Breitling's own domain (the ATS
 * lives on the tenant's own vanity host, not a shared ATS domain).
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'breitling.com' || host.endsWith('.breitling.com');
  } catch {
    return false;
  }
}

/* ── Category / Level / Employment Detection ──────────────────
 * (industry-aligned with the other luxury-watch dedicated crawlers,
 * e.g. omega-job-parser.mjs / richemont-job-parser.mjs) */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(sales associate|vendeur|vendeuse|client advisor|boutique|concierge|retail|flagship)/.test(t)) return 'Commerciale';
  if (/\b(hr specialist|hr business partner|human resources|payroll|risorse umane)/.test(t)) return 'Risorse Umane';
  if (/\b(watch production|lean manufacturing|production|manufactur|horlog|watchmak)/.test(t)) return 'Produzione';
  if (/\b(visual merchandising|social media|editor|editorial|publishing|creator strategy|content specialist|market|comunicaz)/.test(t)) return 'Marketing';
  if (/\b(engineer|ingegner|developer|it\b|software)/.test(t)) return 'IT';
  if (/\b(director|manager|head of)/.test(t)) return 'Management';
  return 'Commerciale';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|apprenti|apprenticeship|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stagiaire|trainee)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|head of|director|assistant boutique director)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(title = '') {
  const t = normalize(title);
  if (/\b(intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|apprenti|apprenticeship|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stagiaire)/.test(t)) return 'INTERN';
  if (/\btemporary\b/.test(t)) return 'TEMPORARY';
  const pct = t.match(/\((\d{1,3})\s*%\)/) || t.match(/(\d{1,3})\s*%/);
  if (pct) {
    const value = parseInt(pct[1], 10);
    if (value > 0 && value < 100) return 'PART_TIME';
  }
  return 'FULL_TIME';
}

/* ── Location Parsing ─────────────────────────────────────────
 * Breitling's search API returns `jobLocationShort` as an ARRAY of
 * strings like "Bern, BE, CHE, " or "ZH, CHE, 8002<br/>" (one entry
 * per posted location — real postings in the CH-filtered result set
 * only ever carry a single entry; only the excluded talent-pool
 * placeholder is multi-location). */

export function parseLocation(raw = '') {
  const cleaned = String(raw || '').replace(/<br\s*\/?>/gi, '').trim();
  const parts = cleaned.split(',').map((p) => p.trim());

  // The "CHE" country-code token's position tells apart the two shapes this
  // feed actually sends: the usual [city, canton, "CHE", postalCode?] (e.g.
  // "Bern, BE, CHE, ") vs. the Zurich-boutique canton-only form with NO city
  // token at all — [canton, "CHE", postalCode] (e.g. "ZH, CHE, 8002"). The
  // latter used to be misread as [city="ZH", canton="CHE"→invalid→HQ fallback
  // SO, postalCode=parts[3]→undefined], silently substituting Solothurn HQ
  // for a Zürich posting and dropping the real postal code.
  const cheIndex = parts.findIndex((p) => /^che$/i.test(p));
  const isCantonOnlyForm = cheIndex === 1;

  const cityRaw = isCantonOnlyForm ? '' : (parts[0] || '');
  const cantonRaw = isCantonOnlyForm ? (parts[0] || '') : (parts[1] || '');
  const postalRaw = (isCantonOnlyForm ? (parts[2] || '') : (parts[3] || '')).trim();

  // Validate against the real 26-canton registry — a well-formed-but-wrong
  // 2-letter token from the feed must not be trusted verbatim (AGENTS.md #6
  // sibling class shared with ghol/holcim/stadler-rail/spitex-ch).
  const canton = normalizeCantonCode(cantonRaw);
  const postalCode = /^\d{4}$/.test(postalRaw) ? postalRaw : '';

  const isBareCantonCode = !cityRaw
    || (!!normalizeCantonCode(cityRaw) && cityRaw.toUpperCase() === canton);
  const city = (!cityRaw || isBareCantonCode)
    ? (CANTON_CITY_FALLBACK[canton] || cityRaw || HQ.city)
    : cityRaw;

  return { city, canton: canton || HQ.canton, postalCode };
}

/**
 * Resolve postal code / street address, falling back to the
 * documented HQ address ONLY for Grenchen (never fabricated for
 * other cities where the source genuinely omits the field).
 */
function resolveAddress({ city, canton, postalCode }) {
  const isGrenchen = /grenchen/i.test(city) || canton === HQ.canton;
  return {
    city,
    canton,
    postalCode: postalCode || (isGrenchen ? HQ.postalCode : ''),
    streetAddress: isGrenchen ? HQ.streetAddress : '',
  };
}

function parseStandardStartDate(raw = '') {
  const m = String(raw || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return new Date().toISOString().split('T')[0];
  const [, dd, mm, yyyy] = m;
  return `${yyyy}-${mm}-${dd}`;
}

/* ── HTTP: search API (POST + retry) ──────────────────────────
 * Mirrors the retry-wrapped POST pattern used by geberit-job-parser.mjs
 * (postSearch), since the shared fetchHtml() helper is GET-only. */

async function postJobsSearch(body, { retries = 3 } = {}) {
  const baseDelay = Number(process.env.JOBS_CRAWLER_RETRY_BASE_MS) || 1000;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(SEARCH_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT
            || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(baseDelay * 2 ** attempt);
    }
  }
  throw lastErr;
}

/**
 * Fetch every CH job listing summary from the search API,
 * paginating until a page returns no new records.
 */
async function fetchJobListings() {
  const listings = [];
  const seenIds = new Set();
  let pageNumber = 0;

  for (;;) {
    const payload = await postJobsSearch({
      keywords: '',
      locale: LOCALE,
      location: 'Switzerland',
      pageNumber,
      sortBy: 'recent',
    });
    const results = Array.isArray(payload?.jobSearchResult) ? payload.jobSearchResult : [];
    if (results.length === 0) break;

    let newCount = 0;
    for (const entry of results) {
      const r = entry?.response || {};
      const id = String(r.id || '').trim();
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      newCount += 1;
      listings.push(r);
    }

    if (newCount === 0) break;
    pageNumber += 1;
    if (pageNumber > 50) break; // safety cap against infinite loop
  }

  return listings;
}

/**
 * Fetch a detail page and concatenate ALL `itemprop="description"`
 * blocks (the Unify template splits the description across three
 * separate spans — intro/mission, contribution, employer info — a
 * single-match extraction would silently drop most of the content).
 */
async function fetchJobDescription(url) {
  try {
    const html = await fetchHtml(url, { timeoutMs: 20000 });
    if (!html) return '';
    const blocks = [];
    const rx = /<span[^>]*itemprop="description"[^>]*>([\s\S]*?)<\/span>/gi;
    let m;
    while ((m = rx.exec(html)) !== null) {
      const text = normalizeSpace(decodeEntities(stripHtml(m[1] || '')));
      if (text) blocks.push(text);
    }
    return blocks.join('\n\n').trim();
  } catch (err) {
    console.warn(`⚠️ Breitling detail fetch failed for ${url}: ${err?.message || err}`);
    return '';
  }
}

/**
 * Fetch all Breitling jobs (Switzerland only). Returns an array of
 * ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step of the translate-pending pipeline.
 */
export async function fetchAllBreitlingJobs() {
  console.log(`🔍 Fetching ${BREITLING_COMPANY_NAME} jobs`);
  console.log(`   Source: ${SEARCH_API_URL} (location=Switzerland)\n`);

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }
  console.log(`   📋 Listings found: ${listings.length}`);

  const jobs = [];
  const seenUrls = new Set();

  for (const r of listings) {
    const id = String(r.id || '').trim();
    const title = normalizeSpace(decodeEntities(r.unifiedStandardTitle || ''));
    if (!id || !title || title.length < 3) continue;

    // Skip generic talent-pool / spontaneous-application placeholders.
    if (/^talent\s*pool\b/i.test(title) || /^(spontanbewerbung|initiativbewerbung|blindbewerbung)$/i.test(title)) {
      continue;
    }

    const rawLocations = Array.isArray(r.jobLocationShort) ? r.jobLocationShort : [];
    const parsedLoc = resolveAddress(parseLocation(rawLocations[0] || ''));
    const location = `${parsedLoc.city}, ${parsedLoc.canton}`;
    const canton = inferSwissTargetCanton(location) || parsedLoc.canton || HQ.canton;

    const slugPath = slugify(title);
    const publicUrl = `${CAREER_URL}job/${slugPath}/${id}-${LOCALE}`;
    if (seenUrls.has(publicUrl)) continue;
    seenUrls.add(publicUrl);

    let descriptionText = await fetchJobDescription(publicUrl);
    const wordCount = descriptionText ? descriptionText.split(/\s+/).filter(Boolean).length : 0;
    if (wordCount < MIN_DESCRIPTION_WORDS) {
      const fallback = `${title} presso ${BREITLING_COMPANY_NAME} a ${location}. Manifattura orologiera svizzera di lusso, sede storica a Grenchen dal 1884. Candidature tramite il portale carriere ufficiale.`;
      descriptionText = descriptionText ? `${descriptionText}\n\n${fallback}` : fallback;
    }

    const sourceLang = detectLang(descriptionText || title, 'en');
    const employmentType = detectEmploymentType(title);
    const postedDate = parseStandardStartDate(r.unifiedStandardStart);
    const currency = Array.isArray(r.currency) && r.currency[0] ? r.currency[0] : 'CHF';
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const jobSlug = slugify(`${title} breitling ${location}`);

    const job = {
      // ── Required fields ──
      id: `${BREITLING_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: BREITLING_COMPANY_NAME,
      companyKey: BREITLING_KEY,
      companyDomain: BREITLING_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      needsRetranslation: true,
      location,
      canton,
      url: publicUrl,
      source: 'Breitling Dedicated Parser (SuccessFactors Unify)',
      sourceLang,
      crawledAt: new Date().toISOString(),
      // ── Recommended fields ──
      addressLocality: parsedLoc.city,
      addressRegion: canton,
      streetAddress: parsedLoc.streetAddress,
      postalCode: parsedLoc.postalCode,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: SECTOR,
      currency,
      featured: false,
      postedDate,
      applyUrl: publicUrl,
      jobReqId: id,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total ${BREITLING_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
