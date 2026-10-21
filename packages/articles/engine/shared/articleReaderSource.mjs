/**
 * AST-backed source reader shared by the TypeScript article engine and the
 * corpus floor verifier.
 *
 * The source files are generated TypeScript modules, not arbitrary text. The
 * reader intentionally accepts only a named object literal whose keys and
 * values are static literals. That keeps the site and corpus on one grammar:
 * comments, property order and type assertions are harmless, while computed
 * keys, calls, spreads and partial dynamic values fail closed.
 */

import {
  findTopLevelVariable,
  isObjectLiteral,
  parseStaticSource,
  readStaticObjectProperties,
  readStaticString,
  staticPropertyName,
  unwrapStaticExpression,
} from './staticSourceAst.mjs';

const LOCALES = ['it', 'en', 'de', 'fr'];

function invalidArgument(name) {
  throw new TypeError('parseArticleUrlSlugs: ' + name + ' must be a non-empty string');
}

function malformed(message) {
  throw new SyntaxError(`parseArticleUrlSlugs: ${message}`);
}

/**
 * Parse one `const <slugConst> = { ... }` source block into its locale URL
 * map. A missing declaration is a grammar error; callers that treat the
 * source file as optional must handle the file's absence before calling this
 * parser.
 *
 * @param {string} source
 * @param {string} slugConst
 * @returns {Record<string, Record<string, string>>}
 */
export function parseArticleUrlSlugs(source, slugConst) {
  if (typeof source !== 'string' || source.trim().length === 0) invalidArgument('source');
  if (typeof slugConst !== 'string' || slugConst.trim().length === 0) invalidArgument('slugConst');

  let sourceFile;
  try {
    sourceFile = parseStaticSource(source, `${slugConst}.ts`, { errorPrefix: 'parseArticleUrlSlugs:' });
  } catch {
    // Preserve the old public error category for a truncated declaration. It
    // is still a hard parser error; callers must not fall back to article ids.
    malformed(`missing slug map declaration for ${slugConst}`);
  }

  const declaration = findTopLevelVariable(sourceFile, slugConst);
  if (!declaration?.initializer) {
    malformed(`missing slug map declaration for ${slugConst}`);
  }
  const root = unwrapStaticExpression(declaration.initializer);
  if (!isObjectLiteral(root)) {
    malformed(`malformed slug map for ${slugConst}`);
  }

  let properties;
  try {
    properties = readStaticObjectProperties(root, `slug map ${slugConst}`);
  } catch (error) {
    malformed(`malformed slug map for ${slugConst}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (properties.length === 0) {
    malformed(`empty slug map for ${slugConst}`);
  }

  const out = {};
  for (const property of properties) {
    const articleId = staticPropertyName(property.name);
    if (!articleId) malformed(`malformed slug map for ${slugConst}`);
    if (Object.prototype.hasOwnProperty.call(out, articleId)) {
      malformed(`duplicate article id ${articleId}`);
    }

    let localeProperties;
    if (!isObjectLiteral(property.initializer)) {
      malformed(`malformed slug map for ${slugConst}`);
    }
    try {
      localeProperties = readStaticObjectProperties(
        property.initializer,
        `locale map for ${articleId}`,
      );
    } catch (error) {
      malformed(`malformed locale map for ${articleId}: ${error instanceof Error ? error.message : String(error)}`);
    }

    const fields = {};
    for (const localeProperty of localeProperties) {
      const locale = staticPropertyName(localeProperty.name);
      if (!locale || !LOCALES.includes(locale)) continue;
      if (Object.prototype.hasOwnProperty.call(fields, locale)) {
        malformed(`duplicate locale ${locale} for ${articleId}`);
      }
      let value;
      try {
        value = readStaticString(localeProperty.initializer, sourceFile, {
          label: `locale ${locale} for ${articleId}`,
          errorPrefix: 'parseArticleUrlSlugs:',
        });
      } catch (error) {
        malformed(`malformed locale map for ${articleId}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!value.trim()) malformed(`empty locale ${locale} for ${articleId}`);
      fields[locale] = value;
    }

    const missing = LOCALES.filter((locale) => !Object.prototype.hasOwnProperty.call(fields, locale));
    if (missing.length > 0) {
      malformed(`incomplete locale map for ${articleId}; missing ${missing.join(', ')}`);
    }
    out[articleId] = Object.fromEntries(LOCALES.map((locale) => [locale, fields[locale]]));
  }
  return out;
}
