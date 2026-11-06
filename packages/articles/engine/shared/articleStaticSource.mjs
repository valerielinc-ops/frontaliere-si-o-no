import { basename } from 'node:path';
import { decodeStaticString } from './staticSourceAst.mjs';
import { repairLegacyDoubleEscapedBreaks } from './ts-literals.mjs';
import { loadArticleSourceTypeScript } from './typescriptRuntime.mjs';

const ARTICLE_KEY_PREFIX = 'blog.article.';
const ARTICLE_TRANSLATION_KEY = /^blog\.article\.(.+)\.([A-Za-z][A-Za-z0-9]*)$/;
const ts = loadArticleSourceTypeScript();

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

/**
 * A translation record can carry unrelated helper text alongside article
 * entries. It is not data the reader publishes, so an interpolated template
 * there must not abort extraction of the article namespace. Article keys keep
 * the strict static-literal check below.
 */
function isInterpolatedTemplateExpression(node) {
  let current = node;
  while (current) {
    if (ts.isTemplateExpression(current)) return true;
    if (
      ts.isParenthesizedExpression(current)
      || ts.isAsExpression(current)
      || ts.isTypeAssertionExpression(current)
      || ts.isNonNullExpression(current)
      || (typeof ts.isSatisfiesExpression === 'function' && ts.isSatisfiesExpression(current))
    ) {
      current = current.expression;
      continue;
    }
    break;
  }
  return false;
}

function skipNonArticleTemplateLiteral(property, key) {
  return !key.startsWith(ARTICLE_KEY_PREFIX) && isInterpolatedTemplateExpression(property.initializer);
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
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    const start = node.getStart(sourceFile, false);
    const quote = sourceFile.text[start];
    const raw = sourceFile.text.slice(start + 1, node.end - 1);
    // Translation modules historically preserve literal tabs in visible
    // titles. Keep that call-site contract while sharing all other literal
    // decoding rules with the AST readers.
    return decodeStaticString(raw, quote, { tabAs: '\t' });
  }
  fail(sourcePath, `article translation ${key} must have a static string literal value`, sourceFile, node);
}

/**
 * Parse one complete static translation module into primitive article-field
 * entries. The source offset supports diagnostics that must retain the
 * original line number without exposing or retaining TypeScript AST nodes.
 * This function returns only after the entire module has passed validation.
 *
 * @param {string} source complete TypeScript module text
 * @param {string} sourcePath diagnostic filename
 * @returns {Array<{articleId:string,field:string,value:string,index:number,valueStart:number,valueEnd:number}>}
 */
export function parseStaticArticleTranslationEntries(source, sourcePath) {
  const sourceFile = parseSourceFile(source, sourcePath);
  const objectLiteral = findTranslationObject(sourceFile, sourcePath);
  const result = [];
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
    if (skipNonArticleTemplateLiteral(property, key)) continue;
    const value = readStringLiteralValue(property.initializer, sourceFile, sourcePath, key);
    if (!key.startsWith(ARTICLE_KEY_PREFIX)) continue;
    const match = ARTICLE_TRANSLATION_KEY.exec(key);
    if (!match) fail(sourcePath, `malformed article translation key ${key}`, sourceFile, property.name);

    const [, articleId, field] = match;
    if (!articleId.trim()) fail(sourcePath, 'article translation id must be non-empty', sourceFile, property.name);
    result.push({
      articleId,
      field,
      value,
      index: property.name.getStart(sourceFile, false),
      // The raw span excludes the literal's quote/backtick delimiters. These
      // UTF-16 source offsets let legacy readers preserve their own decoding
      // of selected literal values without retaining AST nodes or copying
      // every source string into the result.
      valueStart: property.initializer.getStart(sourceFile, false) + 1,
      valueEnd: property.initializer.getEnd() - 1,
    });
  }

  return result;
}

/**
 * Parse one complete static translation module into its article/field string
 * values. This legacy Map API is a projection of the same validated entries
 * used by line-aware readers.
 *
 * @param {string} source complete TypeScript module text
 * @param {string} sourcePath diagnostic filename
 * @returns {Map<string, Map<string, string>>}
 */
export function parseStaticArticleTranslationSource(source, sourcePath) {
  const result = new Map();
  for (const { articleId, field, value } of parseStaticArticleTranslationEntries(source, sourcePath)) {
    if (!result.has(articleId)) result.set(articleId, new Map());
    result.get(articleId).set(field, value);
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
