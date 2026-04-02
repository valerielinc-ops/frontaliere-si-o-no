/**
 * Helvetia Assicurazioni — jobs.helvetia.com job parser
 *
 * Helvetia is a Swiss insurance company with operations in Ticino.
 * The careers portal is at:
 *   https://jobs.helvetia.com/ch/?lang=it
 *
 * Job listings are displayed on the portal and may use a JSON API.
 * Job detail URLs typically follow patterns like:
 *   https://jobs.helvetia.com/ch/job/{slug}/{jobId}
 *
 * This parser extracts jobs from the listing page HTML.
 */

const CAREERS_URL = 'https://jobs.helvetia.com/ch/?lang=it';
const CAREERS_BASE = 'https://jobs.helvetia.com';
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
 * Parse the Helvetia listing page HTML to extract job links.
 * Returns array of { id, title, url, location, canton, department, jobId }
 */
export function parseHelvetiaListingHtml(html) {
  if (!html || typeof html !== 'string') return [];

  const jobs = [];

  // Pattern 1: job links with numeric IDs in path
  const linkRe = /<a\s+[^>]*href="([^"]*\/(?:job|stelle|position)[^"]*?\/(\d+)[^"]*)"/gi;
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
    const locationMatch = contextBlock.match(/(?:Lugano|Bellinzona|Locarno|Mendrisio|Chiasso|Zürich|Zurich|Bern|Basel|St\.\s*Gallen|Winterthur)/i);
    const location = locationMatch ? locationMatch[0] : 'Lugano';

    const deptMatch = contextBlock.match(/(?:Underwriting|Claims|Sinistri|Consulenza|Consulting|IT|Marketing|Finance|Finanza|HR|Legal|Operations|Actuarial|Attuariale|Sales|Vendite|Risk|Digital)/i);
    const department = deptMatch ? deptMatch[0] : '';

    jobs.push({
      id: `helvetia-${jobId}`,
      title: rawTitle,
      url: fullUrl,
      location,
      canton: 'TI',
      department,
      jobId,
    });
  }

  // Pattern 2: JSON API data embedded in page (common for modern career portals)
  if (jobs.length === 0) {
    const jsonRe = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
    let jMatch;
    while ((jMatch = jsonRe.exec(html)) !== null) {
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
            id: `helvetia-${jobId}`,
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

  // Pattern 3: generic job card links
  if (jobs.length === 0) {
    const genericRe = /<a\s+[^>]*href="(\/[^"]*(?:job|stelle|position|vacancy)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    let gMatch;
    while ((gMatch = genericRe.exec(html)) !== null) {
      const relUrl = gMatch[1];
      const rawTitle = normalizeSpace(stripHtml(gMatch[2]));
      if (!rawTitle || rawTitle.length < 3) continue;
      const idMatch = relUrl.match(/(\d{3,})/);
      const jobId = idMatch ? idMatch[1] : String(jobs.length + 1);
      jobs.push({
        id: `helvetia-${jobId}`,
        title: rawTitle,
        url: `${CAREERS_BASE}${relUrl}`,
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
 * Parse a Helvetia job detail page for description content.
 */
export function parseHelvetiaDetailHtml(html) {
  if (!html || typeof html !== 'string') return null;

  let rawHtml = '';

  const selectors = [
    /<div[^>]*class="[^"]*job[-_]?description[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class="[^"]*job[-_]?detail[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class="[^"]*description[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class="[^"]*vacancy[-_]?detail[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /<section[^>]*class="[^"]*job[^"]*"[^>]*>([\s\S]*?)<\/section>/i,
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
 * Fetch all job URLs from the Helvetia listing page.
 */
export async function fetchHelvetiaJobUrls(timeoutMs = 15000) {
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
    return parseHelvetiaListingHtml(html);
  } catch (err) {
    console.warn(`\u26a0\ufe0f Failed to fetch Helvetia careers page: ${err.message}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch and parse a single Helvetia detail page.
 */
export async function fetchHelvetiaDetailPage(url, timeoutMs = 15000) {
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
    return parseHelvetiaDetailHtml(html);
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
