/**
 * Quote-safe extraction of `blog.article.<id>.<field>` values from the
 * `blog-meta-*.ts` tables.
 *
 * Extracted here because the naive `'[^']*'` shape had drifted into five
 * independent copies inside `create-article.mjs` alone (#4881), four of them
 * truncating on the first apostrophe. Article titles routinely contain one
 * ("l'iniziativa", "dell'A9"), so those copies silently under-matched and
 * weakened duplicate detection across the whole corpus.
 *
 * One definition, imported by every consumer — including the tests, which
 * previously re-declared their own copy and so could have gone on passing
 * while the script regressed.
 */

import { unescapeTsString } from './unescape-ts-string.mjs';

/** Global regex matching `'blog.article.<id>.<field>': '<escaped value>'`. */
export function metaFieldRegex(field) {
  return new RegExp(`'blog\\.article\\.([^']+)\\.${field}':\\s*'((?:[^'\\\\]|\\\\.)*)'`, 'g');
}

/**
 * Unescapes a TS single-quoted string body captured by `metaFieldRegex`.
 * Only quotes and a literal backslash are decoded here — title/excerpt
 * fields are single-line, so `\n`/`\r`/`\t` were never part of this
 * function's scope and stay untouched (see unescape-ts-string.mjs for why
 * that matters and for the shared decoder this now runs through, fixed for
 * #5632).
 */
export function unescapeTsValue(s) {
  return unescapeTsString(s, { "'": "'", '"': '"', '\\': '\\' });
}
