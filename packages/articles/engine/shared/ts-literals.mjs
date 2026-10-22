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
  'await', 'break', 'case', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'in',
  'instanceof', 'new', 'of', 'return', 'throw', 'typeof', 'void', 'yield',
]);
const REGEX_PREFIX_PUNCTUATION = new Set([
  '(', '[', '{', ',', ':', ';', '=', '!', '?', '+', '-', '*', '%', '&', '|', '^', '~', '<', '>',
]);
const CONTROL_PAREN_KEYWORDS = new Set(['catch', 'for', 'if', 'switch', 'while', 'with']);
const BLOCK_BRACE_KEYWORDS = new Set([
  'catch', 'class', 'do', 'else', 'enum', 'finally', 'interface', 'module', 'namespace', 'static',
  'try',
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
  let blockBracePending = false;
  while (cursor < source.length) {
    cursor = skipStaticTrivia(source, cursor, sourcePath, errorLabel);
    if (cursor >= source.length) break;
    const character = source[cursor];
    const nextCharacter = source[cursor + 1];

    if (character === "'" || character === '"' || character === '`') {
      const literal = readStaticStringLiteral(source, cursor, sourcePath, errorLabel);
      if (!literal) throw new Error(`[${errorLabel}] Unterminated string literal in ${sourcePath}`);
      const afterLiteral = skipStaticTrivia(source, literal.end, sourcePath, errorLabel);
      if (source[afterLiteral] !== ':') {
        cursor = literal.end;
        canStartRegex = false;
        lastSignificant = 'literal';
        lastIdentifier = null;
        blockBracePending = false;
        continue;
      }

      const afterKey = afterLiteral;
      const valueStart = skipStaticTrivia(source, afterKey + 1, sourcePath, errorLabel);
      if (!STATIC_LITERAL_QUOTES.has(source[valueStart])) {
        throw new Error(`[${errorLabel}] Property ${decodeStaticStringLiteral(literal.value, literal.quote)} must have a static string value in ${sourcePath}`);
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
        key: decodeStaticStringLiteral(literal.value, literal.quote),
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
      const member = lastSignificant === 'dot';
      canStartRegex = !member && REGEX_PREFIX_KEYWORDS.has(word);
      lastIdentifier = { value: word, member };
      lastSignificant = 'identifier';
      if (!member && BLOCK_BRACE_KEYWORDS.has(word)) blockBracePending = true;
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
      blockBracePending = false;
      continue;
    }
    if (character === '!' && !canStartRegex) {
      cursor += 1;
      canStartRegex = false;
      lastSignificant = 'postfix';
      lastIdentifier = null;
      blockBracePending = false;
      continue;
    }

    if (character === '/' && canStartRegex) {
      const end = skipStaticRegexLiteral(source, cursor);
      if (end < 0) throw new Error(`[${errorLabel}] Unterminated regex literal in ${sourcePath}`);
      cursor = end;
      canStartRegex = false;
      lastSignificant = 'literal';
      lastIdentifier = null;
      blockBracePending = false;
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
      blockBracePending = false;
      continue;
    }

    if (character === '(') {
      parenContexts.push(Boolean(
        lastIdentifier && !lastIdentifier.member && CONTROL_PAREN_KEYWORDS.has(lastIdentifier.value),
      ));
      cursor += 1;
      canStartRegex = true;
      lastSignificant = 'open-paren';
      lastIdentifier = null;
      blockBracePending = false;
      continue;
    }

    if (character === ')') {
      const controlParen = parenContexts.pop() === true;
      cursor += 1;
      canStartRegex = controlParen;
      lastSignificant = 'close-paren';
      lastIdentifier = null;
      blockBracePending = false;
      continue;
    }

    if (character === '=' && nextCharacter === '>') {
      cursor += 2;
      canStartRegex = true;
      lastSignificant = 'arrow';
      lastIdentifier = null;
      blockBracePending = false;
      continue;
    }

    if (source[cursor] === '{') {
      const isBlockBrace = lastSignificant === 'close-paren'
        || lastSignificant === 'arrow'
        || blockBracePending
        || (lastSignificant === 'identifier'
          && lastIdentifier
          && !lastIdentifier.member
          && BLOCK_BRACE_KEYWORDS.has(lastIdentifier.value));
      braceContexts.push(isBlockBrace ? 'block' : 'object');
      if (!isBlockBrace) {
        braceDepth += 1;
        sawObjectOpen = true;
      }
      cursor += 1;
      canStartRegex = true;
      lastSignificant = isBlockBrace ? 'open-block' : 'open-object';
      lastIdentifier = null;
      blockBracePending = false;
      continue;
    }
    if (source[cursor] === '}') {
      const braceContext = braceContexts.pop();
      if (braceContext === 'object' && braceDepth > 0) {
        braceDepth -= 1;
        if (braceDepth === 0) closedObject = true;
      } else if (!braceContext && !sawObjectOpen) {
        // Compatibility fragments commonly start at the first property and
        // retain the generated object's closing brace.
        closedObject = true;
      }
      cursor += 1;
      canStartRegex = braceContext === 'block';
      lastSignificant = braceContext === 'block' ? 'close-block' : 'close-object';
      lastIdentifier = null;
      blockBracePending = false;
      continue;
    }
    cursor += 1;
    canStartRegex = REGEX_PREFIX_PUNCTUATION.has(character);
    lastSignificant = character === '.' ? 'dot' : 'punctuation';
    lastIdentifier = null;
    if (BLOCK_BRACE_PENDING_RESET.has(character)) blockBracePending = false;
  }
  if (requireObjectClosure && (
    (!sawObjectOpen && !closedObject)
    || (sawObjectOpen && (braceDepth !== 0 || !closedObject))
  )) {
    throw new Error(`[${errorLabel}] Static object is not closed in ${sourcePath}`);
  }
  return entries;
}
