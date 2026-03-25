/**
 * PKB Private Bank — careers portal parser
 *
 * Main page: https://www.pkb.ch/en/about-us/work-with-us/
 * Careers portal: https://careers.pkb.ch/jobs.php?source=&lan=en&language=en
 *
 * The careers portal (careers.pkb.ch) uses JavaScript-based redirect/tracking.
 * Job listings may need to be extracted from the rendered HTML or from
 * a separate API endpoint.
 *
 * This parser handles both the main PKB page (for links) and the
 * careers portal (for actual job listings).
 */

const CAREERS_URL = 'https://www.pkb.ch/en/about-us/work-with-us/';
const CAREERS_PORTAL = 'https://careers.pkb.ch/jobs.php?source=&lan=en&language=en';
const CAREERS_BASE = 'https://careers.pkb.ch';
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
 * Parse the PKB careers portal HTML for job listings.
 * The portal may use various HTML structures — we try multiple patterns.
 */
export function parsePkbListingHtml(html) {
  if (!html || typeof html !== 'string') return [];

  const jobs = [];

  // Strategy 1: Look for job links with typical patterns
  // careers.pkb.ch/job-details.php?id=XXX or similar
  const linkRe = /<a\s+[^>]*href="([^"]*(?:job[_-]?details|position|vacancy|offer)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = linkRe.exec(html)) !== null) {
    const href = match[1];
    const rawTitle = normalizeSpace(stripHtml(match[2]));
    if (!rawTitle || rawTitle.length < 3) continue;

    const fullUrl = href.startsWith('http') ? href : new URL(href, CAREERS_BASE).href;
    const idMatch = href.match(/[?&]id=(\d+)/i) || href.match(/\/(\d+)\/?$/);
    const jobId = idMatch ? idMatch[1] : slugify(rawTitle).slice(0, 30);

    jobs.push({
      id: `pkb-private-bank-${jobId}`,
      title: rawTitle,
      url: fullUrl,
      jobId,
      location: 'Lugano',
      canton: 'TI',
    });
  }

  // Strategy 2: Look for table rows or list items with job-like content
  if (jobs.length === 0) {
    const rowRe = /<(?:tr|li|div)\s+[^>]*class="[^"]*(?:job|position|vacancy|offer|listing)[^"]*"[^>]*>([\s\S]*?)<\/(?:tr|li|div)>/gi;
    while ((match = rowRe.exec(html)) !== null) {
      const block = match[1];
      const titleMatch = block.match(/<(?:a|h[1-6]|strong|b)[^>]*>([\s\S]*?)<\/(?:a|h[1-6]|strong|b)>/i);
      if (!titleMatch) continue;

      const rawTitle = normalizeSpace(stripHtml(titleMatch[1]));
      if (!rawTitle || rawTitle.length < 3) continue;

      const linkMatch = block.match(/<a\s+[^>]*href="([^"]+)"/i);
      const url = linkMatch
        ? (linkMatch[1].startsWith('http') ? linkMatch[1] : new URL(linkMatch[1], CAREERS_BASE).href)
        : CAREERS_PORTAL;

      jobs.push({
        id: `pkb-private-bank-${slugify(rawTitle).slice(0, 40)}`,
        title: rawTitle,
        url,
        jobId: slugify(rawTitle).slice(0, 30),
        location: 'Lugano',
        canton: 'TI',
      });
    }
  }

  // Strategy 3: Fallback — look for any links containing job-related keywords in the title text
  if (jobs.length === 0) {
    const allLinksRe = /<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    while ((match = allLinksRe.exec(html)) !== null) {
      const href = match[1];
      const rawTitle = normalizeSpace(stripHtml(match[2]));

      // Filter for job-like titles (must contain banking/finance keywords or typical role words)
      if (!rawTitle || rawTitle.length < 10) continue;
      if (!/(?:analyst|manager|officer|director|specialist|associate|advisor|consultant|compliance|risk|wealth|portfolio|banking|relationship|intern|stage|assistant|developer|engineer)/i.test(rawTitle)) continue;

      const fullUrl = href.startsWith('http') ? href : new URL(href, CAREERS_BASE).href;

      jobs.push({
        id: `pkb-private-bank-${slugify(rawTitle).slice(0, 40)}`,
        title: rawTitle,
        url: fullUrl,
        jobId: slugify(rawTitle).slice(0, 30),
        location: 'Lugano',
        canton: 'TI',
      });
    }
  }

  // Deduplicate by title
  const seen = new Set();
  return jobs.filter((j) => {
    const key = j.title.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Fetch and parse the PKB careers portal.
 */
export async function fetchPkbJobs(timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(CAREERS_PORTAL, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html',
        'User-Agent': UA,
      },
      redirect: 'follow',
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    return parsePkbListingHtml(html);
  } catch (err) {
    console.warn(`\u26a0\ufe0f Failed to fetch PKB careers portal: ${err.message}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse a PKB job detail page for description.
 */
export function parsePkbDetailHtml(html) {
  if (!html || typeof html !== 'string') return null;

  // Extract main content area
  const contentMatch = html.match(/<div[^>]*class="[^"]*(?:content|description|detail|body)[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  const rawHtml = contentMatch ? contentMatch[1] : '';
  const description = normalizeSpace(stripHtml(rawHtml));

  // Extract requirements/bullets
  const bullets = [];
  const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = liRe.exec(rawHtml)) !== null) {
    const text = normalizeSpace(stripHtml(m[1]));
    if (text.length > 5) bullets.push(text);
  }

  return {
    description: description || '',
    bullets,
  };
}
