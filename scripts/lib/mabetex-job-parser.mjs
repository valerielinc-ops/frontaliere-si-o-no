/**
 * Mabetex Group — mabetex.com job parser
 *
 * Mabetex Group is a construction/engineering company headquartered in Lugano,
 * Canton Ticino, with global operations in construction and development.
 *
 * Careers page: https://www.mabetex.com/career/
 *
 * HTML structure: standard corporate website with job entries linking to
 * detail pages or embedded descriptions.
 */

const CAREERS_URL = 'https://www.mabetex.com/career/';
const CAREERS_BASE = 'https://www.mabetex.com';
const UA = 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function stripHtml(html = '') {
  return String(html || '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\s+/g, ' ')
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

/**
 * Infer employment type from title, description and optional percentage field.
 * Swiss job postings commonly include percentage (e.g. "80-100%").
 */
export function inferEmploymentType(title = '', description = '', percentage = '') {
  const combined = `${title} ${percentage} ${description}`;
  if (/part[- ]?time|teilzeit|tempo parziale|temps partiel/i.test(combined)) return 'PART_TIME';
  const pctMatch = combined.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/) || combined.match(/(\d{2,3})\s*%/);
  if (pctMatch) {
    const maxPct = pctMatch[2] ? parseInt(pctMatch[2]) : parseInt(pctMatch[1]);
    if (maxPct < 80) return 'PART_TIME';
  }
  return 'FULL_TIME';
}

/**
 * Parse the Mabetex careers page HTML to extract job links.
 * Returns array of { title, url, location }
 *
 * Matches <a> tags linking to career detail pages or containing job titles.
 * Common patterns:
 *   - /career/{slug}/ or /career/{slug}.html
 *   - /careers/{slug}/
 *   - Anchors with job-related class names or within job listing containers
 */
export function parseMabetexListingHtml(html) {
  if (!html || typeof html !== 'string') return [];

  const jobs = [];
  // Match links to career detail pages: /career/something or /careers/something
  const linkRe = /<a\s+[^>]*href="(\/career(?:s)?\/[^"#?]+)"/gi;
  let match;

  while ((match = linkRe.exec(html)) !== null) {
    const relUrl = match[1];
    // Skip the main /career/ page itself and asset links
    if (/^\/careers?\/?$/.test(relUrl)) continue;
    if (/\.(css|js|png|jpg|jpeg|gif|svg|pdf|ico)$/i.test(relUrl)) continue;

    const fullUrl = `${CAREERS_BASE}${relUrl}`;

    // Extract the anchor text (title)
    const afterLink = html.slice(match.index, match.index + 800);
    const titleMatch = afterLink.match(/<a\s+[^>]*>([^<]+)<\/a>/i)
      || afterLink.match(/<a\s+[^>]*>[^<]*<[^>]*>([^<]+)<\/[^>]*>/i);
    if (!titleMatch) continue;

    const rawTitle = normalizeSpace(stripHtml(titleMatch[1]));
    if (!rawTitle || rawTitle.length < 3) continue;

    // Try to extract location from surrounding context
    const contextBlock = html.slice(match.index, match.index + 1200);
    const locationMatch = contextBlock.match(/(?:Lugano|Pristina|Astana|Riyadh|Moscow|Prishtina|Zurich|Geneva|Switzerland)/i);
    const location = locationMatch ? locationMatch[0] : 'Lugano';

    jobs.push({
      title: rawTitle,
      url: fullUrl,
      location,
    });
  }

  // Deduplicate by URL
  const seen = new Set();
  return jobs.filter((j) => {
    const key = j.url.replace(/\/+$/, '').toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Parse a Mabetex job detail page for description content.
 */
export function parseMabetexDetailHtml(html) {
  if (!html || typeof html !== 'string') return null;

  let rawHtml = '';

  // Try common content selectors for corporate job pages
  const selectors = [
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /<div[^>]*class="[^"]*(?:job[-_]?description|career[-_]?content|entry[-_]?content|post[-_]?content|page[-_]?content)[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class="[^"]*content[-_]?area[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<main[^>]*>([\s\S]*?)<\/main>/i,
  ];

  for (const re of selectors) {
    const m = html.match(re);
    if (m) {
      rawHtml = m[1] || m[0];
      break;
    }
  }

  // Fallback: extract the largest text block between common markers
  if (!rawHtml) {
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (bodyMatch) rawHtml = bodyMatch[1];
  }

  const description = normalizeSpace(stripHtml(rawHtml));

  return {
    description: description || '',
    rawHtml,
  };
}

/**
 * Fetch all job URLs from the Mabetex careers page.
 */
export async function fetchMabetexJobUrls(timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(CAREERS_URL, {
      signal: controller.signal,
      headers: { Accept: 'text/html', 'User-Agent': UA },
      redirect: 'follow',
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    return parseMabetexListingHtml(html);
  } catch (err) {
    console.warn(`\u26a0\ufe0f Failed to fetch Mabetex careers page: ${err.message}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch and parse a single Mabetex detail page.
 */
export async function fetchMabetexDetailPage(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'text/html', 'User-Agent': UA },
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const html = await res.text();
    return parseMabetexDetailHtml(html);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
