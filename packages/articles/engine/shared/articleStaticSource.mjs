import { createRequire } from 'node:module';
import { isAbsolute, resolve, basename } from 'node:path';
import { repairLegacyDoubleEscapedBreaks } from './tsStringEscapes.ts';

const TYPESCRIPT_VERSION = '5.8.3';
const ARTICLE_KEY_PREFIX = 'blog.article.';
const ARTICLE_TRANSLATION_KEY = /^blog\.article\.(.+)\.([A-Za-z][A-Za-z0-9]*)$/;
const require = createRequire(import.meta.url);

/**
 * Load the pinned compiler without creating a Program or evaluating article
 * source. Corpus workflows pass an isolated compiler path; the site uses its
 * already-pinned package dependency for local builds and tests.
 */
function loadTypeScript() {
  const configuredEntry = process.env.ARTICLE_SOURCE_TYPESCRIPT;
  let compilerEntry;

  if (configuredEntry !== undefined) {
    if (typeof configuredEntry !== 'string' || configuredEntry.trim() === '' || !isAbsolute(configuredEntry)) {
      throw new Error('ARTICLE_SOURCE_TYPESCRIPT must be an absolute path to the pinned TypeScript compiler entry.');
    }
    compilerEntry = resolve(configuredEntry);
  } else {
    try {
      compilerEntry = require.resolve('typescript');
    } catch (error) {
      throw new Error(
        'The article source reader requires TypeScript 5.8.3; set ARTICLE_SOURCE_TYPESCRIPT to its compiler entry.',
        { cause: error },
      );
    }
  }

  const ts = require(compilerEntry);
  if (ts.version !== TYPESCRIPT_VERSION) {
    throw new Error(
      `The article source reader requires TypeScript ${TYPESCRIPT_VERSION}; received ${String(ts.version)} from ${compilerEntry}.`,
    );
  }
  if (typeof ts.createSourceFile !== 'function' || typeof ts.forEachChild !== 'function') {
    throw new Error(`TypeScript ${TYPESCRIPT_VERSION} is missing the AST API required by the article source reader.`);
  }
  return ts;
}

const ts = loadTypeScript();

function locationSuffix(sourceFile, node) {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile, false));
  return `:${position.line + 1}:${position.character + 1}`;
}

function fail(sourcePath, message, sourceFile, node) {
  const location = sourceFile && node ? locationSuffix(sourceFile, node) : '';
  throw new SyntaxError(`[article-source] ${message} in ${sourcePath}${location}`);
}

function parseSourceFile(source, sourcePath) {
  if (typeof source !== 'string') throw new TypeError('article source must be a string');
  if (typeof sourcePath !== 'string' || sourcePath.trim() === '') throw new TypeError('sourcePath must be a non-empty string');

  // Parent pointers are unnecessary for this read-only pass and keeping them
  // off bounds the transient AST memory for large locale chunks.
  const sourceFile = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const diagnostic = sourceFile.parseDiagnostics[0];
  if (diagnostic) {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
    const position = typeof diagnostic.start === 'number'
      ? sourceFile.getLineAndCharacterOfPosition(diagnostic.start)
      : null;
    const suffix = position ? `:${position.line + 1}:${position.character + 1}` : '';
    throw new SyntaxError(`[article-source] TypeScript syntax error in ${sourcePath}${suffix}: ${message}`);
  }

  // The published source files are static data modules. Reject real template
  // expressions anywhere in the file so no partial result can be emitted and
  // no nested expression can expose fake `blog.article.*` keys to extraction.
  // Escaped `\${...}`, normal strings, and comments are not TemplateExpression
  // nodes and remain ordinary literal content.
  const rejectTemplateExpressions = (node) => {
    if (ts.isTemplateExpression(node)) {
      fail(sourcePath, 'Interpolated template literal is not supported in static article data', sourceFile, node);
    }
    ts.forEachChild(node, rejectTemplateExpressions);
  };
  rejectTemplateExpressions(sourceFile);

  return sourceFile;
}

function isStringRecordType(typeNode) {
  if (!typeNode || !ts.isTypeReferenceNode(typeNode) || !ts.isIdentifier(typeNode.typeName)) return false;
  if (typeNode.typeName.text !== 'Record' || typeNode.typeArguments?.length !== 2) return false;
  return typeNode.typeArguments.every((argument) => argument.kind === ts.SyntaxKind.StringKeyword);
}

function staticPropertyName(name) {
  if (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) {
    return name.text;
  }
  return null;
}

function findTranslationObject(sourceFile, sourcePath) {
  if (sourceFile.statements.length !== 2) {
    fail(sourcePath, 'translation module must contain exactly a const record and its default export', sourceFile, sourceFile);
  }

  const [declarationStatement, exportStatement] = sourceFile.statements;
  if (!ts.isVariableStatement(declarationStatement)) {
    fail(sourcePath, 'translation module must begin with a const record declaration', sourceFile, declarationStatement);
  }
  if (declarationStatement.declarationList.flags !== ts.NodeFlags.Const) {
    fail(sourcePath, 'translation record must be declared with const', sourceFile, declarationStatement);
  }
  if (ts.canHaveModifiers(declarationStatement) && ts.getModifiers(declarationStatement)?.length) {
    fail(sourcePath, 'translation record declaration must not have modifiers', sourceFile, declarationStatement);
  }
  if (declarationStatement.declarationList.declarations.length !== 1) {
    fail(sourcePath, 'translation module must declare exactly one record', sourceFile, declarationStatement);
  }

  const declaration = declarationStatement.declarationList.declarations[0];
  if (!ts.isIdentifier(declaration.name) || !isStringRecordType(declaration.type)) {
    fail(sourcePath, 'translation record must have a Record<string, string> type and identifier name', sourceFile, declaration);
  }
  if (!declaration.initializer || !ts.isObjectLiteralExpression(declaration.initializer)) {
    fail(sourcePath, 'translation record initializer must be an object literal', sourceFile, declaration);
  }

  if (
    !ts.isExportAssignment(exportStatement)
    || exportStatement.isExportEquals
    || !ts.isIdentifier(exportStatement.expression)
    || exportStatement.expression.text !== declaration.name.text
  ) {
    fail(sourcePath, 'translation module must default-export its declared record', sourceFile, exportStatement);
  }

  return declaration.initializer;
}

function readStringLiteralValue(node, sourceFile, sourcePath, key) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  fail(sourcePath, `article translation ${key} must have a static string literal value`, sourceFile, node);
}

/**
 * Parse one complete static translation module into its article/field string
 * values. Each call creates one transient TypeScript SourceFile and returns
 * only the extracted strings; neither source text nor AST nodes are cached.
 *
 * @param {string} source complete TypeScript module text
 * @param {string} sourcePath diagnostic filename
 * @returns {Map<string, Map<string, string>>}
 */
export function parseStaticArticleTranslationSource(source, sourcePath) {
  const sourceFile = parseSourceFile(source, sourcePath);
  const objectLiteral = findTranslationObject(sourceFile, sourcePath);
  const result = new Map();
  const seenKeys = new Set();

  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) {
      fail(sourcePath, 'article translation records must contain only static property assignments', sourceFile, property);
    }
    if (ts.isComputedPropertyName(property.name)) {
      fail(sourcePath, 'computed article translation keys are not supported', sourceFile, property.name);
    }

    const key = staticPropertyName(property.name);
    if (key === null) fail(sourcePath, 'translation record keys must be static strings', sourceFile, property.name);
    if (seenKeys.has(key)) fail(sourcePath, `duplicate translation key ${key}`, sourceFile, property.name);
    seenKeys.add(key);
    const value = readStringLiteralValue(property.initializer, sourceFile, sourcePath, key);
    if (!key.startsWith(ARTICLE_KEY_PREFIX)) continue;
    const match = ARTICLE_TRANSLATION_KEY.exec(key);
    if (!match) fail(sourcePath, `malformed article translation key ${key}`, sourceFile, property.name);

    const [, articleId, field] = match;
    if (!articleId.trim()) fail(sourcePath, 'article translation id must be non-empty', sourceFile, property.name);
    if (!result.has(articleId)) result.set(articleId, new Map());
    const fields = result.get(articleId);
    if (fields.has(field)) fail(sourcePath, `duplicate article translation ${key}`, sourceFile, property.name);
    fields.set(field, value);
  }

  return result;
}

/**
 * Parse a per-article body module, requiring the filename and all body keys to
 * name the same article. The existing body-only legacy-break repair is applied
 * after TypeScript has decoded each static literal; FAQ JSON stays untouched.
 *
 * @param {string} source complete TypeScript module text
 * @param {string} sourcePath diagnostic filename
 * @returns {Record<string, Record<string, string>>}
 */
export function parseStaticBlogBodySource(source, sourcePath) {
  const translations = parseStaticArticleTranslationSource(source, sourcePath);
  const expectedArticleId = basename(sourcePath, '.ts');
  const out = Object.create(null);
  let bodyFieldCount = 0;

  for (const [articleId, fields] of translations) {
    if (articleId !== expectedArticleId) {
      throw new SyntaxError(`[article-source] body key ${articleId} does not match file ${sourcePath}`);
    }
    const values = Object.create(null);
    for (const [field, value] of fields) {
      if (field === 'faq') {
        values[field] = value;
      } else if (/^body\d+$/.test(field)) {
        values[field] = repairLegacyDoubleEscapedBreaks(value);
        bodyFieldCount += 1;
      } else {
        throw new SyntaxError(`[article-source] unexpected field ${field} in body module ${sourcePath}`);
      }
    }
    out[articleId] = values;
  }

  if (bodyFieldCount === 0) {
    throw new SyntaxError(`[article-source] existing article body file has no static body fields: ${sourcePath}`);
  }
  return out;
}
