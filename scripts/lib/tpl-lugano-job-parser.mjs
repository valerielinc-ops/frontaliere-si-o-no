/**
 * TPL (Trasporti Pubblici Luganesi) — tplsa.ch job parser
 *
 * TPL is the public transport operator for the Lugano area in Ticino.
 * Their careers page at tplsa.ch/2/50/tpl-lavora-con-noi.html shows
 * open positions when available. The page is server-rendered HTML.
 *
 * This module exports:
 *   parseTplListingPage(html)  — extract job links from careers page
 *   parseTplDetailPage(html)   — extract job data from a detail page
 *   isTplJob(job)              — match TPL jobs in dataset
 */

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function stripHtml(html = '') {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
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
 * Extract job URLs from the TPL careers listing page.
 *
 * Real markup (verified live 2026-07): the "Elenco posizioni" table rows
 * link each open position to an application/detail page of the form
 *   <a style = "color: #68be4d" href = "/2/50/candidati/?idhr=748">
 *     <i class="fas fa-arrow-right"></i> Specialista Risorse Umane</a>
 * Notes:
 *   - the CMS emits spaces around the `=` of attributes (href = "..."),
 *   - `idhr=0` is the spontaneous-application form, not a job posting.
 *
 * @param {string} html - Raw HTML of the listing page
 * @returns {{ url: string, title: string }[]}
 */
export function parseTplListingPage(html = '') {
  if (!html) return [];

  const results = [];
  const seen = new Set();

  const linkPattern =
    /<a\b[^>]*href\s*=\s*"([^"]*\/candidati\/?\?[^"]*\bidhr=(\d+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkPattern.exec(html)) !== null) {
    const rawUrl = match[1].replace(/&amp;/g, '&');
    const idhr = match[2];
    if (idhr === '0') continue; // spontaneous-application form, not a posting

    const rawTitle = normalizeSpace(stripHtml(match[3]));
    if (!rawTitle || rawTitle.length < 3) continue;

    const url = rawUrl.startsWith('http')
      ? rawUrl
      : `https://www.tplsa.ch${rawUrl.startsWith('/') ? '' : '/'}${rawUrl}`;

    if (seen.has(url)) continue;
    seen.add(url);
    results.push({ url, title: rawTitle });
  }

  return results;
}

/**
 * Extract job data from a TPL detail page.
 *
 * @param {string} html - Raw HTML of a job detail page
 * @returns {{ title: string, body: string, location: string } | null}
 */
export function parseTplDetailPage(html = '') {
  if (!html) return null;

  const titleMatch = html.match(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/i);
  const title = titleMatch ? normalizeSpace(stripHtml(titleMatch[1])) : '';

  // TPL jobs are always in Lugano area
  const location = 'Lugano';

  let body = '';
  const contentMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
    || html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (contentMatch) {
    body = stripHtml(contentMatch[1]);
  }

  // Real tplsa.ch application pages (/2/50/candidati/?idhr=N) have no
  // <main>/<article>: the job block runs from the <h1> (title + link to the
  // PDF "capitolato" + application instructions) up to the generic "Menu2"
  // accordion of company cards that follows it.
  if (!body && titleMatch) {
    const afterTitle = html.slice(titleMatch.index + titleMatch[0].length);
    const endIdx = afterTitle.search(/<div[^>]*class\s*=\s*"[^"]*Menu2[^"]*"/i);
    if (endIdx >= 0) {
      body = stripHtml(afterTitle.slice(0, endIdx));
    }
  }

  body = body
    .split('\n')
    .map((line) => normalizeSpace(line))
    .filter(Boolean)
    .join('\n');

  if (!title && !body) return null;

  return { title, body, location };
}

/**
 * Check if a job belongs to TPL.
 * @param {object} job
 * @returns {boolean}
 */
export function isTplJob(job) {
  if (!job) return false;
  const company = String(job.company || '').toLowerCase();
  const key = String(job.companyKey || '').toLowerCase();
  const url = String(job.url || '').toLowerCase();
  return (
    key === 'tpl-lugano' ||
    key.includes('tpl') ||
    company.includes('trasporti pubblici luganesi') ||
    company.includes('tpl') ||
    url.includes('tplsa.ch')
  );
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
