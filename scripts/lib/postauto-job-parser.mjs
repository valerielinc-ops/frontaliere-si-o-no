#!/usr/bin/env node
/**
 * PostAuto job parser — job.post.ch SuccessFactors NES platform, PostAuto brand.
 *
 * Source: https://www.postauto.ch/en/jobs-and-careers (public marketing page —
 * the actual job feed lives on the shared Swiss Post Group jobs platform,
 * not a standalone PostAuto ATS).
 *
 * PostAuto AG (PostBus Ltd) is Swiss Post's public-transport subsidiary — the
 * largest manufacturer-independent bus fleet operator in Switzerland (~2400
 * vehicles, 942 lines, 189 million passengers/year), running regional bus
 * routes across nearly every canton. Its legal registered office is
 * Wankdorfallee 4, 3030 Bern BE (confirmed via the company's own legal notice
 * at https://www.postauto.ch/en/pages/footer/publication-details, UID
 * CHE-112.242.941 — NOT Chur/Graubünden: "Gürtelstrasse 14, 7001/7003 Chur"
 * is only a regional operating branch for the Graubünden network, not the
 * registered HQ).
 *
 * ATS discovery: PostAuto is NOT on a standalone ATS. It shares the
 * SuccessFactors NES job platform used by the whole Post Group (Die
 * Schweizerische Post / PostFinance / PostAuto) at job.post.ch. The public
 * search widget calls `POST job.post.ch/services/recruiting/v1/jobs`
 * (confirmed live, no auth, no server-side brand filter — the endpoint always
 * returns the full national Post Group job list). Every record carries a
 * `cust_brandCompanyJobSearch` field tagging which Post Group brand posted
 * it; `"PostAuto"` isolates this employer from the "Die Schweizerische Post"
 * / "PostFinance" postings living in the same feed (verified live: 11
 * PostAuto records on the de_DE listing page alone).
 *
 * Detail-page HTML parsing (JobPosting JSON-LD / `.joblayouttoken` token
 * fallback) is fully delegated to the shared `postch-job-parser.mjs`
 * (`parsePostJobDetail` / `extractPostJobIdFromUrl`) — this parser only owns
 * PostAuto-specific concerns: brand filtering of the shared listing feed,
 * canton/city resolution across PostAuto's multi-canton regional network
 * (never defaulting to the Bern HQ when a job's real location resolves — the
 * same canton-gated pattern as the Yapeal/CERN dedicated crawlers),
 * category/employment-type detection, and slug/id construction. Structurally
 * mirrors the BLS AG dedicated crawler (also a multi-canton transport
 * operator using `inferAnyCanton`).
 *
 * IMPORTANT — do not widen `isPostAutoJob()` to match the bare `job.post.ch`
 * host: that host is SHARED with the separate `posta-svizzera-centro-regionale`
 * dedicated crawler (update-postch-jobs.mjs / postch-job-parser.mjs), which
 * also owns jobs on job.post.ch (Post + PostFinance postings). Matching the
 * bare host here would make `runStandardCrawlerPipeline`'s `isCompanyJob`
 * filter swallow those sibling jobs into this crawler's merge step and
 * delete them on the next run (they would not reappear in this crawler's
 * PostAuto-only fetch). Company scoping stays on `companyKey`/`company`
 * plus the PostAuto-exclusive `postauto.ch` marketing domain;
 * `isTrustedDomain()` (URL validation only, not company scoping) is the
 * function allowed to trust the shared `job.post.ch` detail host.
 *
 * Public detail URLs are job.post.ch/{brand}/job/{slug}/{id}-{locale}.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllPostAutoJobs() — Fetch and parse all PostAuto jobs
 *   - isPostAutoJob()        — Match jobs belonging to this company
 *   - isTrustedDomain()      — Validate URLs belong to this company
 *   - slugify() / stripHtml() — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferAnyCanton, normalizeCantonCode } from './target-swiss-locations.mjs';
import { parsePostJobDetail, extractPostJobIdFromUrl } from './postch-job-parser.mjs';
import { dedicatedPostOwner } from './crawler-company-ownership.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const POSTAUTO_KEY = 'postauto';
export const POSTAUTO_COMPANY_NAME = 'PostAuto AG';
export const POSTAUTO_COMPANY_DOMAIN = 'postauto.ch';

const CAREER_URL = 'https://www.postauto.ch/en/jobs-and-careers';

// Shared Post Group jobs API (job.post.ch) — same endpoint used by the
// posta-svizzera-centro-regionale crawler, but here we filter the returned
// records down to the PostAuto brand only (see module docblock).
const JOBS_API_URL = 'https://job.post.ch/services/recruiting/v1/jobs';
// Paginate every locale: the API only returns jobs translated to the
// requested locale, so it/fr/en-only PostAuto postings would be silently
// missed if we only scanned de_DE.
const JOBS_API_LISTING_LOCALES = ['de_DE', 'it_IT', 'fr_FR', 'en_US'];
const JOBS_API_MAX_PAGES = 100000; // uncapped — loop breaks on empty page / seen>=totalJobs
const JOBS_DETAIL_LOCALES = ['it_IT', 'de_DE', 'fr_FR', 'en_US']; // priority for description language

/* ── HQ fallback (Wankdorfallee 4, 3030 Bern, BE) ─────────────── */
/* Confirmed via https://www.postauto.ch/en/pages/footer/publication-details */
/* (own legal notice, UID CHE-112.242.941) — the registered legal HQ is in  */
/* Bern, NOT Chur/Graubünden (which only hosts a regional operating branch). */

const HQ = {
  city: 'Bern',
  canton: 'BE',
  postalCode: '3030',
  streetAddress: 'Wankdorfallee 4',
  region: 'BE',
};

const SECTOR = 'Trasporti pubblici / Autobus';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to PostAuto.
 * Used by the template to filter this company's jobs from the global dataset.
 *
 * Deliberately does NOT match on the shared `job.post.ch` host — see the
 * module docblock for why that would corrupt the sibling Post.ch crawler's
 * data on merge.
 */
export function isPostAutoJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === POSTAUTO_KEY ||
    key.startsWith('postauto') ||
    company.includes('postauto') ||
    url.includes('postauto.ch')
  );
}

/**
 * Validate that a URL belongs to PostAuto's marketing domain OR the shared
 * job.post.ch ATS host that actually serves the detail pages. This function
 * is URL-trust validation only (used for the SEO validation gate) — it is
 * NOT used for cross-crawler company scoping (see `isPostAutoJob` above).
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'postauto.ch' || host.endsWith('.postauto.ch')) return true;
    if (host === 'job.post.ch') return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(chauffeur|fahrer|autista|conducteur|conductrice|driver|lenker|fuhrer)/.test(t)) return 'Autisti / Conducenti';
  if (/\b(sicherheit|securit|sicurezza|security)/.test(t)) return 'Sicurezza';
  if (/\b(werkstatt|mecanic|meccanic|garage|unterhalt|manutenz|entretien)/.test(t)) return 'Tecnica / Officina';
  if (/\b(disposition|planif|pianific|einsatzleit|dispatch)/.test(t)) return 'Pianificazione trasporti';
  if (/\b(ingegner|engineer|entwickl|informat|software|develop|it\b)/.test(t)) return 'IT';
  if (/\b(admin|segret|contab|buchhalt|account)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|verkauf|commerce|kund|client|customer)/.test(t)) return 'Assistenza clienti';
  if (/\b(hr|human|risorse|personal|recruit)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ|controll)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht)/.test(t)) return 'Legale';
  if (/\b(lehre|apprendist|apprenti|lernend)/.test(t)) return 'Formazione';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stagiair|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|leiter|leiterin)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/* ── Address / canton resolution ──────────────────────────────
 * PostAuto runs regional bus networks across nearly every Swiss canton —
 * unlike a single-site employer, a job's location must be resolved to its
 * OWN canton (CH-wide via inferAnyCanton, mirroring the BLS AG dedicated
 * crawler), never defaulted to the Bern HQ just because the office is
 * unresolved. postalCode/streetAddress stay canton-gated to the HQ fallback
 * exactly like postalCode already was (yapeal-job-parser.mjs's resolveAddress
 * is the canonical reference for this pattern; do not regress to an
 * unconditional `|| HQ.streetAddress` — see fix commit for PR #3376 review).
 */
function resolveAddress(cityRaw = '', regionRaw = '') {
  const city = normalizeSpace(cityRaw);
  const regionCode = normalizeCantonCode(regionRaw || '');
  const canton = regionCode || (city ? inferAnyCanton(city) : '') || '';

  if (city && canton) {
    const isHqCity = /bern/i.test(city);
    return {
      city,
      canton,
      postalCode: isHqCity ? HQ.postalCode : '',
      streetAddress: isHqCity ? HQ.streetAddress : '',
      region: canton,
    };
  }

  // Unmapped/empty location → safe HQ fallback, never dropped.
  return {
    city: HQ.city,
    canton: HQ.canton,
    postalCode: HQ.postalCode,
    streetAddress: HQ.streetAddress,
    region: HQ.region,
  };
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

/**
 * POST one page against the shared Post Group jobs search endpoint.
 * @returns {Promise<{totalJobs:number, jobs:object[]}>}
 */
async function fetchJobsApiPage(locale, pageNumber, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(JOBS_API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Accept-Language': 'de-DE,de;q=0.9,it;q=0.8,fr;q=0.7',
        Origin: 'https://job.post.ch',
        Referer: 'https://job.post.ch/search/',
        'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT ||
          'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
      body: JSON.stringify({ locale, pageNumber, sortBy: 'date' }),
    });
    if (!res.ok) {
      console.warn(`⚠️ HTTP ${res.status} for jobs API (${locale} page ${pageNumber})`);
      return { totalJobs: 0, jobs: [] };
    }
    const data = await res.json();
    const jobs = Array.isArray(data?.jobSearchResult)
      ? data.jobSearchResult.map((r) => r?.response).filter(Boolean)
      : [];
    return { totalJobs: Number(data?.totalJobs ?? 0), jobs };
  } catch (err) {
    console.warn(`⚠️ Jobs API fetch failed (${locale} page ${pageNumber}): ${err.message}`);
    return { totalJobs: 0, jobs: [] };
  } finally {
    clearTimeout(timer);
  }
}

function decodeUrlSegment(value = '') {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

/**
 * Build the canonical SuccessFactors detail URL from a raw API record.
 */
function buildDetailUrl(record, locale = 'de_DE') {
  const brand = String(record?.brandUrl || 'default').trim() || 'default';
  const slug = decodeUrlSegment(record?.unifiedUrlTitle || record?.urlTitle || '');
  const id = String(record?.id || '').trim();
  if (!slug || !id) return '';
  return `https://job.post.ch/${brand}/job/${slug}/${id}-${locale}`;
}

/**
 * Check whether a raw API record's `cust_brandCompanyJobSearch` tags it as
 * a PostAuto posting (case-insensitive substring — see BRAND_MATCH note).
 */
export function isPostAutoRecord(record) {
  const brands = Array.isArray(record?.cust_brandCompanyJobSearch)
    ? record.cust_brandCompanyJobSearch
    : [];
  return brands.some((brand) => dedicatedPostOwner(brand) === POSTAUTO_KEY);
}

/**
 * Fetch every PostAuto-branded record from the shared Post Group jobs API.
 * Paginates each locale, deduplicates by record id, then filters down to
 * `cust_brandCompanyJobSearch` containing "PostAuto".
 */
async function fetchPostAutoListings(timeoutMs) {
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const byId = new Map();

  for (const apiLocale of JOBS_API_LISTING_LOCALES) {
    let pageNumber = 0;
    let totalJobs = Infinity;
    let seen = 0;
    while (seen < totalJobs && pageNumber < JOBS_API_MAX_PAGES) {
      const { totalJobs: total, jobs } = await fetchJobsApiPage(apiLocale, pageNumber, timeoutMs);
      if (jobs.length === 0) break;
      for (const record of jobs) {
        const id = String(record?.id || '').trim();
        if (!id || byId.has(id)) continue;
        if (isPostAutoRecord(record)) byId.set(id, record);
      }
      seen += jobs.length;
      totalJobs = total;
      pageNumber += 1;
      await delay(250);
    }
    console.log(`     ${apiLocale}: scanned ${seen} record(s) (claimed total: ${Number.isFinite(totalJobs) ? totalJobs : 'unknown'})`);
  }

  return [...byId.values()];
}

/**
 * Fetch all PostAuto jobs (CH-wide, all cantons its regional network covers).
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllPostAutoJobs() {
  console.log(`🔍 Fetching ${POSTAUTO_COMPANY_NAME} jobs`);
  console.log(`   Source: ${JOBS_API_URL} (brand="PostAuto", shared Post Group platform)\n`);

  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;

  const records = await fetchPostAutoListings(timeoutMs);
  console.log(`  📋 PostAuto-branded records found: ${records.length}`);

  if (records.length === 0) {
    console.warn('⚠️ No PostAuto job listings returned.');
    return [];
  }

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const jobs = [];
  const seen = new Set();

  for (const record of records) {
    const supported = new Set(
      (Array.isArray(record.supportedLocales) ? record.supportedLocales : [])
        .map((l) => String(l || '').trim())
    );
    const orderedLocales = [
      ...JOBS_DETAIL_LOCALES.filter((l) => supported.has(l)),
      ...JOBS_DETAIL_LOCALES.filter((l) => !supported.has(l)),
    ];

    let detail = null;
    let sourceUrl = '';
    for (const locale of orderedLocales) {
      const url = buildDetailUrl(record, locale);
      if (!url) continue;
      const res = await fetch(url, {
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT ||
            'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
        },
      }).catch(() => null);
      await delay(300);
      if (!res || !res.ok) continue;
      const html = await res.text().catch(() => '');
      if (!html) continue;
      const parsed = parsePostJobDetail(html, url);
      const looksLikePlaceholder = /^stellendetails$/i.test(String(parsed?.title || '').trim());
      const hasBody = (parsed?.description || '').length > 80;
      if (parsed?.title && !looksLikePlaceholder && hasBody) {
        detail = parsed;
        sourceUrl = url;
        break;
      }
    }

    if (!detail || !detail.title) {
      console.warn(`  ⚠️ Could not parse detail for job ${record.id}`);
      continue;
    }
    if (seen.has(sourceUrl)) continue;
    seen.add(sourceUrl);

    const title = normalizeSpace(detail.title);
    if (!title || title.length < 3) continue;

    const { city, canton, postalCode, streetAddress, region } = resolveAddress(detail.city, detail.region);
    const location = normalizeSpace(city || HQ.city);

    const descriptionText = detail.description || '';
    const description = descriptionText || `${title} bei ${POSTAUTO_COMPANY_NAME} in ${location}.`;
    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} postauto ${location}`);
    const urlHash = createHash('sha1').update(sourceUrl).digest('hex').slice(0, 12);
    const employmentType = detectEmploymentType(detail.employmentType || title);
    const postedDate = detail.datePosted || new Date().toISOString().split('T')[0];

    const job = {
      // ── Required fields ──
      id: `${POSTAUTO_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: POSTAUTO_COMPANY_NAME,
      companyKey: POSTAUTO_KEY,
      companyDomain: POSTAUTO_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton,
      url: sourceUrl,
      source: 'PostAuto Dedicated Parser (job.post.ch, brand=PostAuto)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: city || location,
      addressRegion: region || canton,
      streetAddress,
      postalCode,
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
      ...(detail.validThrough ? { validThrough: detail.validThrough } : {}),
      ...(detail.workload ? { pensum: detail.workload } : {}),
      applyUrl: sourceUrl,
      jobReqId: record.id || null,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
    console.log(`     ✅ ${title} — ${location} (${canton})`);
  }

  console.log(`\n📋 Total ${POSTAUTO_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

// Re-export shared helpers so callers don't need a second import line.
export { slugify, stripHtml, extractPostJobIdFromUrl };
export const CAREER_URL_EXPORT = CAREER_URL;
