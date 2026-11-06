/**
 * Mikron Group — Drupal-based job listing parser
 *
 * Mikron Group is a Swiss industrial/precision manufacturing company with
 * two Swiss sites: Mikron Machining in Agno (Ticino) and Mikron Automation
 * in Boudry (Neuchâtel). Both publish on the same national career page; the
 * canton is derived per-job from each teaser's location value.
 *
 * Career page: https://www.mikron.com/en/group/our-people/join-us/jobs
 * The page uses a Drupal Views module; the first page of job teasers is
 * rendered server-side with division, function, and location metadata.
 */

import { isSwissLocationText } from './target-swiss-locations.mjs';
import { normalizeDescriptionSpace, stripScriptsAndStyles } from './crawler-template.mjs';
import { truncateSlugAtWordBoundary } from './slug-truncate.mjs';
import { dropFabricatedLocaleText } from './source-locale-description.mjs';
import { dropFabricatedDescription } from './drop-fabricated-description.mjs';

export const MIKRON_CAREERS_URL = 'https://www.mikron.com/en/group/our-people/join-us/jobs';
export const MIKRON_HOST = 'www.mikron.com';

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
  return truncateSlugAtWordBoundary(s, 200);
}

/**
 * Check if a location string resolves to a Swiss site.
 */
export function isSwissLocation(locationText = '') {
  return isSwissLocationText(locationText);
}

/**
 * Return one balanced listing element starting at an opening row tag.
 * Views rows can contain nested divs, so a first-closing-tag regex is not a
 * reliable boundary for extracting metadata.
 */
function extractBalancedRowHtml(html, start) {
  const opening = html.slice(start).match(/^<(article|div|tr)\b[^>]*>/i);
  if (!opening) return '';

  const tag = opening[1];
  const tagRe = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
  tagRe.lastIndex = start;
  let depth = 0;
  let match;
  while ((match = tagRe.exec(html)) !== null) {
    const token = match[0];
    if (token.startsWith('</')) {
      depth -= 1;
      if (depth === 0) return html.slice(start, tagRe.lastIndex);
    } else if (!/\/\s*>$/.test(token)) {
      depth += 1;
    }
  }
  return '';
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
 * @param {boolean} options.filterSwiss - If true, keep jobs matching the
 *   Swiss location helper (default: false → all Swiss sites)
 * @returns {Array<{title: string, url: string, division: string, jobFunction: string, location: string, idx: number}>}
 */
export function parseMikronJobs(html = '', options = {}) {
  const filterSwiss = options.filterSwiss ?? false;
  if (!html || typeof html !== 'string') return [];

  const jobs = [];
  let idx = 0;

  // Strategy 0 (primary): the Drupal "open_jobs" view renders one
  // <article class="mi-job-teaser"> per job, server-side, with a
  // job-attributes block that includes the real "Location" value
  // (e.g. "Switzerland, Boudry" for the Automation division in NE,
  // "Switzerland, Agno" for Machining in TI). Parse the full article so
  // the location is never fabricated and non-Agno (NE/…) jobs survive.
  const teaserRe = /<article[^>]*class="[^"]*mi-job-teaser[^"]*"[^>]*>([\s\S]*?)<\/article>/gi;
  let teaserMatch;
  while ((teaserMatch = teaserRe.exec(html)) !== null) {
    const block = teaserMatch[1];
    const linkMatch = block.match(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    const url = linkMatch[1];
    const title = normalizeSpace(htmlToText(linkMatch[2]));
    if (!title || title.length < 3) continue;

    const text = normalizeSpace(htmlToText(block));
    const locMatch = block.match(/(Switzerland|Germany|France|China|USA|Singapore|Lithuania)\s*,\s*([A-Za-zÀ-ÿ.\-\s]+?)\s*</i)
      || text.match(/(Switzerland|Germany|France|China|USA|Singapore|Lithuania)\s*,\s*([A-Za-zÀ-ÿ.\-]+)/i);
    const location = locMatch ? normalizeSpace(`${locMatch[1]}, ${locMatch[2]}`) : '';
    const divisionMatch = text.match(/Division\s+([A-Za-z&\s]+?)(?=\s+(?:Function|Location|Workload|$))/i);

    idx++;
    jobs.push({
      title,
      url: url.startsWith('http') ? url : `https://${MIKRON_HOST}${url}`,
      division: divisionMatch ? normalizeSpace(divisionMatch[1]) : '',
      jobFunction: '',
      location,
      idx,
    });
  }
  if (jobs.length > 0) {
    // A Swiss-only parse must have a positive Swiss signal; an unknown
    // location is not safe to publish before detail enrichment verifies it.
    const filtered = filterSwiss ? jobs.filter((j) => isSwissLocation(j.location)) : jobs;
    return dedupeByUrl(filtered);
  }

  // Strategy 1: Look for views-row or article elements containing job links
  const rowRe = /<(?:article|div|tr)[^>]*class="[^"]*(?:views-row|job(?:[-\s"]|$)|node(?:[-\s"]|$))[^"]*"[^>]*>([\s\S]*?)<\/(?:article|div|tr)>/gi;
  let rowMatch;
  while ((rowMatch = rowRe.exec(html)) !== null) {
    const rowStart = rowMatch.index ?? 0;
    const rowHtml = extractBalancedRowHtml(html, rowStart) || rowMatch[0];
    // Prevent the row regex from re-entering nested wrappers in the same row.
    rowRe.lastIndex = rowStart + rowHtml.length;
    const block = rowHtml;
    const linkMatch = block.match(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;

    const url = linkMatch[1];
    const title = normalizeSpace(htmlToText(linkMatch[2]));
    if (!title || title.length < 3) continue;

    // Extract metadata fields
    const textContent = normalizeSpace(htmlToText(rowHtml));
    const divisionMatch = textContent.match(/(?:division|business)[:\s]*([A-Za-z\s&]+?)(?=\s*(?:function|location|$))/i);
    const functionMatch = textContent.match(/(?:function|category)[:\s]*([A-Za-z\s&/]+?)(?=\s*(?:location|$))/i);
    const locationMatch = textContent.match(/(Switzerland\s*,\s*[A-Za-z]+)/i)
      || textContent.match(/(?:location|place)[:\s]*([A-Za-z\s,]+?)$/i);

    const division = divisionMatch ? normalizeSpace(divisionMatch[1]) : '';
    const jobFunction = functionMatch ? normalizeSpace(functionMatch[1]) : '';
    const location = locationMatch ? normalizeSpace(locationMatch[1]) : '';

    if (filterSwiss && !isSwissLocation(location)) continue;

    idx++;
    jobs.push({
      title,
      url: url.startsWith('http') ? url : `https://${MIKRON_HOST}${url}`,
      division,
      jobFunction,
      location,
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
        location: '',
        idx,
      });
    }
  }

  return dedupeByUrl(filterSwiss ? jobs.filter((j) => isSwissLocation(j.location)) : jobs);
}

/** Deduplicate parsed job rows by their (lowercased) URL. */
function dedupeByUrl(jobs = []) {
  const seen = new Set();
  return jobs.filter((j) => {
    const key = String(j.url || '').toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Inner HTML of the first `<div>` matched by `openRx`, read to its balanced
 * closing tag (nested divs included). '' when absent or unbalanced.
 */
function balancedDivInner(html, openRx) {
  const open = openRx.exec(html);
  if (!open) return '';
  const start = open.index + open[0].length;
  const tagRx = /<\/?div\b[^>]*>/gi;
  tagRx.lastIndex = start;
  let depth = 1;
  let tag;
  while ((tag = tagRx.exec(html))) {
    if (tag[0][1] === '/') {
      depth -= 1;
      if (depth === 0) return html.slice(start, tag.index);
    } else {
      depth += 1;
    }
  }
  return '';
}

/**
 * The vacancy body of the current mikron.com template: `<div id="job-content">`
 * holds the h1, an "Apply" button, the `job-attributes` table (Division /
 * Function / Related location) and then the posting itself (intro, h3
 * sections, lists), followed by a second "Apply" button. Only the posting is
 * returned, as line-preserving text; the title, buttons and attribute table
 * are page chrome that used to open every published description
 * ("Polymecanic Team Leader Apply Division Automation Function …").
 */
function mikronJobContentText(html = '') {
  let body = balancedDivInner(html, /<div[^>]*\bid=["']job-content["'][^>]*>/i);
  if (!body) return '';
  const attributes = /<div[^>]*\bclass=["'][^"']*\bjob-attributes\b[^"']*["'][^>]*>/i.exec(body);
  if (attributes) {
    const inner = balancedDivInner(body.slice(attributes.index), /<div[^>]*>/i);
    const end = attributes.index + attributes[0].length + inner.length;
    body = body.slice(0, attributes.index) + body.slice(body.indexOf('</div>', end) + '</div>'.length);
  }
  body = body
    .replace(/<h1\b[^>]*>[\s\S]*?<\/h1>/gi, '')
    .replace(/<a\b[^>]*href=["'][^"']*\/apply\?[^"']*["'][^>]*>[\s\S]*?<\/a>/gi, '');
  return normalizeDescriptionSpace(htmlToText(body)).replace(/\n{2,}(?=• )/g, '\n');
}

/**
 * The Italian company blurb the runner used to write into
 * `descriptionByLocale.it` of every job ("Posizione aperta: <title> presso
 * Mikron Group …"). The locale-preserving merge keeps an existing non-source
 * translation forever, so the fossil has to be removed from the stored jobs
 * explicitly; the localization step then translates the real posting.
 * Returns true when the job was changed.
 */
const MIKRON_IT_FALLBACK_RE = /^Posizione aperta: [\s\S]*? presso Mikron Group [\s\S]*Mikron Group è un leader globale/;

export function dropMikronItalianFallback(job) {
  return dropFabricatedLocaleText(job, 'it', MIKRON_IT_FALLBACK_RE);
}

// The English company paragraph the runner published when a detail page was
// thin or unreadable ("Open position: … Mikron Group is a global leader in
// precision manufacturing …"): text the source never showed.
const MIKRON_EN_FALLBACK_RE = /Mikron Group is a global leader in precision manufacturing and automation/;

/**
 * Remove every description the runner once wrote itself from a stored job:
 * the Italian blurb and the English fallback paragraph (with the translations
 * made from it). Returns true when the job was changed.
 */
export function dropMikronFabricatedText(job) {
  const italian = dropMikronItalianFallback(job);
  const english = dropFabricatedDescription(job, MIKRON_EN_FALLBACK_RE);
  return italian || english;
}

/**
 * A freshly crawled job whose detail body is under the shared word floor
 * carries no description: keep the body stored from an earlier read of the
 * source, or leave the job unpublished this run (shared helper).
 */
export { keepStoredSourceBodies as keepMikronSourceBodies } from './stored-source-body.mjs';

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

  const titleSource = stripScriptsAndStyles(html);
  const titleMatch = titleSource.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
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

  const description = mikronJobContentText(html) || normalizeSpace(htmlToText(contentHtml));

  const locationMatch = html.match(/(?:location|standort)[:\s]*(Switzerland\s*,\s*[A-Za-z]+)/i);
  const location = locationMatch ? normalizeSpace(locationMatch[1]) : '';

  const divisionMatch = html.match(/(?:division|business\s*unit)[:\s]*([A-Za-z\s&]+)/i);
  const division = divisionMatch ? normalizeSpace(divisionMatch[1]) : '';

  return { title, description, location, division };
}
