// Body-word-count helper for the winnerFingerprint.averageWordCount field.
//
// `data/article-performance.json` historically emitted `averageWordCount: null`
// because no upstream source carries word counts. The fix reads each winner's
// IT body file (`services/locales/blog-body/it/<slug>.ts`) and counts words
// in the concatenated `body1`/`body2`/.../`faq` string values.
//
// We deliberately operate on the raw .ts file text (no TS round-trip): the
// shape is `Record<string, string>` literals where each value is the body
// chunk for a single key. Stripping the JS scaffolding leaves the plain
// content, which is good enough for an average-word-count signal.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

// Match every string-value of every `'blog.article.<slug>.<key>': '...'`
// entry in a body-<slug>.ts file. Keys we care about are body1..bodyN +
// optionally `faq`/`callout`/etc. — any string value contributes to the
// rough word count.
const ENTRY_RE = /['"]blog\.article\.[a-z0-9-]+\.[a-z0-9_]+['"]\s*:\s*(['"])((?:\\.|(?!\1).)*)\1/gi;

// Tokenizer: any run of word characters (incl. accented) counts as one
// "word". Markdown punctuation, code fences and list markers are ignored.
const WORD_RE = /[A-Za-zÀ-ÖØ-öø-ÿ0-9]+/g;

/**
 * Count words in a single body file's source text. Returns 0 when the file
 * has no parseable string entries.
 *
 * @param {string} text — UTF-8 file contents.
 * @returns {number}
 */
export function countWordsInBodySource(text) {
  if (!text) return 0;
  let total = 0;
  let m;
  ENTRY_RE.lastIndex = 0;
  while ((m = ENTRY_RE.exec(text)) !== null) {
    const raw = m[2];
    // Unescape the common JS string escapes; we don't need full fidelity,
    // just enough to stop counting backslashes as words.
    const unescaped = raw.replace(/\\(['"\\nrt])/g, (_, c) => {
      if (c === 'n') return ' ';
      if (c === 'r') return ' ';
      if (c === 't') return ' ';
      return c;
    });
    const words = unescaped.match(WORD_RE);
    if (words) total += words.length;
  }
  return total;
}

/**
 * Read the IT body file for a given slug and return its word count, or
 * null when the file doesn't exist (skip-not-fail contract: missing body
 * just means we drop that winner from the average instead of throwing).
 *
 * @param {string} slug
 * @param {{ rootDir: string }} opts
 * @returns {number|null}
 */
export function wordCountForSlug(slug, { rootDir }) {
  if (!slug || typeof slug !== 'string') return null;
  const file = path.join(rootDir, 'services', 'locales', 'blog-body', 'it', `${slug}.ts`);
  if (!existsSync(file)) return null;
  try {
    const text = readFileSync(file, 'utf-8');
    const wc = countWordsInBodySource(text);
    return wc > 0 ? wc : null;
  } catch {
    return null;
  }
}

/**
 * Average word count across an array of winner objects (each with a
 * `slug` and `locale`). We only attempt to read IT bodies — non-IT
 * locales translate the IT source so the count is approximately the same
 * but the IT file is the canonical length signal.
 *
 * Returns a positive integer (rounded average) or null when no winner
 * had a readable body file.
 *
 * @param {Array<{ slug: string, locale: string }>} winners
 * @param {{ rootDir: string }} opts
 * @returns {number|null}
 */
export function computeAverageWordCount(winners, { rootDir }) {
  if (!Array.isArray(winners) || !winners.length) return null;
  const counts = [];
  const seenSlugs = new Set();
  for (const w of winners) {
    if (!w || !w.slug) continue;
    // Same slug appears once per locale (4 locales). Count the body once.
    if (seenSlugs.has(w.slug)) continue;
    seenSlugs.add(w.slug);
    const wc = wordCountForSlug(w.slug, { rootDir });
    if (wc !== null) counts.push(wc);
  }
  if (!counts.length) return null;
  const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
  return Math.round(avg);
}
