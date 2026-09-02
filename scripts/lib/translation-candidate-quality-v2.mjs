import { detectLanguageWithConfidence } from './detect-language.mjs';
import { titleLooksUntranslated } from './job-locale-utils.mjs';
import { hasConcatenatedWords, isAcceptableTranslation, isStructureFlattenedCopy } from './translation-quality.mjs';
import {
  deepFreezeTranslationV2,
  digestTranslationDocumentV2,
} from './translation-unit-identity-v2.mjs';

export const TRANSLATION_CANDIDATE_QUALITY_V2_SCHEMA_VERSION = 2;

const INPUT_KEYS = ['candidateText', 'field', 'protectedTokens', 'sourceLang', 'sourceText', 'targetLang'];
const PROTECTED_TOKEN_KEYS = ['category', 'value'];
const LANGUAGES = new Set(['it', 'en', 'de', 'fr']);
const FIELDS = new Set(['title', 'description']);
const TOKEN_CATEGORIES = new Set(['company', 'person', 'location', 'salary', 'structured']);
const MAX_TEXT_LENGTH = 120_000;
const MAX_PROTECTED_TOKENS = 64;
const MAX_PROTECTED_TOKEN_LENGTH = 512;
const MIN_DOMINANT_PERIODIC_TOKENS = 32;
const MAX_EXHAUSTIVE_PERIODIC_COMPARISONS = 16_000_000;
const MAX_LONG_PERIODIC_COMPARISONS = 4_000_000;
const LONG_PERIOD_REPEAT_BOUND = 16;
const MIN_NGRAM_REUSE_TOKENS = 256;
const NGRAM_REUSE_WIDTH = 12;
// detect-language documents confidence >= 0.6 as reliable; do not create a
// second calibration for this additive gate.
const RELIABLE_LANGUAGE_CONFIDENCE = 0.6;
const MAX_EVIDENCE = 8;

const DEFAULT_IGNORABLE_RE = (() => {
  try {
    // Node's supported target implements this Unicode property. The fallback
    // remains complete for older runtimes rather than weakening boundaries.
    return /\p{Default_Ignorable_Code_Point}/gu;
  } catch {
    return /[\u00ad\u034f\u061c\u115f-\u1160\u17b4-\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufeff\uffa0\ufff0-\ufff8\u{1bca0}-\u{1bca3}\u{1d173}-\u{1d17a}\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;
  }
})();
const PROTECTED_BOUNDARY = String.raw`[\p{L}\p{N}+&#]`;
const PROTECTED_BOUNDARY_RE = new RegExp(PROTECTED_BOUNDARY, 'u');

const URL_RE = /https?:\/\/[^\s<>"']+/giu;
const EMAIL_RE = /(?<![\p{L}\p{N}_%+\-])([\p{L}\p{N}][\p{L}\p{N}._%+\-]*@[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?(?:\.[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?)+)(?![\p{L}\p{N}_%+\-])/gu;
const VERSION_RE = /\bv\d+(?:\.\d+)*\b/giu;
const DATE_RE = /(?<![\p{L}\p{N}])\d{4}([./-])\d{1,2}\1\d{1,2}(?![\p{L}\p{N}])/gu;
// Spaces/apostrophes are grouping separators only before exact 3-digit
// groups. This avoids treating a prose sequence such as `1 2 3 ...` as one
// enormous number (and keeps the regex's repetition bounded by its input).
const NUMBER_ATOM = String.raw`(?:\d{1,3}(?:(?:[ '\u2019\u00a0\u202f]\d{3})+|(?:[.,]\d{3})+)(?:[.,]\d+)?|\d+(?:[.,]\d+)?|[.,]\d+)`;
const CURRENCY = String.raw`(?:CHF|EUR|USD|GBP|€|\$|£)`;
// Deliberately narrow, corpus-backed units: this recognizes translations of
// employment hours and rates without treating arbitrary prose as a unit.
const UNIT_ATOM = String.raw`(?:heures?|hours?|or[ae]|h|stunden?|weeks?|settiman[ae]|semaines?|wochen?|months?|mesi?|mois|monate?n?)`;
const RANGE_SPACE = String.raw`\s{0,256}`;
const RANGE_PREFIX = String.raw`(?:(?:[+\-−]${RANGE_SPACE}${CURRENCY}|${CURRENCY}${RANGE_SPACE}[+\-−]?|[+\-−])${RANGE_SPACE})?`;
const RANGE_SUFFIX = String.raw`(?:(?:${RANGE_SPACE}${CURRENCY})|(?:${RANGE_SPACE}%))*`;
const RANGE_ENDPOINT = String.raw`(${RANGE_PREFIX}${NUMBER_ATOM}${RANGE_SUFFIX})`;
const RANGE_RE = new RegExp(String.raw`(?<![\p{L}\p{N}_.])${RANGE_ENDPOINT}${RANGE_SPACE}(?:-|\u2010|\u2011|\u2012|\u2013|\u2014|\u2212)${RANGE_SPACE}${RANGE_ENDPOINT}${RANGE_SUFFIX}(?![\p{L}\p{N}_]|[.,]\d)`, 'giu');
const NUMBER_RE = new RegExp(String.raw`(?<![\p{L}\p{N}_.])(CHF|EUR|USD|GBP|€|\$|£)?(${NUMBER_ATOM})(?:${RANGE_SPACE}(${UNIT_ATOM})(?:${RANGE_SPACE}\/${RANGE_SPACE}(${UNIT_ATOM}))?)?(?![.,]\d)`, 'giu');
const MAX_NUMERIC_AFFIX_WHITESPACE = 256;
const AFFIX_SPACE = String.raw`\s{0,${MAX_NUMERIC_AFFIX_WHITESPACE}}`;
const AFFIX_SIGN_THEN_CURRENCY_RE = new RegExp(String.raw`([+\-−])?${AFFIX_SPACE}(CHF|EUR|USD|GBP|€|\$|£)${AFFIX_SPACE}$`, 'iu');
const AFFIX_CURRENCY_THEN_SIGN_RE = new RegExp(String.raw`(CHF|EUR|USD|GBP|€|\$|£)${AFFIX_SPACE}([+\-−])?${AFFIX_SPACE}$`, 'iu');
const AFFIX_CURRENCY_AFTER_RE = new RegExp(String.raw`^${AFFIX_SPACE}(CHF|EUR|USD|GBP|€|\$|£)`, 'iu');
const AFFIX_SIGN_RE = new RegExp(String.raw`([+\-−])${AFFIX_SPACE}$`, 'u');
const AFFIX_PERCENT_RE = new RegExp(String.raw`^${AFFIX_SPACE}%`, 'u');
const AFFIX_LEFT_START_RE = /[+\-−A-Za-z€$£]/u;
const AFFIX_RIGHT_START_RE = /[%A-Za-z€$£]/u;
const WHITESPACE_RE = /\s/u;
const UNIT_CANONICAL = new Map([
  ['h', 'hour'], ['hour', 'hour'], ['hours', 'hour'], ['ora', 'hour'], ['ore', 'hour'], ['heure', 'hour'], ['heures', 'hour'], ['stunde', 'hour'], ['stunden', 'hour'],
  ['week', 'week'], ['weeks', 'week'], ['settimana', 'week'], ['settimane', 'week'], ['semaine', 'week'], ['semaines', 'week'], ['woche', 'week'], ['wochen', 'week'],
  ['month', 'month'], ['months', 'month'], ['mese', 'month'], ['mesi', 'month'], ['mois', 'month'], ['monat', 'month'], ['monate', 'month'], ['monaten', 'month'],
]);

function compareText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function assertBoundedText(value, label, limit = MAX_TEXT_LENGTH) {
  if (typeof value !== 'string' || value.length > limit) {
    throw new TypeError(`${label} must be bounded text`);
  }
}

function snapshotExactDataObject(value, keys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) {
    throw new TypeError(`${label} has an unsupported schema`);
  }
  const snapshot = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.get || descriptor.set) {
      throw new TypeError(`${label} must use data properties`);
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function snapshotProtectedTokens(value) {
  if (!Array.isArray(value)) throw new TypeError('protectedTokens must be a bounded array');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_PROTECTED_TOKENS) {
    throw new TypeError('protectedTokens must be a bounded array');
  }
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.length !== length + 1 || !Object.hasOwn(descriptors, 'length')) {
    throw new TypeError('protectedTokens must be a bounded array');
  }
  for (const key of ownKeys) {
    if (key === 'length') continue;
    if (typeof key !== 'string') throw new TypeError('protectedTokens must be a bounded array');
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index < 0 || index >= length || String(index) !== key) {
      throw new TypeError('protectedTokens must be a bounded array');
    }
  }
  const tokens = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.get || descriptor.set) {
      throw new TypeError('protectedTokens must use data properties');
    }
    tokens.push(snapshotExactDataObject(descriptor.value, PROTECTED_TOKEN_KEYS, 'protected token'));
  }
  return Object.freeze(tokens);
}

function normalizeLanguage(value, label) {
  if (typeof value !== 'string' || !LANGUAGES.has(value)) {
    throw new TypeError(`${label} must be one of it, en, de, fr`);
  }
  return value;
}

function validateInput(input) {
  const value = snapshotExactDataObject(input, INPUT_KEYS, 'translation candidate quality v2 input');
  assertBoundedText(value.sourceText, 'sourceText');
  assertBoundedText(value.candidateText, 'candidateText');
  const sourceLang = normalizeLanguage(value.sourceLang, 'sourceLang');
  const targetLang = normalizeLanguage(value.targetLang, 'targetLang');
  if (!FIELDS.has(value.field)) throw new TypeError('field must be title or description');
  const protectedTokens = snapshotProtectedTokens(value.protectedTokens).map((token) => {
    if (!TOKEN_CATEGORIES.has(token.category)) throw new TypeError('protected token category is invalid');
    assertBoundedText(token.value, 'protected token value', MAX_PROTECTED_TOKEN_LENGTH);
    if (!canonicalProtectedParts(token.value).length) throw new TypeError('protected token value must contain visible tokens');
    return Object.freeze({ category: token.category, value: token.value });
  });
  const protectedTokenKeys = protectedTokens.map((token) => `${token.category}:${canonicalProtectedParts(token.value).join('\u0000')}`);
  if (new Set(protectedTokenKeys).size !== protectedTokenKeys.length) {
    throw new TypeError('protectedTokens must not contain canonical duplicates');
  }
  return Object.freeze({
    sourceText: value.sourceText,
    candidateText: value.candidateText,
    sourceLang,
    targetLang,
    field: value.field,
    protectedTokens: Object.freeze(protectedTokens),
  });
}

function visibleTokens(value) {
  return canonicalProtectedText(value).match(/[\p{L}\p{N}]+/gu) ?? [];
}

function canonicalProtectedText(value) {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(DEFAULT_IGNORABLE_RE, '')
    .toLocaleLowerCase('und');
}

function canonicalProtectedParts(value) {
  return canonicalProtectedText(value)
    // `C++` and `AT&T` are names, not decoration. Keep symbol runs which can
    // change an identifier while deliberately ignoring ordinary separators.
    .match(/[\p{L}\p{N}]+|[+&#]+/gu) ?? [];
}

function sameSequence(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function containsProtectedToken(text, value) {
  const canonicalText = canonicalProtectedText(text);
  const canonicalValue = canonicalProtectedText(value);
  if (/[+&#]/u.test(canonicalValue)) {
    const exactPattern = canonicalValue
      .split(/\s+/u)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join(String.raw`\s+`);
    return new RegExp(String.raw`(?<!${PROTECTED_BOUNDARY})${exactPattern}(?!${PROTECTED_BOUNDARY})`, 'u').test(canonicalText);
  }
  const textParts = [...canonicalText.matchAll(/[\p{L}\p{N}]+|[+&#]+/gu)];
  const valueParts = canonicalProtectedParts(value);
  if (valueParts.length > textParts.length) return false;
  for (let index = 0; index <= textParts.length - valueParts.length; index += 1) {
    if (!valueParts.every((part, offset) => textParts[index + offset][0] === part)) continue;
    const start = textParts[index].index ?? 0;
    const end = (textParts[index + valueParts.length - 1].index ?? 0) + textParts[index + valueParts.length - 1][0].length;
    if (!PROTECTED_BOUNDARY_RE.test(canonicalText[start - 1] ?? '')
        && !PROTECTED_BOUNDARY_RE.test(canonicalText[end] ?? '')) return true;
  }
  return false;
}

function isDegenerateDescription(tokens) {
  if (tokens.length === 0 || new Set(tokens).size < 2) return true;
  // A lexical diversity cutoff is unsound here: the real corpus includes
  // legitimate descriptions with a 1.18% unique-token ratio. Detect instead
  // positional periodicity, and confirm every near-periodic candidate by
  // direct comparison before rejecting it.
  const tokenIds = new Map();
  const values = new Uint32Array(tokens.length);
  let nextId = 1;
  for (let index = 0; index < tokens.length; index += 1) {
    let id = tokenIds.get(tokens[index]);
    if (id === undefined) {
      id = nextId;
      nextId += 1;
      tokenIds.set(tokens[index], id);
    }
    values[index] = id;
  }
  // The prefix function gives the shortest exact period of the complete token
  // sequence in O(n), regardless of alphabet size or duplicate n-grams. A
  // trailing partial repetition is still a period and remains degenerate once
  // at least four units are present.
  if (values.length >= MIN_DOMINANT_PERIODIC_TOKENS) {
    const prefixLengths = new Uint32Array(values.length);
    for (let index = 1; index < values.length; index += 1) {
      let matched = prefixLengths[index - 1];
      while (matched > 0 && values[index] !== values[matched]) {
        matched = prefixLengths[matched - 1];
      }
      if (values[index] === values[matched]) matched += 1;
      prefixLengths[index] = matched;
    }
    const exactPeriod = values.length - prefixLengths[values.length - 1];
    if (exactPeriod * 4 <= values.length) return true;
  }
  // Long near-periods over a small alphabet can hide every useful occurrence
  // anchor and sit beyond both bounded direct scans. Count exact fixed-width
  // token windows instead: a window key is the comma-delimited token-id tuple,
  // so equality is collision-free rather than hash-probabilistic. Requiring
  // reused windows for 90% of the complete token sequence is deliberately
  // conservative; ordinary repeated boilerplate does not approach this bound.
  // Width is constant, making this pass O(n) in time and memory regardless of
  // the unknown period length.
  const requiredMatches = Math.ceil(values.length * 0.9);
  if (values.length >= MIN_NGRAM_REUSE_TOKENS) {
    const seenNgrams = new Set();
    let reusedNgrams = 0;
    for (let start = 0; start + NGRAM_REUSE_WIDTH <= values.length; start += 1) {
      const key = values.subarray(start, start + NGRAM_REUSE_WIDTH).join(',');
      if (seenNgrams.has(key)) {
        reusedNgrams += 1;
        if (reusedNgrams >= requiredMatches) return true;
      } else {
        seenNgrams.add(key);
      }
    }
  }
  // Exhaustively score primitive periods before using occurrence anchors.
  // This path depends only on positional equality, so repeated tokens and
  // repeated n-grams inside the primitive unit cannot hide its true period.
  // The comparison budget is independent of vocabulary and caps hostile
  // 120k-character input; the anchor/LCP path below covers remaining periods.
  const allowedMismatches = values.length - requiredMatches + 2;
  const maxPeriod = Math.floor(values.length / 4);
  let exhaustiveComparisons = 0;
  let exhaustivelyScannedThrough = 0;
  if (values.length >= MIN_DOMINANT_PERIODIC_TOKENS) {
    for (let period = 1; period <= maxPeriod; period += 1) {
      let mismatches = 0;
      let budgetExhausted = false;
      for (let index = period; index < values.length; index += 1) {
        exhaustiveComparisons += 1;
        if (values[index] !== values[index - period]) mismatches += 1;
        if (exhaustiveComparisons >= MAX_EXHAUSTIVE_PERIODIC_COMPARISONS) {
          budgetExhausted = true;
          break;
        }
        if (mismatches > allowedMismatches) break;
      }
      if (budgetExhausted) break;
      if (mismatches <= allowedMismatches) return true;
      exhaustivelyScannedThrough = period;
    }

    // Long primitive periods have few repetitions. Scan that bounded band
    // from n/4 downward so a four-copy candidate is reached immediately even
    // with a short prefix/tail or sparse substitutions. This preserves the
    // same 90% authority and adds a fixed cost, rather than raising the broad
    // exhaustive budget.
    const minLongPeriod = Math.floor(values.length / (LONG_PERIOD_REPEAT_BOUND + 1));
    let longPeriodComparisons = 0;
    longPeriods:
    for (let period = maxPeriod; period > minLongPeriod; period -= 1) {
      if (period <= exhaustivelyScannedThrough) break;
      let mismatches = 0;
      for (let index = period; index < values.length; index += 1) {
        longPeriodComparisons += 1;
        if (values[index] !== values[index - period]) mismatches += 1;
        if (longPeriodComparisons >= MAX_LONG_PERIODIC_COMPARISONS) break longPeriods;
        if (mismatches > allowedMismatches) break;
      }
      if (mismatches <= allowedMismatches) return true;
    }
  }
  const base = 1_000_003;
  const forward = new Uint32Array(values.length + 1);
  const reverse = new Uint32Array(values.length + 1);
  const powers = new Uint32Array(values.length + 1);
  powers[0] = 1;
  for (let index = 0; index < values.length; index += 1) {
    forward[index + 1] = Math.imul(forward[index], base) + values[index];
    reverse[index + 1] = Math.imul(reverse[index], base) + values[values.length - index - 1];
    powers[index + 1] = Math.imul(powers[index], base);
  }
  const hash = (table, start, length) => (
    table[start + length] - Math.imul(table[start], powers[length])
  ) >>> 0;
  const equalPrefixLength = (left, right, limit, table) => {
    let low = 0;
    let high = limit;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (hash(table, left, middle) === hash(table, right, middle)) low = middle;
      else high = middle - 1;
    }
    return low;
  };
  // Retain every qualifying anchor, rather than the first anchor per period.
  // Pair anchors, rather than single tokens, keep a period visible when its
  // repeated unit contains adjacent duplicates (`a a b b`), whose individual
  // token gaps alternate within every unit. There is at most one candidate per
  // token-pair index, keeping this O(n) in memory; LCP checks are O(log n).
  const candidatePeriods = new Map();
  const occurrences = new Map();
  const pairBase = values.length + 1;
  for (let index = 0; index + 1 < values.length; index += 1) {
    const pair = values[index] * pairBase + values[index + 1];
    const previous = occurrences.get(pair);
    if (!previous) {
      occurrences.set(pair, { last: index, gap: 0, run: 0 });
      continue;
    }
    const gap = index - previous.last;
    const run = gap === previous.gap ? previous.run + 1 : 1;
    if (run >= 3) {
      // The fourth occurrence proves three comparison anchors. Retain each
      // anchor once (with a deterministic smallest period) so an altered
      // first repetition cannot hide its matching prefix from the interval
      // union built below.
      for (let offset = 0; offset < 3; offset += 1) {
        const anchor = index - offset * gap;
        const knownPeriod = candidatePeriods.get(anchor);
        if (knownPeriod === undefined || gap < knownPeriod) candidatePeriods.set(anchor, gap);
      }
    }
    occurrences.set(pair, { last: index, gap, run });
  }
  const candidates = [...candidatePeriods]
    .sort(([leftAnchor, leftPeriod], [rightAnchor, rightPeriod]) => (
      leftAnchor - rightAnchor || leftPeriod - rightPeriod
    ))
    .map(([anchor, period]) => [period, anchor]);
  const exactRegions = new Set();
  const comparisonIntervals = new Map();
  for (const [period, anchor] of candidates) {
    if (period < 1 || period * 4 > tokens.length) continue;
    const right = equalPrefixLength(anchor - period, anchor, tokens.length - anchor, forward);
    const left = equalPrefixLength(
      tokens.length - anchor,
      tokens.length - (anchor - period),
      anchor - period,
      reverse,
    );
    const start = anchor - left - period;
    const end = anchor + right;
    const regionLength = end - start;
    const comparisonStart = Math.max(start + period, period);
    if (comparisonStart < end) {
      const intervals = comparisonIntervals.get(period) ?? [];
      intervals.push([comparisonStart, end]);
      comparisonIntervals.set(period, intervals);
    }
    if (regionLength < MIN_DOMINANT_PERIODIC_TOKENS || regionLength * 10 < tokens.length * 9) continue;
    const regionKey = `${start}:${end}:${period}`;
    if (exactRegions.has(regionKey)) continue;
    exactRegions.add(regionKey);
    let exact = true;
    for (let index = start + period; index < end; index += 1) {
      if (tokens[index] !== tokens[index - period]) {
        exact = false;
        break;
      }
    }
    if (exact) return true;
  }

  // Merge LCP-shortlisted comparison positions per period. This remains
  // O(n log n): there is one interval per anchor and at most one anchor per
  // token index. A global direct pass, rather than the former prefix-limited
  // check, is the authority for a near-periodic decision.
  const promisingPeriods = [];
  for (const [period, intervals] of comparisonIntervals) {
    intervals.sort(([leftStart, leftEnd], [rightStart, rightEnd]) => (
      leftStart - rightStart || leftEnd - rightEnd
    ));
    let covered = 0;
    let mergedStart = -1;
    let mergedEnd = -1;
    for (const [start, end] of intervals) {
      if (mergedStart < 0) {
        mergedStart = start;
        mergedEnd = end;
      } else if (start <= mergedEnd) {
        mergedEnd = Math.max(mergedEnd, end);
      } else {
        covered += mergedEnd - mergedStart;
        mergedStart = start;
        mergedEnd = end;
      }
    }
    if (mergedStart >= 0) covered += mergedEnd - mergedStart;
    if (covered + period + 2 >= requiredMatches) promisingPeriods.push(period);
  }
  promisingPeriods.sort((left, right) => left - right);
  // A nondegenerate candidate does not reach the 90% interval threshold and
  // therefore incurs no O(n) direct scan. A qualifying interval set is made
  // only of same-period comparison positions; the first exact confirmation
  // returns immediately, so a real periodic input performs one direct pass.
  for (const period of promisingPeriods) {
    let directMatches = 0;
    for (let index = period; index < tokens.length; index += 1) {
      if (tokens[index] === tokens[index - period]) directMatches += 1;
    }
    if (directMatches + period + 2 >= requiredMatches) return true;
  }
  return false;
}

function isIncompleteTitle(sourceTokens, candidateTokens, candidateText) {
  const candidateVisibleLength = candidateTokens.join('').length;
  if (candidateTokens.length === 0) return true;
  if (isSourceInitialism(sourceTokens, candidateText)) return false;
  if (candidateVisibleLength < 3) return true;
  // Corpus measure (tests/fixtures/title-locale-corpus.json): among 119
  // non-source-copy title pairs, a valid 2->1 translation has a 10-char
  // target token. Do not invent a ratio threshold: only reject the structurally
  // degenerate multi-token -> one token of <=3 visible characters case.
  return sourceTokens.length >= 2 && candidateTokens.length === 1 && candidateVisibleLength <= 3;
}

function isSourceInitialism(sourceTokens, candidateText) {
  const candidate = candidateText.trim();
  if (sourceTokens.length < 2 || !/^[A-Z]{2,10}$/.test(candidate)) return false;
  const initials = sourceTokens.map((token) => token[0]?.toUpperCase()).join('');
  return candidate === initials;
}

function sortedMultiset(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([value, count]) => JSON.stringify([value, count]));
}

function sameMultiset(left, right) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function extractUrls(text) {
  if (!text.includes('://')) return [];
  return sortedMultiset([...text.matchAll(URL_RE)].map((match) => {
    const start = match.index ?? 0;
    const url = match[0];
    // Only an immediate, balanced parenthesis wrapper with no URL parenthesis
    // is unambiguously external. Every other terminal character is preserved.
    if (text[start - 1] === '(' && url.endsWith(')') && !/[()]/u.test(url.slice(0, -1))) {
      return url.slice(0, -1);
    }
    return url;
  }));
}

function extractEmails(text) {
  if (!text.includes('@')) return [];
  // Both matchAll iterators are ordered by index. Streaming URL ranges avoids
  // materializing and sorting O(U) ranges before scanning O(E) addresses.
  const urls = text.matchAll(URL_RE);
  let nextUrl = urls.next().value;
  const emails = [];
  for (const match of text.matchAll(EMAIL_RE)) {
    const start = match.index ?? 0;
    while (nextUrl && (nextUrl.index ?? 0) + nextUrl[0].length <= start) nextUrl = urls.next().value;
    if (nextUrl && start >= (nextUrl.index ?? 0) && start < (nextUrl.index ?? 0) + nextUrl[0].length) continue;
    emails.push(match[1]);
  }
  return sortedMultiset(emails);
}

function numericCore(raw, locale) {
  const compact = raw.replace(/[ '\u2019\u00a0\u202f]/g, '').replace(/[.,]+$/u, '');
  const commaCount = (compact.match(/,/g) ?? []).length;
  const dotCount = (compact.match(/\./g) ?? []).length;
  if (commaCount && dotCount) {
    const decimal = compact.lastIndexOf(',') > compact.lastIndexOf('.') ? ',' : '.';
    const grouping = decimal === ',' ? '.' : ',';
    const groups = compact.split(decimal)[0].split(grouping);
    if (groups.length > 1 && !groups.slice(1).every((group) => group.length === 3)) return `seg:${compact}`;
    return compact
      .replace(decimal === ',' ? /\./g : /,/g, '')
      .replace(decimal, '.');
  }
  if (commaCount > 1 || dotCount > 1) {
    const separator = commaCount ? ',' : '.';
    const groups = compact.split(separator);
    return groups.slice(1).every((group) => group.length === 3) ? groups.join('') : `seg:${compact}`;
  }
  const separator = commaCount ? ',' : dotCount ? '.' : '';
  if (!separator) return compact;
  const [whole, fraction = ''] = compact.split(separator);
  const decimalByLocale = separator === ',' ? locale !== 'en' : locale === 'en';
  // A three-digit tail is a grouping separator in the continental formats;
  // it stays decimal for English, where 1.234 is a valid decimal spelling.
  if (!decimalByLocale && fraction.length === 3) return `${whole}${fraction}`;
  return `${whole}.${fraction}`;
}

function currencyCode(raw) {
  const upper = raw.toUpperCase();
  if (upper.includes('CHF')) return 'CHF';
  if (upper.includes('EUR') || raw.includes('€')) return 'EUR';
  if (upper.includes('USD') || raw.includes('$')) return 'USD';
  return 'GBP';
}

function mergeRanges(ranges) {
  const ordered = [...ranges].sort(([leftStart, leftEnd], [rightStart, rightEnd]) => (
    leftStart - rightStart || rightEnd - leftEnd
  ));
  const merged = [];
  for (const [start, end] of ordered) {
    const previous = merged[merged.length - 1];
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

function numericAffix(text, start, end) {
  let left = start - 1;
  while (left >= 0 && start - left <= MAX_NUMERIC_AFFIX_WHITESPACE && WHITESPACE_RE.test(text[left])) left -= 1;
  let right = end;
  while (right < text.length && right - end < MAX_NUMERIC_AFFIX_WHITESPACE && WHITESPACE_RE.test(text[right])) right += 1;
  const prefix = left >= 0 && AFFIX_LEFT_START_RE.test(text[left])
    ? text.slice(Math.max(0, start - MAX_NUMERIC_AFFIX_WHITESPACE - 16), start) : '';
  const suffix = right < text.length && AFFIX_RIGHT_START_RE.test(text[right])
    ? text.slice(end, Math.min(text.length, end + MAX_NUMERIC_AFFIX_WHITESPACE + 16)) : '';
  const signThenCurrency = prefix ? AFFIX_SIGN_THEN_CURRENCY_RE.exec(prefix) : null;
  const currencyThenSign = prefix ? AFFIX_CURRENCY_THEN_SIGN_RE.exec(prefix) : null;
  const currencyAfter = suffix ? AFFIX_CURRENCY_AFTER_RE.exec(suffix) : null;
  const directSign = prefix ? AFFIX_SIGN_RE.exec(prefix)?.[1] ?? '' : '';
  const currency = signThenCurrency?.[2] ?? currencyThenSign?.[1] ?? currencyAfter?.[1] ?? '';
  const currencySign = signThenCurrency?.[1] ?? currencyThenSign?.[2] ?? '';
  const sign = (currencySign || directSign).replace('−', '-') || 'none';
  const hasPercent = suffix ? AFFIX_PERCENT_RE.test(suffix) : false;
  return { currency, hasPercent, sign };
}

function rangeEndpointSignature(raw, locale) {
  const numberMatch = new RegExp(NUMBER_ATOM, 'u').exec(raw);
  if (!numberMatch || numberMatch.index === undefined) return 'invalid';
  const start = numberMatch.index;
  const affix = numericAffix(raw, start, start + numberMatch[0].length);
  return { core: numericCore(numberMatch[0], locale), sign: affix.sign };
}

function rangeEndpointUnits(raw) {
  const units = [...raw.matchAll(new RegExp(CURRENCY, 'giu'))].map((match) => `currency:${currencyCode(match[0])}`);
  if (raw.includes('%')) units.push('percent');
  return [...new Set(units)].sort(compareText);
}

function canonicalUnit(raw) {
  return raw ? UNIT_CANONICAL.get(raw.toLocaleLowerCase('und')) ?? null : null;
}

function unitLabel(numerator, denominator) {
  const unit = canonicalUnit(numerator);
  if (!unit) return '';
  const per = canonicalUnit(denominator);
  return per ? `unit:${unit}/${per}` : `unit:${unit}`;
}

function extractNumericSignatures(text, locale) {
  // Numeric syntax is compared semantically only. Invisible/combining marks
  // must not sever an adjacent sign, currency or percent affix, while neither
  // the candidate text nor persisted memory is ever rewritten.
  const numericText = canonicalProtectedText(text);
  const protectedEvents = [];
  const signatures = [];
  for (const match of numericText.matchAll(VERSION_RE)) {
    const start = match.index ?? 0;
    protectedEvents.push({ start, end: start + match[0].length, kind: 'version', match });
  }
  for (const match of numericText.matchAll(DATE_RE)) {
    const start = match.index ?? 0;
    protectedEvents.push({ start, end: start + match[0].length, kind: 'date', match });
  }
  for (const match of numericText.matchAll(RANGE_RE)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    protectedEvents.push({ start, end, kind: 'range', match });
  }
  let occupiedEnd = -1;
  const acceptedRanges = [];
  for (const event of protectedEvents.sort((left, right) => (
    left.start - right.start || right.end - left.end || compareText(left.kind, right.kind)
  ))) {
    if (event.start < occupiedEnd) continue;
    occupiedEnd = event.end;
    acceptedRanges.push([event.start, event.end]);
    if (event.kind === 'version') {
      signatures.push(`version:${event.match[0].toLowerCase()}`);
    } else if (event.kind === 'date') {
      const [year, month, day] = event.match[0].split(event.match[1]);
      signatures.push(`date:${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`);
    } else {
      const first = rangeEndpointSignature(event.match[1], locale);
      const second = rangeEndpointSignature(event.match[2], locale);
      const firstUnits = rangeEndpointUnits(event.match[1]);
      const secondUnits = rangeEndpointUnits(event.match[2]);
      const allUnits = [...new Set([...firstUnits, ...secondUnits])].sort(compareText);
      const unit = allUnits.length <= 1
        ? `global:${allUnits[0] ?? 'number'}`
        : `bound:${firstUnits.join('+') || 'number'}:${secondUnits.join('+') || 'number'}`;
      signatures.push(`range:unit:${unit}:${first.sign}:${first.core}:${second.sign}:${second.core}`);
    }
  }
  const ranges = mergeRanges(acceptedRanges);
  let rangeCursor = 0;
  for (const match of numericText.matchAll(NUMBER_RE)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    while (rangeCursor < ranges.length && ranges[rangeCursor][1] <= start) rangeCursor += 1;
    if (rangeCursor < ranges.length && start < ranges[rangeCursor][1] && end > ranges[rangeCursor][0]) continue;
    const affix = numericAffix(numericText, start, end);
    const currency = match[1] ?? affix.currency;
    const label = currency
      ? `currency:${currencyCode(currency)}`
      : affix.hasPercent ? 'percent' : unitLabel(match[3], match[4]) || 'number';
    signatures.push(`${label}:${affix.sign}:${numericCore(match[2], locale)}`);
  }
  return sortedMultiset(signatures);
}

function evidence(code) {
  return Object.freeze({
    code,
    digest: digestTranslationDocumentV2({ code, schemaVersion: TRANSLATION_CANDIDATE_QUALITY_V2_SCHEMA_VERSION }),
  });
}

function createOutcome(blockingCodes, advisoryCodes, appliedGates) {
  const uniqueBlockingCodes = [...new Set(blockingCodes)];
  const uniqueAdvisoryCodes = [...new Set(advisoryCodes)];
  const codes = [...new Set([...uniqueBlockingCodes, ...uniqueAdvisoryCodes])].sort(compareText).slice(0, MAX_EVIDENCE);
  const evidenceItems = codes.map(evidence);
  const status = uniqueBlockingCodes.length === 0 ? 'validated' : 'rejected';
  const retryClass = status === 'validated'
    ? 'none'
    : uniqueBlockingCodes.includes('source.empty') ? 'terminal' : 'retryable';
  return deepFreezeTranslationV2({
    schemaVersion: TRANSLATION_CANDIDATE_QUALITY_V2_SCHEMA_VERSION,
    status,
    retryClass,
    evidence: evidenceItems,
    metrics: {
      appliedGates,
      advisoryCount: uniqueAdvisoryCodes.length,
      blockingFailureCount: uniqueBlockingCodes.length,
    },
  });
}

/**
 * Deterministically validates one prospective job translation without I/O.
 * It deliberately emits only fixed reason codes and content-addressed digests,
 * never source/candidate text or protected-token values.
 */
export function assessTranslationCandidateQualityV2(input) {
  const value = validateInput(input);
  const blocking = [];
  const advisory = [];
  let appliedGates = 0;
  const source = value.sourceText.trim();
  const candidate = value.candidateText.trim();
  const sourceTokens = visibleTokens(source);
  const candidateTokens = visibleTokens(candidate);

  appliedGates += 1;
  if (!source || sourceTokens.length === 0) blocking.push('source.empty');
  if (!candidate || candidateTokens.length === 0) blocking.push('candidate.empty');

  if (source && candidate) {
    appliedGates += 1;
    if (value.sourceLang !== value.targetLang && sameSequence(sourceTokens, candidateTokens)) {
      blocking.push('source.echo');
    }

    appliedGates += 1;
    if (!sameMultiset(extractUrls(source), extractUrls(candidate))) blocking.push('url.multiset_mismatch');

    appliedGates += 1;
    if (!sameMultiset(extractEmails(source), extractEmails(candidate))) blocking.push('email.multiset_mismatch');

    appliedGates += 1;
    if (!sameMultiset(
      extractNumericSignatures(source, value.sourceLang),
      extractNumericSignatures(candidate, value.targetLang),
    )) blocking.push('numeric.multiset_mismatch');

    for (const token of value.protectedTokens) {
      if (!containsProtectedToken(source, token.value)) continue;
      appliedGates += 1;
      if (!containsProtectedToken(candidate, token.value)) blocking.push('protected_token.missing');
    }

    if (value.field === 'description') {
      appliedGates += 1;
      if (isDegenerateDescription(candidateTokens)) blocking.push('description.degenerate_content');
      const structureFlattened = isStructureFlattenedCopy(source, candidate);
      if (structureFlattened) blocking.push('structure.flattened');
      if (!structureFlattened && !isAcceptableTranslation(source, candidate)) blocking.push('description.unacceptable');
    } else {
      appliedGates += 1;
      if (isIncompleteTitle(sourceTokens, candidateTokens, candidate)) blocking.push('title.incomplete_content');
      if (titleLooksUntranslated({
        title: candidate,
        sourceTitle: source,
        sourceLang: value.sourceLang,
        targetLocale: value.targetLang,
      }).untranslated) blocking.push('title.untranslated');
      if (hasConcatenatedWords(candidate, value.targetLang)) blocking.push('title.concatenated_words');
    }

    appliedGates += 1;
    const language = detectLanguageWithConfidence(candidate, value.targetLang);
    if (language.lang !== value.targetLang) {
      if (language.confidence >= RELIABLE_LANGUAGE_CONFIDENCE) {
        blocking.push('language.high_confidence_mismatch');
      } else if (value.field === 'description' && candidateTokens.length >= 64 && language.lang === value.sourceLang) {
        blocking.push('language.low_confidence_mismatch');
      } else {
        advisory.push('language.low_confidence_mismatch');
      }
    }
  }

  return createOutcome(blocking, advisory, appliedGates);
}
