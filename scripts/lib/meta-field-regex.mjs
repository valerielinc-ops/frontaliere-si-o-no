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

/** Global regex matching `'blog.article.<id>.<field>': '<escaped value>'`. */
export function metaFieldRegex(field) {
  return new RegExp(`'blog\\.article\\.([^']+)\\.${field}':\\s*'((?:[^'\\\\]|\\\\.)*)'`, 'g');
}

/** Unescapes a TS single-quoted string body captured by `metaFieldRegex`. */
export function unescapeTsValue(s) {
  return s.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}
