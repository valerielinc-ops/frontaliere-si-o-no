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
const NUMBER_ATOM = String.raw`(?:\d+(?:[ '\u2019\u00a0\u202f,.]\d+)*|[.,]\d+)`;
const CURRENCY = String.raw`(?:CHF|EUR|USD|GBP|€|\$|£)`;
const RANGE_SPACE = String.raw`\s{0,256}`;
const RANGE_PREFIX = String.raw`(?:(?:[+\-−]${RANGE_SPACE}${CURRENCY}|${CURRENCY}${RANGE_SPACE}[+\-−]?|[+\-−])${RANGE_SPACE})?`;
const RANGE_SUFFIX = String.raw`(?:(?:${RANGE_SPACE}${CURRENCY})|(?:${RANGE_SPACE}%))*`;
const RANGE_ENDPOINT = String.raw`(${RANGE_PREFIX}${NUMBER_ATOM}${RANGE_SUFFIX})`;
const RANGE_RE = new RegExp(String.raw`(?<![\p{L}\p{N}_.])${RANGE_ENDPOINT}${RANGE_SPACE}(?:-|\u2010|\u2011|\u2012|\u2013|\u2014|\u2212)${RANGE_SPACE}${RANGE_ENDPOINT}${RANGE_SUFFIX}(?![\p{L}\p{N}_]|[.,]\d)`, 'giu');
const NUMBER_RE = new RegExp(String.raw`(?<![\p{L}\p{N}_.])(CHF|EUR|USD|GBP|€|\$|£)?(${NUMBER_ATOM})(?![\p{L}\p{N}_]|[.,]\d)`, 'giu');
const MAX_NUMERIC_AFFIX_WHITESPACE = 256;

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
  // The production corpus has a 1st-percentile unique-token ratio of 0.386
  // but a 0.012 minimum (112,500 descriptions), so a diversity threshold
  // would either reject real prose or miss a repeated long phrase. Instead,
  // derive a period from four equal token positions, then make one bounded
  // linear coverage pass. Keeping the first 20 positions per token admits the
  // documented <=16-token prefix without a period cap or quadratic scan.
  const positionsByToken = new Map();
  for (let index = 0; index < tokens.length; index += 1) {
    const positions = positionsByToken.get(tokens[index]) ?? [];
    if (positions.length < 20) positions.push(index);
    positionsByToken.set(tokens[index], positions);
  }
  for (const positions of positionsByToken.values()) {
    if (positions.length < 4) continue;
    const positionSet = new Set(positions);
    for (let first = 0; first < positions.length - 3; first += 1) {
      for (let second = first + 1; second < positions.length - 2; second += 1) {
        const period = positions[second] - positions[first];
        if (period < 1 || tokens.length < period * 4
            || tokens.length - positions[first] < MIN_DOMINANT_PERIODIC_TOKENS
            || !positionSet.has(positions[second] + period)
            || !positionSet.has(positions[second] + period * 2)) continue;
        let matches = 0;
        // Begin at the repeated phase, not at a permitted short prefix. This
        // prevents a 16-token introduction from diluting a 17-token period.
        const comparisonStart = positions[first] + period;
        const compared = tokens.length - comparisonStart;
        for (let index = comparisonStart; index < tokens.length; index += 1) {
          if (tokens[index] === tokens[index - period]) matches += 1;
        }
        if (matches / compared >= 0.9) return true;
      }
    }
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
  const urlRanges = [...text.matchAll(URL_RE)].map((match) => [match.index ?? 0, (match.index ?? 0) + match[0].length]);
  return sortedMultiset([...text.matchAll(EMAIL_RE)]
    .filter((match) => !urlRanges.some(([start, end]) => (match.index ?? 0) >= start && (match.index ?? 0) < end))
    .map((match) => match[1]));
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

function overlaps(ranges, start, end) {
  return ranges.some(([rangeStart, rangeEnd]) => start < rangeEnd && rangeStart < end);
}

function numericAffix(text, start, end) {
  const prefix = text.slice(Math.max(0, start - MAX_NUMERIC_AFFIX_WHITESPACE - 16), start);
  const suffix = text.slice(end, Math.min(text.length, end + MAX_NUMERIC_AFFIX_WHITESPACE + 16));
  const space = String.raw`\s{0,${MAX_NUMERIC_AFFIX_WHITESPACE}}`;
  const signThenCurrency = new RegExp(String.raw`([+\-−])?${space}(CHF|EUR|USD|GBP|€|\$|£)${space}$`, 'iu').exec(prefix);
  const currencyThenSign = new RegExp(String.raw`(CHF|EUR|USD|GBP|€|\$|£)${space}([+\-−])?${space}$`, 'iu').exec(prefix);
  const currencyAfter = new RegExp(String.raw`^${space}(CHF|EUR|USD|GBP|€|\$|£)`, 'iu').exec(suffix);
  const directSign = new RegExp(String.raw`([+\-−])${space}$`, 'u').exec(prefix)?.[1] ?? '';
  const currency = signThenCurrency?.[2] ?? currencyThenSign?.[1] ?? currencyAfter?.[1] ?? '';
  const currencySign = signThenCurrency?.[1] ?? currencyThenSign?.[2] ?? '';
  const sign = (currencySign || directSign).replace('−', '-') || 'none';
  const hasPercent = new RegExp(String.raw`^${space}%`, 'u').test(suffix);
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

function extractNumericSignatures(text, locale) {
  // Numeric syntax is compared semantically only. Invisible/combining marks
  // must not sever an adjacent sign, currency or percent affix, while neither
  // the candidate text nor persisted memory is ever rewritten.
  const numericText = canonicalProtectedText(text);
  const ranges = [];
  const signatures = [];
  for (const match of numericText.matchAll(VERSION_RE)) {
    const start = match.index ?? 0;
    ranges.push([start, start + match[0].length]);
    signatures.push(`version:${match[0].toLowerCase()}`);
  }
  for (const match of numericText.matchAll(DATE_RE)) {
    const start = match.index ?? 0;
    ranges.push([start, start + match[0].length]);
    const [year, month, day] = match[0].split(match[1]);
    signatures.push(`date:${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`);
  }
  for (const match of numericText.matchAll(RANGE_RE)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (overlaps(ranges, start, end)) continue;
    ranges.push([start, end]);
    const first = rangeEndpointSignature(match[1], locale);
    const second = rangeEndpointSignature(match[2], locale);
    const firstUnits = rangeEndpointUnits(match[1]);
    const secondUnits = rangeEndpointUnits(match[2]);
    const allUnits = [...new Set([...firstUnits, ...secondUnits])].sort(compareText);
    const unit = allUnits.length <= 1
      ? `global:${allUnits[0] ?? 'number'}`
      : `bound:${firstUnits.join('+') || 'number'}:${secondUnits.join('+') || 'number'}`;
    signatures.push(`range:unit:${unit}:${first.sign}:${first.core}:${second.sign}:${second.core}`);
  }
  for (const match of numericText.matchAll(NUMBER_RE)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (overlaps(ranges, start, end)) continue;
    const affix = numericAffix(numericText, start, end);
    const currency = match[1] ?? affix.currency;
    const label = currency ? `currency:${currencyCode(currency)}` : affix.hasPercent ? 'percent' : 'number';
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
      if (language.confidence >= RELIABLE_LANGUAGE_CONFIDENCE) blocking.push('language.high_confidence_mismatch');
      else advisory.push('language.low_confidence_mismatch');
    }
  }

  return createOutcome(blocking, advisory, appliedGates);
}
