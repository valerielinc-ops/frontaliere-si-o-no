/**
 * Pure source reader shared by the TypeScript article engine and the
 * dependency-free corpus floor verifier.
 *
 * The two runtimes must agree on the grammar of the section slug maps. Keeping
 * the parser here means a new router formatting variant changes both readers
 * together instead of changing the archive emitter and its floor reference
 * independently.
 */

const LOCALES = ['it', 'en', 'de', 'fr'];

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const SLUG_MAP_ENTRY_RE = /["']([^"']+)["']\s*:\s*\{([^{}]*)\}/g;
const LOCALE_FIELD_RE = /(?:\b(it|en|de|fr)\b|["'](it|en|de|fr)["'])\s*:\s*["']([^"']*)["']/g;

function invalidArgument(name) {
  throw new TypeError('parseArticleUrlSlugs: ' + name + ' must be a non-empty string');
}

function maskComments(source) {
  const chars = source.split('');
  let quote = null;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === '\\') {
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '/' && source[index + 1] === '/') {
      chars[index] = ' ';
      chars[index + 1] = ' ';
      index += 2;
      while (index < source.length && source[index] !== '\n' && source[index] !== '\r') {
        chars[index] = ' ';
        index += 1;
      }
      index -= 1;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      chars[index] = ' ';
      chars[index + 1] = ' ';
      index += 2;
      while (index < source.length) {
        if (source[index] === '*' && source[index + 1] === '/') {
          chars[index] = ' ';
          chars[index + 1] = ' ';
          index += 2;
          break;
        }
        if (source[index] !== '\n' && source[index] !== '\r') chars[index] = ' ';
        index += 1;
      }
      index -= 1;
    }
  }
  return chars.join('');
}

function skipTrivia(source, start = 0) {
  let index = start;
  while (index < source.length) {
    if (/\s/.test(source[index])) {
      index += 1;
      continue;
    }
    if (source.startsWith('//', index)) {
      const newline = source.indexOf('\n', index + 2);
      index = newline === -1 ? source.length : newline + 1;
      continue;
    }
    if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2);
      if (end === -1) return -1;
      index = end + 2;
      continue;
    }
    break;
  }
  return index;
}

function isTrivia(source) {
  const end = skipTrivia(source);
  return end >= 0 && end === source.length;
}

function isCommaAndTrivia(source) {
  const comma = skipTrivia(source);
  if (comma < 0 || source[comma] !== ',') return false;
  const end = skipTrivia(source, comma + 1);
  return end >= 0 && end === source.length;
}

function isOptionalTrailingCommaAndTrivia(source) {
  const first = skipTrivia(source);
  if (first < 0 || first === source.length) return first === source.length;
  if (source[first] !== ',') return false;
  const end = skipTrivia(source, first + 1);
  return end >= 0 && end === source.length;
}

function parseLocalizedEntry(articleId, body) {
  const fields = {};
  const matches = [...body.matchAll(LOCALE_FIELD_RE)];
  let previousEnd = 0;
  for (const [index, match] of matches.entries()) {
    const separator = body.slice(previousEnd, match.index);
    const validSeparator = index === 0 ? isTrivia(separator) : isCommaAndTrivia(separator);
    if (!validSeparator) {
      throw new SyntaxError('parseArticleUrlSlugs: malformed locale map for ' + articleId);
    }
    const locale = match[1] || match[2];
    if (Object.prototype.hasOwnProperty.call(fields, locale)) {
      throw new SyntaxError('parseArticleUrlSlugs: duplicate locale ' + locale + ' for ' + articleId);
    }
    if (!match[3].trim()) {
      throw new SyntaxError('parseArticleUrlSlugs: empty locale ' + locale + ' for ' + articleId);
    }
    fields[locale] = match[3];
    previousEnd = match.index + match[0].length;
  }
  if (!isOptionalTrailingCommaAndTrivia(body.slice(previousEnd))) {
    throw new SyntaxError('parseArticleUrlSlugs: malformed locale map for ' + articleId);
  }

  const missing = LOCALES.filter((locale) => !Object.prototype.hasOwnProperty.call(fields, locale));
  if (missing.length > 0) {
    throw new SyntaxError(
      'parseArticleUrlSlugs: incomplete locale map for ' + articleId + '; missing ' + missing.join(', '),
    );
  }

  const localized = {};
  for (const locale of LOCALES) localized[locale] = fields[locale];
  return localized;
}

/**
 * Parse one `const <slugConst> = { ... }` source block into its locale URL
 * map. A missing declaration is a grammar error; callers that treat the source
 * file as optional must handle the file's absence before calling this parser.
 *
 * @param {string} source
 * @param {string} slugConst
 * @returns {Record<string, Record<string, string>>}
 */
export function parseArticleUrlSlugs(source, slugConst) {
  if (typeof source !== 'string' || source.trim().length === 0) invalidArgument('source');
  if (typeof slugConst !== 'string' || slugConst.trim().length === 0) invalidArgument('slugConst');
  const declaration = maskComments(source).match(
    new RegExp('\\bconst\\s+' + escapeRegex(slugConst) + '(?:\\s*:\\s*[^=\\n]+)?\\s*=\\s*\\{([\\s\\S]*?)\\}\\s*;', 'm'),
  );
  if (!declaration) {
    throw new SyntaxError('parseArticleUrlSlugs: missing slug map declaration for ' + slugConst);
  }
  const block = declaration[1];
  if (!block.trim()) {
    throw new SyntaxError('parseArticleUrlSlugs: empty slug map for ' + slugConst);
  }

  const out = {};
  const matches = [...block.matchAll(SLUG_MAP_ENTRY_RE)];
  if (matches.length === 0) {
    throw new SyntaxError('parseArticleUrlSlugs: empty or malformed slug map for ' + slugConst);
  }
  let previousEnd = 0;
  for (const [index, match] of matches.entries()) {
    const separator = block.slice(previousEnd, match.index);
    const validSeparator = index === 0 ? isTrivia(separator) : isCommaAndTrivia(separator);
    if (!validSeparator) {
      throw new SyntaxError('parseArticleUrlSlugs: malformed slug map for ' + slugConst);
    }
    if (Object.prototype.hasOwnProperty.call(out, match[1])) {
      throw new SyntaxError('parseArticleUrlSlugs: duplicate article id ' + match[1]);
    }
    out[match[1]] = parseLocalizedEntry(match[1], match[2]);
    previousEnd = match.index + match[0].length;
  }
  if (!isOptionalTrailingCommaAndTrivia(block.slice(previousEnd))) {
    throw new SyntaxError('parseArticleUrlSlugs: malformed slug map for ' + slugConst);
  }
  return out;
}
