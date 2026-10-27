import {
  decodeStaticStringLiteral,
  readStaticStringLiteral,
  skipStaticTrivia,
} from './ts-literals.mjs';

/**
 * Lexical, balanced resolver for generated SEO entries.
 *
 * This module lives under the engine subtree because that subtree is mirrored
 * to the site. Corpus scripts use the compatibility re-export at
 * `scripts/lib/seo-entry.mjs`; the implementation must remain self-contained
 * so a mirrored engine consumer never imports a corpus-only helper.
 */

const CLOSING = { '{': '}', '[': ']', '(': ')' };
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LINE_TERMINATORS = '\n\r\u2028\u2029';
const isLineTerminator = character => LINE_TERMINATORS.includes(character);

function lineTerminatorIndex(source, offset) {
  for (let index = offset; index < source.length; index += 1) {
    if (isLineTerminator(source[index])) return index;
  }
  return -1;
}

const REGEX_PREFIX_KEYWORDS = new Set([
  'await', 'break', 'case', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'in',
  'instanceof', 'new', 'of', 'return', 'throw', 'typeof', 'void', 'yield',
]);
const REGEX_PREFIX_PUNCTUATION = new Set([
  '(', '[', '{', ',', ':', ';', '=', '!', '?', '+', '-', '*', '%', '&', '|', '^', '~', '<', '>',
]);
const CONTROL_PAREN_KEYWORDS = new Set(['catch', 'for', 'if', 'switch', 'while', 'with']);
const BLOCK_BRACE_KEYWORDS = new Set([
  'catch', 'class', 'do', 'else', 'enum', 'finally', 'function', 'interface', 'module', 'namespace',
  'static', 'try',
]);

/**
 * Find the closing delimiter for the one at `openIdx`, ignoring strings,
 * comments, and regular-expression literals. Returns `-1` when unclosed.
 */
function matchingDelimiter(src, openIdx) {
  const open = src[openIdx];
  const close = CLOSING[open];
  if (!close) throw new Error(`matchingDelimiter: '${open}' non è un delimitatore di apertura`);
  let depth = 0;
  let quote = null;
  let canStartRegex = true;
  let lastSignificant = null;
  let lastIdentifier = null;
  let statementStart = true;
  let lineBreakSinceToken = false;
  let caseLabelPending = false;
  let lastClosedParenControl = null;
  const parenContexts = [];
  const bracketContexts = [];
  const braceContexts = [];
  const statementEndingTokens = new Set([
    'identifier', 'literal', 'postfix', 'close-paren', 'close-bracket', 'close-object', 'close-block',
  ]);
  const recordLineBreak = () => {
    lineBreakSinceToken = true;
    if (parenContexts.length === 0 && bracketContexts.length === 0
      && statementEndingTokens.has(lastSignificant)) {
      statementStart = true;
    }
  };

  const skipRegex = (start) => {
    let inClass = false;
    for (let i = start + 1; i < src.length; i += 1) {
      if (src[i] === '\\') { i += 1; continue; }
      if (isLineTerminator(src[i])) return start;
      if (src[i] === '[') { inClass = true; continue; }
      if (src[i] === ']' && inClass) { inClass = false; continue; }
      if (src[i] === '/' && !inClass) {
        // A second slash is a line comment, not a regex terminator. Treat the
        // ambiguous literal as unclosed so a hidden bracket cannot be used as
        // an entry boundary.
        if (src[i + 1] === '/') return -1;
        while (/[A-Za-z]/.test(src[i + 1] || '')) i += 1;
        return i;
      }
    }
    return -1;
  };

  for (let i = openIdx; i < src.length; i += 1) {
    const ch = src[i];
    if (quote !== null) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      const lineEnd = lineTerminatorIndex(src, i + 2);
      if (lineEnd === -1) return -1;
      recordLineBreak();
      i = lineEnd;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) return -1;
      if (/\n|\r|\u2028|\u2029/u.test(src.slice(i, end + 2))) {
        recordLineBreak();
      }
      i = end + 1;
      continue;
    }
    if (/\s/.test(ch)) {
      if (isLineTerminator(ch)) {
        recordLineBreak();
      }
      continue;
    }
    const lineBreakBeforeToken = lineBreakSinceToken;
    lineBreakSinceToken = false;
    const controlKeywordBeforeToken = lastSignificant === 'close-paren' ? lastClosedParenControl : null;
    lastClosedParenControl = null;
    if (ch === '`') {
      const end = templateEnd(src, i);
      if (end === -1) return -1;
      i = end;
      canStartRegex = false;
      lastSignificant = 'literal';
      lastIdentifier = null;
      statementStart = false;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = quotedEnd(src, i, ch);
      if (end === -1) return -1;
      i = end;
      canStartRegex = false;
      lastSignificant = 'literal';
      lastIdentifier = null;
      statementStart = false;
      continue;
    }
    if (ch === '/' && canStartRegex) {
      const end = skipRegex(i);
      if (end === -1) return -1;
      i = end;
      canStartRegex = false;
      lastSignificant = 'literal';
      lastIdentifier = null;
      statementStart = false;
      continue;
    }
    if (src.startsWith('...', i)) {
      i += 2;
      canStartRegex = true;
      lastSignificant = 'spread';
      lastIdentifier = null;
      statementStart = false;
      continue;
    }
    if (ch === '/') {
      canStartRegex = true;
      lastSignificant = 'division';
      lastIdentifier = null;
      statementStart = false;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let end = i + 1;
      while (/[A-Za-z0-9_$]/.test(src[end] || '')) end += 1;
      const word = src.slice(i, end);
      const member = lastSignificant === 'dot' || lastSignificant === 'private-prefix';
      const identifierAtStatementStart = statementStart;
      canStartRegex = !member && REGEX_PREFIX_KEYWORDS.has(word);
      lastIdentifier = { value: word, member, statementStart: identifierAtStatementStart };
      lastSignificant = 'identifier';
      if (!member && identifierAtStatementStart && braceContexts.some(context => context.isSwitch)
        && (word === 'case' || word === 'default')) {
        caseLabelPending = true;
      }
      statementStart = false;
      i = end - 1;
      continue;
    }
    if (ch === '?' && src[i + 1] === '.') {
      i += 1;
      canStartRegex = false;
      lastSignificant = 'dot';
      lastIdentifier = null;
      statementStart = false;
      continue;
    }
    if (ch === '.' || ch === '#') {
      canStartRegex = false;
      lastSignificant = ch === '.' ? 'dot' : 'private-prefix';
      lastIdentifier = null;
      statementStart = false;
      continue;
    }
    if ((ch === '+' && src[i + 1] === '+') || (ch === '-' && src[i + 1] === '-')) {
      i += 1;
      canStartRegex = false;
      lastSignificant = 'postfix';
      lastIdentifier = null;
      statementStart = false;
      continue;
    }
    if (ch === '!' && src[i + 1] !== '=') {
      const postfix = !lineBreakBeforeToken && !canStartRegex;
      if (postfix) {
        canStartRegex = false;
        lastSignificant = 'postfix';
      } else {
        canStartRegex = true;
        lastSignificant = 'punctuation';
      }
      lastIdentifier = null;
      statementStart = false;
      continue;
    }
    if (ch === '=' && src[i + 1] === '>') {
      i += 1;
      canStartRegex = true;
      lastSignificant = 'arrow';
      lastIdentifier = null;
      statementStart = false;
      continue;
    }
    if (ch === '(') {
      const isTarget = open === '(' && i === openIdx;
      const controlKeyword = lastIdentifier && !lastIdentifier.member
        && CONTROL_PAREN_KEYWORDS.has(lastIdentifier.value)
        ? lastIdentifier.value
        : null;
      parenContexts.push({
        isTarget,
        control: controlKeyword !== null,
        controlKeyword,
      });
      if (isTarget) depth += 1;
      canStartRegex = true;
      lastSignificant = 'open-paren';
      lastIdentifier = null;
      statementStart = false;
      continue;
    }
    if (ch === ')') {
      const context = parenContexts.pop();
      lastClosedParenControl = context?.controlKeyword ?? null;
      if (context?.isTarget) {
        depth -= 1;
        if (depth === 0) return i;
      }
      canStartRegex = context?.control === true;
      lastSignificant = 'close-paren';
      lastIdentifier = null;
      statementStart = Boolean(context?.control);
      continue;
    }
    if (ch === '[') {
      const isTarget = open === '[' && i === openIdx;
      bracketContexts.push(isTarget);
      if (isTarget) depth += 1;
      canStartRegex = true;
      lastSignificant = 'open-bracket';
      lastIdentifier = null;
      statementStart = false;
      continue;
    }
    if (ch === ']') {
      const isTarget = bracketContexts.pop();
      if (isTarget) {
        depth -= 1;
        if (depth === 0) return i;
      }
      canStartRegex = false;
      lastSignificant = 'close-bracket';
      lastIdentifier = null;
      statementStart = false;
      continue;
    }
    if (ch === '{') {
      const isTarget = open === '{' && i === openIdx;
      const isBlock = !isTarget && (
        lastSignificant === 'close-paren'
        || lastSignificant === 'arrow'
        || lastSignificant === 'semicolon'
        || lastSignificant === 'close-block'
        || statementStart
        || (lastSignificant === 'identifier' && lastIdentifier
          && lastIdentifier.statementStart
          && !lastIdentifier.member && BLOCK_BRACE_KEYWORDS.has(lastIdentifier.value))
        || caseLabelPending
      );
      braceContexts.push({
        isTarget,
        isBlock: Boolean(isBlock),
        isSwitch: Boolean(isBlock && controlKeywordBeforeToken === 'switch'),
      });
      if (isTarget) depth += 1;
      canStartRegex = true;
      lastSignificant = isBlock ? 'open-block' : 'open-object';
      lastIdentifier = null;
      statementStart = Boolean(isBlock);
      caseLabelPending = false;
      continue;
    }
    if (ch === '}') {
      const context = braceContexts.pop();
      if (context?.isTarget) {
        depth -= 1;
        if (depth === 0) return i;
      }
      canStartRegex = context?.isBlock === true;
      lastSignificant = context?.isBlock ? 'close-block' : 'close-object';
      lastIdentifier = null;
      statementStart = context?.isBlock === true;
      caseLabelPending = false;
      continue;
    }
    if (ch === ':') {
      canStartRegex = true;
      lastSignificant = 'colon';
      lastIdentifier = null;
      if (caseLabelPending) statementStart = true;
      continue;
    }
    if (ch === ';') {
      canStartRegex = true;
      lastSignificant = 'semicolon';
      lastIdentifier = null;
      statementStart = true;
      continue;
    }
    canStartRegex = REGEX_PREFIX_PUNCTUATION.has(ch);
    lastSignificant = 'punctuation';
    lastIdentifier = null;
    statementStart = false;
  }
  return -1;
}

/** Return the end of an ordinary quoted JavaScript string, or `-1`. */
function quotedEnd(src, start, quote) {
  for (let i = start + 1; i < src.length; i += 1) {
    if (src[i] === '\\') { i += 1; continue; }
    if (src[i] === quote) return i;
    if (isLineTerminator(src[i])) return -1;
  }
  return -1;
}

/**
 * Find the closing backtick, including `${...}` expressions and nested
 * literals. Template text is not an SEO entry.
 */
function templateEnd(src, start) {
  for (let i = start + 1; i < src.length; i += 1) {
    if (src[i] === '\\') { i += 1; continue; }
    if (src[i] === '`') return i;
    if (src[i] !== '$' || src[i + 1] !== '{') continue;

    let depth = 1;
    for (i += 2; i < src.length; i += 1) {
      const ch = src[i];
      if (ch === '\\') { i += 1; continue; }
      if (ch === "'" || ch === '"') {
        const end = quotedEnd(src, i, ch);
        if (end === -1) return -1;
        i = end;
        continue;
      }
      if (ch === '`') {
        const end = templateEnd(src, i);
        if (end === -1) return -1;
        i = end;
        continue;
      }
      if (ch === '/' && src[i + 1] === '/') {
        const end = lineTerminatorIndex(src, i + 2);
        if (end === -1) return -1;
        i = end;
        continue;
      }
      if (ch === '/' && src[i + 1] === '*') {
        const end = src.indexOf('*/', i + 2);
        if (end === -1) return -1;
        i = end + 1;
        continue;
      }
      if (ch === '{') depth += 1;
      if (ch === '}' && --depth === 0) break;
    }
    if (depth !== 0) return -1;
  }
  return -1;
}

/** Find the end of a value expression before its containing object delimiter. */
function valueExpressionEnd(src, start) {
  let cursor = start;
  while (cursor < src.length) {
    const character = src[cursor];
    if (/\s/u.test(character)) {
      cursor += 1;
      continue;
    }
    if (character === ',' || character === '}') return cursor;
    if (character === "'" || character === '"') {
      const close = quotedEnd(src, cursor, character);
      cursor = close < 0 ? src.length : close + 1;
      continue;
    }
    if (character === '`') {
      const close = templateEnd(src, cursor);
      cursor = close < 0 ? src.length : close + 1;
      continue;
    }
    if (character === '/' && src[cursor + 1] === '/') {
      const lineEnd = lineTerminatorIndex(src, cursor + 2);
      cursor = lineEnd < 0 ? src.length : lineEnd;
      continue;
    }
    if (character === '/' && src[cursor + 1] === '*') {
      const close = src.indexOf('*/', cursor + 2);
      cursor = close < 0 ? src.length : close + 2;
      continue;
    }
    if (CLOSING[character]) {
      const close = matchingDelimiter(src, cursor);
      cursor = close < 0 ? src.length : close + 1;
      continue;
    }
    cursor += 1;
  }
  return cursor;
}

/**
 * Read top-level properties from one already-balanced SEO entry.
 *
 * Generated SEO objects can contain duplicate static properties while a
 * refresh is being reconciled. JavaScript object literals keep the last
 * assignment, so every metadata consumer must resolve the same final value.
 * Dynamic template values are skipped as opaque source; they are never
 * evaluated by the static reader.
 */
function forEachStaticProperty(block, visit) {
  const objectOpen = block.indexOf('{');
  let cursor = objectOpen >= 0 ? objectOpen + 1 : block.length;

  while (cursor < block.length) {
    cursor = skipStaticTrivia(block, cursor, 'SEO entry', 'seo-field');
    if (cursor >= block.length || block[cursor] === '}') break;

    let key;
    let keyEnd = cursor;
    const first = block[cursor];
    if (first === "'" || first === '"' || first === '`') {
      const literal = readStaticStringLiteral(block, cursor, 'SEO entry', 'seo-field');
      if (!literal) break;
      key = decodeStaticStringLiteral(literal.value, literal.quote);
      keyEnd = literal.end;
    } else if (/[A-Za-z_$]/u.test(first)) {
      keyEnd += 1;
      while (/[A-Za-z0-9_$]/u.test(block[keyEnd] || '')) keyEnd += 1;
      key = block.slice(cursor, keyEnd);
    } else {
      cursor += 1;
      continue;
    }

    const colon = skipStaticTrivia(block, keyEnd, 'SEO entry', 'seo-field');
    if (block[colon] !== ':') {
      cursor = keyEnd;
      continue;
    }
    const valueStart = skipStaticTrivia(block, colon + 1, 'SEO entry', 'seo-field');
    const valueEnd = valueExpressionEnd(block, valueStart);

    visit({ key, valueStart, valueEnd });
    cursor = valueEnd > cursor ? valueEnd : cursor + 1;
  }
}

/** Return whether a template literal contains an unevaluated interpolation. */
function hasTemplateInterpolation(block, valueStart, valueEnd) {
  for (let cursor = valueStart + 1; cursor < valueEnd; cursor += 1) {
    if (block[cursor] === '\\') {
      cursor += 1;
      continue;
    }
    if (block[cursor] === '$' && block[cursor + 1] === '{') return true;
  }
  return false;
}

/** Return whether a value span contains an interpolated template literal. */
function hasInterpolatedTemplateInRange(source, start, end, { allowBaseUrlTemplates = false } = {}) {
  let cursor = start;
  while (cursor < end) {
    const character = source[cursor];
    if (character === "'" || character === '"') {
      const close = quotedEnd(source, cursor, character);
      if (close < 0) return false;
      cursor = Math.min(close + 1, end);
      continue;
    }
    if (character === '/' && source[cursor + 1] === '/') {
      const lineEnd = lineTerminatorIndex(source, cursor + 2);
      if (lineEnd < 0) return false;
      cursor = Math.min(lineEnd, end);
      continue;
    }
    if (character === '/' && source[cursor + 1] === '*') {
      const close = source.indexOf('*/', cursor + 2);
      if (close < 0) return false;
      cursor = Math.min(close + 2, end);
      continue;
    }
    if (character === '`') {
      const close = templateEnd(source, cursor);
      const templateEndExclusive = close < 0 ? end : Math.min(close + 1, end);
      if (hasTemplateInterpolation(source, cursor, templateEndExclusive)) {
        const raw = close < 0 ? '' : source.slice(cursor, close + 1);
        const resolvedByEmitter = allowBaseUrlTemplates
          && /^`\$\{BASE_URL\}(?:(?!\$\{)[^`])*`$/u.test(raw);
        if (!resolvedByEmitter) return true;
      }
      cursor = templateEndExclusive;
      continue;
    }
    cursor += 1;
  }
  return false;
}

function emptyPropertyState() {
  return { assigned: false, dynamic: false, value: undefined };
}

function mergePropertyStates(previous, next) {
  return {
    assigned: previous.assigned || next.assigned,
    dynamic: previous.dynamic || next.dynamic,
    // A JSON-LD array contains independent objects, so the last object that
    // assigns the field wins for readers while a dynamic assignment in any
    // object remains fail-closed for validation.
    value: next.assigned ? next.value : previous.value,
  };
}

/**
 * Resolve one field from structuredData, which may be an object or an array
 * of JSON-LD objects. URL templates in unrelated properties must not make a
 * static headline/description look dynamic merely because they share the
 * same array container.
 */
function structuredDataPropertyState(block, valueStart, valueEnd, field, resolver, options = {}) {
  const quote = block[valueStart];
  if (quote === '{') {
    return resolver(block.slice(valueStart, valueEnd), field, options);
  }
  if (quote !== '[') {
    return hasInterpolatedTemplateInRange(block, valueStart, valueEnd, options)
      ? { assigned: true, dynamic: true, value: undefined }
      : emptyPropertyState();
  }

  const array = block.slice(valueStart, valueEnd);
  const arrayEnd = array.length - 1;
  let cursor = 1;
  let state = emptyPropertyState();
  while (cursor < arrayEnd) {
    cursor = skipStaticTrivia(array, cursor, 'SEO entry', 'structuredData-array');
    if (cursor >= arrayEnd || array[cursor] === ']') break;

    // JSON-LD arrays emitted by the article source are arrays of object
    // literals. An expression here could hide a metadata field, so reject it
    // rather than silently publishing a reduced feed.
    if (array[cursor] !== '{') {
      return { assigned: true, dynamic: true, value: undefined };
    }
    const close = matchingDelimiter(array, cursor);
    if (close < 0 || close >= arrayEnd) {
      return { assigned: true, dynamic: true, value: undefined };
    }
    state = mergePropertyStates(
      state,
      resolver(array.slice(cursor, close + 1), field, options),
    );
    cursor = skipStaticTrivia(array, close + 1, 'SEO entry', 'structuredData-array');
    if (cursor < arrayEnd && array[cursor] === ',') {
      cursor += 1;
      continue;
    }
    if (cursor < arrayEnd && array[cursor] !== ']') {
      return { assigned: true, dynamic: true, value: undefined };
    }
  }
  return state;
}

function interpolatedPropertyState(block, field, options = {}) {
  let lastTopLevelValue = emptyPropertyState();
  let lastStructuredDataValue = emptyPropertyState();
  forEachStaticProperty(block, ({ key, valueStart, valueEnd }) => {
    if (key === field) {
      lastTopLevelValue = {
        assigned: true,
        dynamic: hasInterpolatedTemplateInRange(block, valueStart, valueEnd, options),
        value: undefined,
      };
    }
    if (key === 'structuredData') {
      lastStructuredDataValue = structuredDataPropertyState(
        block,
        valueStart,
        valueEnd,
        field,
        interpolatedPropertyState,
        options,
      );
    }
  });
  return {
    assigned: lastTopLevelValue.assigned || lastStructuredDataValue.assigned,
    dynamic: lastTopLevelValue.dynamic || lastStructuredDataValue.dynamic,
    value: undefined,
  };
}

function readPropertyState(block, valueStart, valueEnd) {
  const quote = block[valueStart];
  if ((quote === "'" || quote === '"' || quote === '`' || quote === '(')
    && hasInterpolatedTemplateInRange(block, valueStart, valueEnd)) {
    return { assigned: true, dynamic: true, value: undefined, quote };
  }
  if (quote !== "'" && quote !== '"' && quote !== '`') {
    return { assigned: true, dynamic: false, value: undefined, quote };
  }
  const literal = readStaticStringLiteral(block, valueStart, 'SEO entry', 'seo-field');
  return {
    assigned: true,
    dynamic: false,
    value: decodeStaticStringLiteral(literal.value, literal.quote),
    quote: literal.quote,
    valueStart,
    valueEnd: literal.end,
  };
}

/** Resolve a field while retaining whether the final assignment is dynamic. */
export function staticPropertyState(block, field) {
  let lastValue = emptyPropertyState();
  let lastTopLevelValue = emptyPropertyState();
  forEachStaticProperty(block, ({ key, valueStart, valueEnd }) => {
    if (key === field) {
      lastTopLevelValue = readPropertyState(block, valueStart, valueEnd);
      lastValue = lastTopLevelValue;
    }
    if (key === 'structuredData'
      && ['headline', 'datePublished', 'dateModified', 'articleSection'].includes(field)) {
      const nested = structuredDataPropertyState(
        block,
        valueStart,
        valueEnd,
        field,
        staticPropertyState,
      );
      lastValue = nested.assigned ? nested : lastTopLevelValue;
    }
  });
  return lastValue;
}

/** Return whether any relevant assignment is an unevaluated template literal. */
export function hasInterpolatedStaticProperty(block, field, options = {}) {
  return interpolatedPropertyState(block, field, options).dynamic;
}

/** Return the final balanced structuredData object, if it is an object. */
export function readStructuredSeoBlock(block) {
  let structuredData;
  forEachStaticProperty(block, ({ key, valueStart, valueEnd }) => {
    if (key === 'structuredData') {
      structuredData = block[valueStart] === '{'
        ? block.slice(valueStart, valueEnd)
        : undefined;
    }
  });
  return structuredData;
}

/** Return the final structuredData description state, including interpolation. */
export function readStructuredSeoDescriptionState(block) {
  let state = emptyPropertyState();
  forEachStaticProperty(block, ({ key, valueStart, valueEnd }) => {
    if (key !== 'structuredData') return;
    const dynamic = structuredDataPropertyState(
      block,
      valueStart,
      valueEnd,
      'description',
      interpolatedPropertyState,
    );
    const staticValue = structuredDataPropertyState(
      block,
      valueStart,
      valueEnd,
      'description',
      staticPropertyState,
    );
    state = {
      assigned: dynamic.assigned || staticValue.assigned,
      dynamic: dynamic.dynamic || staticValue.dynamic,
      value: dynamic.dynamic || staticValue.dynamic ? undefined : staticValue.value,
    };
  });
  return state;
}

/** Return the final static string assigned to a top-level field. */
export function lastStaticPropertyValue(block, field) {
  return staticPropertyState(block, field).value;
}

/**
 * Return every top-level static string assigned to `field`.
 *
 * Writers use this to reject ambiguous duplicate fields before a refresh. The
 * returned ranges are source-relative and retain the original quote, so a
 * caller can replace the chosen literal without falling back to a first-match
 * regular expression that might cross into structuredData.
 */
export function staticPropertyValues(block, field) {
  const values = [];
  forEachStaticProperty(block, ({ key, valueStart, valueEnd }) => {
    if (key !== field) return;
    const state = readPropertyState(block, valueStart, valueEnd);
    if (state.quote !== "'" && state.quote !== '"' && state.quote !== '`') return;
    values.push({
      quote: state.quote,
      valueStart,
      valueEnd: state.valueEnd ?? valueEnd,
      value: state.value,
      dynamic: state.dynamic,
    });
  });
  return values;
}

/** Return source spans for every top-level property, including object values. */
export function staticPropertySpans(block, field) {
  const spans = [];
  forEachStaticProperty(block, ({ key, valueStart, valueEnd }) => {
    if (key === field) {
      const state = readPropertyState(block, valueStart, valueEnd);
      spans.push({
        valueStart,
        valueEnd,
        quote: block[valueStart],
        dynamic: state.dynamic,
      });
    }
  });
  return spans;
}

/** Read the final `description` from the JSON-LD-shaped structuredData object. */
export function readStructuredSeoDescription(block) {
  let description;
  forEachStaticProperty(block, ({ key, valueStart, valueEnd }) => {
    if (key !== 'structuredData') return;
    description = structuredDataPropertyState(
      block,
      valueStart,
      valueEnd,
      'description',
      staticPropertyState,
    ).value;
  });
  return description;
}

function isRealSeoKey(src, start, end) {
  let lineStart = start;
  while (lineStart > 0 && !isLineTerminator(src[lineStart - 1])) {
    lineStart -= 1;
  }
  if (!/^[\t ]*$/.test(src.slice(lineStart, start))) return false;
  const key = src.slice(start + 1, end);
  return /^blog-[^'\\\r\n\u2028\u2029]+$/u.test(key) && /^\s*:\s*\{/.test(src.slice(end + 1));
}

/**
 * Mask comments and literal contents without changing UTF-16 offsets.
 * Canonical single-quoted SEO keys are deliberately kept visible.
 * Unclosed tokens are rejected instead of turning the remainder into an
 * apparently valid prefix.
 */
export function maskSeoSource(source, file = 'SEO source') {
  const src = String(source);
  const masked = new Array(src.length);
  for (let i = 0; i < src.length; i += 1) {
    masked[i] = isLineTerminator(src[i]) ? src[i] : ' ';
  }

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '/' && src[i + 1] === '/') {
      const end = lineTerminatorIndex(src, i + 2);
      i = end === -1 ? src.length - 1 : end - 1;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) throw new Error(`${file}: commento multilinea non chiuso`);
      i = end + 1;
      continue;
    }
    if (ch === '`') {
      const end = templateEnd(src, i);
      if (end === -1) throw new Error(`${file}: template literal non chiuso`);
      i = end;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = quotedEnd(src, i, ch);
      if (end === -1) throw new Error(`${file}: stringa ${ch} non chiusa`);
      if (ch === "'" && end !== -1 && isRealSeoKey(src, i, end)) {
        for (let j = i; j <= end; j += 1) masked[j] = src[j];
      }
      i = end;
      continue;
    }
    masked[i] = ch;
  }
  return masked.join('');
}

function locateSeoEntryMatches(source, entryRe, file) {
  const src = String(source);
  const masked = maskSeoSource(src, file);
  const matches = [];
  for (const match of masked.matchAll(entryRe)) {
    const keyOffset = match[0].indexOf("'blog-");
    const index = match.index + keyOffset;
    const openIdx = match.index + match[0].length - 1;
    const closeIdx = matchingDelimiter(src, openIdx);
    if (closeIdx === -1) {
      const id = match[1] ?? 'unknown';
      throw new Error(`${file}: graffe sbilanciate attorno a blog-${id}`);
    }
    matches.push({
      id: match[1],
      index,
      lineStart: match.index,
      indent: match[0].slice(0, keyOffset),
      openIdx,
      closeIdx,
    });
  }
  return matches;
}

/** Locate every real `blog-<id>` object entry, regardless of indentation. */
export function findSeoEntryMatches(source, id, file = 'SEO source') {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`${file}: article id must be a non-empty string`);
  }

  const escaped = escapeRegex(id);
  const entryRe = new RegExp(`^[\\t ]*'blog-(${escaped})'\\s*:\\s*\\{`, 'gm');
  return locateSeoEntryMatches(source, entryRe, file);
}

/** Locate all real SEO entries for consumers that need the whole chunk. */
export function findAllSeoEntryMatches(source, file = 'SEO source') {
  return locateSeoEntryMatches(source, /^[\t ]*'blog-([^']+)'\s*:\s*\{/gm, file);
}

/** Remove every `'blog-<id>': { ... },` block from `source`. */
export function removeSeoEntriesFromSource(source, id, file = 'SEO source') {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`${file}: article id must be a non-empty string`);
  }

  let src = String(source);
  const matches = findSeoEntryMatches(src, id, file);
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const { lineStart, closeIdx } = matches[i];
    let end = closeIdx + 1;
    if (src[end] === ',') end += 1;
    if (src[end] === '\r' && src[end + 1] === '\n') end += 2;
    else if (isLineTerminator(src[end])) end += 1;
    src = src.slice(0, lineStart) + src.slice(end);
  }

  const remaining = findSeoEntryMatches(src, id, file).length;
  if (remaining !== 0) {
    throw new Error(`${file}: restano ${remaining} voci SEO per blog-${id} dopo la rimozione`);
  }
  return { changed: matches.length > 0, src, removed: matches.length };
}
