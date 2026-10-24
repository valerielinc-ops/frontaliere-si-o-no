/**
 * Small, dependency-explicit reader for generated TypeScript data modules.
 *
 * Article sources are data, not application code. The old readers searched
 * their bytes with regular expressions or delimiter scanners, which made a
 * quoted key inside a value indistinguishable from a real property and let a
 * dynamic expression look like a partial static record. Every caller that
 * consumes a static article source must go through this module so the AST
 * boundary and the literal decoding policy stay identical in the site mirror
 * and in the corpus mirror.
 *
 * `typescript` is an intentional runtime dependency of the articles package.
 * This file is `.mjs` (rather than importing a TypeScript helper) because the
 * corpus floor and publish readers also execute it under plain Node.
 */

import { loadArticleSourceTypeScript } from './typescriptRuntime.mjs';
import { decodeTypeScriptCodePointEscape } from './ts-literals.mjs';

const ts = loadArticleSourceTypeScript();

const SCRIPT_KIND_BY_EXTENSION = new Map([
  ['.js', ts.ScriptKind.JS],
  ['.jsx', ts.ScriptKind.JSX],
  ['.mjs', ts.ScriptKind.JS],
  ['.cjs', ts.ScriptKind.JS],
  ['.tsx', ts.ScriptKind.TSX],
]);

function scriptKindFor(fileName) {
  const match = /\.[^.]+$/.exec(String(fileName));
  return SCRIPT_KIND_BY_EXTENSION.get(match?.[0].toLowerCase()) ?? ts.ScriptKind.TS;
}

function diagnosticText(message) {
  if (typeof message === 'string') return message;
  if (message && typeof message.messageText === 'string') return message.messageText;
  if (message && Array.isArray(message.messageText)) {
    return message.messageText.map(diagnosticText).join(' ');
  }
  return String(message);
}

function parseErrorPrefix(errorPrefix) {
  return errorPrefix ? `${errorPrefix} ` : '';
}

function createSourceFile(source, fileName) {
  return ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(fileName),
  );
}

/**
 * A few corpus chunks are emitted as object-property fragments, and the
 * historical body reader also accepted a bare template-delimited property
 * name (`\`key\``). The latter is a static data convention but not valid
 * TypeScript unless it is computed (`[\`key\`]`), which this reader must reject.
 * Normalize only the uncomputed, no-substitution form to a quoted property name
 * before asking TypeScript for the AST. Re-encode the scanner's cooked value
 * instead of copying the template's raw spelling: real line breaks and escaped
 * backticks must become valid string-literal escapes. Computed and interpolated
 * names remain unsupported and therefore fail closed.
 */
function templatePropertyNameReplacements(source) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, source);
  const tokens = [];
  let kind;
  do {
    kind = scanner.scan();
    tokens.push({
      kind,
      pos: scanner.getTokenPos(),
      end: scanner.getTextPos(),
      value: scanner.getTokenValue(),
    });
  } while (kind !== ts.SyntaxKind.EndOfFileToken);

  const replacements = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const token = tokens[index];
    const previous = tokens[index - 1];
    const next = tokens[index + 1];
    if (
      token.kind !== ts.SyntaxKind.NoSubstitutionTemplateLiteral
      || next.kind !== ts.SyntaxKind.ColonToken
      || (previous
        && previous.kind !== ts.SyntaxKind.OpenBraceToken
        && previous.kind !== ts.SyntaxKind.CommaToken)
    ) continue;

    const value = token.value;
    if (typeof value !== 'string') continue;
    const replacement = JSON.stringify(value)
      .replace(/\u2028|\u2029/gu, (character) => `\\u${character.codePointAt(0).toString(16)}`);
    replacements.push({ start: token.pos, end: token.end, value: replacement });
  }

  return replacements;
}

function normalizeTemplatePropertyNames(source) {
  const replacements = templatePropertyNameReplacements(source);
  if (replacements.length === 0) return source;
  let normalized = source;
  for (let index = replacements.length - 1; index >= 0; index -= 1) {
    const replacement = replacements[index];
    normalized = normalized.slice(0, replacement.start)
      + replacement.value
      + normalized.slice(replacement.end);
  }
  return normalized;
}

function expressionStartsWithStaticString(node) {
  if (!node) return false;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return true;
  if (ts.isParenthesizedExpression(node)) return expressionStartsWithStaticString(node.expression);
  if (ts.isBinaryExpression(node)) return expressionStartsWithStaticString(node.left);
  if (ts.isCallExpression(node)) return expressionStartsWithStaticString(node.expression);
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    return expressionStartsWithStaticString(node.expression);
  }
  return false;
}

/**
 * Parse a source module and fail closed on syntax errors.
 *
 * @param {string} source
 * @param {string} fileName
 * @param {{ errorPrefix?: string, rejectInterpolatedTemplates?: boolean, interpolationMessage?: string, allowPropertyFragments?: boolean, normalizeTemplatePropertyNames?: boolean }} [options]
 * @returns {import('typescript').SourceFile}
 */
export function parseStaticSource(source, fileName = 'static-source.ts', options = {}) {
  if (typeof source !== 'string') throw new TypeError('static source must be a string');
  let parsedSource = options.normalizeTemplatePropertyNames
    ? normalizeTemplatePropertyNames(source)
    : source;
  let sourceFile = createSourceFile(parsedSource, fileName);
  let diagnostics = sourceFile.parseDiagnostics ?? [];

  if (diagnostics.length > 0 && options.allowPropertyFragments) {
    const fragmentSource = `const __static_source_fragment = {${parsedSource}\n};`;
    const fragmentFile = createSourceFile(fragmentSource, fileName);
    if ((fragmentFile.parseDiagnostics ?? []).length === 0) {
      parsedSource = fragmentSource;
      sourceFile = fragmentFile;
      diagnostics = [];
    }
  }

  if (diagnostics.length > 0) {
    const detail = diagnosticText(diagnostics[0].messageText);
    const prefix = parseErrorPrefix(options.errorPrefix);
    if (/unterminated (?:string|template) literal/i.test(detail)) {
      throw new SyntaxError(`${prefix}Unterminated string literal in ${fileName}`);
    }
    throw new SyntaxError(`${prefix}${detail} in ${fileName}`);
  }

  if (options.rejectInterpolatedTemplates) {
    let interpolation;
    const visit = (node) => {
      if (ts.isTemplateExpression(node)) {
        interpolation = node;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    if (interpolation) {
      throw new Error(options.interpolationMessage
        ?? `${parseErrorPrefix(options.errorPrefix)}Interpolated template literal is not static article data: ${fileName}`);
    }
  }

  return sourceFile;
}

/** @param {import('typescript').Expression} expression */
export function unwrapStaticExpression(expression) {
  let current = expression;
  while (
    current && (
      ts.isParenthesizedExpression(current)
      || ts.isAsExpression(current)
      || ts.isTypeAssertionExpression(current)
      || ts.isSatisfiesExpression(current)
      || ts.isNonNullExpression(current)
    )
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * Return a non-computed property name. Computed names are deliberately not
 * evaluated: a static reader must not guess what runtime code would return.
 *
 * @param {import('typescript').PropertyName | undefined} name
 * @returns {string | null}
 */
export function staticPropertyName(name) {
  if (!name) return null;
  if (
    ts.isIdentifier(name)
    || ts.isStringLiteral(name)
    || ts.isNoSubstitutionTemplateLiteral(name)
    || ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  return null;
}

/**
 * Decode the raw contents of a static literal with the article readers'
 * historical output contract. This is intentionally not `eval` and is not
 * `node.text`: title/excerpt readers flatten `\n` to a space, `\t` to a space,
 * and preserve unknown escapes for downstream JSON consumers.
 *
 * @param {string} raw
 * @param {string} quote
 * @param {{ newlineAs?: string, tabAs?: string }} [options]
 */
export function decodeStaticString(raw, quote, options = {}) {
  const newlineAs = options.newlineAs ?? '\n';
  const tabAs = options.tabAs ?? ' ';
  let value = '';
  for (let cursor = 0; cursor < raw.length;) {
    if (raw[cursor] !== '\\') {
      value += raw[cursor];
      cursor += 1;
      continue;
    }

    const escaped = raw[cursor + 1];
    if (escaped === undefined) {
      value += '\\';
      cursor += 1;
      continue;
    }
    if (escaped === '\r' || escaped === '\n' || escaped === '\u2028' || escaped === '\u2029') {
      cursor += escaped === '\r' && raw[cursor + 2] === '\n' ? 3 : 2;
      continue;
    }
    if (quote === '`' && (escaped === '`' || escaped === '$')) {
      value += escaped;
      cursor += 2;
      continue;
    }

    const codePoint = decodeTypeScriptCodePointEscape(raw.slice(cursor + 1));
    if (codePoint) {
      value += codePoint.value;
      cursor += codePoint.length + 1;
      continue;
    }

    const unicode = escaped === 'u' && /^[0-9a-fA-F]{4}$/.test(raw.slice(cursor + 2, cursor + 6));
    const escapeLength = unicode ? 6 : 2;
    const token = raw.slice(cursor, cursor + escapeLength);
    switch (escaped) {
      case 'n': value += newlineAs; break;
      case 'r': break;
      case 't': value += tabAs; break;
      case 'b': value += '\b'; break;
      case 'f': value += '\f'; break;
      case 'v': value += '\v'; break;
      // Legacy octal escapes (`\\01`..`\\07`) are not NUL plus a digit.
      // Keep the source token intact rather than changing the published value.
      case '0': value += /[0-9]/u.test(raw[cursor + 2] ?? '') ? token : '\0'; break;
      case '\\': value += '\\'; break;
      case "'": value += "'"; break;
      case '"': value += '"'; break;
      case 'u':
        value += unicode ? String.fromCharCode(Number.parseInt(token.slice(2), 16)) : token;
        break;
      default: value += token;
    }
    cursor += escapeLength;
  }
  return value;
}

/**
 * Read a static string expression. A template expression, identifier, call,
 * concatenation or other runtime value is an error, never a partial fallback.
 *
 * @param {import('typescript').Expression | undefined} expression
 * @param {import('typescript').SourceFile} sourceFile
 * @param {{ label?: string, newlineAs?: string, errorPrefix?: string }} [options]
 */
export function readStaticString(expression, sourceFile, options = {}) {
  const node = expression ? unwrapStaticExpression(expression) : undefined;
  const label = options.label ?? 'static property';
  const prefix = parseErrorPrefix(options.errorPrefix);
  const defaultMessage = `${label} must have a static string literal`;
  if (!node) throw new Error(`${prefix}${options.nonLiteralMessage ?? defaultMessage}`);
  if (ts.isTemplateExpression(node)) {
    throw new Error(`${prefix}Interpolated template literal is not static article data: ${sourceFile.fileName}`);
  }
  if (!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node)) {
    const message = expressionStartsWithStaticString(node)
      ? options.literalExpressionMessage
      : options.nonLiteralMessage;
    throw new Error(`${prefix}${message ?? defaultMessage}`);
  }
  const start = node.getStart(sourceFile);
  const quote = sourceFile.text[start];
  const raw = sourceFile.text.slice(start + 1, node.end - 1);
  return decodeStaticString(raw, quote, { newlineAs: options.newlineAs });
}

/**
 * Read a static boolean expression. Runtime values are an error, never a
 * truthiness fallback: provenance must not turn an unknown declaration into
 * an assertion that no AI assistance was used.
 *
 * @param {import('typescript').Expression | undefined} expression
 * @param {import('typescript').SourceFile} sourceFile
 * @param {{ label?: string, errorPrefix?: string, nonLiteralMessage?: string }} [options]
 */
export function readStaticBoolean(expression, sourceFile, options = {}) {
  const node = expression ? unwrapStaticExpression(expression) : undefined;
  const label = options.label ?? 'static property';
  const prefix = parseErrorPrefix(options.errorPrefix);
  const defaultMessage = `${label} must have a static boolean literal`;
  if (!node || (node.kind !== ts.SyntaxKind.TrueKeyword && node.kind !== ts.SyntaxKind.FalseKeyword)) {
    throw new Error(`${prefix}${options.nonLiteralMessage ?? defaultMessage}`);
  }
  return node.kind === ts.SyntaxKind.TrueKeyword;
}

/**
 * Return direct object properties. A spread, method or computed property is
 * unsupported because evaluating it would turn this reader into application
 * code and could expose a partial registry.
 *
 * @param {import('typescript').Expression | undefined} expression
 * @param {string} label
 * @returns {import('typescript').PropertyAssignment[]}
 */
export function readStaticObjectProperties(expression, label = 'static object') {
  const object = expression && unwrapStaticExpression(expression);
  if (!object || !ts.isObjectLiteralExpression(object)) {
    throw new Error(`${label} must be a static object literal`);
  }
  const properties = [];
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) {
      throw new Error(`${label} contains an unsupported dynamic property`);
    }
    if (staticPropertyName(property.name) === null) {
      throw new Error(`${label} contains a computed property name`);
    }
    properties.push(property);
  }
  return properties;
}

/** @param {import('typescript').SourceFile} sourceFile @param {string} name */
export function findTopLevelVariable(sourceFile, name) {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return declaration;
    }
  }
  return null;
}

/** @param {import('typescript').SourceFile} sourceFile */
export function findFirstTopLevelObject(sourceFile) {
  return findTopLevelObjects(sourceFile)[0] ?? null;
}

/**
 * Meta chunks are sometimes concatenated by publish scripts. Keep every
 * top-level object initializer so the caller cannot silently read only the
 * first locale chunk.
 *
 * @param {import('typescript').SourceFile} sourceFile
 * @returns {import('typescript').ObjectLiteralExpression[]}
 */
export function findTopLevelObjects(sourceFile) {
  const objects = [];
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const initializer = declaration.initializer && unwrapStaticExpression(declaration.initializer);
        if (initializer && ts.isObjectLiteralExpression(initializer)) objects.push(initializer);
      }
    }
    if (ts.isExportAssignment(statement)) {
      const expression = unwrapStaticExpression(statement.expression);
      if (ts.isObjectLiteralExpression(expression)) objects.push(expression);
    }
  }
  return objects;
}

/** @param {import('typescript').SourceFile} sourceFile */
export function findFirstTopLevelArray(sourceFile) {
  return findTopLevelArrays(sourceFile)[0] ?? null;
}

/**
 * Generated registries are split into many `RAW_ARTICLES_CHUNK_N` arrays.
 * Return every direct top-level static array so no shard silently disappears.
 *
 * @param {import('typescript').SourceFile} sourceFile
 * @returns {import('typescript').ArrayLiteralExpression[]}
 */
export function findTopLevelArrays(sourceFile) {
  const arrays = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const initializer = declaration.initializer && unwrapStaticExpression(declaration.initializer);
      if (initializer && ts.isArrayLiteralExpression(initializer)) arrays.push(initializer);
    }
  }
  return arrays;
}

/**
 * Expand the static object literals in the root registry arrays. Generated
 * registries keep object rows in `*_CHUNK_N` arrays and define one aggregate
 * array with static spreads of those chunks. Known spreads are expanded; every
 * other array element fails closed instead of being silently dropped.
 *
 * @param {import('typescript').SourceFile} sourceFile
 * @param {string} [errorLabel]
 * @returns {import('typescript').ObjectLiteralExpression[]}
 */
export function findTopLevelStaticObjectLiterals(sourceFile, errorLabel = '[article-registry] registry array') {
  const declarations = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      const initializer = declaration.initializer && unwrapStaticExpression(declaration.initializer);
      if (initializer && ts.isArrayLiteralExpression(initializer)) {
        declarations.push({ name: declaration.name.text, array: initializer });
      }
    }
  }
  if (declarations.length === 0) return [];

  const byName = new Map(declarations.map((declaration) => [declaration.name, declaration.array]));
  const referenced = new Set();
  for (const { array } of declarations) {
    for (const element of array.elements) {
      if (!ts.isSpreadElement(element)) continue;
      const target = unwrapStaticExpression(element.expression);
      if (target && ts.isIdentifier(target) && byName.has(target.text)) referenced.add(target.text);
    }
  }
  const roots = declarations.filter(({ name }) => !referenced.has(name));
  const rootArrays = roots.length > 0 ? roots : declarations;

  const expand = (array, visiting) => {
    const objects = [];
    for (const element of array.elements) {
      const value = unwrapStaticExpression(element);
      if (value && ts.isObjectLiteralExpression(value)) {
        objects.push(value);
        continue;
      }
      if (!ts.isSpreadElement(element)) {
        throw new SyntaxError(`${errorLabel} contains an unsupported dynamic element`);
      }
      const target = unwrapStaticExpression(element.expression);
      let targetArray;
      if (target && ts.isArrayLiteralExpression(target)) {
        targetArray = target;
      } else if (target && ts.isIdentifier(target)) {
        targetArray = byName.get(target.text);
      }
      if (!targetArray) {
        throw new SyntaxError(`${errorLabel} contains an unsupported dynamic spread`);
      }
      if (visiting.has(targetArray)) {
        throw new SyntaxError(`${errorLabel} contains a cyclic spread`);
      }
      const nextVisiting = new Set(visiting);
      nextVisiting.add(targetArray);
      objects.push(...expand(targetArray, nextVisiting));
    }
    return objects;
  };

  return rootArrays.flatMap(({ array }) => expand(array, new Set([array])));
}

/**
 * Collect object literals when a small fixture or legacy source has no named
 * array wrapper. The normal generated registries use `findFirstTopLevelArray`;
 * this fallback keeps the parser useful for source fragments without making a
 * second lexical scanner.
 *
 * @param {import('typescript').SourceFile} sourceFile
 * @returns {import('typescript').ObjectLiteralExpression[]}
 */
export function findObjectLiterals(sourceFile) {
  const objects = [];
  const visit = (node) => {
    if (ts.isObjectLiteralExpression(node)) objects.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return objects;
}

/** @param {import('typescript').Expression | undefined} expression */
export function isObjectLiteral(expression) {
  const node = expression && unwrapStaticExpression(expression);
  return Boolean(node && ts.isObjectLiteralExpression(node));
}
