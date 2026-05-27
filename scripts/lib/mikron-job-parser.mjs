/**
 * Mikron Group — Drupal-based job listing parser
 *
 * Mikron Group is a Swiss industrial/precision manufacturing company
 * with operations in Agno, Canton Ticino (Mikron Machining division).
 *
 * Career page: https://www.mikron.com/en/group/our-people/join-us/jobs
 * The page uses a Drupal Views module with AJAX filtering.
 * Jobs are rendered as HTML cards with division, function, and location metadata.
 *
 * Location filter for Agno: ?location=Switzerland%2C+Agno
 */

import { isTargetSwissLocation } from './target-swiss-locations.mjs';

export const MIKRON_CAREERS_URL = 'https://www.mikron.com/en/group/our-people/join-us/jobs';
export const MIKRON_AGNO_URL = `${MIKRON_CAREERS_URL}?location=Switzerland%2C+Agno`;
export const MIKRON_HOST = 'www.mikron.com';

export const AGNO_LOCATION_KEYWORDS = ['agno', 'ticino', 'lugano'];

/**
 * Normalize whitespace.
 */
export function normalizeSpace(value = '') {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Strip HTML tags and decode entities.
 */
export function htmlToText(html = '') {
  if (!html) return '';
  return String(html)
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/(?:p|li|h[1-6]|div|ul|ol)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\u00a0/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Slugify a text string.
 */
export function slugify(value = '', suffix = '') {
  let s = String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (suffix) {
    s = `${s}-${suffix}`.replace(/--+/g, '-');
  }
  return s.slice(0, 200);
}

/**
 * Check if a location string refers to Agno/Ticino.
 */
export function isAgnoLocation(locationText = '') {
  return isTargetSwissLocation(locationText);
}

/**
 * Parse job listings from Mikron's Drupal HTML career page.
 *
 * Job cards typically have structure like:
 *   <article> or <div class="views-row">
 *     <h3><a href="/en/.../job-title">Job Title</a></h3>
 *     <div class="field--division">Division Name</div>
 *     <div class="field--function">Function Name</div>
 *     <div class="field--location">Switzerland, Agno</div>
 *   </article>
 *
 * @param {string} html - Raw HTML of the jobs page
 * @param {object} options - Options
 * @param {boolean} options.filterAgno - If true, only return Agno jobs (default: true)
 * @returns {Array<{title: string, url: string, division: string, jobFunction: string, location: string, idx: number}>}
 */
export function parseMikronJobs(html = '', options = {}) {
  const { filterAgno = true } = options;
  if (!html || typeof html !== 'string') return [];

  const jobs = [];
  let idx = 0;

  // Strategy 1: Look for views-row or article elements containing job links
  const rowRe = /<(?:article|div|tr)[^>]*class="[^"]*(?:views-row|job|node)[^"]*"[^>]*>([\s\S]*?)<\/(?:article|div|tr)>/gi;
  let rowMatch;
  while ((rowMatch = rowRe.exec(html)) !== null) {
    const block = rowMatch[1];
    const linkMatch = block.match(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;

    const url = linkMatch[1];
    const title = normalizeSpace(htmlToText(linkMatch[2]));
    if (!title || title.length < 3) continue;

    // Extract metadata fields
    const textContent = normalizeSpace(htmlToText(block));
    const divisionMatch = textContent.match(/(?:division|business)[:\s]*([A-Za-z\s&]+?)(?=\s*(?:function|location|$))/i);
    const functionMatch = textContent.match(/(?:function|category)[:\s]*([A-Za-z\s&/]+?)(?=\s*(?:location|$))/i);
    const locationMatch = textContent.match(/(?:location|place)[:\s]*([A-Za-z\s,]+?)$/i)
      || textContent.match(/(Switzerland\s*,\s*[A-Za-z]+)/i);

    const division = divisionMatch ? normalizeSpace(divisionMatch[1]) : '';
    const jobFunction = functionMatch ? normalizeSpace(functionMatch[1]) : '';
    const location = locationMatch ? normalizeSpace(locationMatch[1]) : '';

    if (filterAgno && location && !isAgnoLocation(location)) continue;

    idx++;
    jobs.push({
      title,
      url: url.startsWith('http') ? url : `https://${MIKRON_HOST}${url}`,
      division,
      jobFunction,
      location: location || 'Switzerland, Agno',
      idx,
    });
  }

  // Strategy 2: Fallback — look for links to job detail pages within the content
  if (jobs.length === 0) {
    const jobLinkRe = /<a[^>]*href="(\/en\/[^"]*(?:join-us|jobs|career)[^"]*\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let jlMatch;
    while ((jlMatch = jobLinkRe.exec(html)) !== null) {
      const url = jlMatch[1];
      const title = normalizeSpace(htmlToText(jlMatch[2]));
      if (!title || title.length < 3) continue;
      // Skip pagination/filter links
      if (/page=|next|previous|filter|sort/i.test(url)) continue;

      idx++;
      jobs.push({
        title,
        url: `https://${MIKRON_HOST}${url}`,
        division: '',
        jobFunction: '',
        location: 'Switzerland, Agno',
        idx,
      });
    }
  }

  // Deduplicate by URL
  const seen = new Set();
  return jobs.filter((j) => {
    const key = j.url.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Parse a Mikron job detail page for description.
 *
 * The detail pages on mikron.com typically have:
 *   - <h1> with the job title
 *   - Main content in <article>, <main>, or div.node/field--body
 *   - Sections for responsibilities, requirements, what we offer
 *
 * @param {string} html - Raw HTML of the job detail page
 * @returns {{ title: string, description: string, location: string, division: string }}
 */
export function parseMikronJobDetail(html = '') {
  if (!html) return { title: '', description: '', location: '', division: '' };

  const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = titleMatch ? normalizeSpace(htmlToText(titleMatch[1])) : '';

  // Strategy 1: Look for the main content area (article/main/content nodes)
  let contentHtml = '';
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  const nodeMatch = html.match(/<div[^>]*class="[^"]*(?:node|content|job-detail|field--body|layout-content|block-system)[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<\/div>|<div[^>]*class="[^"]*(?:footer|sidebar))/i);

  if (articleMatch) contentHtml = articleMatch[1];
  else if (mainMatch) contentHtml = mainMatch[1];
  else if (nodeMatch) contentHtml = nodeMatch[1];

  // Strategy 2: Extract all paragraphs, lists, and headings between h1 and footer/nav
  if (!contentHtml || normalizeSpace(htmlToText(contentHtml)).length < 50) {
    // Get everything after h1 up to footer/nav
    const afterH1 = html.match(/<\/h1>([\s\S]*?)(?:<footer|<nav[^>]*class="[^"]*(?:footer|nav)|<div[^>]*id="footer")/i);
    if (afterH1) contentHtml = afterH1[1];
    else {
      // Fallback: get all content between body tags
      const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      if (bodyMatch) contentHtml = bodyMatch[1];
    }
  }

  // Strip navigation, scripts, styles, and header elements from content
  contentHtml = contentHtml
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '');

  const description = normalizeSpace(htmlToText(contentHtml));

  const locationMatch = html.match(/(?:location|standort)[:\s]*(Switzerland\s*,\s*[A-Za-z]+)/i);
  const location = locationMatch ? normalizeSpace(locationMatch[1]) : '';

  const divisionMatch = html.match(/(?:division|business\s*unit)[:\s]*([A-Za-z\s&]+)/i);
  const division = divisionMatch ? normalizeSpace(divisionMatch[1]) : '';

  return { title, description, location, division };
}
