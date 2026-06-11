#!/usr/bin/env node
/**
 * Shared helpers to recover the REAL job description from a detail page when
 * the listing source only carries metadata (the canonical fix for the
 * boilerplate-guard failures of #1718/#1719/#1722/#1723 — see the Coop/Straumann
 * pattern in #1790). Extracted into ONE module instead of copy-pasting the same
 * regex into every parser (AGENTS.md rule #6: a regex duplicated in ≥2 files must
 * live in a single shared module so drift is impossible by-construction).
 *
 * Two extractors, both pure (no fetching) so they're trivially unit-testable:
 *   - extractJobPostingDescription(html): pulls the description out of a
 *     server-rendered schema.org/JobPosting embedded as a JSON-LD <script> block
 *     (Decathlon DigitalRecruiters detail pages, Straumann Phenom SSR pages).
 *   - extractMicrodataDescription(html): pulls the description out of an
 *     itemprop="description" microdata container (SuccessFactors jobs2web /
 *     RMK detail pages — Implenia, Liebherr).
 *
 * Both return '' on any miss so the caller can fall back to the listing teaser.
 */

/**
 * Extract the `description` of the first schema.org JobPosting found in any
 * `<script type="application/ld+json">` block. The description may itself be
 * HTML (Decathlon) — callers run it through stripHtml().
 *
 * @param {string} html
 * @returns {string} raw description (possibly HTML), or '' if none.
 */
export function extractJobPostingDescription(html = '') {
  if (!html || typeof html !== 'string') return '';
  const blocks = [...html.matchAll(
    /<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi,
  )].map((m) => m[1]);
  for (const block of blocks) {
    let data;
    try {
      data = JSON.parse(block);
    } catch {
      continue; // malformed JSON-LD block — skip
    }
    // A block may be a single object, an array, or a @graph wrapper.
    const candidates = [];
    const queue = Array.isArray(data) ? [...data] : [data];
    while (queue.length) {
      const node = queue.shift();
      if (!node || typeof node !== 'object') continue;
      if (Array.isArray(node['@graph'])) queue.push(...node['@graph']);
      candidates.push(node);
    }
    for (const node of candidates) {
      const type = node?.['@type'];
      const isJobPosting = Array.isArray(type)
        ? type.some((t) => String(t).includes('JobPosting'))
        : String(type || '').includes('JobPosting');
      if (isJobPosting && node.description) return String(node.description);
    }
  }
  return '';
}

/**
 * Balance-scan the `itemprop="description"` element of a microdata
 * schema.org/JobPosting page and return its inner HTML. Used by the
 * SuccessFactors jobs2web / RMK detail pages (Implenia, Liebherr) which embed
 * the body as microdata rather than a JSON-LD script.
 *
 * Depth-balanced on the element's own tag name so nested same-tag children
 * (the body is typically a `<div>` full of nested `<div>`/`<ul>`) are captured
 * whole. Returns '' when no such element exists (e.g. JS-rendered shells).
 *
 * @param {string} html
 * @returns {string} inner HTML of the description element, or ''.
 */
export function extractMicrodataDescription(html = '') {
  if (!html || typeof html !== 'string') return '';
  const startTag = html.match(/<(\w+)[^>]*itemprop="description"[^>]*>/i);
  if (!startTag) return '';
  const tag = startTag[1];
  const start = startTag.index + startTag[0].length;
  const openNeedle = `<${tag}`;
  const closeNeedle = `</${tag}>`;
  let pos = start;
  let depth = 1;
  while (depth > 0 && pos < html.length) {
    const nextOpen = html.indexOf(openNeedle, pos);
    const nextClose = html.indexOf(closeNeedle, pos);
    if (nextClose === -1) break; // unbalanced — bail
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth += 1;
      pos = nextOpen + openNeedle.length;
    } else {
      depth -= 1;
      pos = nextClose + closeNeedle.length;
    }
  }
  return html.slice(start, pos - closeNeedle.length);
}
