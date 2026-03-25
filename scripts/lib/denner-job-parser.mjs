/**
 * Denner — jobs.migros.ch/denner-sa job parser
 *
 * Denner is a subsidiary of the Migros Group. Their jobs are listed on
 * the Migros Group jobs portal at jobs.migros.ch under the "Denner SA"
 * company filter. The portal is a Nuxt.js SSR application backed by
 * GraphQL/Typesense search.
 *
 * Denner has numerous stores across Ticino, making their positions
 * highly relevant for Italian cross-border workers.
 *
 * Exports:
 *   parseDennerListingPage(html)  — extract job links from listing page
 *   parseDennerDetailPage(html)   — extract job data from detail page
 *   isDennerTicinoJob(job)        — filter for Ticino positions
 *   isDennerJob(job)              — match Denner jobs in dataset
 *   DENNER_PORTAL_URL             — Migros Group portal URL for Denner
 */

/** Migros Group job portal URL for Denner */
export const DENNER_PORTAL_URL = 'https://jobs.migros.ch/it/le-nostre-imprese/denner-sa';

/** Ticino locations where Denner operates */
const TICINO_LOCATIONS = [
  'lugano', 'bellinzona', 'locarno', 'mendrisio', 'chiasso',
  'giubiasco', 'biasca', 'agno', 'manno', 'rivera',
  'camorino', 'tenero', 'losone', 'gordola', 'minusio',
  'massagno', 'pregassona', 'viganello', 'paradiso',
  'stabio', 'balerna', 'novazzano', 'coldrerio',
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
 * Extract job links from the Denner/Migros listing page.
 * The Migros portal uses Nuxt.js with job cards linking to detail pages.
 *
 * @param {string} html - Raw HTML of the listing page
 * @returns {{ url: string, title: string, location: string }[]}
 */
export function parseDennerListingPage(html = '') {
  if (!html) return [];

  const results = [];

  // Migros portal links pattern: /it/offerte-di-lavoro/{slug}
  const linkPattern = /href="(\/it\/offerte-di-lavoro\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkPattern.exec(html)) !== null) {
    const relUrl = match[1];
    const rawTitle = normalizeSpace(stripHtml(match[2]));
    if (relUrl && rawTitle && rawTitle.length > 3) {
      results.push({
        url: `https://jobs.migros.ch${relUrl}`,
        title: rawTitle,
        location: '',
      });
    }
  }

  // Also try German URL pattern
  const deLinkPattern = /href="(\/de\/stellenangebote\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  while ((match = deLinkPattern.exec(html)) !== null) {
    const relUrl = match[1];
    const rawTitle = normalizeSpace(stripHtml(match[2]));
    if (relUrl && rawTitle && rawTitle.length > 3) {
      results.push({
        url: `https://jobs.migros.ch${relUrl}`,
        title: rawTitle,
        location: '',
      });
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
 * Extract job data from a Denner/Migros detail page.
 * Migros detail pages have structured sections for overview, tasks,
 * skills, and benefits.
 *
 * @param {string} html - Raw HTML of a job detail page
 * @returns {{ title: string, body: string, location: string, percentage: string } | null}
 */
export function parseDennerDetailPage(html = '') {
  if (!html) return null;

  const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = titleMatch ? normalizeSpace(stripHtml(titleMatch[1])) : '';

  // Location from JSON-LD or page content
  let location = '';
  const locationMatch = html.match(/addressLocality['"]\s*:\s*['"]([^'"]+)/i)
    || html.match(/(?:Luogo|Standort|Location)\s*:?\s*([^<\n,]+)/i);
  if (locationMatch) {
    location = normalizeSpace(locationMatch[1]);
  }

  // Percentage
  let percentage = '';
  const pctMatch = html.match(/(\d+\s*(?:-\s*\d+)?\s*%)/);
  if (pctMatch) {
    percentage = normalizeSpace(pctMatch[1]);
  }

  // Body from main content
  let body = '';
  const contentMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
    || html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);

  if (contentMatch) {
    body = normalizeSpace(stripHtml(contentMatch[1]));
  }

  if (!title && !body) return null;

  return { title, body, location, percentage };
}

/**
 * Check if a Denner job is in Ticino.
 * @param {{ location?: string, canton?: string, city?: string }} job
 * @returns {boolean}
 */
export function isDennerTicinoJob(job) {
  if (!job) return false;
  const loc = String(job.location || job.city || '').toLowerCase();
  const canton = String(job.canton || '').toLowerCase();

  if (canton === 'ti' || canton === 'ticino' || canton === 'tessin') return true;

  return TICINO_LOCATIONS.some((kw) => loc.includes(kw));
}

/**
 * Check if a job belongs to Denner.
 * @param {object} job
 * @returns {boolean}
 */
export function isDennerJob(job) {
  if (!job) return false;
  const key = String(job.companyKey || '').toLowerCase();
  const company = String(job.company || '').toLowerCase();
  const url = String(job.url || '').toLowerCase();

  return (
    key === 'denner' ||
    key.includes('denner') ||
    company.includes('denner') ||
    url.includes('denner') ||
    (url.includes('jobs.migros.ch') && url.includes('denner'))
  );
}
