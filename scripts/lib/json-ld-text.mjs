/**
 * Parse the text of a `<script type="application/ld+json">` block.
 *
 * Some publishers emit JSON-LD whose string values carry raw line breaks or
 * tabs (organizer-written descriptions pasted verbatim). That text is not
 * valid JSON — `JSON.parse` rejects it with "Bad control character in string
 * literal" — but the block is otherwise well formed and is the page's primary
 * structured data. Measured on Guidle 2026-10-04: 16 of the 80 detail pages of
 * one crawl run carried exactly this defect, and dropping those blocks counted
 * the events as parser drift.
 *
 * The repair is deliberately narrow: only C0 control characters INSIDE a
 * string literal are rewritten, as the JSON escape the publisher should have
 * written (`\n`, `\t`, `\u0001`…). Characters outside strings are left alone
 * (raw whitespace there is legal JSON), so the parsed value is the one a
 * well-formed block with the same text would produce. Anything else that is
 * malformed still throws, and callers keep skipping it.
 */

const SHORT_ESCAPES = new Map([
  ['\b', '\\b'],
  ['\f', '\\f'],
  ['\n', '\\n'],
  ['\r', '\\r'],
  ['\t', '\\t'],
]);

/**
 * Rewrite raw C0 control characters inside JSON string literals as escapes.
 * @param {string} text
 * @returns {string}
 */
export function escapeControlCharsInJsonStrings(text) {
  if (typeof text !== 'string' || !text) return '';
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (escaped) {
      escaped = false;
      out += ch;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      out += ch;
      continue;
    }
    if (ch === '"') {
      inString = false;
      out += ch;
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code < 0x20) {
      out += SHORT_ESCAPES.get(ch) || `\\u${code.toString(16).padStart(4, '0')}`;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Strictly parse a JSON-LD block, retrying once with raw control characters
 * inside string literals escaped. A leading BOM and an HTML comment wrapper
 * (`<!-- … -->`) are tolerated. Throws when the block is still not JSON.
 * @param {string} raw
 * @returns {unknown}
 */
export function parseJsonLdText(raw) {
  const text = String(raw ?? '')
    .replace(/^﻿/, '')
    .trim()
    .replace(/^<!--\s*|\s*-->$/g, '');
  try {
    return JSON.parse(text);
  } catch (strictError) {
    const repaired = escapeControlCharsInJsonStrings(text);
    if (repaired === text) throw strictError;
    return JSON.parse(repaired);
  }
}
