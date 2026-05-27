/**
 * Amministrazione Cantonale TI — concorsi.ti.ch detail page parser
 *
 * The Rexx Systems Portal 7 career site renders the concorso detail page as
 * server-side HTML with:
 *   - an institutional header ("Repubblica e Cantone Ticino", "Sezione delle
 *     risorse umane") that must NOT be used as the job title
 *   - a preamble ("Concorsi per la nomina", "Dipartimento ...", concorso
 *     number like "5/25") before the actual position title
 *   - the actual concorso title in a heading element deeper in the content
 *   - structured sections (Compiti, Mansioni, Requisiti, Profilo, …) that
 *     together form the full job notice
 *
 * Two failure modes the base crawler exhibits (FRO-70):
 *   1. Title mismatch — institutional page heading used instead of the
 *      concorso title
 *   2. Short body — only the intro paragraph captured, sections omitted
 *
 * This module exposes:
 *   parseTichDetailPage(html)  → { title, body, sourceBodyLength }
 *   titleOverlap(a, b)         → 0–1 similarity score (word-level Jaccard)
 *   MIN_TICH_DESC_LENGTH       → 200 (minimum chars for a full description)
 */

import { JSDOM } from 'jsdom';

/** Minimum body length for a «full» TiCH job description. */
export const MIN_TICH_DESC_LENGTH = 200;

// ── Helpers ─────────────────────────────────────────────────────────────────

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function stripHtml(html = '') {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n')
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
 * Patterns that indicate the text is institutional chrome, NOT the concorso
 * title.  Used to skip headings when searching for the real title.
 */
const INSTITUTIONAL_RE =
  /^(Repubblica(\s+e\s+Cantone)?|Cantone\s+Ticino|Offerte?\s+d['']impieghi|Offerta\s+di\s+lavoro|Amministrazione\s+cantonale|Portal\s*7|Jobportal|Rexx|Sezione\s+delle\s+risorse|Foglio\s+Ufficiale|\d{1,3}\s*\/\s*\d{2,4}\s*$|Concorsi\s+per\s+(la\s+)?nomina|Dipartimento\b)/i;

/**
 * Heading elements to try, in priority order, when extracting the title.
 * We skip any text that matches INSTITUTIONAL_RE or is too short/numeric.
 */
const HEADING_TAGS = ['h2', 'h3', 'h4', 'h5'];

/**
 * Priority-ordered CSS selectors for the job body container.
 * Rexx Systems Portal 7 uses varied class names across customer instances;
 * we try specific patterns first and fall back to generic structural ones.
 */
const BODY_SELECTORS = [
  // Rexx Systems Portal 7 known selectors
  '.jobOffer',
  '.job-offer',
  '.job-offer-detail',
  '#jobOfferDetail',
  '#jobOffer',
  '[class*="jobOffer"]',
  '[class*="job-offer"]',
  // Generic content selectors
  '#mainContent',
  '#main-content',
  '.main-content',
  '#content .content',
  '#content',
  'main',
];

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Compute word-level Jaccard similarity between two strings.
 * Returns a value in [0, 1].  Used to detect title mismatches.
 */
export function titleOverlap(a = '', b = '') {
  const words = (s) =>
    new Set(
      String(s || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 3),
    );
  const setA = words(a);
  const setB = words(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const w of setA) if (setB.has(w)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Extract the actual concorso title and full body from a concorsi.ti.ch
 * (Rexx Systems Portal 7) detail page.
 *
 * Returns:
 *   { title, body, sourceBodyLength }
 *
 * - title           — the actual concorso title (not the institutional header)
 * - body            — plain text of the full job notice (all sections)
 * - sourceBodyLength — length of body (for the 25% guard in the enricher)
 */
export function parseTichDetailPage(html = '') {
  if (!html) return { title: '', body: '', sourceBodyLength: 0 };

  const { document } = new JSDOM(html).window;

  // ── Title extraction ────────────────────────────────────────────────────
  let title = '';

  // 1. Try the <title> tag: strip portal/system suffixes and check
  const pageTitle = normalizeSpace(document.querySelector('title')?.textContent || '');
  if (pageTitle) {
    const cleaned = pageTitle
      .replace(/\s*[|–\-]\s*(Jobportal|Portal\s*7|Rexx[^|]*|concorsi\.ti\.ch)[^|]*/gi, '')
      .replace(/\s*[|–\-]\s*$/, '')
      .trim();
    if (cleaned && cleaned.length > 10 && !INSTITUTIONAL_RE.test(cleaned)) {
      title = cleaned;
    }
  }

  // 2. If <title> didn't yield a good title, walk headings to find the first
  //    non-institutional one.
  if (!title) {
    for (const tag of HEADING_TAGS) {
      for (const el of document.querySelectorAll(tag)) {
        const text = normalizeSpace(el.textContent || '');
        if (
          text.length >= 10 &&
          !INSTITUTIONAL_RE.test(text) &&
          !/^\d/.test(text) // skip pure numeric codes like "5/25"
        ) {
          title = text;
          break;
        }
      }
      if (title) break;
    }
  }

  // 3. Last resort: h1 if it looks non-institutional
  if (!title) {
    const h1 = document.querySelector('h1');
    const h1text = normalizeSpace(h1?.textContent || '');
    if (h1text.length >= 10 && !INSTITUTIONAL_RE.test(h1text)) {
      title = h1text;
    }
  }

  // ── Body extraction ─────────────────────────────────────────────────────
  let body = '';

  for (const sel of BODY_SELECTORS) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const text = stripHtml(el.innerHTML || '');
    if (text.length > body.length) body = text;
    if (text.length >= MIN_TICH_DESC_LENGTH) break;
  }

  // Fallback: element with most text among structural containers
  if (body.length < MIN_TICH_DESC_LENGTH) {
    let best = null;
    let bestLen = 0;
    for (const el of document.querySelectorAll('div, section, article, table')) {
      const len = (el.textContent || '').trim().length;
      if (len > bestLen) {
        best = el;
        bestLen = len;
      }
    }
    if (best && bestLen > body.length) {
      body = stripHtml(best.innerHTML || '');
    }
  }

  return { title, body, sourceBodyLength: body.length };
}
