import { detectLanguageWithConfidence } from './detect-language.mjs';
import { titleLooksUntranslated } from './job-locale-utils.mjs';
import { hasConcatenatedWords, isAcceptableTranslation, isStructureFlattenedCopy } from './translation-quality.mjs';
import {
  assertTranslationExactKeysV2,
  assertTranslationPlainObjectV2,
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
// detect-language documents confidence >= 0.6 as reliable; do not create a
// second calibration for this additive gate.
const RELIABLE_LANGUAGE_CONFIDENCE = 0.6;
const MAX_EVIDENCE = 8;

const URL_RE = /https?:\/\/[^\s<>"']+/giu;
const EMAIL_TOKEN_RE = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/iu;
const VERSION_RE = /\bv\d+(?:\.\d+)*\b/giu;
const NUMERIC_RE = /(?<![\p{L}\p{N}_.])\d[\d .,'’\u00a0\u202f]*/gu;

function compareText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function assertBoundedText(value, label, limit = MAX_TEXT_LENGTH) {
  if (typeof value !== 'string' || value.length > limit) {
    throw new TypeError(`${label} must be bounded text`);
  }
}

function normalizeLanguage(value, label) {
  if (typeof value !== 'string' || !LANGUAGES.has(value)) {
    throw new TypeError(`${label} must be one of it, en, de, fr`);
  }
  return value;
}

function validateInput(input) {
  assertTranslationPlainObjectV2(input, 'translation candidate quality v2 input');
  assertTranslationExactKeysV2(input, INPUT_KEYS, 'translation candidate quality v2 input');
  assertBoundedText(input.sourceText, 'sourceText');
  assertBoundedText(input.candidateText, 'candidateText');
  const sourceLang = normalizeLanguage(input.sourceLang, 'sourceLang');
  const targetLang = normalizeLanguage(input.targetLang, 'targetLang');
  if (!FIELDS.has(input.field)) throw new TypeError('field must be title or description');
  if (!Array.isArray(input.protectedTokens) || input.protectedTokens.length > MAX_PROTECTED_TOKENS) {
    throw new TypeError('protectedTokens must be a bounded array');
  }
  const protectedTokens = input.protectedTokens.map((token) => {
    assertTranslationPlainObjectV2(token, 'protected token');
    assertTranslationExactKeysV2(token, PROTECTED_TOKEN_KEYS, 'protected token');
    if (!TOKEN_CATEGORIES.has(token.category)) throw new TypeError('protected token category is invalid');
    assertBoundedText(token.value, 'protected token value', MAX_PROTECTED_TOKEN_LENGTH);
    if (!visibleTokens(token.value).length) throw new TypeError('protected token value must contain visible tokens');
    return Object.freeze({ category: token.category, value: token.value });
  });
  const protectedTokenKeys = protectedTokens.map((token) => `${token.category}:${visibleTokens(token.value).join('\u0000')}`);
  if (new Set(protectedTokenKeys).size !== protectedTokenKeys.length) {
    throw new TypeError('protectedTokens must not contain canonical duplicates');
  }
  return Object.freeze({
    sourceText: input.sourceText,
    candidateText: input.candidateText,
    sourceLang,
    targetLang,
    field: input.field,
    protectedTokens: Object.freeze(protectedTokens),
  });
}

function visibleTokens(value) {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('und')
    .match(/[\p{L}\p{N}]+/gu) ?? [];
}

function sameSequence(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function containsTokenSequence(textTokens, valueTokens) {
  if (valueTokens.length > textTokens.length) return false;
  for (let index = 0; index <= textTokens.length - valueTokens.length; index += 1) {
    if (valueTokens.every((token, offset) => textTokens[index + offset] === token)) return true;
  }
  return false;
}

function isDegenerateDescription(tokens) {
  return tokens.length === 0 || new Set(tokens).size < 2;
}

function isIncompleteTitle(sourceTokens, candidateTokens) {
  const candidateVisibleLength = candidateTokens.join('').length;
  if (candidateTokens.length === 0 || candidateVisibleLength < 3) return true;
  // Corpus measure (tests/fixtures/title-locale-corpus.json): among 119
  // non-source-copy title pairs, a valid 2->1 translation has a 10-char
  // target token. Do not invent a ratio threshold: only reject the structurally
  // degenerate multi-token -> one token of <=3 visible characters case.
  return sourceTokens.length >= 2 && candidateTokens.length === 1 && candidateVisibleLength <= 3;
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
  return sortedMultiset((text.match(URL_RE) ?? []).map((url) => url.replace(/[.,;:!?]+$/u, '')));
}

function extractEmails(text) {
  if (!text.includes('@')) return [];
  const withoutUrls = text.includes('://') ? text.replace(URL_RE, ' ') : text;
  return sortedMultiset((withoutUrls.match(/\S+/gu) ?? [])
    .map((token) => token.replace(/[.,;:!?]+$/u, ''))
    .filter((token) => EMAIL_TOKEN_RE.test(token)));
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

function extractNumericSignatures(text, locale) {
  const versions = text.match(VERSION_RE) ?? [];
  const withoutVersions = text.replace(VERSION_RE, ' ');
  const numeric = [];
  const normalizedCores = new Map();
  for (const match of withoutVersions.matchAll(NUMERIC_RE)) {
    const number = match[0].trim();
    const index = match.index ?? 0;
    const prefix = withoutVersions.slice(Math.max(0, index - 12), index);
    const suffix = withoutVersions.slice(index + match[0].length, index + match[0].length + 12);
    const signThenCurrency = prefix.match(/([+\-−])?\s*(CHF|EUR|USD|GBP|€|\$|£)\s*$/iu);
    const currencyThenSign = prefix.match(/(CHF|EUR|USD|GBP|€|\$|£)\s*([+\-−])?\s*$/iu);
    const currencyAfter = suffix.match(/^\s*(CHF|EUR|USD|GBP|€|\$|£)/iu);
    const directSign = prefix.match(/([+\-−])\s*$/u)?.[1] ?? '';
    const currency = signThenCurrency?.[2] ?? currencyThenSign?.[1] ?? currencyAfter?.[1] ?? '';
    const currencySign = signThenCurrency?.[1] ?? currencyThenSign?.[2] ?? '';
    const sign = (currencySign || directSign).replace('−', '-') || 'none';
    const hasPercent = /^\s*%/u.test(suffix);
    const prefixLabel = currency ? `currency:${currencyCode(currency)}:` : hasPercent ? 'percent:' : 'number:';
    const core = normalizedCores.get(number) ?? numericCore(number, locale);
    normalizedCores.set(number, core);
    numeric.push(`${prefixLabel}${sign}:${core}`);
  }
  return sortedMultiset([...versions.map((version) => `version:${version.toLowerCase()}`), ...numeric]);
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
  if (!source) blocking.push('source.empty');
  if (!candidate) blocking.push('candidate.empty');

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
      const tokenTokens = visibleTokens(token.value);
      if (!containsTokenSequence(sourceTokens, tokenTokens)) continue;
      appliedGates += 1;
      if (!containsTokenSequence(candidateTokens, tokenTokens)) blocking.push('protected_token.missing');
    }

    if (value.field === 'description') {
      appliedGates += 1;
      if (isDegenerateDescription(candidateTokens)) blocking.push('description.degenerate_content');
      const structureFlattened = isStructureFlattenedCopy(source, candidate);
      if (structureFlattened) blocking.push('structure.flattened');
      if (!structureFlattened && !isAcceptableTranslation(source, candidate)) blocking.push('description.unacceptable');
    } else {
      appliedGates += 1;
      if (isIncompleteTitle(sourceTokens, candidateTokens)) blocking.push('title.incomplete_content');
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
