/**
 * McDonald's Switzerland — job parser
 *
 * Careers portal: https://jobs.mcdonalds.ch/ — a Paradox/McHire-hosted React
 * SPA (migrated away from the old Drupal site the previous, now-deleted,
 * crawler was built for — root cause of the "0 jobs" false negative: the
 * old crawler looked for `drupalSettings.mcdo_jobs_mapEntries`, which no
 * longer exists on this domain at all).
 *
 * The SPA's own listing page (`/de/jobs-gastronomie`) embeds only the FIRST
 * 10 jobs server-side (`window.__PRELOAD_STATE__.jobSearch`); the rest load
 * client-side via `POST /api/get-jobs`, which is behind bot-detection (WAF
 * returns a bare "Access Denied" 403 regardless of UA/Referer/Origin
 * headers — no Playwright attempted since a much simpler unprotected path
 * exists, see below).
 *
 * Working, Playwright-free discovery path: the site publishes a full
 * sitemap index (`/sitemap.xml`, always meant to be publicly crawlable —
 * no bot-detection applied to it) listing ~40 per-job sitemap files, each
 * with 4 <loc> entries (one per locale: de-ch/en/fr-ch/it-ch, all pointing
 * at the SAME job ID, just a different locale-prefixed URL). Reading just
 * the de-ch entries (falling back to any available locale for a group that
 * lacks one) enumerates every open job with zero risk of bot-blocking.
 *
 * Each individual job detail page (e.g.
 * `/de-ch/crew-member/job/P8-317976-1`) is server-rendered and embeds a
 * standard schema.org `JobPosting` JSON-LD block with title, dates,
 * jobLocation (street/city/canton/postal/country) and full HTML
 * description — everything needed to build a job record.
 */

export const MCDO_KEY = 'mcdonald-s-switzerland';
export const COMPANY_NAME = "McDonald's Switzerland";
export const COMPANY_DOMAIN = 'mcdonalds.ch';

const MCDO_BASE = 'https://jobs.mcdonalds.ch';
const SITEMAP_INDEX_URL = `${MCDO_BASE}/sitemap.xml`;
const LOCALE_PREFERENCE = ['de-ch', 'en', 'fr-ch', 'it-ch'];

const DEFAULT_UA = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

// Swiss canton name → 2-letter abbreviation fallback, in case a jobLocation
// ever ships a full canton name instead of `addressRegion` abbreviation.
const CANTON_NAME_TO_ABBR = {
  zurich: 'ZH', bern: 'BE', berne: 'BE', luzern: 'LU', lucerne: 'LU', uri: 'UR',
  schwyz: 'SZ', obwalden: 'OW', nidwalden: 'NW', glarus: 'GL', zug: 'ZG',
  fribourg: 'FR', freiburg: 'FR', solothurn: 'SO', 'basel-stadt': 'BS',
  'basel-landschaft': 'BL', schaffhausen: 'SH', 'appenzell ausserrhoden': 'AR',
  'appenzell innerrhoden': 'AI', 'st. gallen': 'SG', 'st gallen': 'SG',
  graubunden: 'GR', graubünden: 'GR', grigioni: 'GR', aargau: 'AG',
  thurgau: 'TG', ticino: 'TI', vaud: 'VD', valais: 'VS', wallis: 'VS',
  neuchatel: 'NE', neuchâtel: 'NE', geneve: 'GE', genève: 'GE', geneva: 'GE',
  jura: 'JU',
};

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
  const region = String(addressRegion || '').trim();
  if (/^[A-Z]{2}$/.test(region)) return region;
  const byName = CANTON_NAME_TO_ABBR[String(region || city || '').trim().toLowerCase()];
  return byName || '';
}

/**
 * McDonald's crew postings are almost universally part-time/hourly; the
 * JSON-LD `employmentType` array is usually empty. Fall back to title
 * heuristics (apprenticeship roles are the main full-time-ish exception).
 */
export function inferEmploymentType(title = '', ldEmploymentType = []) {
  const types = Array.isArray(ldEmploymentType) ? ldEmploymentType.map(String) : [];
  if (types.some((t) => /full/i.test(t))) return 'FULL_TIME';
  if (types.some((t) => /part/i.test(t))) return 'PART_TIME';
  if (/apprenti|lehre|apprendist/i.test(title)) return 'FULL_TIME';
  return 'PART_TIME';
}

/* ── Network helpers ──────────────────────────────────────────── */

async function fetchText(url, { userAgent = DEFAULT_UA, timeoutMs = 15000, retries = 2, backoffMs = 800 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': userAgent, Accept: 'text/html,application/xml' },
        signal: controller.signal,
        redirect: 'follow',
      });
      if (res.ok) return await res.text();
      const retryable = res.status === 408 || res.status === 429 || (res.status >= 500 && res.status <= 599);
      if (!retryable) return null;
    } catch {
      // fall through to retry/backoff
    } finally {
      clearTimeout(timer);
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

/* ── Sitemap discovery ────────────────────────────────────────── */

function extractLocs(xml = '') {
  const locs = [];
  const regex = /<loc>([^<]+)<\/loc>/gi;
  let m;
  while ((m = regex.exec(xml)) !== null) locs.push(m[1].trim());
  return locs;
}

/**
 * Discover every open job's canonical detail-page URL via the public
 * sitemap index — no client-side JS, no bot-detection.
 */
export async function discoverMcdoJobUrls({ userAgent = DEFAULT_UA, timeoutMs = 15000 } = {}) {
  const indexXml = await fetchText(SITEMAP_INDEX_URL, { userAgent, timeoutMs });
  if (!indexXml) return { jobUrls: [], sitemapCount: 0 };

  const allSitemapUrls = extractLocs(indexXml).filter((u) => /\/sitemap-[0-9a-f]+-/.test(u));

  // Group per-job sitemaps by their hash prefix (one prefix == one job,
  // 4 locale variants of the same job ID) and pick the best available
  // locale per group.
  const groups = new Map();
  for (const url of allSitemapUrls) {
    const match = url.match(/\/sitemap-([0-9a-f]+)-([a-z-]+)\.xml$/i);
    if (!match) continue;
    const [, hash, locale] = match;
    if (!groups.has(hash)) groups.set(hash, {});
    groups.get(hash)[locale] = url;
  }

  const pickedSitemapUrls = [];
  for (const localesForHash of groups.values()) {
    const preferred = LOCALE_PREFERENCE.find((loc) => localesForHash[loc]) || Object.keys(localesForHash)[0];
    if (preferred) pickedSitemapUrls.push(localesForHash[preferred]);
  }

  const perGroupJobUrls = await runWithConcurrency(
    pickedSitemapUrls,
    async (sitemapUrl) => {
      const xml = await fetchText(sitemapUrl, { userAgent, timeoutMs });
      if (!xml) return [];
      return extractLocs(xml).filter((u) => /\/job\/[A-Za-z0-9-]+$/.test(u));
    },
    8
  );

  const jobUrls = [...new Set(perGroupJobUrls.flat())];
  return { jobUrls, sitemapCount: pickedSitemapUrls.length };
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
  const city = address.addressLocality || '';
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
    source: "McDonald's Dedicated Parser (sitemap + JSON-LD)",
  };
}

/**
 * Fetch and parse all McDonald's Switzerland jobs end-to-end.
 */
export async function fetchMcdoJobs({ userAgent = DEFAULT_UA, timeoutMs = 15000, detailConcurrency = 8 } = {}) {
  const { jobUrls, sitemapCount } = await discoverMcdoJobUrls({ userAgent, timeoutMs });
  console.log(`  🗺️  Sitemap groups: ${sitemapCount}, unique job URLs: ${jobUrls.length}`);
  if (jobUrls.length === 0) return [];

  const parsedList = await runWithConcurrency(
    jobUrls,
    (url) => fetchMcdoDetailPage(url, { userAgent, timeoutMs }),
    detailConcurrency
  );

  const jobs = [];
  for (const parsed of parsedList) {
    const job = buildMcdoJob(parsed);
    if (job) jobs.push(job);
  }
  return jobs;
}
