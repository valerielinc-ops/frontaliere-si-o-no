/**
 * LIS – Lugano Istituti Sociali — Arca24 ATS parser
 *
 * The LIS careers portal at lavoraconnoi.lugano-lis.ch runs on the
 * Arca24 recruitment platform.  The shared crawler pipeline cannot
 * reach the Arca24 seed URLs because:
 *   1. The ATS host (lavoraconnoi.lugano-lis.ch) is a subdomain of
 *      the company website (lugano-lis.ch), NOT a recognised ATS host.
 *   2. Adapter seed URLs are routed as generic career URLs which are
 *      capped at 8 per company — by the time they are added, the cap
 *      is already filled by generic career-hint URLs from the main site.
 *
 * This parser bypasses the shared pipeline entirely and scrapes the
 * Arca24 listing + detail pages directly.
 *
 * Listing page structure (jobs.php):
 *   <div class="singleResult">
 *     <a href="../job/view-job.php?id=ID-SLUG&language=LANG"><h3>TITLE</h3></a>
 *     <table> location rows </table>
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
 *   <div itemprop="description">FULL DESCRIPTION</div>       ← preferred source
 *   <div class="jobDescription">FULL DESCRIPTION</div>       ← Arca24 variant
 *   <div class="descriptionContainer">SHORT SNIPPET</div>    ← fallback only
 */

import { getCompanyDefaults } from './crawler-location-config.mjs';

const HQ = getCompanyDefaults('lis');

const LIS_HOST = 'lavoraconnoi.lugano-lis.ch';
const LIS_BASE = `https://${LIS_HOST}`;
const COMPANY_NAME = 'LIS – Lugano Istituti Sociali';
const DEFAULT_UA = 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/; Slackbot compatible)';

const LISTING_URLS = [
  `${LIS_BASE}/jobs.php?custom2=Yes&source=direct`,
  `${LIS_BASE}/jobs.php?custom2=Yes&source=direct&page=2`,
];

// ── Utility helpers ──────────────────────────────────────────

export function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

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
    .replace(/&apos;/gi, "'")
    .replace(/&(sol|comma|ndash|NewLine|colo|times|deg|lpar|rpar);/gi, (_, ent) => {
      const map = {
        sol: '/', comma: ',', ndash: '\u2013', newline: '\n', colo: ':',
        times: '\u00d7', deg: '\u00b0', lpar: '(', rpar: ')',
      };
      return map[String(ent || '').toLowerCase()] || _;
    })
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function slugify(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 180);
}

function decodeHtmlEntities(html = '') {
  return String(html || '')
    .replace(/&(sol|comma|ndash|NewLine|colo|times|deg|amp|lt|gt|quot|apos|lpar|rpar);/gi, (_, ent) => {
      const map = {
        sol: '/', comma: ',', ndash: '\u2013', newline: '\n', colo: ':',
        times: '\u00d7', deg: '\u00b0', amp: '&', lt: '<', gt: '>',
        quot: '"', apos: "'", lpar: '(', rpar: ')',
      };
      return map[String(ent || '').toLowerCase()] || _;
    })
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function parseArca24Date(raw = '') {
  // Arca24 dates: DD/MM/YYYY
  const m = String(raw || '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return '';
  return `${m[3]}-${m[2]}-${m[1]}`; // ISO YYYY-MM-DD
}

function extractItemprop(html, prop) {
  // Extract text content of the first element with itemprop="prop"
  const regex = new RegExp(`itemprop=["']${prop}["'][^>]*>([^<]*)`, 'i');
  const m = html.match(regex);
  return m ? decodeHtmlEntities(normalizeSpace(m[1])) : '';
}

// ── Listing page parser ──────────────────────────────────────

/**
 * Parse the Arca24 listing page HTML and extract job URLs with metadata.
 * Returns an array of { url, title, location, snippet, dates }.
 */
export function parseArca24ListingPage(html, baseUrl = LIS_BASE) {
  const jobs = [];
  // Each job is in a <div class="singleResult">
  const resultRegex = /<div\s+class="singleResult[^"]*"[^>]*>([\s\S]*?)(?=<div\s+class="singleResult|<div\s+class="pagination|<\/main|<div\s+class="footer|$)/gi;
  let match;
  while ((match = resultRegex.exec(html)) !== null) {
    const block = match[1];

    // Extract link and title
    const linkMatch = block.match(/<a[^>]*href=["']([^"'#]+view-job\.php[^"'#]*)["'][^>]*>\s*<h3[^>]*>([\s\S]*?)<\/h3>/i);
    if (!linkMatch) continue;

    const relativeUrl = decodeHtmlEntities(linkMatch[1]);
    let absoluteUrl;
    try {
      absoluteUrl = new URL(relativeUrl, baseUrl).toString();
    } catch {
      continue;
    }

    const title = normalizeSpace(stripHtml(linkMatch[2]));
    if (!title || title.length < 3) continue;

    // Extract location from citySpan or location spans
    const cityMatch = block.match(/<span\s+class="citySpan"[^>]*>([^<]+)/i);
    const location = cityMatch ? decodeHtmlEntities(normalizeSpace(cityMatch[1])) : '';

    // Extract description snippet
    const descMatch = block.match(/<div\s+class="descriptionContainer[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const snippet = descMatch ? normalizeSpace(stripHtml(descMatch[1])) : '';

    // Extract dates
    const dateMatch = block.match(/<span\s+class="date"[^>]*>([^<]+)/i);
    const dates = dateMatch ? decodeHtmlEntities(normalizeSpace(dateMatch[1])) : '';

    jobs.push({ url: absoluteUrl, title, location, snippet, dates });
  }
  return jobs;
}

// ── Salary extraction ────────────────────────────────────────

/**
 * Extract salary information from LIS/ROCIS-style description text.
 * Patterns:
 *   "classe 7 min. CHF 64'017 / max. CHF 82'602"
 *   "classe 7: min. CHF 64'017.00 / max. CHF 82'602.00"
 *   "classe 9 min. CHF 72'636 / max. CHF 93'731"
 * When multiple classes are present, returns the highest salary range.
 * @returns {{ salaryClass: string, min: number, max: number, currency: string } | null}
 */
export function extractLisSalary(text) {
  if (!text) return null;
  // Match all "classe X ... min. CHF YYY / max. CHF ZZZ" occurrences
  const classRe = /classe\s+(\d{1,2})\s*:?\s*min\.?\s*CHF\s*([\d''\u2019.]+)\s*\/\s*max\.?\s*CHF\s*([\d''\u2019.]+)/gi;
  let m;
  let bestResult = null;
  while ((m = classRe.exec(text)) !== null) {
    const cls = m[1];
    const min = Math.round(parseFloat(m[2].replace(/['''\u2019]/g, '')) || 0);
    const max = Math.round(parseFloat(m[3].replace(/['''\u2019]/g, '')) || 0);
    if (Number.isFinite(min) && Number.isFinite(max) && min > 10000 && max > min) {
      if (!bestResult || max > bestResult.max) {
        bestResult = { salaryClass: cls, min, max, currency: 'CHF' };
      }
    }
  }
  if (bestResult) return bestResult;

  // Fallback: Swiss salary range pattern "CHF XX'XXX / CHF YY'YYY" without class
  const rangeMatch = text.match(/CHF\s*([\d''\u2019]{5,}(?:\.\d{2})?)\s*\/\s*(?:max\.?\s*)?CHF\s*([\d''\u2019]{5,}(?:\.\d{2})?)/i);
  if (rangeMatch) {
    const min = Math.round(parseFloat(rangeMatch[1].replace(/['''\u2019]/g, '')) || 0);
    const max = Math.round(parseFloat(rangeMatch[2].replace(/['''\u2019]/g, '')) || 0);
    if (Number.isFinite(min) && Number.isFinite(max) && min > 10000 && max > min) {
      return { salaryClass: '', min, max, currency: 'CHF' };
    }
  }

  return null;
}

// ── Detail page parser ───────────────────────────────────────

/**
 * Parse an Arca24 job detail page and extract structured job data.
 * Returns null if the page cannot be parsed.
 */
export function parseArca24DetailPage(html, pageUrl = '') {
  if (!html || typeof html !== 'string') return null;

  // Title from H1 (strip company name prefix and "Invia/Send/Envoyer" button text)
  const h1Match = html.match(/<h1[^>]*itemprop=["']title["'][^>]*>([\s\S]*?)<\/h1>/i);
  let title = '';
  if (h1Match) {
    title = normalizeSpace(stripHtml(h1Match[1]))
      .replace(/^LIS\s*[\u2013\-]\s*Lugano\s+Istituti\s+Sociali\s*/i, '')
      .replace(/\s+(Invia|Send|Envoyer|Senden)\s*$/i, '')
      .trim();
  }
  // Fallback to og:title
  if (!title || title.length < 3) {
    const ogMatch = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
    if (ogMatch) {
      title = normalizeSpace(ogMatch[1])
        .replace(/\s*-\s*(Svizzera|Switzerland|Suisse|Schweiz)\b.*$/i, '')
        .replace(/\s*-\s*LIS\b.*$/i, '')
        .trim();
    }
  }
  // Fallback to <title>
  if (!title || title.length < 3) {
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    if (titleMatch) {
      title = normalizeSpace(titleMatch[1])
        .replace(/\s*-\s*LIS\b.*$/i, '')
        .trim();
    }
  }
  if (!title || title.length < 3) return null;

  // Location from microdata
  const locality = extractItemprop(html, 'addressLocality') || '';
  const region = extractItemprop(html, 'addressRegion') || '';
  const streetAddress = extractItemprop(html, 'streetAddress') || '';
  const location = locality || region || 'Pregassona';

  // Sector and role
  const sector = extractItemprop(html, 'industry') || '';
  const role = extractItemprop(html, 'occupationalCategory') || '';

  // Dates
  const datePosted = parseArca24Date(extractItemprop(html, 'datePosted'));
  const validThrough = parseArca24Date(extractItemprop(html, 'validThrough'));

  // Description: extract main body content
  // Priority 1: <div itemprop="description"> — the semantic job description
  // Priority 2: <div class="jobDescription"> — common Arca24 variant
  // Priority 3: largest <div class="descriptionContainer"> — fallback
  let description = '';

  // Priority 1: itemprop="description" (may contain nested HTML)
  const itemDescMatch = html.match(/<div\s+[^>]*itemprop=["']description["'][^>]*>([\s\S]*?)<\/div>/i);
  if (itemDescMatch) {
    const candidate = stripHtml(itemDescMatch[1]);
    if (candidate.length > 50) description = candidate;
  }

  // Priority 2: <div class="jobDescription">
  if (!description) {
    const jobDescMatch = html.match(/<div\s+class="jobDescription[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    if (jobDescMatch) {
      const candidate = stripHtml(jobDescMatch[1]);
      if (candidate.length > 50) description = candidate;
    }
  }

  // Priority 3: largest descriptionContainer (skips short "related jobs" snippets)
  if (!description) {
    const descContainers = [];
    const descRegex = /<div\s+class="descriptionContainer[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
    let dm;
    while ((dm = descRegex.exec(html)) !== null) {
      const text = stripHtml(dm[1]);
      if (text.length > 50) {
        descContainers.push(text);
      }
    }
    descContainers.sort((a, b) => b.length - a.length);
    description = descContainers[0] || '';
  }

  // Extract salary from description if present
  // Pattern: "classe X min. CHF XX'XXX.XX / max. CHF XX'XXX.XX" (LIS/ROCIS format)
  // or "classe X: min. CHF XX'XXX / max. CHF XX'XXX"
  const salary = extractLisSalary(description);

  // Company name from microdata
  const orgMatch = html.match(/itemprop=["']name["'][^>]*>([^<]*LIS[^<]*Lugano[^<]*Istituti[^<]*)/i);
  const company = orgMatch ? normalizeSpace(orgMatch[1]) : COMPANY_NAME;

  return {
    title,
    company,
    location,
    streetAddress,
    region: region || 'Ticino',
    sector,
    role,
    datePosted,
    validThrough,
    description,
    salary,
    url: pageUrl,
  };
}

// ── Network helpers ──────────────────────────────────────────

async function fetchPage(url, { userAgent = DEFAULT_UA, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': userAgent },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Public API ───────────────────────────────────────────────

/**
 * Discover all job URLs from the Arca24 listing pages.
 * Returns an array of { url, title, location, snippet, dates }.
 */
export async function fetchLisJobUrls({ userAgent = DEFAULT_UA, timeoutMs = 15000 } = {}) {
  const allJobs = [];
  const seenUrls = new Set();

  for (const listingUrl of LISTING_URLS) {
    const html = await fetchPage(listingUrl, { userAgent, timeoutMs });
    if (!html) {
      console.warn(`  \u26a0\ufe0f Failed to fetch listing page: ${listingUrl}`);
      continue;
    }
    const jobs = parseArca24ListingPage(html, listingUrl);
    for (const job of jobs) {
      // Deduplicate by URL (strip language param for dedup)
      const dedupKey = job.url.replace(/[&?]language=[^&]*/g, '').toLowerCase();
      if (seenUrls.has(dedupKey)) continue;
      seenUrls.add(dedupKey);
      allJobs.push(job);
    }
  }

  return allJobs;
}

/**
 * Fetch and parse a single Arca24 job detail page.
 * Returns parsed job data or null on failure.
 */
export async function fetchLisDetailPage(url, { userAgent = DEFAULT_UA, timeoutMs = 15000 } = {}) {
  const html = await fetchPage(url, { userAgent, timeoutMs });
  if (!html) return null;
  return parseArca24DetailPage(html, url);
}

/**
 * Build a job object compatible with the shared crawler pipeline from parsed data.
 */
export function buildLisJob(url, parsed) {
  if (!parsed || !parsed.title) return null;
  const slug = slugify(parsed.title);
  if (!slug || slug.length < 3) return null;

  const job = {
    title: parsed.title,
    company: COMPANY_NAME,
    companyKey: 'lis-lugano-istituti-sociali',
    companyDomain: 'lugano-lis.ch',
    url,
    slug,
    location: parsed.location || 'Pregassona',
    canton: HQ.canton,
    country: 'CH',
    postalCode: parsed.location === 'Pregassona' ? '6963' : '6900',
    streetAddress: parsed.streetAddress || 'Via alla Bozzoreda 15',
    description: parsed.description || '',
    datePosted: parsed.datePosted || new Date().toISOString().split('T')[0],
    validThrough: parsed.validThrough || '',
    sector: parsed.sector || '',
    role: parsed.role || '',
    source: 'arca24',
    titleByLocale: { it: parsed.title, en: parsed.title, de: parsed.title, fr: parsed.title },
    slugByLocale: { it: slug, en: slug, de: slug, fr: slug },
    descriptionByLocale: { it: parsed.description || '', en: '', de: '', fr: '' },
  };

  // Add salary data if extracted from description
  if (parsed.salary) {
    job.salaryMin = parsed.salary.min;
    job.salaryMax = parsed.salary.max;
    job.salaryCurrency = parsed.salary.currency;
    if (parsed.salary.salaryClass) {
      job.salaryClass = parsed.salary.salaryClass;
    }
  }

  return job;
}
