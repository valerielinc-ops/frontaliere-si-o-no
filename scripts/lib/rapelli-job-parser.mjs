/**
 * Rapelli (ORIOR Food AG) — careers.orior.ch job parser
 *
 * The Rapelli careers portal is hosted on ORIOR's SuccessFactors instance:
 *   https://careers.orior.ch/go/Rapelli-IT/5365701/
 *
 * Job detail URLs follow the pattern:
 *   https://careers.orior.ch/job/Stabio-{Title}-TI/{jobId}/
 *
 * HTML structure on the listing page:
 *   <a href="/job/{Location}-{Title}-TI/{jobId}/">Job Title</a>
 *   followed by company name, location, and department text
 *
 * This parser extracts jobs from the listing page HTML.
 */

const CAREERS_URL = 'https://careers.orior.ch/go/Rapelli-IT/5365701/';
const CAREERS_BASE = 'https://careers.orior.ch';
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
 * Parse the Rapelli listing page HTML to extract job links.
 * Returns array of { title, url, location, department }
 */
export function parseRapelliListingHtml(html) {
  if (!html || typeof html !== 'string') return [];

  const jobs = [];
  // Match job links: /job/{path}/{jobId}/
  const linkRe = /<a\s+[^>]*href="(\/job\/[^"]+\/(\d+)\/?)"/gi;
  let match;

  while ((match = linkRe.exec(html)) !== null) {
    const relUrl = match[1];
    const jobId = match[2];
    const fullUrl = `${CAREERS_BASE}${relUrl}`;

    // Extract the anchor text (title)
    const afterLink = html.slice(match.index, match.index + 500);
    const titleMatch = afterLink.match(/<a\s+[^>]*>[^<]*<[^>]*>([^<]+)<\/[^>]*>\s*<\/a>/i)
      || afterLink.match(/<a\s+[^>]*>([^<]+)<\/a>/i);
    if (!titleMatch) continue;

    const rawTitle = normalizeSpace(stripHtml(titleMatch[1]));
    if (!rawTitle || rawTitle.length < 3) continue;

    // Extract location from URL path (e.g., Stabio-Title-TI)
    const pathMatch = relUrl.match(/\/job\/([^/]+)/);
    let location = 'Stabio';
    if (pathMatch) {
      const parts = decodeURIComponent(pathMatch[1]).split('-');
      if (parts.length > 0) location = parts[0];
    }

    // Extract department from surrounding text
    const contextBlock = html.slice(match.index, match.index + 800);
    const deptMatch = contextBlock.match(/(?:Tecnologia|Ricerca e sviluppo|Produzione|Logistica|Qualità|Amministrazione|Risorse umane|Vendite|Marketing)/i);
    const department = deptMatch ? deptMatch[0] : '';

    jobs.push({
      id: `rapelli-${jobId}`,
      title: rawTitle,
      url: fullUrl,
      location,
      canton: 'TI',
      department,
      jobId,
    });
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
 * Parse a Rapelli job detail page for description content.
 */
export function parseRapelliDetailHtml(html) {
  if (!html || typeof html !== 'string') return null;

  // Extract job description from main content area
  const contentMatch = html.match(/<div[^>]*class="[^"]*job-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
    || html.match(/<div[^>]*class="[^"]*jobDisplay[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
    || html.match(/<div[^>]*class="[^"]*job_description[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

  const rawHtml = contentMatch ? contentMatch[1] : '';
  const description = normalizeSpace(stripHtml(rawHtml));

  return {
    description: description || '',
    rawHtml,
  };
}

/**
 * Fetch all job URLs from the Rapelli listing page.
 */
export async function fetchRapelliJobUrls(timeoutMs = 15000) {
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
    return parseRapelliListingHtml(html);
  } catch (err) {
    console.warn(`\u26a0\ufe0f Failed to fetch Rapelli careers page: ${err.message}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch and parse a single Rapelli detail page.
 */
export async function fetchRapelliDetailPage(url, timeoutMs = 15000) {
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
    return parseRapelliDetailHtml(html);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
