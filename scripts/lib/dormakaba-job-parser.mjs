#!/usr/bin/env node
/**
 * dormakaba job parser — Fetcher and job builder.
 *
 * Source: https://jobs.dormakaba.com/search/
 *
 * ATS investigation (2026-07, issue #3337 backlog): the issue row listed
 * "Custom" as the ATS, which this codebase has flagged as historically wrong
 * for several companies in the backlog. Live headless-browser network trace
 * against jobs.dormakaba.com/search/ confirmed the branded frontend is a
 * SAP SuccessFactors "Career Site Builder" (CSB) React SPA that POSTs to the
 * SAME public Azure-Search-backed REST API used by the existing Geberit
 * parser (`scripts/lib/geberit-job-parser.mjs`) — and 13 other dedicated
 * crawlers in this repo (cler, thermo-fisher-scientific, hirslanden, avaloq,
 * jumbo, casale, lastminute, axpo, transgourmet, lafonte, migros-hq, smg,
 * interdiscount, givaudan) — at `production.api.recruiting-solutions.org`.
 * Request captured live:
 *   POST https://production.api.recruiting-solutions.org/search
 *   x-api-key: pk_doka-prod_… (publishable frontend key, shipped in plain JS)
 *   customerid: doka-prod
 * This module follows the same fetch/parse shape as geberit-job-parser.mjs
 * (the established convention for this CSB flavor — each tenant gets its own
 * file since the JSON field shape and available metadata differ slightly per
 * tenant, e.g. dormakaba exposes `legalEntity`/`jobFunctionLabel`/`jobLevelLabel`
 * that Geberit's tenant does not surface the same way).
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllDormakabaJobs() — Fetch and parse all jobs
 *   - isDormakabaJob()        — Match jobs belonging to this company
 *   - isTrustedDomain()       — Validate URLs belong to this company
 *   - resolveAddress()        — City-gated (never canton-only) HQ/office
 *                               street+postal fallback for structured data
 */
import { slugify, stripHtml } from './crawler-template.mjs';
import { getCantonForLocation } from './crawler-location-config.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const DORMAKABA_KEY = 'dormakaba';
export const DORMAKABA_COMPANY_NAME = 'dormakaba';
export const DORMAKABA_COMPANY_DOMAIN = 'dormakaba.com';

const CAREER_URL = 'https://jobs.dormakaba.com/search/';

// Group HQ fallback (Rümlang, ZH) — per issue #3337 row + verified via the
// company's own location page (dormakaba.com/ch-de/ruemlang: "Hofwisenstrasse
// 24, 8153 Rümlang") and Zefix (Swiss commercial registry): dormakaba Holding
// AG / dormakaba International Holding AG / dormakaba Finance AG all carry
// legal seat "Rümlang". Used only when a job has no resolvable city at all.
const HQ = {
  city: 'Rümlang',
  canton: 'ZH',
  postalCode: '8153',
  addressRegion: 'ZH',
};

const SECTOR = 'Sicurezza / Controllo accessi (hardware per porte e sistemi di accesso)';

// Posting host of the branded SuccessFactors CSB tenant.
const ATS_HOST = 'jobs.dormakaba.com';

/**
 * Known dormakaba Swiss office addresses, keyed by legal entity for clarity.
 * Both were verified against independent primary/registry sources (NOT
 * guessed) — see the source note on each entry.
 */
const KNOWN_OFFICES = {
  // dormakaba group HQ. Source: dormakaba.com/ch-de/ruemlang location page
  // ("Hofwisenstrasse 24, 8153 Rümlang") + Zefix legal-seat lookup for
  // dormakaba Holding AG / dormakaba International Holding AG / dormakaba
  // Finance AG (all "Rümlang").
  ruemlang: { streetAddress: 'Hofwisenstrasse 24', postalCode: '8153', canton: 'ZH' },
  // dormakaba Schweiz AG — the actual Swiss operating subsidiary and the
  // `legalEntity` on most CH job postings. Source: Zefix legal seat
  // ("Wetzikon (ZH)") + Moneyhouse registered-office record ("Mühlebühlstrasse
  // 23, Kempten, 8623 Wetzikon ZH").
  wetzikon: { streetAddress: 'Mühlebühlstrasse 23', postalCode: '8623', canton: 'ZH' },
};

// Safe canton-level postal fallbacks for Swiss cities that appear in job
// addresses but have no verified dormakaba office street — never invent a
// street number we haven't confirmed (Non-Negotiable #3: safe default, not
// removal of the postalCode/streetAddress check).
const CANTON_POSTAL_FALLBACK = {
  SG: '9000',
  VD: '1000',
  ZH: '8000',
};

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * Resolve a known dormakaba Swiss office address for a free-text city string.
 *
 * City-gated via regex (NEVER canton-only equality) so a job merely tagged
 * with canton ZH (e.g. any other Zürich-area city) never inherits Rümlang's
 * or Wetzikon's exact street by mistake — only an actual match on the city
 * name itself unlocks the verified street address.
 *
 * Returns `null` when the city isn't one of the two verified offices; callers
 * should fall back to {@link CANTON_POSTAL_FALLBACK} / {@link HQ} for a safe
 * generic postal code without fabricating a street.
 *
 * @param {string} city - free-text city, e.g. "Rümlang", "Wetzikon".
 * @returns {{streetAddress: string, postalCode: string, canton: string}|null}
 */
export function resolveAddress(city = '') {
  const c = String(city || '');
  if (/r[üu]mlang/i.test(c)) return { ...KNOWN_OFFICES.ruemlang };
  if (/wetzikon/i.test(c)) return { ...KNOWN_OFFICES.wetzikon };
  return null;
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to dormakaba.
 * Used by the template to filter this company's jobs from the global dataset.
 *
 * IMPORTANT: LEGIC Identsystems AG jobs (a genuinely separate legal entity —
 * confirmed via the API's own `legalEntity`/`brandName: 'Legic'` fields, and
 * excluded by dormakaba's own public career site by default) must NOT match
 * here even though they share the same ATS instance and appear in the same
 * search index.
 */
export function isDormakabaJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');
  const legalEntity = normalize(job?.legalEntity || '');

  if (legalEntity.includes('legic')) return false;

  return (
    key === DORMAKABA_KEY ||
    key.startsWith('dormakaba') ||
    company.includes('dormakaba') ||
    url.includes('dormakaba.com')
  );
}

/**
 * Validate that a URL belongs to dormakaba's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === DORMAKABA_COMPANY_DOMAIN || host.endsWith(`.${DORMAKABA_COMPANY_DOMAIN}`)) return true;
    if (host === ATS_HOST) return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '', jobFunctionLabel = '') {
  const t = normalize(`${title} ${jobFunctionLabel}`);
  if (/\b(service|installation|montage|techni|tecnic|elektr|install)/.test(t)) return 'Tecnica';
  if (/\b(ingegner|engineer|entwickl|r&d|product development)/.test(t)) return 'Ingegneria';
  if (/\b(admin|segret|contab|buchhalt|account)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|verkauf|commerce|vente)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse)/.test(t)) return 'Logistica';
  if (/\b(produz|operat|operator|manufactur)/.test(t)) return 'Produzione';
  if (/\b(qualit|qa|qc|quality)/.test(t)) return 'Qualità';
  if (/\b(it|software|develop|programm)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ|controller)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht)/.test(t)) return 'Legale';
  return 'Altro';
}

/** Map dormakaba's own `jobLevelLabel` (or fall back to a title heuristic). */
function detectExperienceLevel(title = '', jobLevelLabel = '') {
  const lvl = normalize(jobLevelLabel);
  if (lvl === 'leadership') return 'senior';
  if (lvl === 'professional') return 'mid';
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/* ── SuccessFactors Career Site Builder JSON API ───────────────
 * Same Azure-Search-backed public API used by the Geberit tenant (see the
 * module docblock). One POST returns the FULL job records — rich HTML
 * description + per-office address list + legal entity + job type/level —
 * for an OData filter, so we query Swiss jobs directly: no headless render,
 * no per-job detail fetch.
 */

const SEARCH_API_URL = 'https://production.api.recruiting-solutions.org/search';
// Publishable (pk_) frontend key — the SPA ships it in plain JS; not a secret.
const SEARCH_API_KEY =
  'pk_doka-prod_LZpDqxaqHBUGmkJWGzFLjSvYJUfJUMEXAkOpPdrqZpPryrHcfwufFxgqXPKnPxUyihhbvWramTqgqXgAOhzPMMJPsQbtNiLO';
const SEARCH_CUSTOMER_ID = 'doka-prod';
// The `country` field is stored TRANSLATED per record locale (unlike Geberit's
// tenant, which stores a single fixed German label regardless of record
// language) — confirmed live: the SAME physical job (jobId "11691-*") carries
// country "Switzerland" in its en_US/cs_CZ record, "Schweiz" in de_DE,
// "Suisse" in fr_FR, "Svizzera" in it_IT. Match every localized Swiss label
// so no locale variant of a Swiss posting is missed.
const SWISS_COUNTRY_LABELS = ['Switzerland', 'Schweiz', 'Suisse', 'Svizzera', 'Sveits', 'Zwitserland', '瑞士'];
const SWISS_FILTER = SWISS_COUNTRY_LABELS
  .map((label) => `addresses/any(a: a/country eq '${label}')`)
  .join(' or ');
const PAGE_SIZE = 100;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Map a SuccessFactors locale code (de_DE, en_US, fr_FR, it_IT, …) → our 2-letter locale. */
function localeToLang(code = '') {
  const lc = String(code || '').slice(0, 2).toLowerCase();
  return ['it', 'de', 'fr', 'en'].includes(lc) ? lc : 'de';
}

/**
 * Convert the CSB description HTML into markdown so heading/list structure
 * survives (the parser-quality audit flags flat prose with no bullets).
 * Falls back to a plain-text strip for anything else.
 */
function htmlToMarkdown(html = '') {
  let s = String(html || '');
  s = s.replace(/<\s*(h[1-6])[^>]*>([\s\S]*?)<\/\s*\1\s*>/gi, (_m, _t, inner) => `\n\n## ${stripHtml(inner).trim()}\n`);
  s = s.replace(/<\s*li[^>]*>([\s\S]*?)<\/\s*li\s*>/gi, (_m, inner) => `\n- ${stripHtml(inner).trim()}`);
  s = s.replace(/<\s*\/\s*(p|div|ul|ol)\s*>/gi, '\n');
  s = s.replace(/<\s*br\s*\/?\s*>/gi, '\n');
  s = stripHtml(s);
  s = s.replace(/&#13;/g, '').replace(/ /g, ' ');
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ');
  return s.trim();
}

/** POST the search API with transient retry. Returns the parsed JSON or throws. */
async function postSearch(body, { retries = 3 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(SEARCH_API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json;charset=UTF-8',
          'x-api-key': SEARCH_API_KEY,
          customerid: SEARCH_CUSTOMER_ID,
          privatejobboard: 'false',
          internal: 'false',
          'User-Agent': UA,
          Referer: CAREER_URL,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} from search API`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        const baseMs = Number(process.env.JOBS_CRAWLER_RETRY_BASE_MS ?? 1000);
        await new Promise((r) => setTimeout(r, baseMs * 2 ** attempt));
      }
    }
  }
  throw lastErr;
}

/** Fetch every Swiss dormakaba job record (with full description) from the CSB API. */
async function fetchSwissJobRecords() {
  const collected = [];
  let skip = 0;
  let total = Infinity;
  // Hard cap to avoid a runaway loop if the API ignores skip.
  for (let page = 0; page < 50 && skip < total; page++) {
    const data = await postSearch({
      count: true,
      facets: [],
      search: '*',
      filter: SWISS_FILTER,
      skip,
      top: PAGE_SIZE,
    });
    if (page === 0) total = Number(data?.['@odata.count'] ?? 0);
    const value = Array.isArray(data?.value) ? data.value : [];
    if (value.length === 0) break;
    collected.push(...value);
    skip += value.length;
    if (collected.length >= total) break;
  }
  return collected;
}

/**
 * Pick the "authored" record among a physical job's per-locale variants.
 * The API returns a machine-translated copy of a job for EVERY supported
 * locale, but only `defaultLanguage` (== the language where `activeLocales`
 * originates) is human-authored; the rest can carry an untranslated title or
 * lower-quality MT body. Prefer the record whose `language` matches its own
 * `defaultLanguage`; fall back to a de > it > fr > en rank otherwise.
 */
function pickAuthoredRecord(records) {
  const authored = records.find((r) => r.language === r.defaultLanguage);
  if (authored) return authored;
  const LANG_RANK = { de: 0, it: 1, fr: 2, en: 3 };
  return [...records].sort(
    (a, b) => (LANG_RANK[localeToLang(a.language)] ?? 9) - (LANG_RANK[localeToLang(b.language)] ?? 9),
  )[0];
}

/**
 * Fetch all dormakaba jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllDormakabaJobs() {
  console.log(`🔍 Fetching dormakaba (Switzerland) jobs`);
  console.log(`   Source: SAP SuccessFactors CSB search API (filter: Swiss addresses)\n`);

  let records;
  try {
    records = await fetchSwissJobRecords();
  } catch (err) {
    console.error(`❌ Failed to fetch dormakaba jobs from CSB API: ${err?.message || err}`);
    return [];
  }
  console.log(`  📋 Swiss job records returned: ${records.length}`);

  // Group per-locale variants by internal id (jobId = "<internalId>-<locale>").
  const byInternal = new Map();
  for (const rec of records) {
    const internalId = String(rec.jobId || '').split('-')[0];
    if (!internalId) continue;
    if (!byInternal.has(internalId)) byInternal.set(internalId, []);
    byInternal.get(internalId).push(rec);
  }

  const jobs = [];

  for (const [internalId, variants] of byInternal) {
    const rec = pickAuthoredRecord(variants);
    const title = normalizeSpace(rec.title || '');
    if (!title || title.length < 3) continue;

    // LEGIC Identsystems AG is a separate legal entity sharing this ATS
    // instance — never emit it as a dormakaba job (see isDormakabaJob docblock).
    const legalEntity = normalizeSpace(rec.legalEntity || '');
    if (normalize(legalEntity).includes('legic') || normalize(rec.brandName || '').includes('legic')) continue;

    const addrs = Array.isArray(rec.addresses) ? rec.addresses : [];
    const addr = addrs.find((a) => a && a.isPrimary) || addrs[0] || {};
    const location = normalizeSpace(addr.city || HQ.city);

    const resolved = resolveAddress(location);
    const canton = resolved?.canton || getCantonForLocation(location) || HQ.canton;
    const postalCode = resolved?.postalCode
      || (location === HQ.city ? HQ.postalCode : CANTON_POSTAL_FALLBACK[canton])
      || HQ.postalCode;
    const streetAddress = resolved?.streetAddress
      || (location === HQ.city ? KNOWN_OFFICES.ruemlang.streetAddress : undefined);

    const description = htmlToMarkdown(rec.description || '');
    if (!description || description.length < 30) continue; // skip empties → never synthesise

    const sourceLang = localeToLang(rec.language);
    const jobSlug = slugify(`${title} dormakaba ch`);
    const id = `dormakaba-${internalId}`;

    const publicUrl = rec.link && /^https?:\/\//i.test(rec.link)
      ? rec.link
      : `https://${ATS_HOST}/job-invite/${internalId}/?locale=${rec.language || 'de_DE'}`;

    const postedDate = String(rec.datePosted || '').slice(0, 10) ||
      new Date().toISOString().split('T')[0];

    const empType = rec.jobTypeLabel === 'Full-Time'
      ? 'FULL_TIME'
      : rec.jobTypeLabel === 'Part-Time'
        ? 'PART_TIME'
        : detectEmploymentType(`${title} ${rec.jobTypeLabel || ''}`);

    const job = {
      // ── Required fields ──
      id,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: DORMAKABA_COMPANY_NAME,
      companyKey: DORMAKABA_KEY,
      companyDomain: DORMAKABA_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton,
      url: publicUrl,
      source: 'dormakaba Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: location,
      postalCode,
      streetAddress,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title, rec.jobFunctionLabel),
      department: rec.jobFunctionLabel || undefined,
      employmentType: empType,
      experienceLevel: detectExperienceLevel(title, rec.jobLevelLabel),
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: publicUrl,
      legalEntity: legalEntity || undefined,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total dormakaba (CH) jobs discovered: ${jobs.length}`);
  return jobs;
}
