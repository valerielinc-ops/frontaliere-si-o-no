import { truncateSlugAtWordBoundary } from './slug-truncate.mjs';
import { TLS_ERROR_CODES } from './transient-fetch.mjs';
/**
 * McDonald's Switzerland — job parser
 *
 * Careers portal: https://jobs.mcdonalds.ch/
 *
 * The canonical listing is `/fr/emplois-restauration` (10 jobs/page, further
 * pages at `/fr/emplois-restauration/page/{n}`). Each page embeds its slice
 * server-side in `window.__PRELOAD_STATE__.jobSearch` (`jobs: [...]`,
 * `totalJob`). The crawler walks the declared CH-wide result set across all
 * 26 cantons and rejects a page that cannot prove unique progress. Listing
 * entries carry title/location/URL but not the job description or posting
 * date, so every job is still enriched from its detail page.
 *
 * Detail pages moved from `/details-offre/{id}` back to
 * `/{lang}/{slug}/job/{reference}` (e.g.
 * `/fr-ch/agent-e-de-maintenance/job/P8-317484-1`), still carrying a
 * schema.org JobPosting JSON-LD block. The parser retains the source-backed
 * address fields and rejects a detail page whose country is not Switzerland;
 * the block currently omits
 * `employmentType` and `validThrough` outright (present pre-2026-08-10,
 * absent again now); both already have safe fallbacks downstream.
 *
 * TRANSPORT POLICY. Requests are attempted over HTTPS first and fall back
 * to HTTP for this host only, and only on a TLS/certificate failure (see
 * `TLS_ERROR_CODES`, shared with `transient-fetch.mjs` so the TLS class has
 * one definition and not two) — kept from the 2026-08-10 rewrite as a defensive
 * measure even though the certificate is valid again as of 2026-08-14.
 */

import { inferAnyCanton, isTargetSwissLocation, normalizeCantonCode } from './target-swiss-locations.mjs';
import { isChCountry } from './ch-country-guard.mjs';

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
  || 'Mozilla/5.0 (compatible; FrontaliereSwissBot/1.0; +https://frontaliereticino.ch/)';

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
  const sourceLocation = [city, addressRegion].filter(Boolean).join(', ').trim();
  if (!sourceLocation || !isTargetSwissLocation(sourceLocation, { includeBorderProximity: false })) return '';
  const explicit = normalizeCantonCode(String(addressRegion || ''));
  return inferAnyCanton(sourceLocation) || explicit;
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
  const numericTotal = Number(state?.jobSearch?.totalJob);
  const totalJob = Number.isSafeInteger(numericTotal) && numericTotal >= 0 ? numericTotal : 0;
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
  const outcome = classifyListingEntry(entry);
  return outcome.kind === 'accepted' ? outcome.parsed : null;
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

function listingSourceIdentity(entry) {
  if (!entry || typeof entry !== 'object') return '';
  for (const candidate of [entry.reference, entry.id, entry.originalURL, entry.applyURL]) {
    const identity = String(candidate || '').trim();
    if (identity) return identity;
  }
  return '';
}

function classifyListingEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return { kind: 'unresolved', reason: 'row is not an object' };
  }
  const title = String(entry.title || '').trim();
  const originalURL = String(entry.originalURL || '').trim();
  if (!title || !originalURL) {
    return { kind: 'unresolved', reason: 'title or originalURL is missing' };
  }

  const location = Array.isArray(entry.locations) ? entry.locations[0] : null;
  const city = String(location?.city || '').trim();
  const sourceCountry = String(location?.countryAbbr || location?.country || '').trim();
  if (sourceCountry && !isChCountry(sourceCountry)) {
    return { kind: 'foreign', reason: 'source country ' + sourceCountry };
  }
  if (!city) {
    return { kind: 'unresolved', reason: 'source city is missing' };
  }

  const sourceRegion = [location?.state, location?.stateAbbr]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(', ');
  const sourceLocation = [city, sourceRegion].filter(Boolean).join(', ').trim();
  const canton = inferCanton(sourceRegion, city);
  if (!canton) {
    return { kind: 'unresolved', reason: 'source locality "' + sourceLocation + '" has no Swiss canton' };
  }

  return {
    kind: 'accepted',
    parsed: {
      title,
      url: String(MCDO_BASE) + '/' + originalURL.replace(/^\/+/, ''),
      jobReqId: String(entry.reference || '').trim(),
      city,
      canton,
      sourceLocation,
      sourceCountry,
      locationStatus: 'verified',
      postalCode: String(location?.zipCode || '').trim(),
      streetAddress: String(location?.streetAddress || '').trim(),
      description: '',
      datePosted: '',
      validThrough: '',
      employmentType: inferEmploymentType(title, entry.employmentType),
    },
  };
}

function parseListingEntries(entries) {
  const parsed = [];
  for (const [index, entry] of entries.entries()) {
    const outcome = classifyListingEntry(entry);
    if (outcome.kind === 'accepted') {
      parsed.push(outcome.parsed);
      continue;
    }
    if (outcome.kind === 'foreign') continue;
    throw new Error(
      '[mcdonalds] listing entry ' + (index + 1)
      + ' has no verified Swiss source location: ' + outcome.reason + '.',
    );
  }
  return parsed;
}

async function fetchListingPage(pageNum, { userAgent, timeoutMs, fetchPage }) {
  const url = listingPageUrl(pageNum);
  const html = typeof fetchPage === 'function'
    ? await fetchPage(url)
    : await fetchText(url, { userAgent, timeoutMs });
  if (typeof html !== 'string' || !html) {
    throw new Error(`[mcdonalds] listing page ${pageNum} unavailable after retries (${url}).`);
  }
  const state = parseMcdoPreloadState(html);
  if (!state || !state.jobSearch || !Array.isArray(state.jobSearch.jobs)) {
    throw new Error(`[mcdonalds] listing page ${pageNum} has no authoritative __PRELOAD_STATE__.`);
  }
  const numericTotal = Number(state.jobSearch.totalJob);
  if (!Number.isSafeInteger(numericTotal) || numericTotal < 0) {
    throw new Error(`[mcdonalds] listing page ${pageNum} has an invalid totalJob.`);
  }
  if (state.jobSearch.jobs.length > numericTotal) {
    throw new Error(`[mcdonalds] listing page ${pageNum} contains ${state.jobSearch.jobs.length} rows for totalJob=${numericTotal}.`);
  }
  return { jobs: state.jobSearch.jobs, totalJob: numericTotal };
}

/**
 * Walk every listing page (10 jobs/page) and return the raw entries.
 *
 * Page 1's `totalJob` is authoritative. The loop stops only when that many
 * unique source records have been read; repeated identities, empty pages, and
 * short pages before the declared total fail closed.
 */
async function discoverAllListingEntries({ userAgent = DEFAULT_UA, timeoutMs = 15000, fetchPage } = {}) {
  const first = await fetchListingPage(1, { userAgent, timeoutMs, fetchPage });
  const declaredTotal = first.totalJob;
  if (declaredTotal === 0) return { entries: [], pageCount: 1, sourceTotal: 0 };

  const uniqueEntries = new Map();
  const perPage = first.jobs.length;
  let pageNum = 1;
  let page = first;

  while (uniqueEntries.size < declaredTotal) {
    if (page.totalJob !== declaredTotal) {
      throw new Error(`[mcdonalds] listing page ${pageNum} changed totalJob from ${declaredTotal} to ${page.totalJob}.`);
    }
    if (page.jobs.length === 0) {
      throw new Error(`[mcdonalds] listing pagination incomplete: read ${uniqueEntries.size}/${declaredTotal} unique records before an empty page.`);
    }

    let pageNew = 0;
    for (const entry of page.jobs) {
      const identity = listingSourceIdentity(entry);
      if (!identity) {
        throw new Error(`[mcdonalds] listing page ${pageNum} contains a row without a stable source identity.`);
      }
      if (uniqueEntries.has(identity)) {
        throw new Error(`[mcdonalds] listing pagination repeated source identity "${identity}"; unique progress stopped at ${uniqueEntries.size}/${declaredTotal}.`);
      }
      uniqueEntries.set(identity, entry);
      pageNew += 1;
    }
    if (pageNew === 0) {
      throw new Error(`[mcdonalds] listing pagination page ${pageNum} added no unique source records.`);
    }
    if (uniqueEntries.size > declaredTotal) {
      throw new Error(`[mcdonalds] listing pagination read ${uniqueEntries.size} unique records for totalJob=${declaredTotal}.`);
    }
    if (uniqueEntries.size === declaredTotal) break;
    if (page.jobs.length < perPage) {
      throw new Error(`[mcdonalds] listing pagination incomplete: read ${uniqueEntries.size}/${declaredTotal} unique records from a short page.`);
    }

    pageNum += 1;
    page = await fetchListingPage(pageNum, { userAgent, timeoutMs, fetchPage });
  }
  return { entries: [...uniqueEntries.values()], pageCount: pageNum, sourceTotal: declaredTotal };
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
export async function discoverMcdoJobUrls({ userAgent = DEFAULT_UA, timeoutMs = 15000, fetchPage } = {}) {
  const { entries, pageCount, sourceTotal } = await discoverAllListingEntries({ userAgent, timeoutMs, fetchPage });
  const jobUrls = [...new Set(parseListingEntries(entries).map((entry) => entry.url))];
  return { jobUrls, sitemapCount: pageCount, sourceTotal };
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
  const sourceCountry = address.addressCountry || place?.addressCountry || '';
  const sourceRegion = String(address.addressRegion || '').trim();
  const sourceLocation = [city, sourceRegion].filter(Boolean).join(', ').trim();
  const normalizedSourceCountry = String(sourceCountry || '').trim();
  const canton = normalizedSourceCountry && !isChCountry(normalizedSourceCountry)
    ? ''
    : inferCanton(sourceRegion, city);
  const locationStatus = normalizedSourceCountry && !isChCountry(normalizedSourceCountry)
    ? 'foreign'
    : canton
      ? 'verified'
      : 'unresolved';

  const description = stripHtml(ld.description || '');
  const datePosted = ld.datePosted ? String(ld.datePosted).slice(0, 10) : '';
  const validThrough = ld.validThrough ? String(ld.validThrough).slice(0, 10) : '';

  return {
    title: String(ld.title).trim(),
    url: ld.url || pageUrl,
    jobReqId: ld.identifier?.value || '',
    city,
    canton,
    sourceLocation,
    sourceCountry: normalizedSourceCountry,
    locationStatus,
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
  if (parsed.locationStatus && parsed.locationStatus !== 'verified') return null;
  const location = String(parsed.city || '').trim();
  const canton = String(parsed.canton || '').trim();
  const sourceLocation = String(parsed.sourceLocation || `${location}, ${canton}`).trim();
  if (
    !location
    || !canton
    || !isTargetSwissLocation(sourceLocation, { includeBorderProximity: false })
    || inferAnyCanton(sourceLocation) !== canton
  ) return null;
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
    addressLocality: location,
    addressRegion: canton,
    addressCountry: 'CH',
    canton,
    country: 'CH',
    postalCode: parsed.postalCode || '',
    streetAddress: parsed.streetAddress || location,
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
  const { entries, pageCount, sourceTotal } = await discoverAllListingEntries({ userAgent, timeoutMs });
  console.log(`  🗺️  Listing entries (jobSearch): ${entries.length}/${sourceTotal} unique records across ${pageCount} page(s)`);
  if (entries.length === 0) return [];

  const parsedList = parseListingEntries(entries);

 let detailFallbacks = 0;
  let detailForeignDrops = 0;
 const enriched = await runWithConcurrency(
   parsedList,
   async (parsed) => {
     const detail = await fetchMcdoDetailPage(parsed.url, { userAgent, timeoutMs });
     if (!detail) {
       detailFallbacks += 1;
       return parsed;
     }
      if (detail.locationStatus === 'foreign') {
        detailForeignDrops += 1;
        return { ...parsed, ...detail, canton: '', locationStatus: 'foreign' };
      }
      if (detail.locationStatus !== 'verified') {
        throw new Error(
          '[mcdonalds] detail ' + parsed.url
          + ' has no verified Swiss source location; refusing listing fallback.',
        );
      }
     return {
       ...parsed,
       description: detail.description || parsed.description,
       datePosted: detail.datePosted || parsed.datePosted,
       validThrough: detail.validThrough || parsed.validThrough,
       postalCode: detail.postalCode || parsed.postalCode,
       streetAddress: detail.streetAddress || parsed.streetAddress,
        canton: detail.canton,
        locationStatus: 'verified',
     };
   },
   detailConcurrency
 );

 const jobs = [];
  for (const parsed of enriched) {
    const job = buildMcdoJob(parsed);
    if (job) jobs.push(job);
  }
 if (detailFallbacks > 0) {
   console.warn(`  ⚠️  Detail pages unavailable or without JobPosting JSON-LD: ${detailFallbacks}; listing location data retained.`);
 }
  if (detailForeignDrops > 0) {
    console.warn(`  ⚠️  Explicitly foreign detail locations excluded: ${detailForeignDrops}.`);
  }
 return jobs;
}

export { MCDO_LISTING_PATH, MCDO_BASE };
