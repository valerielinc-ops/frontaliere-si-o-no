/**
 * La Fonte Job Parser — converts HubSpot CMS card HTML to structured markdown.
 *
 * La Fonte careers page uses HubSpot's `pwr-simple-list-item` cards with rich
 * HTML descriptions containing <p>, <ul>/<li>, <em>, <strong>, <span> elements.
 * This module converts the card HTML to clean markdown with proper structure.
 * The source is the foundation's own Lugano (TI) careers page, not a national
 * employer-search feed.
 */

import { JSDOM } from 'jsdom';
import { meetsSourceBodyFloor } from './source-body-floor.mjs';

// ──────────────────────────────────────────────────────────────
// HTML → Markdown converter
// ──────────────────────────────────────────────────────────────

/**
 * Convert HubSpot card HTML to structured markdown.
 *
 * Returns { markdown, sourceTextLength, headingCount, bulletCount }
 */
export function htmlToMarkdown(html = '') {
  if (!html || !html.trim()) return { markdown: '', sourceTextLength: 0, headingCount: 0, bulletCount: 0 };

  const dom = new JSDOM(`<body>${html}</body>`);
  const body = dom.window.document.body;

  // Remove unwanted elements
  for (const el of body.querySelectorAll('script, style, noscript')) {
    el.remove();
  }

  const sourceTextLength = (body.textContent || '').replace(/\s+/g, ' ').trim().length;

  const lines = [];
  let headingCount = 0;
  let bulletCount = 0;

  function getTextContent(node) {
    return (node.textContent || '').replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function processInline(node) {
    if (node.nodeType === 3) return node.textContent.replace(/\u00A0/g, ' ');
    if (node.nodeType !== 1) return '';

    const tag = node.tagName.toLowerCase();
    const children = Array.from(node.childNodes).map(processInline).join('');

    if (tag === 'strong' || tag === 'b') return children ? `**${children.trim()}**` : '';
    if (tag === 'em' || tag === 'i') return children ? `*${children.trim()}*` : '';
    if (tag === 'br') return '\n';
    if (tag === 'a') {
      const href = node.getAttribute('href') || '';
      const text = children.trim();
      return href && text ? `[${text}](${href})` : text;
    }
    // span, etc. — pass through
    return children;
  }

  function processNode(node) {
    if (node.nodeType === 3) {
      const text = node.textContent.replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
      if (text) lines.push(text);
      return;
    }
    if (node.nodeType !== 1) return;

    const tag = node.tagName.toLowerCase();

    // Headings
    if (/^h[1-6]$/.test(tag)) {
      const text = getTextContent(node);
      if (text) {
        headingCount++;
        lines.push('', `## ${text}`, '');
      }
      return;
    }

    // Horizontal rule
    if (tag === 'hr') {
      lines.push('', '---', '');
      return;
    }

    // Lists
    if (tag === 'ul' || tag === 'ol') {
      lines.push('');
      let idx = 0;
      for (const child of node.children) {
        if (child.tagName.toLowerCase() === 'li') {
          idx++;
          const bullet = tag === 'ol' ? `${idx}.` : '-';
          const text = processInline(child).replace(/\s+/g, ' ').trim();
          if (text) {
            lines.push(`${bullet} ${text}`);
            bulletCount++;
          }
        }
      }
      lines.push('');
      return;
    }

    // Paragraphs
    if (tag === 'p' || tag === 'div') {
      const text = processInline(node).replace(/\s+/g, ' ').trim();
      if (!text) return;

      // Check if it's a pseudo-heading (short bold-only paragraph)
      const boldContent = Array.from(node.querySelectorAll('strong, b'))
        .map((el) => getTextContent(el))
        .join(' ')
        .trim();
      const fullText = getTextContent(node);
      if (boldContent && fullText && boldContent === fullText && fullText.length < 60) {
        headingCount++;
        lines.push('', `## ${fullText}`, '');
        return;
      }

      lines.push('', text, '');
      return;
    }

    // Recurse into other elements
    for (const child of node.childNodes) {
      processNode(child);
    }
  }

  for (const child of body.childNodes) {
    processNode(child);
  }

  const markdown = lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { markdown, sourceTextLength, headingCount, bulletCount };
}

// ──────────────────────────────────────────────────────────────
// Quality validation
// ──────────────────────────────────────────────────────────────

/**
 * Validate a La Fonte job description.
 * @param {{ markdown: string, sourceTextLength: number, headingCount: number, bulletCount: number }} detail
 * @param {number} minChars
 * @param {number} minSourceRatio
 * @returns {{ ok: boolean, warnings: string[] }}
 */
export function validateLaFonteDescription(detail, minChars = 350, minSourceRatio = 0.2) {
  const warnings = [];
  const { markdown, sourceTextLength } = detail;
  const len = (markdown || '').length;

  if (len < minChars) {
    warnings.push(`Description too short: ${len} chars (min ${minChars})`);
  }

  if (sourceTextLength > 200 && len / sourceTextLength < minSourceRatio) {
    warnings.push(
      `Description ratio too low: ${len}/${sourceTextLength} = ${(len / sourceTextLength).toFixed(2)} (min ${minSourceRatio})`
    );
  }

  // Require at least 2 distinct text blocks (paragraphs, list items, or headings)
  const blockCount = (markdown.match(/\n\n/g) || []).length + 1;
  const listCount = (markdown.match(/^- /gm) || []).length;
  const totalBlocks = blockCount + listCount;
  if (totalBlocks < 2 && sourceTextLength > 200) {
    warnings.push(`Too few text blocks: ${totalBlocks} (need at least 2)`);
  }

  return { ok: warnings.length === 0, warnings };
}

// ──────────────────────────────────────────────────────────────
// Published description: the role section of the page, nothing else
// ──────────────────────────────────────────────────────────────

/**
 * The published description is the role card of the careers page as-is
 * (see htmlToMarkdown). The runner used to wrap it in text the page does not
 * carry: "Fondazione La Fonte, con sede a Lugano (TI), è alla ricerca di: X.",
 * a "## Mansioni" heading over nothing, fixed Settore/Sede lines and, for an
 * empty card, "Contattare … per i dettagli della posizione." A card whose body
 * is under the shared word floor (source-body-floor.mjs) yields '' — the
 * caller keeps an earlier source body or leaves the job out.
 */
export function buildLaFonteDescription(cardMarkdown = '') {
  const body = String(cardMarkdown || '').trim();
  return meetsSourceBodyFloor(body) ? body : '';
}

// Frame the old buildDescription() put around the card body. The `Sede` line
// ("Via A. Giacometti 1") survives machine translation verbatim, so it also
// marks the translated copies of that frame in the other locales.
const LEGACY_FRAME_MARKER = 'Via A. Giacometti 1';
const LEGACY_HEAD_RE = /^## Descrizione\s*\n+Fondazione La Fonte, con sede a Lugano \(TI\), è alla ricerca di: [^\n]*\n+/;
const LEGACY_TAIL_RE = /\n*## Mansioni\s*\n[\s\S]*$/;

export function isLaFonteLegacyFrame(text = '') {
  return String(text || '').includes(LEGACY_FRAME_MARKER);
}

/**
 * The card body inside a description written by the old frame ('' when the
 * frame held no body), or the text unchanged when it carries no frame.
 */
export function stripLaFonteLegacyFrame(text = '') {
  const value = String(text || '');
  if (!isLaFonteLegacyFrame(value)) return value.trim();
  return value.replace(LEGACY_HEAD_RE, '').replace(LEGACY_TAIL_RE, '').trim();
}

/**
 * Stored record without the old frame: the source slot (and base
 * description) keep only the card body; framed translations in the other
 * locales are dropped so the translation step regenerates them from it.
 */
export function scrubLaFonteLegacyFrame(job = {}) {
  const sourceLang = job.sourceLang || 'it';
  const descriptionByLocale = {};
  for (const [locale, value] of Object.entries(job.descriptionByLocale || {})) {
    if (locale === sourceLang) {
      const body = buildLaFonteDescription(stripLaFonteLegacyFrame(value));
      if (body) descriptionByLocale[locale] = body;
    } else if (value && !isLaFonteLegacyFrame(value)) {
      descriptionByLocale[locale] = value;
    }
  }
  const description = buildLaFonteDescription(stripLaFonteLegacyFrame(job.description))
    || descriptionByLocale[sourceLang] || '';
  return { ...job, description, descriptionByLocale };
}

/** True when the stored record still carries a body read from the page. */
export function laFonteHasSourceBody(job = {}) {
  return Boolean(scrubLaFonteLegacyFrame(job).description);
}
