import { truncateSlugAtWordBoundary } from './slug-truncate.mjs';
/**
 * PKB Private Bank — Arca24 ATS parser
 *
 * Careers portal: https://careers.pkb.ch/jobs.php (Arca24 recruitment
 * platform — same ATS backend used by LIS Lugano Istituti Sociali).
 *
 * Root cause of the "0 jobs" false negative (#3797): the previous crawler
 * (retired in #222 for returning 0) fetched `jobs.php` with a generic bot
 * User-Agent and no query params. Arca24 detects that as a plain browser
 * and returns only a tiny `<script>` bounce snippet that JS-redirects to
 * `?source=...` — server-rendered HTML is never returned to a bare fetch().
 * Two things are required to get the real listing:
 *   1. A User-Agent Arca24 recognises as a crawler bot (e.g. containing
 *      "Slackbot") — same fix already proven working for LIS.
 *   2. The `?custom2=Yes&source=direct` query params, which some Arca24
 *      tenants (this one included) require to skip the JS bounce entirely.
 * Verified live (2026-07-08): this combination returns 2 published offers,
 * matching the real portal.
 *
 * Listing page structure (jobs.php) — identical to the LIS Arca24 tenant:
 *   <div class="singleResult responsiveOnly" role="listitem">
 *     <a href="../job/view-job.php?id=ID-SLUG&language=LANG"><h3>TITLE</h3></a>
 *     <span class="citySpan">CITY</span>
 *     <div class="descriptionContainer"><p>SNIPPET</p></div>
 *     <span class="date">DD/MM/YYYY - DD/MM/YYYY</span>
 *   </div>
 *
 * Detail page structure (view-job.php):
 *   <h1 itemprop="title"> ... TITLE ... <a>Invia/Send</a> </h1>
 *   <span itemprop="addressLocality">CITY</span>
 *   <span itemprop="addressRegion">CANTON</span>
 *   <span itemprop="streetAddress">STREET</span>
 *   <span itemprop="industry">SECTOR</span>
 *   <span itemprop="datePosted">DD/MM/YYYY</span>
 *   <strong itemprop="validThrough">DD/MM/YYYY</strong>
 *   <div itemprop="description">FULL DESCRIPTION</div>
 */
import { locateTagByAttribute, extractBalancedTagBlock } from './hospital-custom-html-helpers.mjs';
import { stripScriptsAndStyles } from './crawler-template.mjs';
import { readMetaContent } from './html-attr.mjs';

export const PKB_KEY = 'pkb-private-bank';
export const COMPANY_NAME = 'PKB Private Bank SA';
export const COMPANY_DOMAIN = 'pkb.ch';

const PKB_HOST = 'careers.pkb.ch';
const PKB_BASE = `https://${PKB_HOST}`;
// PKB's Arca24 tenant is small enough (a handful of open offers) that
// everything renders on a single unpaginated listing page — confirmed live:
// `&page=2` returns 0 result blocks, not a second page.
const LISTING_URLS = [`${PKB_BASE}/jobs.php?custom2=Yes&source=direct`];

// Arca24 requires a recognised bot User-Agent to serve server-rendered HTML
// instead of a JS-redirect bounce snippet (same fix proven for LIS).
const DEFAULT_UA = 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/; Slackbot compatible)';

export const HQ = {
  city: 'Lugano',
  canton: 'TI',
  postalCode: '6900',
  streetAddress: 'Via Serafino Balestra 1',
};

/* ── Text helpers ─────────────────────────────────────────────── */

export function stripHtml(html = '') {
  return String(html || '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
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
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
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

function parseArca24Date(raw = '') {
  const m = String(raw || '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return '';
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function extractItemprop(html, prop) {
  const regex = new RegExp(`itemprop=["']${prop}["'][^>]*>([^<]*)`, 'i');
  const m = html.match(regex);
  return m ? normalizeSpace(m[1]) : '';
}

/**
 * Infer employment type from title/description/percentage text.
 * Swiss job postings commonly include a percentage (e.g. "80-100%").
 */
export function inferEmploymentType(title = '', description = '', percentage = '') {
  const combined = `${title} ${percentage} ${description}`;
  if (/part[- ]?time|teilzeit|tempo parziale|temps partiel/i.test(combined)) return 'PART_TIME';
  const pctMatch = combined.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/) || combined.match(/(\d{2,3})\s*%/);
  if (pctMatch) {
    const maxPct = pctMatch[2] ? parseInt(pctMatch[2], 10) : parseInt(pctMatch[1], 10);
    if (maxPct < 80) return 'PART_TIME';
  }
  return 'FULL_TIME';
}

/* ── Listing page parser ─────────────────────────────────────── */

/**
 * Parse the Arca24 listing page HTML and extract job URLs with metadata.
 */
export function parsePkbListingPage(html, baseUrl = PKB_BASE) {
  if (!html || typeof html !== 'string') return [];
  const jobs = [];

  // The `singleResult` divs are deeply nested (details/dataContainer/...),
  // so a naive `[\s\S]*?<\/div>` non-greedy match ending on a lookahead for
  // "next singleResult or end of string" is unreliable for the LAST block:
  // real HTML never ends with a bare `</div>` immediately at EOF (there's
  // always trailing markup — footer, scripts, `</html>`), so the `$`
  // alternative never matches and the whole match silently fails, dropping
  // the final job on the page. Instead, find each block's START marker and
  // slice from there to the START of the next block (or EOF) — this needs
  // no well-formed closing-tag boundary at all.
  const markerRegex = /<div\s+class="singleResult[^"]*"[^>]*>/gi;
  const starts = [];
  let markerMatch;
  while ((markerMatch = markerRegex.exec(html)) !== null) {
    starts.push(markerMatch.index + markerMatch[0].length);
  }

  for (let i = 0; i < starts.length; i += 1) {
    const blockStart = starts[i];
    const blockEnd = i + 1 < starts.length ? starts[i + 1] : html.length;
    const block = html.slice(blockStart, blockEnd);

    const linkMatch = block.match(/<a[^>]*href=["']([^"'#]+view-job\.php[^"'#]*)["'][^>]*>\s*<h3[^>]*>([\s\S]*?)<\/h3>/i);
    if (!linkMatch) continue;

    let absoluteUrl;
    try {
      absoluteUrl = new URL(linkMatch[1], baseUrl).toString();
    } catch {
      continue;
    }

    const title = normalizeSpace(stripHtml(linkMatch[2]));
    if (!title || title.length < 3) continue;

    const cityMatch = block.match(/<span\s+class="citySpan"[^>]*>([^<]+)/i);
    const location = cityMatch ? normalizeSpace(cityMatch[1]) : '';

    const descMatch = block.match(/<div\s+class="descriptionContainer[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const snippet = descMatch ? normalizeSpace(stripHtml(descMatch[1])) : '';

    const dateMatch = block.match(/<span\s+class="date"[^>]*>([^<]+)/i);
    const dates = dateMatch ? normalizeSpace(dateMatch[1]) : '';

    jobs.push({ url: absoluteUrl, title, location, snippet, dates });
  }
  return jobs;
}

/* ── Detail page parser ──────────────────────────────────────── */

/**
 * Parse an Arca24 job detail page and extract structured job data.
 * Returns null if the page cannot be parsed.
 */
export function parsePkbDetailPage(html, pageUrl = '') {
  if (!html || typeof html !== 'string') return null;

  const h1Match = stripScriptsAndStyles(html).match(/<h1[^>]*itemprop=["']title["'][^>]*>([\s\S]*?)<\/h1>/i);
  let title = '';
  if (h1Match) {
    title = normalizeSpace(stripHtml(h1Match[1]))
      .replace(/^PKB\s*Private\s*Bank\s*(SA)?\s*/i, '')
      .replace(/\s+(Invia|Send|Envoyer|Senden)\s*$/i, '')
      .trim();
  }
  if (!title || title.length < 3) {
    const ogMatch = readMetaContent(html, 'og:title');
    if (ogMatch) {
      title = normalizeSpace(ogMatch)
        .replace(/\s*-\s*(Svizzera|Switzerland|Suisse|Schweiz)\b.*$/i, '')
        .replace(/\s*-\s*PKB\b.*$/i, '')
        .trim();
    }
  }
  if (!title || title.length < 3) return null;

  const locality = extractItemprop(html, 'addressLocality') || '';
  const region = extractItemprop(html, 'addressRegion') || '';
  const streetAddress = extractItemprop(html, 'streetAddress') || '';
  const location = locality || HQ.city;

  const sector = extractItemprop(html, 'industry') || '';
  const role = extractItemprop(html, 'occupationalCategory') || '';

  const datePosted = parseArca24Date(extractItemprop(html, 'datePosted'));
  const validThrough = parseArca24Date(extractItemprop(html, 'validThrough'));

  let description = '';
  const located = locateTagByAttribute(html, 'itemprop=["\']description["\']', { skipVoidTags: true });
  if (located) {
    const candidate = stripHtml(extractBalancedTagBlock(located.rest, located.tagName));
    if (candidate.length > 50) description = candidate;
  }
  if (!description) {
    const jobDescMatch = html.match(/<div\s+class="jobDescription[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    if (jobDescMatch) {
      const candidate = stripHtml(jobDescMatch[1]);
      if (candidate.length > 50) description = candidate;
    }
  }
  if (!description) {
    const descContainers = [];
    const descRegex = /<div\s+class="descriptionContainer[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
    let dm;
    while ((dm = descRegex.exec(html)) !== null) {
      const text = stripHtml(dm[1]);
      if (text.length > 50) descContainers.push(text);
    }
    descContainers.sort((a, b) => b.length - a.length);
    description = descContainers[0] || '';
  }

  return {
    title,
    location,
    streetAddress,
    region: region || 'Ticino',
    sector,
    role,
    datePosted,
    validThrough,
    description,
    url: pageUrl,
  };
}

/* ── Network helpers ──────────────────────────────────────────── */

async function fetchPage(url, { userAgent = DEFAULT_UA, timeoutMs = 15000, retries = 2, backoffMs = 1000 } = {}) {
  let lastErrorReason = '';
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': userAgent, Accept: 'text/html' },
        signal: controller.signal,
        redirect: 'follow',
      });
      if (res.ok) return await res.text();
      const status = res.status;
      const retryable = status === 408 || status === 429 || (status >= 500 && status <= 599);
      lastErrorReason = `HTTP ${status}`;
      if (!retryable) return null;
    } catch (err) {
      lastErrorReason = err?.name === 'AbortError' ? 'timeout' : (err?.message || 'fetch_error');
    } finally {
      clearTimeout(timer);
    }
    if (attempt < retries) {
      await new Promise((r) => setTimeout(r, backoffMs * Math.pow(2, attempt)));
    }
  }
  if (lastErrorReason) {
    console.warn(`  ⚠️ fetchPage exhausted retries for ${url}: ${lastErrorReason}`);
  }
  return null;
}

/**
 * Discover all job URLs from the PKB Arca24 listing pages.
 */
export async function fetchPkbJobUrls({ userAgent = DEFAULT_UA, timeoutMs = 15000 } = {}) {
  const allJobs = [];
  const seenUrls = new Set();
  const failedUrls = [];

  for (const listingUrl of LISTING_URLS) {
    const html = await fetchPage(listingUrl, { userAgent, timeoutMs });
    if (!html) {
      console.warn(`  ⚠️ Failed to fetch listing page: ${listingUrl}`);
      failedUrls.push(listingUrl);
      continue;
    }
    const jobs = parsePkbListingPage(html, PKB_BASE);
    for (const job of jobs) {
      const dedupKey = job.url.replace(/[&?]language=[^&]*/g, '').toLowerCase();
      if (seenUrls.has(dedupKey)) continue;
      seenUrls.add(dedupKey);
      allJobs.push(job);
    }
  }

  return {
    jobs: allJobs,
    attempted: LISTING_URLS.length,
    succeeded: LISTING_URLS.length - failedUrls.length,
    failed: failedUrls.length,
    failedUrls,
  };
}

/**
 * Fetch and parse a single PKB job detail page.
 * Returns parsed job data or null on failure.
 */
export async function fetchPkbDetailPage(url, { userAgent = DEFAULT_UA, timeoutMs = 15000 } = {}) {
  const html = await fetchPage(url, { userAgent, timeoutMs });
  if (!html) return null;
  return parsePkbDetailPage(html, url);
}

/**
 * Build a job object compatible with the shared crawler pipeline from parsed data.
 */
export function buildPkbJob(url, parsed) {
  if (!parsed || !parsed.title) return null;
  const slug = slugify(`${parsed.title}-pkb-private-bank-${parsed.location || HQ.city}`);
  if (!slug || slug.length < 3) return null;

  const description = parsed.description
    || `Posizione aperta presso PKB Private Bank SA a ${parsed.location || HQ.city} (TI). PKB è una banca privata svizzera indipendente fondata nel 1958, specializzata in gestione patrimoniale e private banking. Candidati tramite il portale ufficiale.`;

  return {
    title: parsed.title,
    company: COMPANY_NAME,
    companyKey: PKB_KEY,
    companyDomain: COMPANY_DOMAIN,
    url,
    slug,
    location: parsed.location || HQ.city,
    canton: HQ.canton,
    country: 'CH',
    postalCode: HQ.postalCode,
    streetAddress: parsed.streetAddress || HQ.streetAddress,
    description,
    // Canonical pipeline field is `postedDate` (the Arca24 microdata itemprop
    // is `datePosted`, but every downstream consumer — JobBoard, sitemap,
    // newsletter, assemble-jobs-dataset churn guard — reads `postedDate`).
    postedDate: parsed.datePosted || new Date().toISOString().split('T')[0],
    validThrough: parsed.validThrough || '',
    sector: parsed.sector || '',
    role: parsed.role || '',
    employmentType: inferEmploymentType(parsed.title, description),
    source: 'PKB Dedicated Parser (Arca24)',
    titleByLocale: { it: parsed.title },
    slugByLocale: { it: slug },
    descriptionByLocale: { it: description },
  };
}

/**
 * Fetch and parse all PKB Private Bank jobs end-to-end.
 * Returns an array of ParsedJob objects ready for the shared crawler pipeline.
 */
export async function fetchPkbJobs({ userAgent = DEFAULT_UA, timeoutMs = 15000 } = {}) {
  const { jobs: listingJobs } = await fetchPkbJobUrls({ userAgent, timeoutMs });
  const results = [];
  for (const listingJob of listingJobs) {
    const detail = await fetchPkbDetailPage(listingJob.url, { userAgent, timeoutMs });
    const merged = detail || { title: listingJob.title, location: listingJob.location, url: listingJob.url, description: listingJob.snippet };
    const job = buildPkbJob(listingJob.url, merged);
    if (job) results.push(job);
  }
  return results;
}
