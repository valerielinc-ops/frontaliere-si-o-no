import { detectLanguageWithConfidence } from './detect-language.mjs';

export const DEFAULT_JOB_LOCALES = ['it', 'en', 'de', 'fr'];

const TITLE_HINTS = {
  en: [
    /\b(engineer|specialist|manager|coordinator|developer|scientist|designer|analyst|quality|project|customer|backend|frontend|software|full[\s-]?stack|intern|internship|associate|banking|all[\s-]?rounder|technician|process|operations?|sales|marketing|support|advisor|consultant|lead|head|product|application|supply chain|research|fellowship|student|position|coach|allocator|librarian|paid media|seo|life science)\b/gi,
    // Note: "jr"/"sr" removed from EN-only hints — they are used across IT/EN/DE/FR job titles
  ],
  de: [
    /\b(mitarbeiter|fachspezialist|fachfrau|fachmann|oberarzt|arzt|pflege|leiter|logistik|spital|praktikant|qualitat|qualität|ingenieur|techniker|verantwortliche|verantwortlicher|diatkoch|diätkoch|apotheker|systemgastronomie|systemgastronomiefachfrau|systemgastronomiefachmann|sekretär|sekretärin|onkologie|hämatologie|rayonleiter|metzger|detailhandelsfachfrau|detailhandelsfachmann|medizinische|berufsbildner|assistenzarzt|pflegefach|chefarzt|altersmedizin|kardiologie|herzchirurgie)\b/gi,
    /\b[a-zäöüß]+:in\b/gi,
    /\b[a-zäöüß]+:mann\b/gi,
    /\befz\b/gi,
    // Swiss health/hospital vocational + institutional vocabulary: German builds
    // these as single fused compound words (no space), so a bare word-boundary
    // alternative in the group above can't reach the stem inside e.g.
    // "Pflegefachperson" or "Poliklinik" (\b requires a non-word char right after
    // the match). Each gets its own \w*-padded stem regex instead of enumerating
    // every inflection/compound by hand. Bug: "Fachperson Gesundheit Universitäre
    // Klinik für Altersmedizin" shipped untranslated into an IT-locale slot —
    // none of fachperson/gesundheit/universitäre/klinik/altersmedizin had
    // word-hint support, so detection fell through to the char-hint-only tier
    // (0.45), under the 0.55 needsRetranslation threshold.
    // universität/universitär require the literal "ä" (no plain-"a" fallback,
    // unlike qualitat/qualität above) — "universit[aä][tr]" would also match
    // Italian "universitario/universitari(a)", which has no umlaut.
    /\b\w*fachperson\w*\b/gi,
    /\bgesundheit\w*\b/gi,
    /\b\w*klinik\w*\b/gi,
    /\b(universität|universitär)\w*\b/gi,
    /\b\w*geriatrie\w*\b/gi,
    /\bhauswirtschaft\w*\b/gi,
  ],
  it: [
    /\b(responsabile|medico|infermiere|impiegato|tecnico|cuoco|apprendista|apprendiste|candidato|collaboratore|ingegnere|caporeparto|fisioterapista|servizio civile|radiologia|ginecologia|ostetricia|ristorazione|operatore|segretario|segretaria|assistente|ricercatrice|ricercatore|architetture|sistemi|cucina|dietista|educatore|educatrice)\b/gi,
    /\b[a-z]+\/a\b/gi,
    /\b[a-z]+\/i\b/gi,
    /\b[a-z]+\/trice\b/gi,
  ],
  fr: [
    /\b(ingénieur|spécialiste|responsable|gestionnaire|employé|stagiaire|cuisinier|pharmacien|secrétaire|médical|technicien|qualité|radiologie|assistant|anesthésie|hématologie|oncologie)\b/gi,
  ],
};

const TITLE_CHAR_HINTS = {
  de: /[äöüß]/i,
  // 'ü' excluded: not a French letter — including it caused DE/FR score
  // ties on German titles (e.g. "Früh-/Spätdienst"), downgrading detection
  // confidence below the threshold needed to catch untranslated titles.
  fr: /[àâçéèêëîïôùûœ]/i,
};

function countMatches(text, regex) {
  if (!regex) return 0;
  const matches = text.match(regex);
  return matches ? matches.length : 0;
}

export function detectTextLocale(value = '', fallback = 'it') {
  const clean = String(value || '').trim();
  if (!clean) return { lang: fallback, confidence: 0, scores: {} };
  return detectLanguageWithConfidence(clean, fallback);
}

export function detectJobTitleLocaleDetails(title = '', fallback = 'it') {
  const clean = String(title || '').trim();
  if (!clean) {
    return { lang: fallback, confidence: 0, method: 'empty', scores: {} };
  }

  const wordScores = Object.fromEntries(
    DEFAULT_JOB_LOCALES.map((locale) => [locale, 0])
  );
  const scores = Object.fromEntries(
    DEFAULT_JOB_LOCALES.map((locale) => [locale, 0])
  );

  for (const locale of DEFAULT_JOB_LOCALES) {
    const rules = TITLE_HINTS[locale] || [];
    for (const rule of rules) {
      wordScores[locale] += countMatches(clean, rule) * 2;
    }
    scores[locale] = wordScores[locale];
    if (TITLE_CHAR_HINTS[locale]?.test(clean)) {
      scores[locale] += 2;
    }
  }

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [bestLocale = fallback, bestScore = 0] = ranked[0] || [];
  const secondScore = ranked[1]?.[1] || 0;
  const detected = detectTextLocale(clean, fallback);
  // A bare diacritic (e.g. the 'ü' in a "Zürich" place name embedded in an
  // otherwise-correctly-translated title) must not alone be enough to declare
  // the whole title untranslated — require at least one dictionary word-hint
  // match before trusting the confident tiers below.
  const bestHasWordSupport = (wordScores[bestLocale] || 0) > 0;

  if (bestHasWordSupport && bestScore >= 3 && bestScore >= secondScore + 2) {
    return { lang: bestLocale, confidence: 0.85, method: 'title-hints-strong', scores };
  }
  if (bestHasWordSupport && bestScore >= 2 && bestScore > secondScore) {
    return { lang: bestLocale, confidence: 0.7, method: 'title-hints', scores };
  }
  if (detected.confidence >= 0.4) {
    return { ...detected, method: 'content-detector' };
  }
  if (bestScore > 0) {
    return {
      lang: bestLocale,
      confidence: Math.min(0.55, 0.35 + bestScore * 0.05),
      method: bestHasWordSupport ? 'title-hints-soft' : 'char-hint-only',
      scores,
    };
  }
  return { ...detected, method: 'fallback' };
}

export function detectJobTitleLang(title = '', fallback = 'it') {
  return detectJobTitleLocaleDetails(title, fallback).lang;
}

/**
 * Generic "still in source language" check for a locale-slotted title.
 *
 * Historically each quality gate hardcoded its own leftover-word denylist
 * (e.g. titleHasItalianWords), which only ever caught IT-source leftovers in
 * non-IT slots. Crawlers with a non-IT sourceLang (e.g. DE-source health-sector
 * employers translating into IT) produced titles the old gates couldn't see —
 * detectJobTitleLocaleDetails is title-tuned and works for any locale pair.
 *
 * @param {string} title        text currently stored in `targetLocale`'s slot
 * @param {string} sourceLang   the job's actual source language
 * @param {string} targetLocale the locale slot being checked
 * @returns {boolean} true if `title` still reads as `sourceLang`, not `targetLocale`
 */
export function titleLooksUntranslatedFromSource(title, sourceLang, targetLocale, { minConfidence = 0.55 } = {}) {
  const clean = String(title || '').trim();
  if (!clean || !sourceLang || !targetLocale || sourceLang === targetLocale) return false;
  const detected = detectJobTitleLocaleDetails(clean, targetLocale);
  return detected.lang === sourceLang && detected.confidence >= minConfidence;
}

/**
 * Publisher-authored jobs declare their source language explicitly: the title
 * and description are human-written by the employer in `sourceLang`, so
 * heuristic language detection must never override that slot. Detection sees
 * an Italian title like "Prompt engineer da remoto" as EN (job-title hints are
 * dominated by English loanwords) and then "repairs" the IT slot via
 * heuristicTranslateJobTitle → "Prompt Ingegnere da remoto" — destroying the
 * paid, publisher-written copy. Both heuristic sites
 * (shared-jobs-crawler ensureLocaleFields and dedicated-crawler-common
 * hardenJobLocaleFields) consult this pin before trusting detection.
 *
 * @param {object} job  any job-shaped record
 * @returns {string|null} the declared source locale to pin, or null to detect
 */
export function pinnedTitleSourceLang(job) {
  if (!job || job.source !== 'publisher-submitted') return null;
  const lang = String(job.sourceLang || '').trim().toLowerCase();
  return DEFAULT_JOB_LOCALES.includes(lang) ? lang : null;
}
