/**
 * McDonald's Switzerland — job parser
 *
 * Careers portal: https://jobs.mcdonalds.ch/
 *
 * ── 2026-08-10 rewrite (issue #5393) ──────────────────────────
 *
 * The previous implementation targeted a Paradox/McHire React SPA and
 * discovered jobs through a sitemap INDEX of ~40 per-job sitemap files
 * (`/sitemap-<hash>-<locale>.xml`), then read a schema.org JobPosting
 * JSON-LD block off each `/{locale}/{slug}/job/{id}` detail page.
 *
 * That portal is gone. Measured live on 2026-08-10, three independent
 * breaks, each on its own sufficient to return zero jobs:
 *
 *  1. TRANSPORT. `https://jobs.mcdonalds.ch/` no longer presents a valid
 *     certificate. The host now resolves to 83.228.194.175
 *     (`od-bdc4d8.infomaniak.ch`, same answer from 1.1.1.1 / 8.8.8.8 /
 *     9.9.9.9) and serves a Sectigo DV certificate issued for
 *     `CN=preview.infomaniak.website` with
 *     `SAN: preview.infomaniak.website, *.infomaniak.site,
 *     *.preview.infomaniak.website` — no `jobs.mcdonalds.ch`. Node/undici
 *     rejects every request with ERR_TLS_CERT_ALTNAME_INVALID, so the old
 *     `fetchText()` returned null for the sitemap index and the crawler
 *     exited at `jobUrls.length === 0`. The apex site `www.mcdonalds.ch`
 *     is unaffected (valid `CN=www.mcdonalds.ch`); it is only the careers
 *     sub-domain that is mis-provisioned. Over plain HTTP the same host
 *     answers 200 with the real portal.
 *
 *  2. DISCOVERY. `/sitemap.xml` is no longer a sitemap index — it is a
 *     flat `<urlset>` of 18 URLs with no `/sitemap-<hash>-<locale>.xml`
 *     children at all, so the old `/\/sitemap-[0-9a-f]+-/` filter matched
 *     nothing.
 *
 *  3. URL SHAPE. Job detail pages are now `/details-offre/{id}`; the old
 *     `/\/job\/[A-Za-z0-9-]+$/` filter matched nothing either.
 *
 * The portal is back on the Drupal site the pre-SPA crawler was built for:
 * the vacancies page `/postes-vacants` embeds the complete, unpaginated
 * `mcdo_jobs_mapEntries` JSON array (72 entries on 2026-08-10) carrying
 * everything a job record needs — `id`, `title`, `date`, `url`, `desc`
 * (full plain-text description), `city_name`, `store_name`, `type_name`
 * and `language`. One request replaces the previous ~40 sitemap fetches
 * plus one fetch per job, and there is no bot-protection on it.
 *
 * Detail pages (`/details-offre/{id}`) still carry a clean, strictly
 * parseable schema.org JobPosting JSON-LD block, so `parseMcdoDetailPage()`
 * is kept: it is the enrichment path for `validThrough` and the postal
 * address, and the fallback if the listing array ever disappears.
 *
 * TRANSPORT POLICY. Requests are attempted over HTTPS first and fall back
 * to HTTP for this host only, and only on a TLS/certificate failure. The
 * emitted job `url` stays on `https://` because that is what the portal
 * itself publishes as canonical in its own sitemap — the certificate is
 * McDonald's to re-provision, and burning `http://` into the permanent
 * dataset would outlive the outage.
 */

import { normalizeCantonCode, inferAnyCanton } from './target-swiss-locations.mjs';

export const MCDO_KEY = 'mcdonald-s-switzerland';
export const COMPANY_NAME = "McDonald's Switzerland";
export const COMPANY_DOMAIN = 'mcdonalds.ch';

const MCDO_BASE = 'https://jobs.mcdonalds.ch';
/**
 * Vacancies page carrying the full `mcdo_jobs_mapEntries` array. The path is
 * the French one because that is the portal's default locale route; the
 * array it embeds is NOT locale-scoped — it holds every open posting with a
 * per-entry `language` field (2026-08-10: 61 de + 10 fr + 1 it).
 */
const MCDO_LISTING_PATH = '/postes-vacants';
const SITEMAP_INDEX_URL = `${MCDO_BASE}/sitemap.xml`;

const DEFAULT_UA = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/** Node/undici error codes that mean "TLS refused this certificate". */
const TLS_ERROR_CODES = new Set([
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_SSL_WRONG_VERSION_NUMBER',
]);

/* ── Text helpers ─────────────────────────────────────────────── */

export function stripHtml(html = '') {
  return String(html || '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function slugify(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 180);
}

export function inferCanton(addressRegion = '', city = '') {
  const explicit = normalizeCantonCode(String(addressRegion || ''));
  if (explicit) return explicit;
  return inferAnyCanton(String(city || addressRegion || ''));
}

/**
 * McDonald's crew postings are almost universally part-time/hourly.
 *
 * The source expresses employment type in two different shapes: the detail
 * page JSON-LD now carries a localized STRING ("Contrat plein temps",
 * "Vollzeit", …) rather than the array the SPA used, and the listing array
 * carries a `type_name` category instead. Accept both, then fall back to
 * title heuristics (apprenticeships are the main full-time-ish exception).
 */
export function inferEmploymentType(title = '', ldEmploymentType = []) {
  const types = (Array.isArray(ldEmploymentType) ? ldEmploymentType : [ldEmploymentType])
    .filter(Boolean)
    .map(String);
  if (types.some((t) => /full|plein[\s-]?temps|vollzeit|tempo\s+pieno/i.test(t))) return 'FULL_TIME';
  if (types.some((t) => /part|partiel|teilzeit|tempo\s+parziale/i.test(t))) return 'PART_TIME';
  if (/apprenti|lehre|lehrstelle|apprendist|apprentissage/i.test(title)) return 'FULL_TIME';
  // Swiss postings state the workload in the title. The listing array carries
  // no employment-type field for head-office roles (`type_name` is only the
  // department, e.g. "Siège Administratif - Postes vacants"), so "(100%)" is
  // the single signal that distinguishes them from hourly crew work.
  if (/\b100\s*%/.test(title)) return 'FULL_TIME';
  if (/\b(?:[1-9]\d?|[1-9]\d?\s*[–-]\s*\d\d)\s*%/.test(title)) return 'PART_TIME';
  return 'PART_TIME';
}

/* ── Network helpers ──────────────────────────────────────────── */

/**
 * Same-host HTTPS→HTTP downgrade, used ONLY when the TLS layer rejects the
 * certificate (see the TRANSPORT note in the module header). A 4xx/5xx or a
 * plain network error never triggers it — those are real failures and must
 * stay visible to the retry/backoff logic.
 */
function httpFallbackUrl(url) {
  return String(url).startsWith('https://') ? String(url).replace(/^https:/, 'http:') : null;
}

async function fetchOnce(url, { userAgent, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': userAgent, Accept: 'text/html,application/xml' },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (res.ok) return { text: await res.text(), status: res.status };
    return { text: null, status: res.status };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, { userAgent = DEFAULT_UA, timeoutMs = 15000, retries = 2, backoffMs = 800 } = {}) {
  let allowTlsFallback = true;
  let target = url;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const { text, status } = await fetchOnce(target, { userAgent, timeoutMs });
      if (text !== null) return text;
      const retryable = status === 408 || status === 429 || (status >= 500 && status <= 599);
      if (!retryable) return null;
    } catch (err) {
      const code = err?.cause?.code || err?.code || '';
      const fallback = allowTlsFallback && TLS_ERROR_CODES.has(code) ? httpFallbackUrl(target) : null;
      if (fallback) {
        // The careers sub-domain currently serves an Infomaniak certificate
        // that does not cover it (#5393). Downgrade once, keep retrying.
        console.warn(`  ⚠️  ${target}: TLS rejected (${code}) — retrying over HTTP for this host.`);
        target = fallback;
        allowTlsFallback = false;
        continue;
      }
      // fall through to retry/backoff
    }
    if (attempt < retries) {
      await new Promise((r) => setTimeout(r, backoffMs * Math.pow(2, attempt)));
    }
  }
  return null;
}

async function runWithConcurrency(items, worker, concurrency) {
  const out = new Array(items.length);
  let i = 0;
  async function runner() {
    while (i < items.length) {
      const idx = i;
      i += 1;
      // eslint-disable-next-line no-await-in-loop
      out[idx] = await worker(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => runner()));
  return out;
}

/* ── Listing discovery (mcdo_jobs_mapEntries) ─────────────────── */

/**
 * Pull the `mcdo_jobs_mapEntries` array out of the vacancies page.
 *
 * The page assigns it inside an inline script; the array is plain JSON, so
 * it is located by its key and then bracket-matched (a non-greedy regex
 * would stop at the first `]` inside a description).
 *
 * @param {string} html
 * @returns {Array<object>} raw listing entries, [] when absent/unparseable
 */
export function parseMcdoMapEntries(html = '') {
  const source = String(html || '');
  const keyIdx = source.search(/mcdo_jobs_mapEntries/);
  if (keyIdx === -1) return [];
  const start = source.indexOf('[', keyIdx);
  if (start === -1) return [];

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(source.slice(start, i + 1));
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      }
    }
  }
  return [];
}

/**
 * Normalize one `mcdo_jobs_mapEntries` entry into the same shape
 * `parseMcdoDetailPage()` returns, so both paths feed `buildMcdoJob()`.
 *
 * @param {object} entry
 * @returns {object|null}
 */
export function mapEntryToParsed(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const title = String(entry.title || '').trim();
  const relUrl = String(entry.url || '').trim();
  if (!title || !relUrl) return null;

  const city = String(entry.city_name || '').trim();
  const description = stripHtml(String(entry.desc || ''));
  const datePosted = /^\d{4}-\d{2}-\d{2}/.test(String(entry.date || ''))
    ? String(entry.date).slice(0, 10)
    : '';

  return {
    title,
    // Canonical https, per the TRANSPORT note in the module header.
    url: relUrl.startsWith('http') ? relUrl : `${MCDO_BASE}${relUrl.startsWith('/') ? '' : '/'}${relUrl}`,
    jobReqId: String(entry.id || '').trim(),
    city,
    canton: inferCanton('', city),
    postalCode: '',
    streetAddress: String(entry.store_name || '').trim(),
    description,
    datePosted,
    validThrough: '',
    employmentType: inferEmploymentType(title, entry.type_name),
  };
}

/**
 * Discover every open job's detail-page URL from the vacancies listing.
 *
 * Kept as a named export (and still returning `{ jobUrls, sitemapCount }`)
 * because the crawler's logging and the health monitor both key off the
 * discovered-URL count; `sitemapCount` is now the listing-page count.
 */
export async function discoverMcdoJobUrls({ userAgent = DEFAULT_UA, timeoutMs = 15000 } = {}) {
  const html = await fetchText(`${MCDO_BASE}${MCDO_LISTING_PATH}`, { userAgent, timeoutMs });
  if (!html) return { jobUrls: [], sitemapCount: 0 };
  const entries = parseMcdoMapEntries(html);
  const jobUrls = [...new Set(entries.map((e) => mapEntryToParsed(e)?.url).filter(Boolean))];
  return { jobUrls, sitemapCount: 1 };
}

/* ── Detail page parsing ──────────────────────────────────────── */

function extractJsonLdBlocks(html = '') {
  const blocks = [];
  const regex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = regex.exec(html)) !== null) {
    try {
      blocks.push(JSON.parse(m[1]));
    } catch {
      // skip malformed block
    }
  }
  return blocks;
}

/**
 * Parse a McDonald's job detail page HTML and return a structured job, or
 * null if no JobPosting JSON-LD block is present.
 */
export function parseMcdoDetailPage(html, pageUrl = '') {
  if (!html || typeof html !== 'string') return null;
  const blocks = extractJsonLdBlocks(html);
  const ld = blocks.find((b) => b && b['@type'] === 'JobPosting');
  if (!ld || !ld.title) return null;

  const place = Array.isArray(ld.jobLocation) ? ld.jobLocation[0] : ld.jobLocation;
  const address = place?.address || {};
  const city = address.addressLocality || place?.name || '';
  const canton = inferCanton(address.addressRegion, city);

  const description = stripHtml(ld.description || '');
  const datePosted = ld.datePosted ? String(ld.datePosted).slice(0, 10) : '';
  const validThrough = ld.validThrough ? String(ld.validThrough).slice(0, 10) : '';

  return {
    title: String(ld.title).trim(),
    url: ld.url || pageUrl,
    jobReqId: ld.identifier?.value || '',
    city,
    canton,
    postalCode: address.postalCode || '',
    streetAddress: address.streetAddress || '',
    description,
    datePosted,
    validThrough,
    employmentType: inferEmploymentType(ld.title, ld.employmentType),
  };
}

export async function fetchMcdoDetailPage(url, { userAgent = DEFAULT_UA, timeoutMs = 15000 } = {}) {
  const html = await fetchText(url, { userAgent, timeoutMs });
  if (!html) return null;
  return parseMcdoDetailPage(html, url);
}

/* ── Job object builder ──────────────────────────────────────── */

export function buildMcdoJob(parsed) {
  if (!parsed || !parsed.title) return null;
  const location = parsed.city || 'Svizzera';
  const slug = slugify(`${parsed.title}-mcdonalds-switzerland-${location}-${parsed.jobReqId || ''}`);
  if (!slug || slug.length < 3) return null;

  const description = parsed.description
    || `Posizione aperta presso un ristorante McDonald's a ${location}${parsed.canton ? ` (${parsed.canton})` : ''}, Svizzera. Candidati tramite il portale ufficiale McDonald's Switzerland.`;

  return {
    title: parsed.title,
    company: COMPANY_NAME,
    companyKey: MCDO_KEY,
    companyDomain: COMPANY_DOMAIN,
    url: parsed.url,
    slug,
    location,
    canton: parsed.canton || '',
    country: 'CH',
    postalCode: parsed.postalCode || '',
    streetAddress: parsed.streetAddress || '',
    description,
    // Canonical pipeline field is `postedDate` (schema.org JSON-LD calls it
    // `datePosted`, but every downstream consumer — JobBoard, sitemap,
    // newsletter, assemble-jobs-dataset churn guard — reads `postedDate`).
    postedDate: parsed.datePosted || new Date().toISOString().split('T')[0],
    validThrough: parsed.validThrough || '',
    employmentType: parsed.employmentType,
    jobReqId: parsed.jobReqId,
    sector: 'Ristorazione / Fast Food',
    source: "McDonald's Dedicated Parser (vacancies listing + JSON-LD)",
  };
}

/**
 * Fetch and parse all McDonald's Switzerland jobs end-to-end.
 *
 * Primary path is the single vacancies-page request; `enrichFromDetail`
 * additionally pulls `validThrough` and the postal address off the per-job
 * JSON-LD (off by default — 72 extra requests for two optional fields).
 */
export async function fetchMcdoJobs({
  userAgent = DEFAULT_UA,
  timeoutMs = 15000,
  detailConcurrency = 8,
  enrichFromDetail = false,
} = {}) {
  const html = await fetchText(`${MCDO_BASE}${MCDO_LISTING_PATH}`, { userAgent, timeoutMs });
  if (!html) {
    console.log(`  ⚠️  Listing page ${MCDO_LISTING_PATH} unreachable — 0 jobs.`);
    return [];
  }

  const entries = parseMcdoMapEntries(html);
  console.log(`  🗺️  Listing entries (mcdo_jobs_mapEntries): ${entries.length}`);
  if (entries.length === 0) return [];

  let parsedList = entries.map((e) => mapEntryToParsed(e)).filter(Boolean);

  if (enrichFromDetail) {
    parsedList = await runWithConcurrency(
      parsedList,
      async (parsed) => {
        const detail = await fetchMcdoDetailPage(parsed.url, { userAgent, timeoutMs });
        if (!detail) return parsed;
        return {
          ...parsed,
          validThrough: detail.validThrough || parsed.validThrough,
          postalCode: detail.postalCode || parsed.postalCode,
          streetAddress: detail.streetAddress || parsed.streetAddress,
          canton: parsed.canton || detail.canton,
        };
      },
      detailConcurrency
    );
  }

  const jobs = [];
  for (const parsed of parsedList) {
    const job = buildMcdoJob(parsed);
    if (job) jobs.push(job);
  }
  return jobs;
}

export { SITEMAP_INDEX_URL, MCDO_LISTING_PATH, MCDO_BASE };
