/**
 * DXT Commodities S.A. — WordPress WPSM accordion parser
 *
 * DXT careers page at https://dxt.com/careers/ uses the WPSM accordion
 * plugin on WordPress. Each location (London, Lugano, Singapore, Stamford)
 * has its own accordion group; each job is a panel within a group.
 *
 * HTML structure (simplified):
 *   <!-- hidden "no results" placeholder for each group -->
 *   <div class="noresults_GROUPID wpsm_panel-group" style="display:none"
 *        id="accordion_pro_GROUPID">...</div>
 *   <!-- real accordion group -->
 *   <div class="wpsm_panel-group" id="accordion_pro_GROUPID">
 *     <div class="wpsm_panel panel wpsm_panel-default" id="offset_GROUPID_N">
 *       <div class="wpsm_panel-heading">
 *         <h4 class="wpsm_panel-title">
 *           <a ...><i class="fa ..."></i> Job Title</a>
 *         </h4>
 *       </div>
 *       <div id="collapse_GROUPID_N" class="wpsm_panel-collapse">
 *         <div class="wpsm_panel-body">
 *           <div id="#wpsm_acc_desc_GROUPID_N" class="wpsm_panel-body_inner ...">
 *             <h1>Job Title</h1>      <!-- optional: title heading in body -->
 *             <p>Description...</p>
 *             <ul><li>...</li></ul>
 *           </div>
 *         </div>
 *       </div>
 *     </div>
 *   </div>
 *
 * Title extraction:
 *   Primary:  text of .wpsm_panel-title a (icons stripped)
 *   Guard:    if a <h1>/<h2>/<h3> exists in the body, compare with tab title
 *             using word-level Jaccard overlap.  If overlap < MIN_TITLE_OVERLAP,
 *             emit a warning and use the content title instead.
 *
 * The content-title heading is also stripped from the description body to avoid
 * duplicating the job title at the start of the description text.
 */

import { JSDOM } from 'jsdom';
import { titleOverlap, MIN_TITLE_OVERLAP } from './title-utils.mjs';
import { isTargetSwissLocation } from './target-swiss-locations.mjs';
export { titleOverlap, MIN_TITLE_OVERLAP };

/** Minimum plain-text description length to accept (characters). */
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
    // Strip remaining tags
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
    // Collapse consecutive blank lines to at most one
    .reduce((acc, line) => {
      if (line === '' && acc.length > 0 && acc[acc.length - 1] === '') return acc;
      acc.push(line);
      return acc;
    }, /** @type {string[]} */ ([]))
    .join('\n')
    .trim();
}


/**
 * Identify which accordion group IDs belong to the Lugano/Switzerland section.
 *
 * Strategy 1: Find an <h2>/<h3> whose text contains a Lugano/Switzerland keyword,
 *             then scan the next ~3000 chars for the first accordion_pro_XXXXX.
 * Strategy 2: Fallback — look for section elements with Lugano-related IDs.
 *
 * @param {string} html - Full page HTML
 * @returns {string[]} accordion group IDs
 */
export function findLuganoAccordionIds(html) {
  const ids = new Set();

  // Scan all h2/h3 headings for target Swiss location keywords
  const headingRe = /<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi;
  let m;
  while ((m = headingRe.exec(html)) !== null) {
    const headingText = m[1].replace(/<[^>]+>/g, '');
    if (!isTargetSwissLocation(headingText)) continue;
    const afterHeading = html.slice(m.index + m[0].length, m.index + m[0].length + 3000);
    const accMatch = afterHeading.match(/id="accordion_pro_(\d+)"/);
    if (accMatch) ids.add(accMatch[1]);
  }

  if (ids.size === 0) {
    const sectionRe = /id="(?:lugano|switzerland)"/gi;
    while ((m = sectionRe.exec(html)) !== null) {
      const afterSection = html.slice(m.index, m.index + 5000);
      const accMatch = afterSection.match(/id="accordion_pro_(\d+)"/);
      if (accMatch) ids.add(accMatch[1]);
    }
  }

  return [...ids];
}

/**
 * Parse all job panels from a WPSM accordion group using JSDOM.
 *
 * @param {string} html            - Page HTML (or accordion group HTML)
 * @param {string} accordionGroupId - Numeric group ID (e.g. "20897")
 * @returns {{ panelId: string, title: string, descriptionText: string }[]}
 */
export function parseWpsmAccordionPanels(html, accordionGroupId) {
  const jobs = [];
  if (!html || !accordionGroupId) return jobs;

  const document = new JSDOM(html).window.document;

  // The WPSM plugin renders two elements with the same id:
  //   1. <div class="noresults_GROUPID ..." style="display:none" id="accordion_pro_GROUPID">
  //      — hidden placeholder, skip it
  //   2. <div class="wpsm_panel-group" id="accordion_pro_GROUPID">
  //      — the real accordion
  const allAccordions = document.querySelectorAll(`[id="accordion_pro_${accordionGroupId}"]`);
  const accordion = Array.from(allAccordions).find(
    el => !el.classList.contains(`noresults_${accordionGroupId}`)
  );
  if (!accordion) return jobs;

  const panels = accordion.querySelectorAll(`[id^="offset_${accordionGroupId}_"]`);

  for (const panel of panels) {
    // ── Tab title ──────────────────────────────────────────────────────────
    // <h4 class="wpsm_panel-title"><a ...><i class="fa..."></i> TITLE</a></h4>
    const titleEl = panel.querySelector('.wpsm_panel-title a');
    if (!titleEl) continue;

    const titleClone = /** @type {Element} */ (titleEl.cloneNode(true));
    // Strip icon elements (<i>, <img>, <svg>) before reading title text
    for (const icon of titleClone.querySelectorAll('i, img, svg')) icon.remove();
    const tabTitle = normalizeSpace(titleClone.textContent || '');

    if (!tabTitle || tabTitle.length < 3) {
      console.log(`  ⏭️  Panel ${accordionGroupId}_?: empty tab title — skipped`);
      continue;
    }

    // ── Panel body ─────────────────────────────────────────────────────────
    const bodyInner = panel.querySelector('.wpsm_panel-body_inner');
    if (!bodyInner) continue;

    const bodyText = bodyInner.textContent || '';

    // Skip "no open positions" placeholders
    if (/no\s+open\s+positions|nessuna\s+posizione/i.test(bodyText)) {
      console.log(`  ⏭️  Panel "${tabTitle}": no open positions — skipped`);
      continue;
    }

    // ── Title overlap guard ─────────────────────────────────────────────────
    // Cross-check the tab title against the first heading in the panel body.
    // If a panel body heading exists but overlaps less than MIN_TITLE_OVERLAP
    // with the tab title, the tab title may be a generic navigation label —
    // use the content title instead.
    const firstHeading = bodyInner.querySelector('h1, h2, h3');
    const contentTitle = firstHeading ? normalizeSpace(firstHeading.textContent || '') : '';

    let title = tabTitle;
    if (contentTitle && contentTitle.length >= 3) {
      const overlap = titleOverlap(tabTitle, contentTitle);
      if (overlap < MIN_TITLE_OVERLAP) {
        console.warn(
          `  ⚠️  Panel "${tabTitle}": overlap ${overlap.toFixed(2)} < ${MIN_TITLE_OVERLAP} ` +
          `with content title "${contentTitle}" — using content title`
        );
        title = contentTitle;
      }
    }

    // ── Description ─────────────────────────────────────────────────────────
    // Clone body inner, strip the title heading (h1/h2/h3) to avoid duplicating
    // the job title at the top of the description text.
    const bodyClone = /** @type {Element} */ (bodyInner.cloneNode(true));
    const headingToStrip = bodyClone.querySelector('h1, h2, h3');
    if (headingToStrip) headingToStrip.remove();

    const descriptionText = htmlToText(bodyClone.innerHTML);

    if (descriptionText.length < MIN_DESC_LENGTH) {
      console.warn(
        `  ⚠️  Panel "${title}": description too short ` +
        `(${descriptionText.length} chars < ${MIN_DESC_LENGTH}) — skipped`
      );
      continue;
    }

    // ── Panel ID ───────────────────────────────────────────────────────────
    // Element id is "offset_GROUPID_N" — extract "GROUPID_N"
    const panelIdMatch = panel.id.match(/offset_(\d+_\d+)$/);
    const panelId = panelIdMatch ? panelIdMatch[1] : panel.id.replace(/^offset_/, '');

    jobs.push({ panelId, title, descriptionText });
  }

  return jobs;
}
