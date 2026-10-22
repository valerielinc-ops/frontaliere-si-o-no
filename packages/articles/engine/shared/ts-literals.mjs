/**
 * Fail-closed readers for static JavaScript/TypeScript string maps.
 *
 * This module lives under `engine/shared/` because the engine is transported
 * to the site repository as a closed subtree. Corpus-only scripts re-export
 * these functions from `scripts/lib/ts-literals.mjs`; the RSS engine must not
 * reach outside the mirrored subtree at runtime.
 */

const STATIC_LITERAL_QUOTES = new Set(['"', "'", '`']);
const TS_ESCAPE_RX = /\\(u[0-9a-fA-F]{4}|\r\n|[\s\S])/g;
const REGEX_PREFIX_KEYWORDS = new Set([
  'await', 'break', 'case', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'in', 'instanceof', 'new', 'of', 'return',
  'throw', 'typeof', 'void', 'yield',
]);
const REGEX_PREFIX_PUNCTUATION = new Set([
  '(', '[', '{', ',', ':', ';', '=', '!', '?', '+', '-', '*', '%', '&', '|', '^', '~', '<', '>',
]);
const CONTROL_PAREN_KEYWORDS = new Set(['catch', 'for', 'if', 'switch', 'while', 'with']);
const BLOCK_BRACE_KEYWORDS = new Set([
  'catch', 'class', 'do', 'else', 'enum', 'finally', 'function', 'interface', 'module', 'namespace', 'static', 'try',
]);
const DECLARATION_BRACE_KEYWORDS = new Set(['class', 'enum', 'function', 'interface', 'module', 'namespace']);
const DECLARATION_PREFIX_KEYWORDS = new Set(['abstract', 'async', 'declare', 'default', 'export']);
const AMBIENT_BLOCK_KEYWORDS = new Set(['global']);
const TYPE_BODY_KEYWORDS = new Set(['class', 'enum', 'global', 'interface', 'module', 'namespace']);
const TYPE_CONTEXT_WORDS = new Set(['asserts', 'extends', 'infer', 'is', 'keyof', 'readonly', 'typeof', 'unique']);
const TYPE_ASSERTION_PREFIX_WORDS = new Set([
  'await', 'case', 'delete', 'else', 'return', 'throw', 'typeof', 'void', 'yield',
]);
const ASI_EXPRESSION_ENDS = new Set([
  'close-block', 'close-expression-block', 'close-object', 'close-paren', 'close-type-alias',
  'close-type-declaration', 'identifier', 'literal', 'postfix',
]);
const BLOCK_BRACE_PENDING_RESET = new Set(['(', ')', '[', ']', ',', ':', ';', '=']);

function isRegexLineTerminator(character) {
  return character === '\n' || character === '\r' || character === '\u2028' || character === '\u2029';
}

/** Skip a regex literal while keeping its quoted-looking body opaque. */
function skipStaticRegexLiteral(source, offset) {
  let inCharacterClass = false;
  let cursor = offset + 1;
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === '\\') {
      cursor += 2;
      continue;
    }
    if (isRegexLineTerminator(character)) return -1;
    if (character === '[') inCharacterClass = true;
    else if (character === ']' && inCharacterClass) inCharacterClass = false;
    else if (character === '/' && !inCharacterClass) {
      cursor += 1;
      while (/[A-Za-z]/u.test(source[cursor] || '')) cursor += 1;
      return cursor;
    }
    cursor += 1;
  }
  return -1;
}

/**
 * TypeScript's angle assertions start an expression, while relational
 * comparisons start after an expression. Use that distinction when the
 * assertion's type begins with a named or composed type (`<Foo & {...}>`).
 */
function looksLikeTypeAssertionPosition(source, offset, statementStart) {
  let cursor = offset - 1;
  while (cursor >= 0 && /\s/u.test(source[cursor])) cursor -= 1;
  if (cursor < 0) return true;
  if (source[cursor] === '}' && statementStart) return true;
  if ('([{,;:=!?&|+-*/%^~>'.includes(source[cursor])) return true;
  const wordEnd = cursor + 1;
  while (cursor >= 0 && /[A-Za-z0-9_$]/u.test(source[cursor])) cursor -= 1;
  const previousWord = source.slice(cursor + 1, wordEnd);
  return TYPE_ASSERTION_PREFIX_WORDS.has(previousWord);
}

/** Detect a generic type argument list without treating an ordinary `<` comparison as one. */
function looksLikeGenericStart(source, offset, statementStart = false) {
  let angleDepth = 1;
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  for (let cursor = offset + 1; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (character === "'" || character === '"' || character === '`') {
      const quote = character;
      cursor += 1;
      while (cursor < source.length) {
        if (source[cursor] === '\\') {
          cursor += 1;
        } else if (source[cursor] === quote) {
          break;
        }
        cursor += 1;
      }
      continue;
    }
    if (character === '/' && source[cursor + 1] === '/') {
      cursor += 2;
      while (cursor < source.length && source[cursor] !== '\n' && source[cursor] !== '\r') cursor += 1;
      continue;
    }
    if (character === '/' && source[cursor + 1] === '*') {
      const close = source.indexOf('*/', cursor + 2);
      if (close < 0) return false;
      cursor = close + 1;
      continue;
    }
    if (character === '/') {
      const regexEnd = skipStaticRegexLiteral(source, cursor);
      if (regexEnd >= 0) {
        cursor = regexEnd - 1;
        continue;
      }
    }
    if (character === '{') braceDepth += 1;
    else if (character === '}' && braceDepth > 0) braceDepth -= 1;
    else if (character === '[') bracketDepth += 1;
    else if (character === ']' && bracketDepth > 0) bracketDepth -= 1;
    else if (character === '(') parenDepth += 1;
    else if (character === ')' && parenDepth > 0) parenDepth -= 1;
    else if (character === '<') angleDepth += 1;
    else if (character === '>' && source[cursor - 1] !== '=' && braceDepth === 0
      && bracketDepth === 0 && parenDepth === 0) {
      angleDepth -= 1;
      if (angleDepth === 0) {
        let next = cursor + 1;
        while (/\s/u.test(source[next] || '')) next += 1;
        const nextWord = /^[A-Za-z_$][A-Za-z0-9_$]*/u.exec(source.slice(next))?.[0];
        const typeAssertionOperand = Boolean(
          nextWord
          || source[next] === '{'
          || source[next] === '['
          || source[next] === '('
          || STATIC_LITERAL_QUOTES.has(source[next])
          || /[0-9]/u.test(source[next] || '')
          || ['!', '+', '-', '~', '/'].includes(source[next]),
        );
        const typeAssertion = Boolean(
          typeAssertionOperand && looksLikeTypeAssertionPosition(source, offset, statementStart),
        );
        return source[next] === '(' || source.startsWith('=>', next) || source[next] === ';'
          || source[next] === ',' || source[next] === ')' || source[next] === '.' || source[next] === '|'
          || source[next] === '&' || source[next] === '=' || source[next] === '[' || source[next] === '!'
          || source.startsWith('?.', next) || source.startsWith('??', next) || source.startsWith('&&', next)
          || source.startsWith('||', next) || source[next] === '+' || source[next] === '-'
          || source[next] === '*' || source[next] === '/' || source[next] === '%' || source[next] === '?'
          || nextWord === 'as' || nextWord === 'satisfies' || nextWord === 'instanceof'
          || nextWord === 'in' || typeAssertion;
      }
    }
  }
  return false;
}

/** Read one static JavaScript/TypeScript string literal. */
export function readStaticStringLiteral(source, startIdx, sourcePath = 'source', errorLabel = 'static-literal') {
  const quote = source[startIdx];
  if (!STATIC_LITERAL_QUOTES.has(quote)) return null;

  let cursor = startIdx + 1;
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === '\\') {
      cursor += source[cursor + 1] === '\r' && source[cursor + 2] === '\n' ? 3 : 2;
      continue;
    }
    if (quote === '`' && char === '$' && source[cursor + 1] === '{') {
      throw new Error(`[${errorLabel}] Interpolated template literal is not supported in static source: ${sourcePath}`);
    }
    if (quote !== '`' && (char === '\n' || char === '\r')) return null;
    if (char === quote) {
      return { quote, value: source.slice(startIdx + 1, cursor), end: cursor + 1 };
    }
    cursor += 1;
  }
  return null;
}

/**
 * Decode a static literal using the same escape contract as the TS readers.
 * @param {string} raw
 * @param {string} [quote]
 * @param {{ newlineAs?: string }} [options]
 */
export function decodeStaticStringLiteral(raw, quote = "'", options = {}) {
  const { newlineAs } = options;
  return raw.replace(TS_ESCAPE_RX, (whole, escape) => {
    switch (escape[0]) {
      case 'n': return '\n';
      // A backslash followed by CRLF (or the escaped `\r` form) is a source
      // continuation, not content. `newlineAs` applies only to decoded `\n`.
      case 'r': return '';
      case '\n': return '';
      case '\r': return '';
      case '\u2028': return '';
      case '\u2029': return '';
      case 't': return ' ';
      case '\\': return '\\';
      case "'": return "'";
      case '"': return '"';
      case '`': return quote === '`' ? '`' : whole;
      case '$': return quote === '`' ? '$' : whole;
      case 'u': {
        const codeUnit = Number.parseInt(escape.slice(1), 16);
        return Number.isNaN(codeUnit) ? whole : String.fromCharCode(codeUnit);
      }
      default: return whole;
    }
  });
}

/** Skip whitespace and comments before the next static object token. */
export function skipStaticTrivia(source, startIdx, sourcePath = 'source', errorLabel = 'static-literal') {
  let cursor = startIdx;
  while (cursor < source.length) {
    if (/\s/u.test(source[cursor])) {
      cursor += 1;
      continue;
    }
    if (source.startsWith('//', cursor)) {
      let newline = cursor + 2;
      while (newline < source.length && source[newline] !== '\n' && source[newline] !== '\r') {
        newline += 1;
      }
      cursor = newline;
      continue;
    }
    if (source.startsWith('/*', cursor)) {
      const close = source.indexOf('*/', cursor + 2);
      if (close < 0) throw new Error(`[${errorLabel}] Unterminated comment in ${sourcePath}`);
      cursor = close + 2;
      continue;
    }
    break;
  }
  return cursor;
}

/**
 * Read object properties whose keys and values are static string literals.
 * Full object files require `,` or `}` after every value. A fragment caller
 * may opt into EOF termination explicitly with `allowTerminalFragment`.
 * @param {string} source
 * @param {string} [sourcePath]
 * @param {{ errorLabel?: string, allowTerminalFragment?: boolean, newlineAs?: string, requireObjectClosure?: boolean }} [options]
 */
export function readStaticObjectEntries(
  source,
  sourcePath = 'source',
  options = {},
) {
  const {
    errorLabel = 'static-literal',
    allowTerminalFragment = false,
    newlineAs,
    // A complete object must close. Callers that intentionally pass a
    // property fragment can opt out explicitly; the default remains strict.
    requireObjectClosure = !allowTerminalFragment,
  } = options;
  if (newlineAs !== undefined && typeof newlineAs !== 'string') {
    throw new TypeError('newlineAs must be a string when provided');
  }

  const entries = [];
  let cursor = 0;
  let braceDepth = 0;
  let sawObjectOpen = false;
  let closedObject = false;
  let canStartRegex = true;
  let lastSignificant = null;
  let lastIdentifier = null;
  const parenContexts = [];
  const braceContexts = [];
  let blockBracePending = null;
  let statementStart = true;
  let labelCandidate = false;
  let caseLabelPending = false;
  let caseLabelOrigin = null;
  const conditionalOrigins = [];
  let bracketDepth = 0;
  let genericAngleDepth = 0;
  let typeAnnotationPending = false;
  let returnTypeActive = false;
  let parameterTypeActive = false;
  let typeAssertionActive = false;
  let typeAliasPending = false;
  let typeAliasActive = false;
  let typeBodyPending = false;
  let declarationPrefix = false;
  let moduleStatementKind = null;
  let moduleNamedActive = false;
  let moduleSourcePending = false;
  let lineTerminatorPending = false;
  while (cursor < source.length) {
    const triviaStart = cursor;
    cursor = skipStaticTrivia(source, cursor, sourcePath, errorLabel);
    if (/[\n\r\u2028\u2029]/u.test(source.slice(triviaStart, cursor))) lineTerminatorPending = true;
    if (cursor >= source.length) break;
    if (lineTerminatorPending) {
      if (parenContexts.length === 0 && bracketDepth === 0 && !braceContexts.includes('object')
        && ASI_EXPRESSION_ENDS.has(lastSignificant)) {
        statementStart = true;
        if (lastSignificant === 'close-expression-block' || typeAnnotationPending
          || parameterTypeActive || returnTypeActive || typeAliasActive || typeAssertionActive) {
          canStartRegex = true;
        }
      }
      lineTerminatorPending = false;
    }
    const character = source[cursor];
    const nextCharacter = source[cursor + 1];

    if (character === "'" || character === '"' || character === '`') {
      const literal = readStaticStringLiteral(source, cursor, sourcePath, errorLabel);
      if (!literal) throw new Error(`[${errorLabel}] Unterminated string literal in ${sourcePath}`);
      const afterLiteral = skipStaticTrivia(source, literal.end, sourcePath, errorLabel);
      const decodedKey = decodeStaticStringLiteral(literal.value, literal.quote);
      const insideTypeObject = braceContexts.includes('type-object')
        || braceContexts.includes('type-alias-object') || braceContexts.includes('type-declaration');
      const insideExecutableBlock = braceContexts.includes('block') || braceContexts.includes('expression');
      const inObject = braceContexts[braceContexts.length - 1] === 'object' && !insideTypeObject;
      const isStaticProperty = source[afterLiteral] === ':'
        && !caseLabelPending
        && conditionalOrigins.length === 0
        && !insideTypeObject
        && !moduleNamedActive
        && !insideExecutableBlock
        && (inObject || decodedKey.startsWith('blog.article.'));
      if (!isStaticProperty) {
        cursor = literal.end;
        if (moduleSourcePending) {
          canStartRegex = true;
          statementStart = true;
          moduleSourcePending = false;
          moduleStatementKind = null;
          typeAliasPending = false;
          typeAliasActive = false;
          typeAssertionActive = false;
          typeAnnotationPending = false;
          parameterTypeActive = false;
          returnTypeActive = false;
        } else {
          canStartRegex = false;
          statementStart = false;
        }
        lastSignificant = 'literal';
        lastIdentifier = null;
        labelCandidate = false;
        declarationPrefix = false;
        typeAnnotationPending = false;
        continue;
      }

      const afterKey = afterLiteral;
      const valueStart = skipStaticTrivia(source, afterKey + 1, sourcePath, errorLabel);
      if (!STATIC_LITERAL_QUOTES.has(source[valueStart])) {
        throw new Error(`[${errorLabel}] Property ${decodedKey} must have a static string value in ${sourcePath}`);
      }
      const valueLiteral = readStaticStringLiteral(source, valueStart, sourcePath, errorLabel);
      if (!valueLiteral) throw new Error(`[${errorLabel}] Unterminated value in ${sourcePath}`);
      const afterValue = skipStaticTrivia(source, valueLiteral.end, sourcePath, errorLabel);
      const terminal = afterValue >= source.length;
      if ((!terminal || !allowTerminalFragment)
        && source[afterValue] !== ',' && source[afterValue] !== '}') {
        throw new Error(`[${errorLabel}] Static property must end with ',' or '}' in ${sourcePath}`);
      }
      if (source[afterValue] === ',') {
        const nextToken = skipStaticTrivia(source, afterValue + 1, sourcePath, errorLabel);
        if (nextToken >= source.length && !allowTerminalFragment) {
          throw new Error(`[${errorLabel}] Static property cannot end with a dangling comma in ${sourcePath}`);
        }
      }

      const decodedValue = decodeStaticStringLiteral(valueLiteral.value, valueLiteral.quote, { newlineAs });
      const entry = {
        key: decodedKey,
        value: newlineAs === undefined
          ? decodedValue
          : decodedValue.replace(/\r\n|\r|\n/gu, () => newlineAs),
        keyQuote: literal.quote,
        valueQuote: valueLiteral.quote,
      };
      // Preserve source spelling and offsets for compatibility adapters without
      // changing the enumerable reader contract used by existing consumers.
      Object.defineProperties(entry, {
        rawKey: { value: literal.value },
        rawValue: { value: valueLiteral.value },
        start: { value: cursor },
        end: { value: valueLiteral.end },
      });
      entries.push(entry);
      cursor = valueLiteral.end;
      canStartRegex = false;
      lastSignificant = 'literal';
      lastIdentifier = null;
      continue;
    }

    if (/[A-Za-z_$]/u.test(character)) {
      let end = cursor + 1;
      while (/[A-Za-z0-9_$]/u.test(source[end] || '')) end += 1;
      const word = source.slice(cursor, end);
      const previousSignificant = lastSignificant;
      const wasStatementStart = statementStart;
      const hadDeclarationPrefix = declarationPrefix;
      const hadTypeAliasPending = typeAliasPending;
      const hadModuleStatementKind = moduleStatementKind;
      const member = previousSignificant === 'dot' || previousSignificant === 'private-prefix';
      typeAnnotationPending = false;
      canStartRegex = !member && REGEX_PREFIX_KEYWORDS.has(word);
      lastIdentifier = { value: word, member };
      lastSignificant = 'identifier';
      if (!member && BLOCK_BRACE_KEYWORDS.has(word)) {
        const declarationInExpression = DECLARATION_BRACE_KEYWORDS.has(word)
          && !(wasStatementStart || hadDeclarationPrefix);
        blockBracePending = declarationInExpression ? 'expression' : 'block';
        declarationPrefix = false;
        typeBodyPending = TYPE_BODY_KEYWORDS.has(word);
      } else if (!member && hadDeclarationPrefix && AMBIENT_BLOCK_KEYWORDS.has(word)) {
        blockBracePending = 'block';
        declarationPrefix = false;
        typeBodyPending = true;
      } else if (!member && DECLARATION_PREFIX_KEYWORDS.has(word)) {
        declarationPrefix = wasStatementStart || hadDeclarationPrefix;
      } else if (!member) {
        declarationPrefix = false;
      }
      if (!member && wasStatementStart && (word === 'import' || word === 'export')) {
        moduleStatementKind = word;
        moduleSourcePending = word === 'import';
      } else if (!moduleNamedActive && moduleStatementKind && word === 'from') {
        moduleSourcePending = true;
      } else if (!moduleNamedActive && moduleStatementKind
        && ['const', 'let', 'var', 'function', 'class', 'interface', 'namespace', 'enum', 'default'].includes(word)) {
        moduleStatementKind = null;
        moduleSourcePending = false;
      }
      if (!member && !moduleNamedActive && (word === 'as' || word === 'satisfies')) {
        typeAssertionActive = true;
        typeAnnotationPending = true;
      }
      if (!member && TYPE_CONTEXT_WORDS.has(word)
        && (returnTypeActive || parameterTypeActive || typeAliasActive || typeAssertionActive)) {
        typeAnnotationPending = true;
      }
      const moduleTypeSpecifier = moduleNamedActive
        && (moduleStatementKind === 'import' || moduleStatementKind === 'export');
      if (!member && word === 'type' && (wasStatementStart || hadDeclarationPrefix) && !moduleTypeSpecifier) {
        typeAliasPending = true;
        typeAliasActive = false;
      } else if (!member && hadTypeAliasPending && !moduleTypeSpecifier) {
        typeAliasPending = true;
      }
      const switchDefault = word === 'default' && wasStatementStart
        && braceContexts[braceContexts.length - 1] === 'block' && !hadModuleStatementKind;
      if (!member && ((word === 'case' && wasStatementStart) || switchDefault)) {
        caseLabelPending = true;
        caseLabelOrigin = {
          paren: parenContexts.length,
          brace: braceContexts.length,
          bracket: bracketDepth,
        };
      }
      labelCandidate = !member && wasStatementStart;
      statementStart = false;
      cursor = end;
      continue;
    }

    // Postfix increment/decrement and TypeScript's postfix non-null
    // assertion terminate the expression on their left. Consume them as a
    // unit so the following division slash cannot be mistaken for a regex.
    if ((character === '+' && nextCharacter === '+')
      || (character === '-' && nextCharacter === '-')) {
      cursor += 2;
      canStartRegex = false;
      lastSignificant = 'postfix';
      lastIdentifier = null;
      blockBracePending = null;
      statementStart = false;
      labelCandidate = false;
      declarationPrefix = false;
      continue;
    }
    if (character === '!' && !canStartRegex) {
      cursor += 1;
      canStartRegex = false;
      lastSignificant = 'postfix';
      lastIdentifier = null;
      blockBracePending = null;
      statementStart = false;
      labelCandidate = false;
      declarationPrefix = false;
      continue;
    }

    if (character === '/' && canStartRegex) {
      const end = skipStaticRegexLiteral(source, cursor);
      if (end < 0) throw new Error(`[${errorLabel}] Unterminated regex literal in ${sourcePath}`);
      cursor = end;
      canStartRegex = false;
      lastSignificant = 'literal';
      lastIdentifier = null;
      blockBracePending = null;
      statementStart = false;
      labelCandidate = false;
      declarationPrefix = false;
      continue;
    }

    // A division slash leaves its right-hand operand in a regex-capable
    // context; keep this transition explicit rather than treating slash as a
    // prefix operator one character at a time.
    if (character === '/' && !canStartRegex) {
      cursor += 1;
      canStartRegex = true;
      lastSignificant = 'division';
      lastIdentifier = null;
      blockBracePending = null;
      statementStart = false;
      labelCandidate = false;
      declarationPrefix = false;
      continue;
    }

    if (character === '(') {
      const controlParen = Boolean(
        lastIdentifier && !lastIdentifier.member && CONTROL_PAREN_KEYWORDS.has(lastIdentifier.value),
      );
      const surroundingBrace = braceContexts[braceContexts.length - 1];
      const methodCandidate = !controlParen
        && !blockBracePending
        && lastSignificant === 'identifier'
        && lastIdentifier
        && !lastIdentifier.member
        && (surroundingBrace === 'object' || surroundingBrace === 'block'
          || surroundingBrace === 'type-declaration');
      parenContexts.push({
        control: controlParen,
        blockKind: methodCandidate ? 'block' : blockBracePending,
        typeContext: typeAnnotationPending,
      });
      cursor += 1;
      canStartRegex = true;
      lastSignificant = 'open-paren';
      lastIdentifier = null;
      if (!blockBracePending) blockBracePending = null;
      statementStart = false;
      labelCandidate = false;
      continue;
    }

    if (character === ')') {
      const parenContext = parenContexts.pop() || {};
      while (conditionalOrigins.length > 0) {
        const origin = conditionalOrigins[conditionalOrigins.length - 1];
        if (origin.phase !== 'after-colon' || parenContexts.length !== origin.paren
          || braceContexts.length !== origin.brace || bracketDepth !== origin.bracket) break;
        conditionalOrigins.pop();
      }
      const controlParen = parenContext.control === true;
      const typeParen = parenContext.typeContext === true;
      cursor += 1;
      canStartRegex = controlParen;
      lastSignificant = 'close-paren';
      lastIdentifier = null;
      blockBracePending = controlParen ? 'block' : (parenContext.blockKind || 'expression');
      statementStart = controlParen;
      labelCandidate = false;
      const typeArrow = typeParen && /^\s*=>/u.test(source.slice(cursor));
      if (!typeArrow) typeAnnotationPending = false;
      if (!typeParen) parameterTypeActive = false;
      continue;
    }

    if (character === '=' && nextCharacter === '>') {
      cursor += 2;
      canStartRegex = true;
      lastSignificant = 'arrow';
      lastIdentifier = null;
      if (!typeAnnotationPending) blockBracePending = 'expression';
      statementStart = false;
      labelCandidate = false;
      declarationPrefix = false;
      continue;
    }

    if (source[cursor] === '{') {
      const pendingBraceKind = blockBracePending;
      const moduleBrace = Boolean(moduleStatementKind && !moduleNamedActive && (
        lastIdentifier?.value === 'import' || lastIdentifier?.value === 'export'
          || lastIdentifier?.value === 'type' || lastSignificant === 'comma'
      ));
      const typeDeclarationBrace = typeBodyPending && pendingBraceKind;
      const typeBrace = genericAngleDepth > 0 || typeAnnotationPending || typeDeclarationBrace;
      const typeAliasBrace = typeAliasActive
        && !braceContexts.includes('type-alias-object')
        && typeBrace;
      const implicitBlock = statementStart;
      const braceKind = moduleBrace || typeDeclarationBrace ? 'block' : typeBrace ? null : pendingBraceKind
        || (lastSignificant === 'close-paren' ? 'expression' : null)
        || (lastSignificant === 'arrow' ? 'expression' : null)
        || (lastSignificant === 'open-block' && statementStart ? 'block' : null)
        || (lastSignificant === 'semicolon' || lastSignificant === 'close-block' ? 'block' : null)
        || (implicitBlock ? 'block' : null);
      const isBlockBrace = Boolean(braceKind);
      braceContexts.push(moduleBrace ? 'block'
        : typeDeclarationBrace ? 'type-declaration'
          : typeAliasBrace ? 'type-alias-object'
            : typeBrace ? 'type-object' : isBlockBrace ? braceKind : 'object');
      if (!isBlockBrace) {
        braceDepth += 1;
        sawObjectOpen = true;
      }
      cursor += 1;
      canStartRegex = true;
      lastSignificant = isBlockBrace ? 'open-block' : 'open-object';
      lastIdentifier = null;
      blockBracePending = isBlockBrace ? null : typeBrace ? pendingBraceKind : null;
      if (moduleBrace) {
        moduleNamedActive = true;
        moduleSourcePending = false;
      }
      if (typeDeclarationBrace) typeBodyPending = false;
      statementStart = isBlockBrace;
      labelCandidate = false;
      if (!isBlockBrace && !typeDeclarationBrace) typeAnnotationPending = false;
      if (!typeBrace) returnTypeActive = false;
      continue;
    }
    if (source[cursor] === '}') {
      const braceContext = braceContexts.pop();
      while (conditionalOrigins.length > 0) {
        const origin = conditionalOrigins[conditionalOrigins.length - 1];
        if (origin.phase !== 'after-colon' || parenContexts.length !== origin.paren
          || braceContexts.length !== origin.brace || bracketDepth !== origin.bracket) break;
        conditionalOrigins.pop();
      }
      if ((braceContext === 'object' || braceContext === 'type-object' || braceContext === 'type-alias-object'
        || braceContext === 'type-declaration')
        && braceDepth > 0) {
        braceDepth -= 1;
        if (braceDepth === 0) closedObject = true;
      } else if (!braceContext && !sawObjectOpen) {
        // Compatibility fragments commonly start at the first property and
        // retain the generated object's closing brace.
        closedObject = true;
      }
      cursor += 1;
      const nextAfterBrace = skipStaticTrivia(source, cursor, sourcePath, errorLabel);
      const returnTypeBodyFollows = braceContext === 'type-object'
        && returnTypeActive
        && !braceContexts.includes('type-object')
        && !braceContexts.includes('type-alias-object')
        && (source[nextAfterBrace] === '{' || source.startsWith('=>', nextAfterBrace));
      if (returnTypeBodyFollows) {
        returnTypeActive = false;
        typeAnnotationPending = false;
      }
      const moduleBlock = moduleNamedActive && braceContext === 'block';
      canStartRegex = braceContext === 'block' || braceContext === 'type-declaration';
      lastSignificant = braceContext === 'block' ? 'close-block'
        : braceContext === 'type-declaration' ? 'close-type-declaration'
        : braceContext === 'expression' ? 'close-expression-block' : 'close-object';
      lastIdentifier = null;
      if (moduleBlock) {
        moduleNamedActive = false;
        moduleSourcePending = true;
        if (moduleStatementKind === 'export' && typeAliasPending) {
          typeAliasPending = false;
          typeAliasActive = false;
        }
        statementStart = true;
      }
      if (braceContext === 'type-alias-object' && !braceContexts.includes('type-alias-object')) {
        canStartRegex = true;
        lastSignificant = 'close-type-alias';
        statementStart = true;
        blockBracePending = null;
        typeAnnotationPending = typeAliasActive || typeAssertionActive || parameterTypeActive || returnTypeActive;
      } else if (braceContext === 'type-object') {
        typeAnnotationPending = typeAliasActive || typeAssertionActive || parameterTypeActive || returnTypeActive;
      } else if (braceContext !== 'type-object' && braceContext !== 'type-alias-object'
        && braceContext !== 'type-declaration'
        && !braceContexts.includes('type-object') && !braceContexts.includes('type-alias-object')) {
        blockBracePending = null;
      }
      statementStart = moduleBlock || braceContext === 'block' || braceContext === 'type-declaration'
        || (braceContext === 'type-alias-object' && !braceContexts.includes('type-alias-object'));
      labelCandidate = false;
      if (braceContext === 'block') {
        caseLabelPending = false;
        caseLabelOrigin = null;
      }
      continue;
    }
    cursor += 1;
    canStartRegex = REGEX_PREFIX_PUNCTUATION.has(character);
    const inObject = braceContexts[braceContexts.length - 1] === 'object'
      && !braceContexts.includes('type-object')
      && !braceContexts.includes('type-alias-object')
      && !braceContexts.includes('type-declaration');
    const insideTypeObject = braceContexts.includes('type-object')
      || braceContexts.includes('type-alias-object') || braceContexts.includes('type-declaration');
    if (character === '[') bracketDepth += 1;
    if (character === ']' && bracketDepth > 0) bracketDepth -= 1;
    const startsTypeAlias = character === '=' && typeAliasPending;
    if (startsTypeAlias) {
      typeAliasPending = false;
      typeAliasActive = true;
    }
    if (character === '<' && (typeAliasPending || typeAliasActive
      || looksLikeGenericStart(source, cursor - 1, statementStart))) genericAngleDepth += 1;
    if (character === '>' && genericAngleDepth > 0) genericAngleDepth -= 1;
    const atCaseOrigin = caseLabelPending && caseLabelOrigin
      && parenContexts.length === caseLabelOrigin.paren
      && braceContexts.length === caseLabelOrigin.brace
      && bracketDepth === caseLabelOrigin.bracket;
    const previousCharacter = source[cursor - 2];
    const optionalParameterMarker = character === '?' && nextCharacter === ':'
      && parenContexts.length > 0 && lastSignificant === 'identifier';
    const isConditional = character === '?'
      && previousCharacter !== '?' && nextCharacter !== '.' && nextCharacter !== '?'
      && !optionalParameterMarker;
    if (character === ':' && conditionalOrigins.length > 0) {
      const completed = conditionalOrigins[conditionalOrigins.length - 1];
      if (completed.phase === 'after-colon'
        && parenContexts.length === completed.paren
        && braceContexts.length === completed.brace
        && bracketDepth === completed.bracket) {
        conditionalOrigins.pop();
      }
    }
    const conditionalOrigin = conditionalOrigins[conditionalOrigins.length - 1];
    const closesCaseConditional = character === ':' && conditionalOrigin
      && conditionalOrigin.phase === 'pending'
      && parenContexts.length === conditionalOrigin.paren
      && braceContexts.length === conditionalOrigin.brace
      && bracketDepth === conditionalOrigin.bracket;
    if (isConditional) {
      conditionalOrigins.push({
        paren: parenContexts.length,
        brace: braceContexts.length,
        bracket: bracketDepth,
        phase: 'pending',
      });
    }
    const returnTypeStart = character === ':'
      && (blockBracePending === 'block' || blockBracePending === 'expression')
      && lastSignificant === 'close-paren'
      && !caseLabelPending
      && !atCaseOrigin;
    const parameterTypeColon = character === ':'
      && !inObject
      && !insideTypeObject
      && lastSignificant === 'identifier'
      && !closesCaseConditional
      && !conditionalOrigin
      && !labelCandidate;
    const optionalTypeColon = character === ':'
      && !inObject
      && !insideTypeObject
      && source[cursor - 2] === '?'
      && !closesCaseConditional
      && !conditionalOrigin
      && !labelCandidate;
    const annotationColon = parameterTypeColon || optionalTypeColon;
    const opensLabeledBlock = character === ':' && !inObject
      && !closesCaseConditional
      && (labelCandidate || atCaseOrigin);
    lastSignificant = character === '.'
      ? 'dot'
      : character === ';'
        ? 'semicolon'
        : character === ','
          ? 'comma'
        : character === '#'
          ? 'private-prefix'
          : 'punctuation';
    lastIdentifier = null;
    if (character === ':') {
      if (closesCaseConditional) {
        conditionalOrigin.phase = 'after-colon';
      } else if (opensLabeledBlock) {
        blockBracePending = 'block';
      } else if (!returnTypeStart && !insideTypeObject) {
        blockBracePending = null;
      }
      statementStart = opensLabeledBlock;
      typeAnnotationPending = returnTypeStart || annotationColon;
      if (returnTypeStart) returnTypeActive = true;
      else if (!insideTypeObject) returnTypeActive = false;
      if (annotationColon) parameterTypeActive = true;
      else if (!insideTypeObject) parameterTypeActive = false;
      if (opensLabeledBlock) {
        caseLabelPending = false;
        caseLabelOrigin = null;
      }
    } else {
      if (BLOCK_BRACE_PENDING_RESET.has(character) && !insideTypeObject) blockBracePending = null;
      statementStart = character === ';';
      labelCandidate = false;
      if (character === ';') {
        caseLabelPending = false;
        caseLabelOrigin = null;
        conditionalOrigins.length = 0;
        if (!insideTypeObject) {
          typeAliasPending = false;
          typeAliasActive = false;
          typeAssertionActive = false;
          typeBodyPending = false;
          moduleStatementKind = null;
          moduleNamedActive = false;
          moduleSourcePending = false;
          if (genericAngleDepth > 0 && parenContexts.length === 0 && bracketDepth === 0) {
            genericAngleDepth = 0;
          }
        }
      }
      if (startsTypeAlias) {
        typeAnnotationPending = true;
      } else if ((returnTypeActive || parameterTypeActive || typeAliasActive || typeAssertionActive)
        && ['|', '&', '(', '[', '?'].includes(character)) {
        typeAnnotationPending = true;
      } else if (character === '>' && genericAngleDepth === 0) {
        typeAnnotationPending = false;
      } else if (character === ']') {
        typeAnnotationPending = false;
      } else if (character !== '<' && character !== '>' && character !== '[') {
        typeAnnotationPending = false;
      }
      if (character !== '<' && character !== '>') declarationPrefix = false;
    }
    if (character === ',' && conditionalOrigins.length > 0) {
      const completed = conditionalOrigins[conditionalOrigins.length - 1];
      if (completed.phase === 'after-colon'
        && parenContexts.length === completed.paren
        && braceContexts.length === completed.brace
        && bracketDepth === completed.bracket) {
        conditionalOrigins.pop();
      }
    }
  }
  if (requireObjectClosure && (
    (!sawObjectOpen && !closedObject)
    || (sawObjectOpen && (braceDepth !== 0 || !closedObject))
  )) {
    throw new Error(`[${errorLabel}] Static object is not closed in ${sourcePath}`);
  }
  return entries;
}
