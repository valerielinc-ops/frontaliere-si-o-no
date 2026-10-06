import crypto from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const EVENT_DESCRIPTION_LOCALES = Object.freeze(['it', 'en', 'de', 'fr']);
export const EVENT_DESCRIPTION_REWRITE_MODEL = 'gpt-5.6-luna';
export const EVENT_DESCRIPTION_PROMPT_VERSION = 'event-description-rewrite-v1';
export const EVENT_DESCRIPTION_CACHE_SCHEMA_VERSION = 1;
export const EVENT_DESCRIPTION_MIN_SHARED_NGRAM = 8;
export const EVENT_DESCRIPTION_MIN_CHARS = 30;
const MODULE_REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

export function isValidSourceDescriptionHash(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

const DESCRIPTION_FIELDS = Object.freeze({
  fallback: 'description',
  byLocale: 'descriptionByLocale',
});

const SOURCE_DESCRIPTION_FIELDS = Object.freeze({
  fallback: 'sourceDescription',
  byLocale: 'sourceDescriptionByLocale',
});

const FACT_FIELDS = Object.freeze([
  'id',
  'title',
  'titleByLocale',
  'startDate',
  'endDate',
  'startTime',
  'category',
  'region',
  'venue',
  'address',
  'comune',
  'comuneMatch',
  'canton',
  'url',
  'price',
  'performer',
  'organizer',
  'sourceKey',
  'sourceName',
  'eventStatus',
  'recurring',
  'crawledAt',
]);

const PROMOTIONAL_WORDS = new Set([
  'imperdibile',
  'imperdibili',
  'unico',
  'unica',
  'unici',
  'uniche',
  'straordinario',
  'straordinaria',
  'straordinari',
  'straordinarie',
  'incredibile',
  'incredibili',
  'fantastico',
  'fantastica',
  'fantastici',
  'fantastiche',
  'amazing',
  'unmissable',
  'unique',
  'extraordinary',
  'incredible',
  'fantastic',
  'unvergesslich',
  'einzigartig',
  'aussergewohnlich',
  'außergewöhnlich',
  'incroyable',
  'incontournable',
  'unique',
]);

const CAPITALIZED_NAME_STOPWORDS = new Set([
  'Al', 'Alla', 'Allo', 'Con', 'Da', 'Dal', 'Dalla', 'De', 'Del', 'Della', 'Di', 'E', 'Il', 'In', 'La', 'Le', 'Lo', 'Nel', 'Nella', 'Per', 'Su', 'Un', 'Una',
  'A', 'And', 'At', 'From', 'In', 'Of', 'On', 'The', 'To', 'With',
  'Der', 'Die', 'Das', 'Ein', 'Eine', 'Im', 'In', 'Mit', 'Von', 'Zu', 'Zum', 'Zur',
  'Au', 'Avec', 'Dans', 'De', 'Des', 'Du', 'En', 'Et', 'La', 'Le', 'Les', 'Pour', 'Un', 'Une',
]);

function usableText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Keep source hashes stable across harmless whitespace/Unicode presentation changes. */
export function normalizeDescriptionText(value) {
  return usableText(value) ? value.normalize('NFKC').replace(/\s+/g, ' ').trim() : '';
}

function readDescriptionFields(event, fields) {
  const byLocale = {};
  const rawByLocale = event?.[fields.byLocale];
  for (const locale of EVENT_DESCRIPTION_LOCALES) {
    const text = normalizeDescriptionText(rawByLocale?.[locale]);
    if (text) byLocale[locale] = text;
  }
  const fallback = normalizeDescriptionText(event?.[fields.fallback]);
  return { byLocale, fallback };
}

function canonicalDescriptionPayload({ byLocale, fallback }) {
  return Object.fromEntries([
    ...EVENT_DESCRIPTION_LOCALES.filter((locale) => byLocale[locale]).map((locale) => [locale, byLocale[locale]]),
    ...(fallback ? [['_fallback', fallback]] : []),
  ]);
}

export function sourceDescriptionHash(event) {
  const fields = readDescriptionFields(event, DESCRIPTION_FIELDS);
  if (!fields.fallback && Object.keys(fields.byLocale).length === 0) return null;
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalDescriptionPayload(fields)))
    .digest('hex');
}

export function sourceDescriptionTexts(event) {
  const fields = readDescriptionFields(event, DESCRIPTION_FIELDS);
  return [...Object.values(fields.byLocale), fields.fallback].filter(Boolean);
}

export function sourceDescriptionRecord(event) {
  const fields = readDescriptionFields(event, DESCRIPTION_FIELDS);
  if (!fields.fallback && Object.keys(fields.byLocale).length === 0) return null;
  const facts = Object.fromEntries(FACT_FIELDS.filter((field) => event?.[field] !== undefined).map((field) => [field, event[field]]));
  return {
    id: event.id,
    sourceKey: event.sourceKey,
    sourceName: event.sourceName,
    sourceDescriptionHash: sourceDescriptionHash(event),
    ...(fields.fallback ? { sourceDescription: fields.fallback } : {}),
    ...(Object.keys(fields.byLocale).length ? { sourceDescriptionByLocale: fields.byLocale } : {}),
    facts,
  };
}

/**
 * Append the crawler's private input to a JSONL file outside the checkout.
 * The caller opts in with EVENT_DESCRIPTION_SOURCE_EXPORT_PATH; no crawler
 * writes source prose unless that path is explicitly supplied.
 */
export function appendPrivateEventDescriptionSources(events, targetPath = process.env.EVENT_DESCRIPTION_SOURCE_EXPORT_PATH) {
  if (!targetPath) return 0;
  const absoluteTarget = path.resolve(targetPath);
  const checkout = MODULE_REPO_ROOT;
  if (absoluteTarget === checkout || absoluteTarget.startsWith(`${checkout}${path.sep}`)) {
    throw new Error('EVENT_DESCRIPTION_SOURCE_EXPORT_PATH must be outside the checkout');
  }
  const records = events.map(sourceDescriptionRecord).filter(Boolean);
  if (!records.length) return 0;
  mkdirSync(path.dirname(absoluteTarget), { recursive: true, mode: 0o700 });
  appendFileSync(absoluteTarget, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, { mode: 0o600 });
  chmodSync(absoluteTarget, 0o600);
  return records.length;
}

/** Remove every acquired description before a slice or dataset can be written. */
export function sanitizeEventForPublication(event) {
  if (!event || typeof event !== 'object') return event;
  // A dataset event may already carry our rewritten prose. In that case the
  // stored hash is the source hash and must win; hashing the rewritten prose
  // again would make a later assembly miss the cache and erase the rewrite.
  const hash = isValidSourceDescriptionHash(event.sourceDescriptionHash)
    ? event.sourceDescriptionHash
    : sourceDescriptionHash(event);
  const {
    description: _description,
    descriptionByLocale: _descriptionByLocale,
    descriptionRewriteValidated: _descriptionRewriteValidated,
    sourceDescription: _sourceDescription,
    sourceDescriptionByLocale: _sourceDescriptionByLocale,
    ...withoutSourceText
  } = event;
  return hash ? { ...withoutSourceText, sourceDescriptionHash: hash } : withoutSourceText;
}

export function rewriteCacheKey(id, sourceHash) {
  return `${String(id)}::${String(sourceHash)}`;
}

export function loadEventDescriptionRewriteCache(filePath) {
  if (!existsSync(filePath)) return { schemaVersion: EVENT_DESCRIPTION_CACHE_SCHEMA_VERSION, entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : { schemaVersion: EVENT_DESCRIPTION_CACHE_SCHEMA_VERSION, entries: {} };
  } catch {
    return { schemaVersion: EVENT_DESCRIPTION_CACHE_SCHEMA_VERSION, entries: {} };
  }
}

function cacheEntryDescriptions(entry) {
  const byLocale = entry?.descriptionByLocale;
  if (!byLocale || typeof byLocale !== 'object') return null;
  const normalized = {};
  for (const locale of EVENT_DESCRIPTION_LOCALES) {
    const text = normalizeDescriptionText(byLocale[locale]);
    if (!text) return null;
    normalized[locale] = text;
  }
  return normalized;
}

export function isValidRewriteCacheEntry(entry, { id, sourceHash } = {}) {
  if (!entry || entry.id !== id || !isValidSourceDescriptionHash(sourceHash) || entry.sourceDescriptionHash !== sourceHash) return false;
  if (entry.model !== EVENT_DESCRIPTION_REWRITE_MODEL || entry.promptVersion !== EVENT_DESCRIPTION_PROMPT_VERSION) return false;
  if (!usableText(entry.rewrittenAt) || Number.isNaN(Date.parse(entry.rewrittenAt))) return false;
  const descriptions = cacheEntryDescriptions(entry);
  if (!descriptions || normalizeDescriptionText(entry.description) !== descriptions.it) return false;
  // The publication gate has no private source export to compare against.
  // Reuse the candidate as factual context only for structural checks (length,
  // markup and promotional language); source-overlap and new-fact checks run
  // at generation time while the private input is still available.
  return EVENT_DESCRIPTION_LOCALES.every((locale) => validateRewriteDescription(descriptions[locale], {
    factTexts: [descriptions[locale]],
  }).ok);
}

/** Apply only an exact id+source-hash cache hit. A miss is deliberately factual-only. */
export function applyDescriptionRewrite(event, cache) {
  const factual = sanitizeEventForPublication(event);
  const hash = factual?.sourceDescriptionHash;
  if (!factual?.id || !hash) return factual;
  const entries = cache?.entries || cache;
  const entry = entries?.[rewriteCacheKey(factual.id, hash)];
  if (!isValidRewriteCacheEntry(entry, { id: factual.id, sourceHash: hash })) return factual;
  const descriptionByLocale = cacheEntryDescriptions(entry);
  return {
    ...factual,
    description: descriptionByLocale.it,
    descriptionByLocale,
    descriptionRewriteValidated: true,
  };
}

/** Remove legacy/raw description translation entries before a crawler persists its cache. */
export function stripDescriptionTranslationCache(cache) {
  if (!cache || typeof cache !== 'object') return 0;
  let removed = 0;
  for (const key of Object.keys(cache)) {
    if (key.startsWith('description::')) {
      delete cache[key];
      removed += 1;
    }
  }
  return removed;
}

function comparisonTokens(value) {
  return normalizeDescriptionText(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('und')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

export function findSharedSourceNgram(candidate, sourceTexts, minWords = EVENT_DESCRIPTION_MIN_SHARED_NGRAM) {
  const candidateTokens = comparisonTokens(candidate);
  if (candidateTokens.length < minWords) return false;
  const sourceWindows = new Set();
  for (const source of sourceTexts || []) {
    const tokens = comparisonTokens(source);
    for (let i = 0; i <= tokens.length - minWords; i += 1) {
      sourceWindows.add(tokens.slice(i, i + minWords).join(' '));
    }
  }
  for (let i = 0; i <= candidateTokens.length - minWords; i += 1) {
    if (sourceWindows.has(candidateTokens.slice(i, i + minWords).join(' '))) return true;
  }
  return false;
}

function numericTokens(value) {
  return [...normalizeDescriptionText(value).matchAll(/\b\d+(?:[.,]\d+)*\b/g)].map((match) => {
    const normalized = match[0].replace(',', '.');
    const numeric = Number(normalized);
    return Number.isFinite(numeric) ? String(numeric) : normalized;
  });
}

function canonicalDate(year, month, day) {
  const fullYear = year < 100 ? 2000 + year : year;
  const date = new Date(Date.UTC(fullYear, month - 1, day));
  if (
    date.getUTCFullYear() !== fullYear
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) return null;
  return `${String(fullYear).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function structuredFactSignatures(value) {
  const text = normalizeDescriptionText(value);
  const signatures = new Set();
  for (const match of text.matchAll(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/gu)) {
    const date = canonicalDate(Number(match[1]), Number(match[2]), Number(match[3]));
    if (date) signatures.add(`date:${date}`);
  }
  for (const match of text.matchAll(/\b(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})\b/gu)) {
    const date = canonicalDate(Number(match[3]), Number(match[2]), Number(match[1]));
    if (date) signatures.add(`date:${date}`);
  }
  for (const match of text.matchAll(/\b(\d{1,2})[:.](\d{2})\b/gu)) {
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour < 24 && minute < 60) signatures.add(`time:${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
  }

  const currency = (value) => {
    const normalized = String(value).toUpperCase().replace(/\.$/u, '');
    if (normalized === 'SFR') return 'CHF';
    return normalized;
  };
  const amount = (value) => {
    const numeric = Number(String(value).replace(',', '.'));
    return Number.isFinite(numeric) ? String(numeric) : null;
  };
  const addPrice = (rawAmount, rawCurrency) => {
    const normalizedAmount = amount(rawAmount);
    const normalizedCurrency = currency(rawCurrency);
    if (normalizedAmount && ['CHF', 'EUR', 'USD', 'GBP'].includes(normalizedCurrency)) {
      signatures.add(`price:${normalizedAmount}:${normalizedCurrency}`);
    }
  };
  // Facts are often passed as JSON (`amount` + `currency`) rather than as a
  // human-formatted price. Accept either representation while still binding
  // the amount to the currency.
  for (const match of text.matchAll(/(?:["']?(?:amount|lowPrice|highPrice)["']?\s*:\s*)(\d+(?:[.,]\d+)?)\s*,\s*["']?currency["']?\s*:\s*["']?(CHF|SFr\.?|EUR|USD|GBP)/giu)) {
    addPrice(match[1], match[2]);
  }
  for (const match of text.matchAll(/\b(CHF|SFr\.?|EUR|USD|GBP)\s*(\d+(?:[.,]\d+)?)\b/giu)) {
    addPrice(match[2], match[1]);
  }
  for (const match of text.matchAll(/\b(\d+(?:[.,]\d+)?)\s*(CHF|SFr\.?|EUR|USD|GBP)\b/giu)) {
    addPrice(match[1], match[2]);
  }
  for (const match of text.matchAll(/([€$£])\s*(\d+(?:[.,]\d+)?)/gu)) {
    addPrice(match[2], { '€': 'EUR', '$': 'USD', '£': 'GBP' }[match[1]]);
  }
  for (const match of text.matchAll(/\b(\d+(?:[.,]\d+)?)\s*([€$£])/gu)) {
    addPrice(match[1], { '€': 'EUR', '$': 'USD', '£': 'GBP' }[match[2]]);
  }
  return signatures;
}

function currencySignatures(value) {
  return new Set([...normalizeDescriptionText(value).matchAll(/\b(CHF|SFr\.?|EUR|USD|GBP)\b/giu)].map((match) => {
    const normalized = match[1].toUpperCase().replace(/\.$/u, '');
    return normalized === 'SFR' ? 'CHF' : normalized;
  }));
}

function capitalizedNameRuns(value) {
  const runs = [];
  for (const sentence of normalizeDescriptionText(value).split(/[.!?…]+/u)) {
    const tokens = sentence.split(/\s+/);
    let current = [];
    const flush = () => {
      if (current.length >= 2 && !CAPITALIZED_NAME_STOPWORDS.has(current[0])) runs.push(current.join(' '));
      current = [];
    };
    for (const rawToken of tokens) {
      const token = rawToken.replace(/^[^\p{L}]+|[^\p{L}'’\-]+$/gu, '');
      if (/^\p{Lu}[\p{L}'’\-]+$/u.test(token)) current.push(token);
      else flush();
      // A comma, pipe, slash or similar punctuation separates two factual
      // names even when both sides are capitalised (for example a venue and
      // its street). Do not turn those adjacent, independently-known names
      // into a fabricated multi-word proper name.
      if (/[,:;|/()[\]{}]/u.test(rawToken)) flush();
    }
    flush();
  }
  return runs;
}

function containsPromotionalLanguage(candidate) {
  return comparisonTokens(candidate).some((token) => PROMOTIONAL_WORDS.has(token));
}

function sentenceCount(text) {
  return (normalizeDescriptionText(text).match(/[.!?…]+(?=\s|$)/g) || []).length;
}

/**
 * Validate one generated locale without ever returning source prose in the
 * diagnostic. Error codes are safe for logs and retry prompts.
 */
export function validateRewriteDescription(candidate, { sourceTexts = [], factTexts = [] } = {}) {
  const text = normalizeDescriptionText(candidate);
  if (!text) return { ok: false, code: 'empty' };
  if (text.length < EVENT_DESCRIPTION_MIN_CHARS) return { ok: false, code: 'too-short' };
  const sentences = sentenceCount(text);
  if (sentences < 2 || sentences > 3) return { ok: false, code: 'sentence-count' };
  if (findSharedSourceNgram(text, sourceTexts)) return { ok: false, code: 'source-ngram-8' };
  if (containsPromotionalLanguage(text)) return { ok: false, code: 'promotional-language' };

  const allowedContext = [...sourceTexts, ...factTexts].join(' ');
  const allowedNumbers = new Set(numericTokens(allowedContext));
  if (numericTokens(text).some((number) => !allowedNumbers.has(number))) return { ok: false, code: 'new-number' };
  const allowedStructuredFacts = structuredFactSignatures(allowedContext);
  if ([...structuredFactSignatures(text)].some((signature) => !allowedStructuredFacts.has(signature))) {
    return { ok: false, code: 'new-date-or-price' };
  }
  const allowedCurrencies = currencySignatures(allowedContext);
  if ([...currencySignatures(text)].some((currency) => !allowedCurrencies.has(currency))) {
    return { ok: false, code: 'new-date-or-price' };
  }

  const normalizedContext = comparisonTokens(allowedContext).join(' ');
  if (capitalizedNameRuns(text).some((run) => !normalizedContext.includes(comparisonTokens(run).join(' ')))) {
    return { ok: false, code: 'new-name' };
  }
  if (/[*_`#<>]/.test(text)) return { ok: false, code: 'markup' };
  return { ok: true };
}

export function validateRewriteBundle(descriptions, { sourceTexts = [], factTexts = [] } = {}) {
  if (!descriptions || typeof descriptions !== 'object') return { ok: false, errors: { bundle: 'missing' } };
  const errors = {};
  for (const locale of EVENT_DESCRIPTION_LOCALES) {
    const result = validateRewriteDescription(descriptions[locale], { sourceTexts, factTexts });
    if (!result.ok) errors[locale] = result.code;
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

export function factsForPrompt(event) {
  const factual = sanitizeEventForPublication(event);
  return Object.fromEntries(FACT_FIELDS.filter((field) => factual?.[field] !== undefined).map((field) => [field, factual[field]]));
}
