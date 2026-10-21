/**
 * Token-aware extraction of `blog.article.<id>.<field>` values from the
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

const STATIC_QUOTES = new Set(["'", '"', '`']);

function skipTrivia(source, start) {
  let cursor = start;
  while (cursor < source.length) {
    if (/\s/u.test(source[cursor])) {
      cursor += 1;
      continue;
    }
    if (source.startsWith('//', cursor)) {
      const newline = source.indexOf('\n', cursor + 2);
      cursor = newline === -1 ? source.length : newline;
      continue;
    }
    if (source.startsWith('/*', cursor)) {
      const close = source.indexOf('*/', cursor + 2);
      if (close === -1) throw new Error('[meta-fields] unterminated comment');
      cursor = close + 2;
      continue;
    }
    break;
  }
  return cursor;
}

/** Read one static JS/TS string literal, retaining its source escapes. */
function readStaticStringLiteral(source, start) {
  const quote = source[start];
  if (!STATIC_QUOTES.has(quote)) return null;

  let cursor = start + 1;
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === '\\') {
      cursor += source[cursor + 1] === '\r' && source[cursor + 2] === '\n' ? 3 : 2;
      continue;
    }
    if (quote === '`' && char === '$' && source[cursor + 1] === '{') {
      throw new Error('[meta-fields] interpolated template literal is not supported');
    }
    if (quote !== '`' && (char === '\n' || char === '\r')) {
      throw new Error('[meta-fields] unterminated string literal');
    }
    if (char === quote) {
      return { value: source.slice(start + 1, cursor), end: cursor + 1 };
    }
    cursor += 1;
  }
  throw new Error('[meta-fields] unterminated string literal');
}

function escapeRegExp(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

/**
 * Read real `blog.article.<id>.<field>` object entries from a static meta map.
 *
 * A raw regex cannot distinguish a key in a comment/prose value from an object
 * member, and it also accepts a value with no member delimiter. This scanner
 * advances over comments and complete literals, accepts keys only at a
 * top-level object member boundary, and requires `,` or `}` after the value.
 * Dynamic or malformed matching entries throw instead of returning a partial
 * corpus to duplicate detection.
 *
 * @returns {Array<{id: string, value: string}>}
 */
export function readMetaFieldEntries(source, field) {
  if (typeof source !== 'string') throw new TypeError('[meta-fields] source must be a string');
  if (typeof field !== 'string' || !/^[A-Za-z][A-Za-z0-9]*$/u.test(field)) {
    throw new TypeError('[meta-fields] field must be a simple identifier');
  }

  const keyPattern = new RegExp(`^blog\\.article\\.(.+)\\.${escapeRegExp(field)}$`, 'u');
  const entries = [];
  let cursor = 0;
  let previous = null;
  let braceDepth = 0;

  while (cursor < source.length) {
    cursor = skipTrivia(source, cursor);
    if (cursor >= source.length) break;

    const char = source[cursor];
    if (STATIC_QUOTES.has(char)) {
      const keyLiteral = readStaticStringLiteral(source, cursor);
      const afterKey = skipTrivia(source, keyLiteral.end);

      if ((previous === '{' || previous === ',') && braceDepth === 1 && source[afterKey] === ':') {
        const key = unescapeTsValue(keyLiteral.value);
        const match = keyPattern.exec(key);
        if (match) {
          const valueStart = skipTrivia(source, afterKey + 1);
          if (!STATIC_QUOTES.has(source[valueStart])) {
            throw new Error(`[meta-fields] ${key} must have a static string value`);
          }
          const valueLiteral = readStaticStringLiteral(source, valueStart);
          const afterValue = skipTrivia(source, valueLiteral.end);
          const delimiter = source[afterValue];
          if (delimiter !== ',' && delimiter !== '}') {
            throw new Error(`[meta-fields] ${key} is missing its member delimiter`);
          }
          entries.push({ id: match[1], value: unescapeTsValue(valueLiteral.value) });
          if (delimiter === '}') braceDepth -= 1;
          previous = delimiter;
          cursor = afterValue + 1;
          continue;
        }
      }

      previous = 'literal';
      cursor = keyLiteral.end;
      continue;
    }

    if (char === '{') {
      braceDepth += 1;
      previous = char;
      cursor += 1;
      continue;
    }
    if (char === '}') {
      if (braceDepth === 0) throw new Error('[meta-fields] unexpected closing brace');
      braceDepth -= 1;
      previous = char;
      cursor += 1;
      continue;
    }
    if (char === ',') {
      previous = char;
      cursor += 1;
      continue;
    }

    previous = char;
    cursor += 1;
  }

  if (braceDepth !== 0) throw new Error('[meta-fields] unbalanced object braces');
  return entries;
}

/**
 * Unescapes a TS single-quoted string body captured by the metadata reader.
 * Only quotes and a literal backslash are decoded here — title/excerpt
 * fields are single-line, so `\n`/`\r`/`\t` were never part of this
 * function's scope and stay untouched (see unescape-ts-string.mjs for why
 * that matters and for the shared decoder this now runs through, fixed for
 * #5632).
 */
export function unescapeTsValue(s) {
  return unescapeTsString(s, { "'": "'", '"': '"', '\\': '\\' });
}
