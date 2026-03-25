/**
 * ALDI Suisse — jobs.aldi.ch job parser
 *
 * ALDI Suisse uses SAP SuccessFactors as their ATS
 * (career5.successfactors.eu/company=aldisuis). The main careers page
 * at jobs.aldi.ch shows featured positions and links to the full
 * SuccessFactors portal.
 *
 * ALDI has stores across Ticino including locations in Lugano area,
 * Bellinzona, and other TI municipalities.
 *
 * Exports:
 *   parseAldiListingPage(html)     — extract job links from listing page
 *   parseAldiDetailPage(html)      — extract job data from detail page
 *   isAldiTicinoJob(job)           — filter for Ticino positions
 *   isAldiJob(job)                 — match ALDI jobs in dataset
 *   ALDI_SUCCESSFACTORS_BASE       — SuccessFactors base URL
 */

/** SAP SuccessFactors base URL for ALDI Suisse */
export const ALDI_SUCCESSFACTORS_BASE = 'https://career5.successfactors.eu/career?company=aldisuis';

/** Ticino locations where ALDI operates */
const TICINO_LOCATIONS = [
  'lugano', 'bellinzona', 'locarno', 'mendrisio', 'chiasso',
  'giubiasco', 'biasca', 'agno', 'manno', 'rivera',
  'camorino', 'tenero', 'losone', 'gordola',
  'ticino', 'tessin',
];

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function stripHtml(html = '') {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extract job links from the ALDI Suisse listing page.
 * The page shows featured positions as carousel cards.
 *
 * @param {string} html - Raw HTML of the listing page
 * @returns {{ url: string, title: string, location: string, percentage: string }[]}
 */
export function parseAldiListingPage(html = '') {
  if (!html) return [];

  const results = [];

  // ALDI uses carousel cards with job title + location
  // Look for links that lead to job detail pages
  const linkPattern = /href="([^"]*(?:career5\.successfactors|jobs\.aldi\.ch\/it\/[^"]*ricerca|jobs\.aldi\.ch\/[^"]*stelle)[^"]*)"/gi;
  let match;
  while ((match = linkPattern.exec(html)) !== null) {
    const url = match[1].startsWith('http') ? match[1] : `https://www.jobs.aldi.ch${match[1]}`;
    results.push({ url, title: '', location: '', percentage: '' });
  }

  // Also look for direct job title + location patterns in the HTML
  const jobCardPattern = /<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  while ((match = jobCardPattern.exec(html)) !== null) {
    const href = match[1];
    const content = normalizeSpace(stripHtml(match[2]));
    // Skip if it's a navigation link
    if (!content || content.length < 5) continue;
    if (/^(home|menu|login|kontakt|contatti)/i.test(content)) continue;

    // Check if it looks like a job posting (has percentage or Mostra/Show)
    if (/\d+\s*%|mostra|show|vedi|anzeigen/i.test(content)) {
      const url = href.startsWith('http') ? href : `https://www.jobs.aldi.ch${href}`;
      results.push({ url, title: content, location: '', percentage: '' });
    }
  }

  // Deduplicate
  const seen = new Set();
  return results.filter((r) => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });
}

/**
 * Extract job data from an ALDI Suisse detail page.
 *
 * @param {string} html - Raw HTML of a job detail page
 * @returns {{ title: string, body: string, location: string, percentage: string } | null}
 */
export function parseAldiDetailPage(html = '') {
  if (!html) return null;

  const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
    || html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
  const title = titleMatch ? normalizeSpace(stripHtml(titleMatch[1])) : '';

  // Location
  let location = '';
  const locationMatch = html.match(/(?:Standort|Sede|Location)\s*:?\s*([^<\n,]+)/i)
    || html.match(/addressLocality['"]\s*:\s*['"]([^'"]+)/i);
  if (locationMatch) {
    location = normalizeSpace(locationMatch[1]);
  }

  // Percentage
  let percentage = '';
  const pctMatch = html.match(/(\d+\s*(?:-\s*\d+)?\s*%)/);
  if (pctMatch) {
    percentage = normalizeSpace(pctMatch[1]);
  }

  // Body
  let body = '';
  const contentMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
    || html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
    || html.match(/<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

  if (contentMatch) {
    body = normalizeSpace(stripHtml(contentMatch[1]));
  }

  if (!title && !body) return null;

  return { title, body, location, percentage };
}

/**
 * Check if an ALDI job is in Ticino.
 * @param {{ location?: string, canton?: string, city?: string }} job
 * @returns {boolean}
 */
export function isAldiTicinoJob(job) {
  if (!job) return false;
  const loc = String(job.location || job.city || '').toLowerCase();
  const canton = String(job.canton || '').toLowerCase();

  if (canton === 'ti' || canton === 'ticino' || canton === 'tessin') return true;

  return TICINO_LOCATIONS.some((kw) => loc.includes(kw));
}

/**
 * Check if a job belongs to ALDI Suisse.
 * @param {object} job
 * @returns {boolean}
 */
export function isAldiJob(job) {
  if (!job) return false;
  const key = String(job.companyKey || '').toLowerCase();
  const company = String(job.company || '').toLowerCase();
  const url = String(job.url || '').toLowerCase();

  return (
    key === 'aldi-suisse' ||
    key.includes('aldi') ||
    company.includes('aldi') ||
    url.includes('jobs.aldi.ch') ||
    url.includes('aldi.ch') ||
    (url.includes('successfactors') && url.includes('aldisuis'))
  );
}
