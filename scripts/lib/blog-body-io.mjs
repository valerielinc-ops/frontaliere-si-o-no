/**
 * Reading and writing article body strings under
 * `services/locales/blog-body[-ch]/<locale>/<id>.ts`.
 *
 * Extracted 2026-07-28. Three scripts had grown their own copy of the same
 * extraction, and they had already drifted:
 *
 *   - repair-repetitive-articles.mjs — the reference implementation
 *   - audit-article-factuality.mjs   — a verbatim copy of it
 *   - audit-articles-factcheck.mjs   — a variant whose regex never anchored the
 *     closing quote and which skipped the backslash unescape, so a body
 *     containing an escaped backslash came out different from the other two
 *
 * Per AGENTS.md #6, a regex duplicated in ≥2 files goes into one shared module
 * so drift is impossible by construction.
 */
import { readFileSync } from 'node:fs';
import { unescapeTsString } from './unescape-ts-string.mjs';

/**
 * Both body dirs share the same {id}.ts-per-locale layout (create-article.mjs
 * bodyDir: 'blog-body' for frontaliere articles, 'blog-body-ch' for svizzera).
 * Scan both: PR #4650's two live repetition bugs were in blog-body-ch and
 * survived a repair pass that only looked at blog-body.
 */
export const BODY_DIRS = ['services/locales/blog-body', 'services/locales/blog-body-ch'];

export const LOCALES = ['it', 'en', 'de', 'fr'];

/** Body dir for a section id ('svizzera' → blog-body-ch, anything else → blog-body). */
export function bodyDirForSection(section) {
  return section === 'svizzera' ? 'services/locales/blog-body-ch' : 'services/locales/blog-body';
}

/**
 * Extracts body1..body3 from a body module's source text.
 *
 * @param {string} content raw .ts file contents
 * @param {string} id      article id (the file's basename)
 * @returns {Record<string,string>} e.g. { body1, body2, body3 } — missing keys omitted
 */
export function extractBodies(content, id) {
  const bodies = {};
  if (typeof content !== 'string' || !id) return bodies;
  for (let i = 1; i <= 3; i++) {
    const key = `blog.article.${id}.body${i}`;
    const pattern = new RegExp(`'${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}':\\s*'((?:[^'\\\\]|\\\\.)*)'`, 's');
    const m = content.match(pattern);
    if (m) bodies[`body${i}`] = unescapeFromTS(m[1]);
  }
  return bodies;
}

/** Reads and extracts in one step. Returns {} when the file cannot be read. */
export function readBodies(filePath, id) {
  try {
    return extractBodies(readFileSync(filePath, 'utf-8'), id);
  } catch {
    return {};
  }
}

/** Decodes a single-quoted TS string literal body back to plain text. */
export function unescapeFromTS(s) {
  return unescapeTsString(String(s || ''), { "'": "'", n: '\n', '\\': '\\' });
}

/** Encodes plain text for embedding in a single-quoted TS string literal. */
export function escapeForTS(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '');
}
