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
const LOCALE_FIELD_RE = /(?:^|,)\s*(?:(it|en|de|fr)|["'](it|en|de|fr)["'])\s*:\s*["']([^"']*)["']/g;

function invalidArgument(name) {
  throw new TypeError('parseArticleUrlSlugs: ' + name + ' must be a non-empty string');
}

function parseLocalizedEntry(articleId, body) {
  const fields = {};
  for (const match of body.matchAll(LOCALE_FIELD_RE)) {
    const locale = match[1] || match[2];
    if (Object.prototype.hasOwnProperty.call(fields, locale)) {
      throw new SyntaxError('parseArticleUrlSlugs: duplicate locale ' + locale + ' for ' + articleId);
    }
    if (!match[3].trim()) {
      throw new SyntaxError('parseArticleUrlSlugs: empty locale ' + locale + ' for ' + articleId);
    }
    fields[locale] = match[3];
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
  const declaration = source.match(
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
  for (const match of block.matchAll(SLUG_MAP_ENTRY_RE)) {
    if (Object.prototype.hasOwnProperty.call(out, match[1])) {
      throw new SyntaxError('parseArticleUrlSlugs: duplicate article id ' + match[1]);
    }
    out[match[1]] = parseLocalizedEntry(match[1], match[2]);
  }
  return out;
}
