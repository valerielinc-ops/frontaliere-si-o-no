import { truncateSlugAtWordBoundary } from './slug-truncate.mjs';
/**
 * McDonald's Switzerland — job parser
 *
 * Careers portal: https://jobs.mcdonalds.ch/
 *
 * ── 2026-08-14 rewrite (issue #5852) ──────────────────────────
 *
 * The Drupal vacancies page (`/postes-vacants`, `mcdo_jobs_mapEntries`)
 * that the 2026-08-10 rewrite (#5393) targeted is gone again — the portal
 * reverted to the Paradox/McHire SPA the crawler ran *before* that rewrite,
 * this time server-rendered rather than client-fetched. Measured live on
 * 2026-08-14: `/postes-vacants` still 200s, but the response no longer
 * embeds `mcdo_jobs_mapEntries` anywhere, so the old regex found nothing
 * and every crawl returned zero jobs for three consecutive runs.
 *
 * The canonical listing is now `/fr/emplois-restauration` (10 jobs/page,
 * further pages at `/fr/emplois-restauration/page/{n}`). Each page embeds
 * its slice of results server-side in a `<script>` assigning
 * `window.__PRELOAD_STATE__.jobSearch` (`jobs: [...]`, `totalJob`), so
 * `discoverAllListingEntries()` walks every page and builds the full
 * result set from that JSON — no client-side rendering or bot-protected
 * XHR involved. Listing entries carry title/location/URL but not the job
 * description or posting date, so every job is still enriched from its
 * detail page.
 *
 * Detail pages moved from `/details-offre/{id}` back to
 * `/{lang}/{slug}/job/{reference}` (e.g.
 * `/fr-ch/agent-e-de-maintenance/job/P8-317484-1`), still carrying a
 * schema.org JobPosting JSON-LD block — `parseMcdoDetailPage()` needed no
 * changes at all, only the URLs feeding it. That block currently omits
 * `employmentType` and `validThrough` outright (present pre-2026-08-10,
 * absent again now); both already have safe fallbacks downstream.
 *
 * TRANSPORT POLICY. Requests are attempted over HTTPS first and fall back
 * to HTTP for this host only, and only on a TLS/certificate failure (see
 * `TLS_ERROR_CODES` below) — kept from the 2026-08-10 rewrite as a defensive
 * measure even though the certificate is valid again as of 2026-08-14.
 */

import { normalizeCantonCode, inferAnyCanton } from './target-swiss-locations.mjs';

export const MCDO_KEY = 'mcdonald-s-switzerland';
export const COMPANY_NAME = "McDonald's Switzerland";
export const COMPANY_DOMAIN = 'mcdonalds.ch';

const MCDO_BASE = 'https://jobs.mcdonalds.ch';
/**
 * Job search listing, French locale (the portal's default route). Page 1
 * lives at this path, further pages at `${MCDO_LISTING_PATH}/page/{n}`.
 */
const MCDO_LISTING_PATH = '/fr/emplois-restauration';

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
  return truncateSlugAtWordBoundary(String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-'), 180);
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
 * "Vollzeit", …) rather than the array the SPA used, and the McHire listing
 * entries carry an `employmentType` array that is usually empty. Accept both
 * shapes, then fall back to
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

/* ── Listing discovery (window.__PRELOAD_STATE__) ─────────────── */

/**
 * Pull the `window.__PRELOAD_STATE__ = {...}` object literal out of a
 * listing page.
 *
 * The page assigns it inside an inline `<script>`, immediately followed by
 * further statements (`window.__BUILD__ = ...`) on the same line — the
 * object is located by its key and then brace-matched (stopping at the
 * first top-level `;` would work today but is one nested `};` away from
 * silently truncating).
 *
 * @param {string} html
 * @returns {object|null} the parsed state object, or null if absent/unparseable
 */
export function parseMcdoPreloadState(html = '') {
  const source = String(html || '');
  const keyIdx = source.indexOf('window.__PRELOAD_STATE__');
  if (keyIdx === -1) return null;
  const eqIdx = source.indexOf('=', keyIdx);
  if (eqIdx === -1) return null;
  const start = source.indexOf('{', eqIdx);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(source.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Extract `jobSearch.jobs` + `jobSearch.totalJob` off one listing page.
 *
 * @param {string} html
 * @returns {{ jobs: Array<object>, totalJob: number }}
 */
export function extractListingJobs(html = '') {
  const state = parseMcdoPreloadState(html);
  const jobs = state?.jobSearch?.jobs;
  const totalJob = Number(state?.jobSearch?.totalJob) || 0;
  return { jobs: Array.isArray(jobs) ? jobs : [], totalJob };
}

/**
 * Normalize one `jobSearch.jobs` listing entry into the same shape
 * `parseMcdoDetailPage()` returns, so both paths feed `buildMcdoJob()`.
 *
 * Listing entries carry no description or posting date — every job is
 * enriched from its detail page in `fetchMcdoJobs()` before those fields
 * are needed.
 *
 * @param {object} entry
 * @returns {object|null}
 */
export function listingEntryToParsed(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const title = String(entry.title || '').trim();
  const originalURL = String(entry.originalURL || '').trim();
  if (!title || !originalURL) return null;

  const location = Array.isArray(entry.locations) ? entry.locations[0] : null;
  const city = String(location?.city || '').trim();

  return {
    title,
    url: `${MCDO_BASE}/${originalURL.replace(/^\/+/, '')}`,
    jobReqId: String(entry.reference || '').trim(),
    city,
    canton: inferCanton(location?.stateAbbr || location?.state || '', city),
    postalCode: String(location?.zipCode || '').trim(),
    streetAddress: String(location?.streetAddress || '').trim(),
    description: '',
    datePosted: '',
    validThrough: '',
    employmentType: inferEmploymentType(title, entry.employmentType),
  };
}

/**
 * Absolute URL of listing page `pageNum` (1-based). Exported so the test
 * suite can pin it against the canonical URL recorded in the captured
 * fixture — see the "listing URL contract" block in
 * `tests/mcdonalds-crawler.test.ts`.
 */
export function listingPageUrl(pageNum) {
  return pageNum <= 1 ? `${MCDO_BASE}${MCDO_LISTING_PATH}` : `${MCDO_BASE}${MCDO_LISTING_PATH}/page/${pageNum}`;
}

async function fetchListingPage(pageNum, { userAgent, timeoutMs }) {
  const html = await fetchText(listingPageUrl(pageNum), { userAgent, timeoutMs });
  if (!html) {
    console.warn(`[mcdonalds] listing page ${pageNum}: fetch fallito — contata come vuota`);
    return { jobs: [], totalJob: 0 };
  }
  const out = extractListingJobs(html);
  // "200 senza __PRELOAD_STATE__" NON e' "zero job": e' la firma del prossimo
  // format drift (classe #5852). Il guard anti-wipe dell'updater impedisce la
  // perdita dati, ma senza questo warn la diagnosi resterebbe muta per i 3 run
  // che servono al monitor.
  if (out.jobs.length === 0 && out.totalJob === 0 && !html.includes('__PRELOAD_STATE__')) {
    console.warn(`[mcdonalds] listing page ${pageNum}: 200 ma nessun __PRELOAD_STATE__ — probabile cambio di formato del portale`);
  }
  return out;
}

/**
 * Walk every listing page (10 jobs/page) and return the raw entries.
 *
 * Page 1's `totalJob` drives how many further pages to fetch — there is
 * no separate "page count" field, only the running total and the observed
 * page size.
 */
async function discoverAllListingEntries({ userAgent = DEFAULT_UA, timeoutMs = 15000 } = {}) {
  const first = await fetchListingPage(1, { userAgent, timeoutMs });
  if (first.jobs.length === 0) return { entries: [], pageCount: 0 };

  const perPage = first.jobs.length;
  // totalJob arriva dal JSON del portale e va creduto solo fino a un punto:
  // un valore assurdo (bug loro, semantica cambiata, tarpit) non deve
  // trasformarsi in una tempesta di fetch. 100 pagine = ~1000 job, oltre 6x
  // il massimo storico osservato (165 job il 2026-08-15).
  const MAX_LISTING_PAGES = 100;
  const totalPages = Math.max(1, Math.min(MAX_LISTING_PAGES, Math.ceil((first.totalJob || perPage) / perPage)));
  const all = [...first.jobs];

  if (totalPages > 1) {
    const pageNums = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
    const rest = await runWithConcurrency(
      pageNums,
      (pageNum) => fetchListingPage(pageNum, { userAgent, timeoutMs }),
      4
    );
    for (const page of rest) all.push(...page.jobs);
  }
  // Un raccolto parziale (pagina intermedia fallita, o totale mendace) non e'
  // uno zero: il monitor non lo vede, e nel merge dell'updater i job mancanti
  // uscirebbero come "removed". Almeno il log deve dirlo.
  if (all.length < (first.totalJob || 0)) {
    console.warn(`[mcdonalds] raccolto parziale: ${all.length}/${first.totalJob} job — pagina fallita o totalJob mendace`);
  }
  return { entries: all, pageCount: totalPages };
}

/**
 * Discover every open job's detail-page URL from the paginated listing.
 *
 * NOTE: nothing in the repo imports this today — `update-mcdonalds-jobs.mjs`
 * calls `fetchMcdoJobs()` directly, and the health monitor reads the emitted
 * job count out of `data/crawler-health.json`, not this return value. The
 * docstring here used to claim both as consumers (carried over from #5393);
 * it is kept as an export only as the URL-only entry point for ad-hoc
 * debugging, and `sitemapCount` now really is the listing-page count it
 * always claimed to be (it returned a bare 1/0 before).
 */
export async function discoverMcdoJobUrls({ userAgent = DEFAULT_UA, timeoutMs = 15000 } = {}) {
  const { entries, pageCount } = await discoverAllListingEntries({ userAgent, timeoutMs });
  const jobUrls = [...new Set(entries.map((e) => listingEntryToParsed(e)?.url).filter(Boolean))];
  return { jobUrls, sitemapCount: pageCount };
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
 * Listing entries (`discoverAllListingEntries()`) carry no description or
 * posting date, so every job is unconditionally enriched from its detail
 * page's JobPosting JSON-LD — that is where `description`/`datePosted`
 * actually come from now, not an optional extra.
 */
export async function fetchMcdoJobs({
  userAgent = DEFAULT_UA,
  timeoutMs = 15000,
  detailConcurrency = 8,
} = {}) {
  const { entries, pageCount } = await discoverAllListingEntries({ userAgent, timeoutMs });
  console.log(`  🗺️  Listing entries (jobSearch): ${entries.length} across ${pageCount} page(s)`);
  if (entries.length === 0) return [];

  const parsedList = entries.map((e) => listingEntryToParsed(e)).filter(Boolean);

  const enriched = await runWithConcurrency(
    parsedList,
    async (parsed) => {
      const detail = await fetchMcdoDetailPage(parsed.url, { userAgent, timeoutMs });
      if (!detail) return parsed;
      return {
        ...parsed,
        description: detail.description || parsed.description,
        datePosted: detail.datePosted || parsed.datePosted,
        validThrough: detail.validThrough || parsed.validThrough,
        postalCode: detail.postalCode || parsed.postalCode,
        streetAddress: detail.streetAddress || parsed.streetAddress,
        canton: detail.canton || parsed.canton,
      };
    },
    detailConcurrency
  );

  const jobs = [];
  for (const parsed of enriched) {
    const job = buildMcdoJob(parsed);
    if (job) jobs.push(job);
  }
  return jobs;
}

export { MCDO_LISTING_PATH, MCDO_BASE };
