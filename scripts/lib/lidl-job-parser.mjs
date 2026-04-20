/**
 * Lidl Svizzera — team.lidl.ch detail page parser
 *
 * The Lidl career site (team.lidl.ch) is a Nuxt/Vue SPA with server-side
 * rendering. Each job detail page contains structured sections (Aufgaben,
 * Profil, Mehrwert) with <ul> bullet-point lists that are richer than the
 * JSON-LD "description" abstract field that the base crawler extracts.
 *
 * This module provides `parseLidlDetailPage(html)` to extract the full
 * multi-section body from the rendered HTML, with two hard guards:
 *   1. body length ≥ MIN_LIDL_FULL_DESC (400 chars)
 *   2. body must contain list content (at least one "- " bullet line)
 *
 * When the guards are not met the extracted body is still returned (shorter /
 * unstructured), letting callers decide whether to use it.
 */

import { JSDOM } from 'jsdom';

/** Minimum body length for a "full" Lidl job description. */
export const MIN_LIDL_FULL_DESC = 400;

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
 * Convert an element's inner HTML to plain text, preserving <li> bullets as
 * "- " markers so callers can detect structured list content.
 */
function innerTextWithBullets(el) {
  if (!el) return '';
  // Replace <li>…</li> with "- …\n" before stripping all other tags
  const html = el.innerHTML
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/li>/gi, '\n');
  return stripHtml(html);
}

/**
 * True if the extracted text contains at least one bullet line.
 * Allows optional leading whitespace before the "- " marker — JSDOM innerHTML
 * preserves source indentation so lines arrive as "      - item".
 */
export function hasListContent(text = '') {
  return /(?:^|\n)\s*-\s+\S/m.test(String(text || ''));
}

/**
 * Priority-ordered CSS selectors for the job description container.
 * team.lidl.ch uses a Nuxt/Vue frontend; selectors cover known class patterns
 * as well as common fallbacks.
 */
const BODY_SELECTORS = [
  // Lidl-specific patterns (observed on team.lidl.ch)
  '.job-detail__description',
  '.jobad-description',
  '.jobad-body',
  '[data-testid="job-description"]',
  '[data-cy="job-description"]',
  // Rich-text content wrappers
  '.rte-text',
  '.rte-content',
  // Generic fallbacks
  '.vacancy-description',
  '.job-content',
  'article .content',
  'main .description',
  'main article',
];

/**
 * Find the element with the highest <li> count — useful as a last resort
 * when no specific selector matches.
 */
function findRichestListElement(document) {
  let best = null;
  let bestCount = 0;
  for (const el of document.querySelectorAll('div, section, article')) {
    const count = el.querySelectorAll('li').length;
    if (count > bestCount) {
      bestCount = count;
      best = el;
    }
  }
  return bestCount >= 3 ? best : null;
}

/**
 * Extract the full job description body from a team.lidl.ch detail page HTML.
 *
 * Returns:
 *   { title, body, hasLists, meetsMinLength }
 *
 * - `title`         — text from the first <h1> element
 * - `body`          — plain text with "- " bullet markers from <li> elements
 * - `hasLists`      — true if body contains list content (guard 2)
 * - `meetsMinLength` — true if body.length >= MIN_LIDL_FULL_DESC (guard 1)
 */
export function parseLidlDetailPage(html = '') {
  if (!html) return { title: '', body: '', hasLists: false, meetsMinLength: false };

  const { document } = new JSDOM(html).window;

  // ── Title ────────────────────────────────────────────────────
  const titleEl = document.querySelector('h1');
  const title = normalizeSpace(titleEl?.textContent || '');

  // ── Body via priority selectors ───────────────────────────────
  let body = '';

  for (const sel of BODY_SELECTORS) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const text = innerTextWithBullets(el);
    if (text.length >= MIN_LIDL_FULL_DESC) {
      body = text;
      break;
    }
    // Keep the longest candidate as fallback even if below threshold
    if (text.length > body.length) body = text;
  }

  // ── Fallback: richest-list element ────────────────────────────
  if (!body || body.length < MIN_LIDL_FULL_DESC) {
    const rich = findRichestListElement(document);
    if (rich) {
      const text = innerTextWithBullets(rich);
      if (text.length > body.length) body = text;
    }
  }

  const lists = hasListContent(body);
  const meetsMinLength = body.length >= MIN_LIDL_FULL_DESC;

  return { title, body, hasLists: lists, meetsMinLength };
}
