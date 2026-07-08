#!/usr/bin/env node
/**
 * Migros HQ Zürich job parser — jobs.migros.ch Nuxt SSR search consumer.
 *
 * Source: https://jobs.migros.ch/en/our-companies/migros-group/vacancies?page=N
 *
 * NOTE: the SmartRecruiters tenant this parser used to hit
 * (api.smartrecruiters.com/v1/companies/Migros) does not exist — it returns
 * `totalFound: 0` for every query (confirmed live). Migros Group's real
 * public career site is jobs.migros.ch, a Nuxt 3 app whose search-results
 * page embeds the full first-page result set (title, location, brand,
 * employment type, detail link) as a `__NUXT_DATA__` JSON payload directly
 * in the server-rendered HTML — no separate API call needed for listings,
 * just `?page=N` pagination. `total` in that payload matches the site's own
 * displayed "NNNN vacancies" count.
 *
 * The `__NUXT_DATA__` payload uses Nuxt/devalue's flattened array format:
 * every object/array value is stored as an index into one shared top-level
 * array, so extracting a subtree means recursively dereferencing indices
 * (see `resolveNuxtRef` below) rather than reading the JSON directly.
 *
 * Detail-page descriptions are enriched via the existing
 * `extractMigrosStructuredData()` helper in the sibling `migros-job-parser.mjs`
 * module (already built for this exact site's `<section id="overview/tasks/
 * skills/benefits/recruitment">` markup, used elsewhere to enrich Migros
 * postings discovered through the generic aggregator pipeline) — reused
 * read-only here rather than re-implemented, per the "prefer an existing
 * shared parser over bespoke code" convention. That module itself is NOT
 * modified.
 *
 * NOTE: 'Migros HQ Zürich' is a legacy name for this crawler; jobs.migros.ch
 * itself is a nationwide Migros Group career site (Migros Industrie,
 * Migros-Genossenschafts-Bund, Denner, Migros Bank, Galaxus, etc. — every
 * brand shown in each listing's `brand` field), so postings are kept
 * nationwide (any Swiss canton), not restricted to Zürich.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllMigrosHqJobs()  — Fetch and parse all jobs
 *   - isMigrosHqJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()       — Validate URLs belong to this company
 *   - slugify() / stripHtml() — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchHtml } from './crawler-template.mjs';
import { inferAnyCanton } from './target-swiss-locations.mjs';
import { extractMigrosStructuredData } from './migros-job-parser.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const MIGROS_HQ_KEY = 'migros-hq';
export const MIGROS_HQ_COMPANY_NAME = 'Migros HQ Zürich';
export const MIGROS_HQ_COMPANY_DOMAIN = 'migros.ch';

const CAREER_HOST = 'jobs.migros.ch';
const LISTING_URL = `https://${CAREER_HOST}/en/our-companies/migros-group/vacancies`;
const MAX_PAGES = 60; // safety cap; ~1200 postings / ~32 per page ≈ 38 pages expected
const DETAIL_CONCURRENCY = Number(process.env.JOBS_CRAWLER_DETAIL_CONCURRENCY) || 5;
const DETAIL_DELAY_MS = Number(process.env.JOBS_CRAWLER_DETAIL_DELAY_MS) || 150;

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Migros HQ Zürich.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isMigrosHqJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === MIGROS_HQ_KEY ||
    key.startsWith('migros-hq') ||
    company.includes('migros hq') ||
    url.includes('migros.ch') ||
    url.includes('migros.com')
  );
}

/**
 * Validate that a URL belongs to Migros HQ Zürich's domain.
 * Migros HQ is published via the Migros Group career site (jobs.migros.ch).
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'migros.ch' || host.endsWith('.migros.ch');
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(ingegner|engineer|entwickl)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mecanic|elektr|install)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|verkauf|commerce|filialleit|verkäufer)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse|chauffeur|fahrer)/.test(t)) return 'Logistica';
  if (/\b(produz|operat|operator|manufactur)/.test(t)) return 'Produzione';
  if (/\b(qualit|qa|qc|quality)/.test(t)) return 'Qualità';
  if (/\b(it|software|develop|programm)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht)/.test(t)) return 'Legale';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
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

/**
 * Prefer the real workload percentage (e.g. "80-100%") scraped from the
 * detail page over a keyword guess from the title — much more accurate.
 */
function classifyEmploymentType(workPercentage, title) {
  const nums = String(workPercentage || '').match(/\d+/g)?.map(Number) || [];
  if (nums.length) {
    const max = Math.max(...nums);
    return max >= 90 ? 'FULL_TIME' : 'PART_TIME';
  }
  return detectEmploymentType(title);
}

/* ── Location Disambiguation ───────────────────────────────── */

/**
 * Migros posts jobs in 600+ distinct, mostly small, Swiss municipalities —
 * far beyond target-swiss-locations.mjs's curated gazetteer (which is built
 * for the frontalieri target-region use case, not an exhaustive nationwide
 * city list). inferAnyCanton() correctly refuses to guess for both "not in
 * the gazetteer" and "genuinely ambiguous across cantons" cases, so a first
 * real run of this nationwide crawl silently dropped ~110 genuinely-Swiss
 * postings this way. Each of these was individually confirmed via its own
 * listing's postal code (e.g. "Wohlen" 5610 = Wohlen AG, not the 3033
 * Wohlen bei Bern; "Küsnacht" 8700 = Küsnacht ZH; "Kirchberg" 3422 = Kirchberg
 * BE, not the 9533 Kirchberg SG) — used as a targeted fallback, consulted
 * only when inferAnyCanton(city) itself returns nothing.
 */
const KNOWN_CITY_CANTON = {
  brunnen: 'SZ',
  rotkreuz: 'ZG',
  'marin-epagnier': 'NE',
  glis: 'VS',
  wohlen: 'AG',
  'küssnacht am rigi': 'SZ',
  küssnacht: 'SZ',
  ilanz: 'GR',
  bazenheid: 'SG',
  wabern: 'BE',
  vésenaz: 'GE',
  effretikon: 'ZH',
  langwiesen: 'ZH',
  küsnacht: 'ZH',
  ibach: 'SZ',
  oberwil: 'BL',
  siebnen: 'SZ',
  emmenbrücke: 'LU',
  dierkon: 'LU',
  bichelsee: 'TG',
  aesch: 'BL',
  brunaupark: 'ZH',
  cugy: 'VD',
  roggwil: 'BE',
  studen: 'BE',
  oberdorf: 'NW',
  rüti: 'ZH',
  langnau: 'BE',
  'langnau i.e': 'BE',
  kirchberg: 'BE',
  bürglen: 'TG',
  bütschwil: 'SG',
  'wilen b. will': 'TG',
  'wilen b. wil': 'TG',
  niederuzwil: 'SG',
  oey: 'BE',
  's.antonino': 'TI',
  birmensdorf: 'ZH',
  erlenbach: 'ZH',
  gümligen: 'BE',
  littau: 'LU',
  niederurnen: 'GL',
  charmey: 'FR',
  'neu st. johann': 'SG',
};

// A single observed case where the site's own `addressLocality` field was
// itself a bare postal code with no city name at all ("8706" — Feldmeilen/
// Meilen, ZH) — consulted only as a last-resort fallback keyed by the
// listing's exact postal code.
const KNOWN_POSTAL_CANTON = {
  8706: 'ZH',
};

function resolveKnownCanton(city, postalCode) {
  const key = normalize(city);
  if (KNOWN_CITY_CANTON[key]) return KNOWN_CITY_CANTON[key];
  const plz = normalizeSpace(postalCode || '');
  if (KNOWN_POSTAL_CANTON[plz]) return KNOWN_POSTAL_CANTON[plz];
  return '';
}

/* ── Nuxt payload decoding ─────────────────────────────────── */

/**
 * Nuxt's `__NUXT_DATA__` payload is a flat array where every object/array
 * value is stored as an index into that same array (a devalue-style
 * dedup scheme — e.g. an identical "brand" object reused by two jobs at the
 * same store is a single array cell referenced twice). Resolving a subtree
 * therefore means recursively following index references, not just
 * `JSON.parse`-ing directly. A depth cap guards against runaway recursion;
 * real listing objects are only a handful of levels deep.
 */
function resolveNuxtRef(arr, i, depth = 0) {
  if (depth > 24 || !Number.isInteger(i) || i < 0 || i >= arr.length) return undefined;
  const v = arr[i];
  if (Array.isArray(v)) {
    return v.map((ref) => (Number.isInteger(ref) ? resolveNuxtRef(arr, ref, depth + 1) : ref));
  }
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, ref] of Object.entries(v)) {
      out[k] = Number.isInteger(ref) ? resolveNuxtRef(arr, ref, depth + 1) : ref;
    }
    return out;
  }
  return v;
}

/**
 * Locate the vacancy-search result node — the one object in the payload
 * carrying `{ hits, total, facets, jobType }` — and resolve just `total`
 * and each `hits[i]` item (skipping the much larger, irrelevant `facets`
 * filter tree for speed).
 */
function parseNuxtSearchResults(html) {
  const m = /<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) return { total: 0, hits: [] };
  let arr;
  try {
    arr = JSON.parse(m[1]);
  } catch {
    return { total: 0, hits: [] };
  }
  if (!Array.isArray(arr)) return { total: 0, hits: [] };

  let nodeIdx = -1;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v && typeof v === 'object' && !Array.isArray(v) && 'hits' in v && 'total' in v && 'facets' in v) {
      nodeIdx = i;
      break;
    }
  }
  if (nodeIdx === -1) return { total: 0, hits: [] };

  const node = arr[nodeIdx];
  const total = Number.isInteger(node.total) ? Number(arr[node.total]) || 0 : 0;
  const hitsRefs = Number.isInteger(node.hits) ? arr[node.hits] : null;
  const hits = Array.isArray(hitsRefs)
    ? hitsRefs
        .map((ref) => (Number.isInteger(ref) ? resolveNuxtRef(arr, ref) : null))
        .filter((hit) => hit && hit.document)
        .map((hit) => hit.document)
    : [];

  return { total, hits };
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

async function fetchListingPage(pageNumber) {
  const url = pageNumber <= 1 ? LISTING_URL : `${LISTING_URL}?page=${pageNumber}`;
  const html = await fetchHtml(url, { timeoutMs: 20000 });
  return parseNuxtSearchResults(html);
}

async function listAllDocuments() {
  const byId = new Map();
  let total = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { total: pageTotal, hits } = await fetchListingPage(page);
    if (page === 1) total = pageTotal;
    if (!hits.length) break;
    for (const doc of hits) {
      const id = doc?.id || doc?.searchApiId;
      if (id && !byId.has(id)) byId.set(id, doc);
    }
    console.log(`  📄 Page ${page}: ${hits.length} hits (running total ${byId.size}/${total})`);
    if (total && byId.size >= total) break;
  }
  return { total, documents: [...byId.values()] };
}

/**
 * Sequential mini-helper to fetch N detail pages with bounded concurrency
 * + per-worker delay (same pattern as scripts/lib/ksw-job-parser.mjs).
 */
async function fetchInBatches(items, concurrency, fn, opts = {}) {
  const delayMs = Number.isFinite(opts.delayMs) ? opts.delayMs : 150;
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        results[i] = { __error: err };
      }
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  const workers = Array.from({ length: Math.max(1, concurrency) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Fetch all Migros Group jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllMigrosHqJobs() {
  console.log(`🔍 Fetching ${MIGROS_HQ_COMPANY_NAME} jobs`);
  console.log(`   Source: ${LISTING_URL}\n`);

  const { total, documents } = await listAllDocuments();
  console.log(`  📋 Listings found: ${documents.length} (site total: ${total})\n`);
  if (documents.length === 0) return [];

  console.log(`  🔎 Fetching ${documents.length} detail pages (concurrency=${DETAIL_CONCURRENCY}, delay=${DETAIL_DELAY_MS}ms)…`);
  const detailResults = await fetchInBatches(
    documents,
    DETAIL_CONCURRENCY,
    async (doc) => {
      const detailUrl = doc.link ? new URL(doc.link, `https://${CAREER_HOST}`).toString() : '';
      if (!detailUrl) return null;
      const html = await fetchHtml(detailUrl, { timeoutMs: 20000 });
      const structured = extractMigrosStructuredData(html);
      return { detailUrl, structured };
    },
    { delayMs: DETAIL_DELAY_MS },
  );

  let detailOk = 0;
  let detailFail = 0;
  const jobs = [];

  for (let i = 0; i < documents.length; i++) {
    const doc = documents[i];
    const detail = detailResults[i];

    const title = normalizeSpace(doc.title || '');
    if (!title || title.length < 3) continue;

    const city = normalizeSpace(doc.addressLocality || '');
    const postalCode = normalizeSpace(doc.addressPostalCode || '');
    const canton = inferAnyCanton(city) || resolveKnownCanton(city, postalCode) || null;
    if (city && !canton) {
      // Genuinely unresolvable (typically a foreign address — Migros has a
      // handful of Liechtenstein/border postings on this same board, e.g.
      // Schaan/Triesen — or a name neither the gazetteer nor the small
      // KNOWN_CITY_CANTON fallback above covers).
      console.warn(`  ⚠️ ${MIGROS_HQ_COMPANY_NAME}: skipping unresolvable location "${city}" (${title})`);
      continue;
    }

    const location = city || 'Zürich';
    const resolvedCanton = canton || 'ZH';

    const brand = Array.isArray(doc.brand) && doc.brand[0]?.label ? doc.brand[0].label : MIGROS_HQ_COMPANY_NAME;
    const employmentTypeLabel = Array.isArray(doc.employmentType) && doc.employmentType[0]?.label ? doc.employmentType[0].label : '';

    const structured = detail && !detail.__error ? detail.structured : null;
    if (structured) detailOk++;
    else detailFail++;

    const descriptionText = structured?.description ? normalizeSpace(structured.description) : '';
    const finalDescription = descriptionText ? structured.description : `${title} — ${brand}`;
    const publicUrl = detail?.detailUrl || LISTING_URL;

    const sourceLang = detectLang(finalDescription || title, 'de');
    const jobSlug = slugify(`${title} migros-hq ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `migros-hq-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: MIGROS_HQ_COMPANY_NAME,
      companyKey: MIGROS_HQ_KEY,
      companyDomain: MIGROS_HQ_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: finalDescription,
      descriptionByLocale: { [sourceLang]: finalDescription },
      location,
      canton: resolvedCanton,
      url: publicUrl,
      source: 'Migros HQ Zürich Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: location,
      addressCountry: 'CH',
      country: 'CH',
      postalCode,
      category: detectCategory(title),
      contract: 'full-time',
      employmentType: classifyEmploymentType(structured?.workPercentage, employmentTypeLabel || title),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Retail',
      currency: 'CHF',
      featured: false,
      postedDate: new Date().toISOString().split('T')[0],
      applyUrl: publicUrl,
      requirements: structured?.requirements || [],
      requirementsByLocale: { [sourceLang]: structured?.requirements || [] },
    };

    jobs.push(job);
  }

  console.log(`  ✅ Detail OK: ${detailOk} · ⚠️ failures: ${detailFail}\n`);
  console.log(`📋 Total ${MIGROS_HQ_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

export { slugify, stripHtml };
