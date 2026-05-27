/**
 * Linnea SA — WordPress Foundation accordion parser
 *
 * The Linnea careers page at https://www.linnea.ch/careers/ is a single
 * WordPress page using Foundation's accordion component.  All job listings
 * are embedded inline under the "OPEN POSITIONS" section.  There are NO
 * individual detail page URLs.
 *
 * HTML structure:
 *   <h2>OPEN POSITIONS</h2>
 *   <ul class="accordion" data-accordion>
 *     <li class="accordion-item" data-accordion-item>
 *       <a class="accordion-title"><h4>Title, Contract, Location, Country</h4></a>
 *       <div class="accordion-content" data-tab-content>
 *         <div class="filter"><p><a class="btn eng white active">ENG</a></p></div>
 *         <article class="eng active">
 *           <h3>Title</h3>
 *           <p>…</p>
 *           <ul><li>…</li></ul>
 *           <p class="apply"><a class="btn white">Apply</a></p>
 *         </article>
 *       </div>
 *     </li>
 *   </ul>
 */

import { JSDOM } from 'jsdom';

/** Minimum description length to accept (in characters, plain text). */
export const MIN_DESC_LENGTH = 350;

export function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * Convert HTML to plain text, preserving block-level paragraph structure.
 * Each paragraph / list item / heading gets its own line; consecutive blank
 * lines are collapsed to at most one blank line.
 */
export function htmlToText(html = '') {
  if (!html) return '';
  return String(html)
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    // Block elements: add a newline before their closing tag
    .replace(/<\/(?:p|li|h[1-6]|div|ul|ol|blockquote|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    // Ignore remaining open tags
    .replace(/<[^>]+>/g, '')
    // HTML entities
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#8211;/g, '–')
    .replace(/&#8217;/g, "'")
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"')
    // Normalize horizontal whitespace within each line but preserve newlines
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    // Remove lines that are only whitespace/empty, collapsing multiple blank lines to one
    .reduce((acc, line) => {
      if (line === '' && acc.length > 0 && acc[acc.length - 1] === '') return acc;
      acc.push(line);
      return acc;
    }, /** @type {string[]} */ ([]))
    .join('\n')
    .trim();
}

export function slugify(text = '', suffix = '') {
  let s = text
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

export function detectCategory(title = '') {
  const t = title.toLowerCase();
  if (/erp|it\b|system|admin|developer|engineer|software/i.test(t)) return 'technology';
  if (/qa|quality|gmp|validation/i.test(t)) return 'quality';
  if (/scientist|research|r&d|laboratory|lab\b/i.test(t)) return 'science';
  if (/produc|manufactur|operator/i.test(t)) return 'production';
  if (/legal|counsel|lawyer/i.test(t)) return 'legal';
  if (/account|financ|controller/i.test(t)) return 'finance';
  if (/hr|human|recruit/i.test(t)) return 'hr';
  if (/sales|commercial|marketing/i.test(t)) return 'sales';
  if (/logistic|supply|warehouse/i.test(t)) return 'logistics';
  return 'general';
}

export function detectExperienceLevel(title = '') {
  if (/junior|jr\.?|entry|intern|stage|stagist/i.test(title)) return 'ENTRY';
  if (/senior|sr\.?|lead|head|director|manager|principal/i.test(title)) return 'SENIOR';
  return 'MID';
}

/**
 * Parse all job accordion items from the Linnea careers page HTML.
 *
 * Uses JSDOM for correct handling of nested HTML (avoiding regex pitfalls
 * with nested `<li>` tags inside the job description lists).
 *
 * Returns an array of parsed job objects.  Items whose description is shorter
 * than MIN_DESC_LENGTH characters are skipped (guard against partial parses
 * caused by HTML structure changes).
 *
 * @param {string} html - Full HTML of the Linnea careers page
 * @returns {{ idx: number, title: string, contractType: string, location: string, descriptionText: string }[]}
 */
export function parseAccordionJobs(html) {
  const jobs = [];
  if (!html) return jobs;

  // Find the OPEN POSITIONS section before parsing — fast early exit
  if (!html.includes('OPEN POSITIONS')) {
    return jobs;
  }

  const document = new JSDOM(html).window.document;

  // All accordion items (Foundation: <li data-accordion-item>)
  const items = document.querySelectorAll('li[data-accordion-item]');

  let idx = 0;
  for (const item of items) {
    // Title heading: <a class="accordion-title"> > <h4>
    const h4 = item.querySelector('a.accordion-title h4');
    if (!h4) continue;

    idx++;
    const rawHeading = (h4.textContent || '').trim();

    // Parse the heading: "Title, Contract Type, Location, Country"
    const headingParts = rawHeading.split(',').map(s => s.trim());
    const title = headingParts[0] || '';
    const contractType = headingParts[1] || '';
    const location = headingParts[2] || 'Riazzino';

    if (!title || title.length < 3) continue;

    // Description body: first <article> inside accordion-content
    const article = item.querySelector('.accordion-content article');
    if (!article) continue;

    // Remove the apply button and duplicate title heading (in-place clone)
    const clone = /** @type {Element} */ (article.cloneNode(true));
    for (const el of clone.querySelectorAll('p.apply, h3')) el.remove();

    const descriptionText = htmlToText(clone.innerHTML);

    // Guard: skip items whose extracted description is too short to be useful.
    if (descriptionText.length < MIN_DESC_LENGTH) {
      console.warn(`  ⚠️  Item ${idx}: "${title}" — description too short (${descriptionText.length} chars < ${MIN_DESC_LENGTH}), skipped`);
      continue;
    }

    jobs.push({
      idx,
      title: normalizeSpace(title),
      contractType: normalizeSpace(contractType),
      location: normalizeSpace(location),
      descriptionText,
    });
  }

  return jobs;
}
