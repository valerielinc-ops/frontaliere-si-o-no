/**
 * Presence predicates for article/event text that may be the literal
 * serialization of JSON `null` (`"null"`, `"Null"`, `"NULL"`, wrapping quotes).
 *
 * A naked `.trim()` treats that marker as content: it wins a merge, skips
 * missing-field recovery, and ships as a published paragraph / title / slug.
 * One module so create-article, article-free-mt and events-utils cannot drift
 * (AGENTS.md #6). Not a port of corpus `body2-payload-verdict.mjs`.
 *
 * Two predicates, split by provenance:
 *   - source / machine sentinel (IT payload, free-MT, CSV/DB feed) →
 *     `hasUsableContentText` — every graph of `null` is unusable;
 *   - model output in a target locale → `hasUsableTranslatedText` — on `de`
 *     only the serialized lowercase form is a marker, because `Null` is the
 *     German word for «zero» (nouns are capitalised). Rejecting it publishes
 *     Italian under `/de/`.
 */

const LITERAL_NULL_STRING_RE = /^null$/i;
const SERIALIZED_NULL_STRING_RE = /^null$/;
const LOCALES_WITH_NULL_AS_WORD = new Set(['de']);

/** Trim, lower-case, drop region/script subtag (`de-CH` → `de`). */
export function normalizeLocaleTag(locale) {
  return String(locale ?? '').trim().toLowerCase().split(/[-_]/)[0];
}

export function localeHasNullAsWord(locale) {
  return LOCALES_WITH_NULL_AS_WORD.has(normalizeLocaleTag(locale));
}

function stripOneWrappingQuotePair(value) {
  if (value.length < 2) return value;
  const q = value[0];
  if ((q === '"' || q === "'") && value[value.length - 1] === q) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function matchesNullLiteral(value, re) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return re.test(trimmed) || re.test(stripOneWrappingQuotePair(trimmed));
}

export function isLiteralNullString(value) {
  return matchesNullLiteral(value, LITERAL_NULL_STRING_RE);
}

export function isSerializedNullString(value) {
  return matchesNullLiteral(value, SERIALIZED_NULL_STRING_RE);
}

export function isNullStringForLocale(value, locale) {
  return localeHasNullAsWord(locale) ? isSerializedNullString(value) : isLiteralNullString(value);
}

/** Usable source/machine text: non-empty string that is not a `null` marker. */
export function hasUsableContentText(value) {
  return typeof value === 'string' && value.trim().length > 0 && !isLiteralNullString(value);
}

/**
 * Usable translated field. Same as `hasUsableContentText` except on locales
 * where `null` is a word (today: `de`): only the serialized lowercase form
 * counts as a marker. Missing locale → fail closed (severe predicate).
 */
export function hasUsableTranslatedText(value, locale) {
  return typeof value === 'string' && value.trim().length > 0 && !isNullStringForLocale(value, locale);
}
