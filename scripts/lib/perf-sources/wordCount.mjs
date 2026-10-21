// Body-word-count helper for the winnerFingerprint.averageWordCount field.
//
// `data/article-performance.json` historically emitted `averageWordCount: null`
// because no upstream source carries word counts. The fix reads each winner's
// IT body file (`services/locales/blog-body/it/<slug>.ts`) and counts words
// in the concatenated `body1`/`body2`/.../`faq` string values.
//
// We parse the complete static TypeScript module without evaluating it, then
// count every article string field as the historical scanner did.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parseStaticArticleTranslationSource } from '../../../packages/articles/engine/shared/articleStaticSource.mjs';

// Tokenizer: any run of word characters (incl. accented) counts as one
// "word". Markdown punctuation, code fences and list markers are ignored.
const WORD_RE = /[A-Za-zÀ-ÖØ-öø-ÿ0-9]+/g;

/**
 * Count words in one complete static body module. A valid empty record returns
 * 0; malformed present source throws with its filename and location.
 *
 * @param {string} text — UTF-8 file contents.
 * @returns {number}
 */
export function countWordsInBodySource(text, sourcePath = '<body source>') {
  const translations = parseStaticArticleTranslationSource(text, sourcePath);
  let total = 0;
  for (const fields of translations.values()) {
    for (const value of fields.values()) {
      const words = value.match(WORD_RE);
      if (words) total += words.length;
    }
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
  let text;
  try {
    text = readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
  const wc = countWordsInBodySource(text, file);
  return wc > 0 ? wc : null;
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
