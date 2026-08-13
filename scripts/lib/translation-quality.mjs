/**
 * Shared translation-quality gate for free-cascade / provider output before it
 * is written to the indexed `descriptionByLocale` dataset.
 *
 * Single source of truth for the "hard char floor accepts clips" anti-pattern:
 * the free cascade (DeepL / Google Translate / SimplyTranslate) can return a
 * string cut to a provider-dependent length cap. A char floor alone accepts
 * those clips, so a faithful translation must also stay within
 * MIN_TRANSLATION_RATIO of the source length. When the source length is unknown
 * (empty/falsy), only the char floor applies.
 *
 * Also the source of truth for a second anti-pattern: free-cascade providers
 * routinely swallow the source text's newlines, returning a same-length
 * candidate where a `\n• item` list got flattened into inline `. • item`
 * running prose. Length/ratio checks alone don't catch this (the char count
 * survives) — audit #3721 found this landed 14 crawlers' `descriptionByLocale`
 * as "no structured content" even though the source-language `description`
 * had proper bullets, because this gate never checked structure parity. Mirrors
 * the equivalent check already in `job-localization-pipeline.mjs`'s
 * `passesQualityGate` (local NLLB/Ollama path) — this gate is the free-cascade
 * equivalent so both translation paths reject the same defect.
 */

// A faithful translation stays within a reasonable band of the source length.
export const MIN_TRANSLATION_RATIO = 0.6;
// Absolute character floor: anything shorter is too thin to be a real
// translation regardless of the source length.
export const MIN_TRANSLATION_CHARS = 100;
// Source bullet count above which losing ALL bullets in the candidate is
// treated as structure-flattening rather than a legitimately bullet-free
// translation (mirrors job-localization-pipeline.mjs's passesQualityGate).
export const MIN_SOURCE_BULLETS_FOR_STRUCTURE_CHECK = 3;

export function countBullets(text = '') {
  return (String(text || '').match(/^\s*[-*•]\s+/gm) || []).length;
}

/**
 * Detects a stored locale copy that lost the source's list structure
 * ("structure-flattening", the #3721/#3836 class): the source text carries a
 * real bulleted list (≥ MIN_SOURCE_BULLETS_FOR_STRUCTURE_CHECK line-start
 * bullets) while the non-empty candidate has none. Unlike
 * `isAcceptableTranslation` (which gates NEW translations before they are
 * persisted), this predicate is meant for EXISTING `descriptionByLocale`
 * entries, so repair passes (hardenJobLocaleFields, translateMissingJobLocales,
 * enrichJobLocalesDCC) can re-flag fossil flattened copies that were written
 * before the gates existed and are otherwise preserved forever by the
 * locale-preserving merge.
 *
 * @param {string} source - authoritative same-language text (usually job.description)
 * @param {string} candidate - stored locale copy to check
 * @returns {boolean} true when candidate flattened away the source's list structure
 */
export function isStructureFlattenedCopy(source, candidate) {
  const cand = typeof candidate === 'string' ? candidate.trim() : '';
  if (!cand) return false;
  if (countBullets(cand) > 0) return false;
  return countBullets(source) >= MIN_SOURCE_BULLETS_FOR_STRUCTURE_CHECK;
}

/**
 * @param {string} source - original (source-language) text being translated
 * @param {string} translated - candidate translation to validate
 * @returns {boolean} true if the candidate is acceptable to persist
 */
export function isAcceptableTranslation(source, translated) {
  if (typeof translated !== 'string') return false;
  const candidate = translated.trim();
  if (candidate.length < MIN_TRANSLATION_CHARS) return false;
  const srcLen = (typeof source === 'string' ? source.trim() : '').length;
  if (srcLen > 0 && candidate.length < srcLen * MIN_TRANSLATION_RATIO) return false;
  const sourceBullets = countBullets(source);
  if (sourceBullets >= MIN_SOURCE_BULLETS_FOR_STRUCTURE_CHECK && countBullets(candidate) === 0) {
    return false;
  }
  return true;
}

// Locales where a single run of MIN_LEN+ letters with no internal space is a
// reliable "source words got glued together" signal (a known free-cascade
// title-translation failure — e.g. "Direttore di filiale" -> "Direttoredifiliale").
// German is deliberately excluded: legitimate compound nouns (e.g.
// "Geschäftsführerin", "Sachbearbeiterin") routinely clear 15+ letters with no
// space, so the same length-only heuristic would false-positive on healthy
// German titles instead of catching a translation defect.
const CONCATENATED_WORD_MIN_LEN = { it: 15, fr: 16, en: 16 };
const LETTER_TOKEN_RE = /^[a-zà-öø-ÿ]+$/i;

/**
 * Legitimate long single-WORD professional terms that would otherwise trip
 * the length-only heuristic below. Normalized (diacritics stripped, case
 * folded) so "kinésithérapeute" / "KINESITHERAPEUTE" / "Kinesitherapeute" all
 * match the same entry.
 *
 * Why a closed allowlist and not a wider/looser length threshold (#5593):
 * `CONCATENATED_WORD_MIN_LEN.fr = 16` false-positived on "kinésithérapeute"
 * and "physiothérapeute" — both EXACTLY 16 letters, both real, frequent job
 * titles in this corpus (see tests/fixtures/title-locale-corpus.json, which
 * already carries live "PHYSIOTHERAPEUTE" titles). Raising the number would
 * only move the false-positive to the next casualty ("ergothérapeute" is 15,
 * "psychomotricien" is 15, "orthophoniste" is 13 — but
 * "audioprothésiste"/"audioprothesiste" is 16 and "psychothérapeute" is 16
 * too) — the healthcare/therapy vocabulary this jobs board indexes is full of
 * siblings at exactly the same length as the two reported here, so a numeric
 * bump is not a fix, only a slower-motion repeat of the same bug. A closed,
 * reviewed list fails differently: a NEW unlisted long word is a silent false
 * positive same as before, but every ADDITION here is a deliberate, auditable
 * decision instead of an opaque cutoff. Add to this list as new false
 * positives are confirmed against a real job title — do not "fix" this by
 * raising CONCATENATED_WORD_MIN_LEN instead.
 */
const LEGITIMATE_LONG_WORDS = new Set([
  // fr — allied health / therapy professions (gender-neutral -e forms and
  // explicit -e/-euse/-ien(ne) variants both included)
  'kinesitherapeute', 'kinesitherapeutes',
  'physiotherapeute', 'physiotherapeutes',
  'ergotherapeute', 'ergotherapeutes',
  'psychotherapeute', 'psychotherapeutes',
  'psychomotricien', 'psychomotricienne', 'psychomotriciens', 'psychomotriciennes',
  'orthophoniste', 'orthophonistes',
  'orthoptiste', 'orthoptistes',
  'audioprothesiste', 'audioprothesistes',
  'osteopathe', 'osteopathes',
  'dieteticien', 'dieteticienne', 'dieteticiens', 'dieteticiennes',
  'radiologue', 'radiologues',
  // it — same professions, Italian forms
  'fisioterapista', 'fisioterapisti', 'fisioterapiste',
  'logopedista', 'logopedisti', 'logopediste',
  'psicomotricista', 'psicomotricisti', 'psicomotriciste',
  'radiologo', 'radiologa', 'radiologhe',
  // en
  'physiotherapist', 'physiotherapists',
  'psychotherapist', 'psychotherapists',
  'occupationaltherapist', 'occupationaltherapists',
]);

/** Fold accents and case so the allowlist matches every spelling variant. */
function normalizeForAllowlist(token) {
  return String(token || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/**
 * Detects a title where 2+ source words were fused into one unspaced token
 * by a translation pass, instead of translating each word and keeping the
 * spaces. Only checked for locales in CONCATENATED_WORD_MIN_LEN — there is
 * no reliable length/charset split between this defect and a genuine long
 * compound word for other locales (notably German).
 *
 * A token that clears the length floor is still exempted when it (or its
 * hyphen-split part) matches LEGITIMATE_LONG_WORDS above — see that constant
 * for why this is a curated list rather than a higher number.
 *
 * @param {string} text - candidate title in the target locale
 * @param {string} locale - target locale of `text`
 * @returns {boolean} true if `text` looks like it has glued-together words
 */
export function hasConcatenatedWords(text, locale) {
  const minLen = CONCATENATED_WORD_MIN_LEN[locale];
  if (!minLen) return false;
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  // Split on hyphens too: hyphenated compounds (e.g. "Sous-directeur-adjoint",
  // "Employe-e") are legitimate multi-word titles, not glued-together output —
  // each hyphen-joined part must independently clear the length floor.
  return trimmed.split(/\s+/).some((rawToken) => rawToken.split(/[-–—]/).some((part) => {
    const token = part.replace(/[.,;:!?'’"()/]/g, '');
    if (token.length < minLen || !LETTER_TOKEN_RE.test(token)) return false;
    if (LEGITIMATE_LONG_WORDS.has(normalizeForAllowlist(token))) return false;
    return true;
  }));
}
