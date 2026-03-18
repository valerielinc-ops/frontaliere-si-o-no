/**
 * IRSOL / USI Drupal detail-page parser
 *
 * IRSOL jobs on the USI listing page link to external HTML pages on irsol.usi.ch
 * (Drupal CMS) instead of PDF calls. This module provides:
 *
 *   - `extractDrupalNodeId(url)` — stable numeric Drupal node ID from URL path
 *   - `extractIrsolDetailPage(html)` — title + full body from a Drupal detail page
 *
 * The Drupal node ID (e.g. "41206") appears as the numeric suffix in both the
 * Italian and English URL variants, making it the reliable cross-lingual match key:
 *
 *   IT: https://www.irsol.usi.ch/it/eventi-notizie/...del-41206
 *   EN: https://www.irsol.usi.ch/en/events-news/...scientist-41206
 */

import { JSDOM } from 'jsdom';

/** Minimum character count for a body to be considered "full content". */
export const MIN_IRSOL_BODY_LENGTH = 200;

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
 * Extract the trailing numeric Drupal node ID from a URL path segment.
 *
 * Matches a sequence of ≥4 digits at the very end of the last path segment,
 * preceded by a non-digit character (dash, underscore, start-of-segment).
 *
 * Examples:
 *   ".../posizione-a-tempo-pieno-di-scienziatoingegnere-del-41206" → "41206"
 *   ".../full-time-position-of-an-instrumentation-scientist-41206"  → "41206"
 */
export function extractDrupalNodeId(url = '') {
  try {
    const pathname = new URL(url).pathname;
    const last = pathname.split('/').filter(Boolean).pop() || '';
    const m = last.match(/(?:^|[-_])(\d{4,})$/);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

/**
 * Extract title and full body text from an IRSOL/USI Drupal detail page.
 *
 * Title priority: h1.page-title → h1.node-title → first h1
 *
 * Body priority (Drupal field selectors → article/main fallbacks):
 *   .field-name-body .field-item
 *   .field-type-text-with-summary .field-item
 *   .field-name-body
 *   article .field-items
 *   article .content
 *   .node-content
 *   main article
 *   main [role="main"]
 *
 * Returns { title, body } where body is plain-text (HTML stripped).
 * If no selector produces text ≥ MIN_IRSOL_BODY_LENGTH the body is returned
 * as-is from the best candidate (may be shorter than the minimum).
 */
export function extractIrsolDetailPage(html = '') {
  if (!html) return { title: '', body: '' };

  const { document } = new JSDOM(html).window;

  // ── Title ────────────────────────────────────────────────────
  const titleEl = document.querySelector('h1.page-title, h1.node-title, h1');
  const title = normalizeSpace(titleEl?.textContent || '');

  // ── Body ─────────────────────────────────────────────────────
  const BODY_SELECTORS = [
    '.field-name-body .field-item',
    '.field-type-text-with-summary .field-item',
    '.field-name-body',
    'article .field-items',
    'article .content',
    '.node-content',
    'main article',
    'main [role="main"]',
  ];

  let body = '';
  let bestCandidate = '';

  for (const sel of BODY_SELECTORS) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const text = stripHtml(el.innerHTML || '');
    if (!bestCandidate) bestCandidate = text;
    if (text.length >= MIN_IRSOL_BODY_LENGTH) {
      body = text;
      break;
    }
  }

  if (!body && bestCandidate) body = bestCandidate;

  return { title, body };
}
