/**
 * Fail-closed readers for static JavaScript/TypeScript string maps.
 *
 * This module lives under `engine/shared/` because the engine is transported
 * to the site repository as a closed subtree. Corpus-only scripts re-export
 * these functions from `scripts/lib/ts-literals.mjs`; the RSS engine must not
 * reach outside the mirrored subtree at runtime.
 */

const STATIC_LITERAL_QUOTES = new Set(['"', "'", '`']);
const TS_ESCAPE_RX = /\\(u[0-9a-fA-F]{4}|[\s\S])/g;

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

/** Decode a static literal using the same escape contract as the TS readers. */
export function decodeStaticStringLiteral(raw, quote = "'") {
  return raw.replace(TS_ESCAPE_RX, (whole, escape) => {
    switch (escape[0]) {
      case 'n': return '\n';
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
      const newline = source.indexOf('\n', cursor + 2);
      cursor = newline < 0 ? source.length : newline;
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
 */
export function readStaticObjectEntries(
  source,
  sourcePath = 'source',
  { errorLabel = 'static-literal', allowTerminalFragment = false } = {},
) {
  const entries = [];
  let cursor = 0;
  while (cursor < source.length) {
    cursor = skipStaticTrivia(source, cursor, sourcePath, errorLabel);
    if (cursor >= source.length) break;
    if (!STATIC_LITERAL_QUOTES.has(source[cursor])) {
      cursor += 1;
      continue;
    }

    const keyLiteral = readStaticStringLiteral(source, cursor, sourcePath, errorLabel);
    if (!keyLiteral) throw new Error(`[${errorLabel}] Unterminated string literal in ${sourcePath}`);
    const afterKey = skipStaticTrivia(source, keyLiteral.end, sourcePath, errorLabel);
    if (source[afterKey] !== ':') {
      cursor = keyLiteral.end;
      continue;
    }

    const valueStart = skipStaticTrivia(source, afterKey + 1, sourcePath, errorLabel);
    if (!STATIC_LITERAL_QUOTES.has(source[valueStart])) {
      throw new Error(`[${errorLabel}] Property ${decodeStaticStringLiteral(keyLiteral.value, keyLiteral.quote)} must have a static string value in ${sourcePath}`);
    }
    const valueLiteral = readStaticStringLiteral(source, valueStart, sourcePath, errorLabel);
    if (!valueLiteral) throw new Error(`[${errorLabel}] Unterminated value in ${sourcePath}`);
    const afterValue = skipStaticTrivia(source, valueLiteral.end, sourcePath, errorLabel);
    const terminal = afterValue >= source.length;
    if ((!terminal || !allowTerminalFragment)
      && source[afterValue] !== ',' && source[afterValue] !== '}') {
      throw new Error(`[${errorLabel}] Static property must end with ',' or '}' in ${sourcePath}`);
    }

    entries.push({
      key: decodeStaticStringLiteral(keyLiteral.value, keyLiteral.quote),
      value: decodeStaticStringLiteral(valueLiteral.value, valueLiteral.quote),
      keyQuote: keyLiteral.quote,
      valueQuote: valueLiteral.quote,
    });
    cursor = valueLiteral.end;
  }
  return entries;
}
