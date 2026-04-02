/**
 * Salt Mobile SA — salt.ch job parser
 *
 * Salt is a major Swiss telecom operator with offices in Ticino.
 * The careers page is at:
 *   https://www.salt.ch/it/about-us/careers
 *
 * Job listings may be embedded in the page HTML or loaded via JS/API.
 * Job detail URLs typically follow patterns on the salt.ch domain
 * or link to an external ATS (e.g. Workday, Greenhouse, etc.).
 *
 * This parser extracts jobs from the careers page HTML.
 */

const CAREERS_URL = 'https://www.salt.ch/it/about-us/careers';
const CAREERS_BASE = 'https://www.salt.ch';
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
 * Parse the Salt Mobile listing page HTML to extract job links.
 * Returns array of { id, title, url, location, canton, department, jobId }
 */
export function parseSaltListingHtml(html) {
  if (!html || typeof html !== 'string') return [];

  const jobs = [];

  // Pattern 1: job links with numeric IDs in path or query
  const linkRe = /<a\s+[^>]*href="([^"]*(?:job|career|position|opening)[^"]*?(?:\/|[?&]id=)(\d+)[^"]*)"/gi;
  let match;

  while ((match = linkRe.exec(html)) !== null) {
    const rawUrl = match[1];
    const jobId = match[2];
    const fullUrl = rawUrl.startsWith('http') ? rawUrl : `${CAREERS_BASE}${rawUrl.startsWith('/') ? '' : '/'}${rawUrl}`;

    const afterLink = html.slice(match.index, match.index + 500);
    const titleMatch = afterLink.match(/<a\s+[^>]*>[^<]*<[^>]*>([^<]+)<\/[^>]*>\s*<\/a>/i)
      || afterLink.match(/<a\s+[^>]*>([^<]+)<\/a>/i);
    if (!titleMatch) continue;

    const rawTitle = normalizeSpace(stripHtml(titleMatch[1]));
    if (!rawTitle || rawTitle.length < 3) continue;

    const contextBlock = html.slice(match.index, match.index + 800);
    const locationMatch = contextBlock.match(/(?:Lugano|Bellinzona|Losanna|Lausanne|Zürich|Zurich|Bern|Basel|Genève|Geneva|Renens)/i);
    const location = locationMatch ? locationMatch[0] : 'Lugano';

    const deptMatch = contextBlock.match(/(?:Sales|Network|Engineering|Customer Service|IT|Marketing|Finance|HR|Legal|Operations|Retail|Technology|Digital)/i);
    const department = deptMatch ? deptMatch[0] : '';

    jobs.push({
      id: `salt-${jobId}`,
      title: rawTitle,
      url: fullUrl,
      location,
      canton: 'TI',
      department,
      jobId,
    });
  }

  // Pattern 2: JSON-LD structured data embedded in page
  if (jobs.length === 0) {
    const jsonLdRe = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
    let jMatch;
    while ((jMatch = jsonLdRe.exec(html)) !== null) {
      try {
        const data = JSON.parse(jMatch[1]);
        const postings = Array.isArray(data) ? data : (data['@type'] === 'JobPosting' ? [data] : []);
        for (const posting of postings) {
          if (posting['@type'] !== 'JobPosting') continue;
          const title = posting.title || '';
          const url = posting.url || '';
          const jobId = url.match(/(\d{3,})/) ? url.match(/(\d{3,})/)[1] : String(jobs.length + 1);
          if (title.length < 3) continue;
          jobs.push({
            id: `salt-${jobId}`,
            title: normalizeSpace(title),
            url,
            location: posting.jobLocation?.address?.addressLocality || 'Lugano',
            canton: 'TI',
            department: posting.industry || '',
            jobId,
          });
        }
      } catch { /* ignore invalid JSON-LD */ }
    }
  }

  // Pattern 3: generic career links
  if (jobs.length === 0) {
    const genericRe = /<a\s+[^>]*href="((?:https?:\/\/[^"]*(?:job|career|position|greenhouse|lever|workday)[^"]*))"[^>]*>([\s\S]*?)<\/a>/gi;
    let gMatch;
    while ((gMatch = genericRe.exec(html)) !== null) {
      const fullUrl = gMatch[1];
      const rawTitle = normalizeSpace(stripHtml(gMatch[2]));
      if (!rawTitle || rawTitle.length < 3) continue;
      const idMatch = fullUrl.match(/(\d{3,})/);
      const jobId = idMatch ? idMatch[1] : String(jobs.length + 1);
      jobs.push({
        id: `salt-${jobId}`,
        title: rawTitle,
        url: fullUrl,
        location: 'Lugano',
        canton: 'TI',
        department: '',
        jobId,
      });
    }
  }

  // Deduplicate by jobId
  const seen = new Set();
  return jobs.filter((j) => {
    if (seen.has(j.jobId)) return false;
    seen.add(j.jobId);
    return true;
  });
}

/**
 * Parse a Salt Mobile job detail page for description content.
 */
export function parseSaltDetailHtml(html) {
  if (!html || typeof html !== 'string') return null;

  let rawHtml = '';

  const selectors = [
    /<div[^>]*class="[^"]*job[-_]?description[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class="[^"]*job[-_]?detail[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class="[^"]*description[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class="[^"]*posting[-_]?description[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /<section[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/section>/i,
  ];

  for (const re of selectors) {
    const m = html.match(re);
    if (m && m[1] && m[1].length > 50) {
      rawHtml = m[1];
      break;
    }
  }

  if (!rawHtml) {
    const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
    if (mainMatch) rawHtml = mainMatch[1];
  }

  const description = normalizeSpace(stripHtml(rawHtml));

  return {
    description: description || '',
    rawHtml,
  };
}

/**
 * Fetch all job URLs from the Salt Mobile listing page.
 */
export async function fetchSaltJobUrls(timeoutMs = 15000) {
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
    return parseSaltListingHtml(html);
  } catch (err) {
    console.warn(`\u26a0\ufe0f Failed to fetch Salt Mobile careers page: ${err.message}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch and parse a single Salt Mobile detail page.
 */
export async function fetchSaltDetailPage(url, timeoutMs = 15000) {
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
    return parseSaltDetailHtml(html);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Infer employment type from title, description and optional percentage field.
 * Swiss job postings commonly include percentage (e.g. "80-100%").
 * @param {string} title
 * @param {string} description
 * @param {string} percentage
 * @returns {string} FULL_TIME or PART_TIME
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
