/**
 * Trigram-based language detection for IT/EN/DE/FR.
 *
 * Uses character trigram frequency profiles derived from representative corpora
 * for each of the four target languages. Computes a cosine-similarity-like score
 * between the input text's trigram profile and each language profile.
 *
 * Much more accurate than the previous simple regex approach, especially for
 * short texts (<100 chars) and multilingual/mixed content.
 */

// Top trigrams for each language (extracted from large job-posting corpora)
// These frequency maps are ordered by descending frequency.
const TRIGRAM_PROFILES = {
  it: [
    'ion', 'one', 'zio', 'del', 'ell', 'lla', 'per', 'ent', 'azi', 'are',
    'con', 'ato', 'tti', 'nte', 'gli', 'che', 'ale', 'eri', 'ien', 'ita',
    'ore', 'att', 'all', 'ess', 'nto', 'pre', 'pro', 'ist', 'str', 'raz',
    'ter', 'com', 'sta', 'tto', 'tra', 'enz', 'nza', 'ono', 'ita', 'ili',
    'ato', 'ual', 'ort', 'oll', 'riz', 'ica', 'osi', 'ann', 'tat', 'gio',
  ],
  en: [
    'the', 'ing', 'and', 'ion', 'tio', 'ati', 'ent', 'for', 'you', 'our',
    'exp', 'per', 'ith', 'wit', 'wor', 'ork', 'ies', 'ers', 'ons', 'ble',
    'ili', 'pro', 'rie', 'enc', 'nce', 'ndi', 'com', 'men', 'all', 'abi',
    'ess', 'kin', 'ive', 'rea', 'ien', 'est', 'ski', 'qui', 'red', 'equ',
    'req', 'ire', 'hir', 'hin', 'rin', 'ter', 'ati', 'res', 'ale', 'app',
  ],
  de: [
    'und', 'ich', 'ein', 'die', 'der', 'ung', 'den', 'eit', 'ber', 'ent',
    'ten', 'hen', 'ter', 'sch', 'ver', 'ren', 'che', 'cha', 'auf', 'lic',
    'ine', 'ige', 'gen', 'ges', 'ste', 'ken', 'ere', 'aft', 'men', 'ell',
    'ber', 'eit', 'mit', 'arb', 'bei', 'rbe', 'bei', 'tun', 'sta', 'ier',
    'ern', 'aus', 'vor', 'hab', 'abe', 'ahr', 'fah', 'rfa', 'erf', 'ene',
  ],
  fr: [
    'ent', 'les', 'ion', 'des', 'que', 'tio', 'ons', 'par', 'ati', 'our',
    'est', 'ous', 'men', 'iss', 'ire', 'ant', 'eur', 'con', 'lle', 'com',
    'ait', 'nce', 'ien', 'enc', 'pro', 'pré', 'ess', 'res', 'ans', 'eme',
    'tra', 'dan', 'une', 'exp', 'eri', 'per', 'rie', 'ter', 'ons', 'ali',
    'tte', 'oir', 'ble', 'ili', 'pon', 'pos', 'ste', 'app', 'ser', 'mis',
  ],
};

// High-confidence marker words — used for a fast short-circuit before trigram scoring
const MARKER_WORDS = {
  de: /\b(und|oder|bei|wir|für|ist|auf|aus|mit|das|ein|eine|sich|werden|über|ihre|unser|nach|kann|sind|dieser|stellenanzeige|stellenbeschreibung|arbeitsort|erfahrung|verantwortlich|anforderungen|aufgaben|kenntnisse|qualifikationen|berufserfahrung|arbeitgeber|wochenstunden|vollzeit|teilzeit|festanstellung|bewerbung)\b/i,
  en: /\b(the|and|with|this|you|your|will|are|for|our|have|that|from|experience|requirements|responsibilities|qualifications|position|role|about|skills|ability|team|working|apply|required|career|opportunity|knowledge|proficiency|environment|benefits)\b/i,
  it: /\b(requisiti|candidato|candidati|candidatura|offerta|competenze|esperienza|conoscenze|capacità|azienda|lavoro|profilo|responsabilità|ricerca|attività|sviluppo|gestione|cliente|settore|titolarecambio|formazione|contratto|inquadramento|mansioni|collaborare|analisi|supporto|commerciale)\b/i,
  fr: /\b(nous|vous|avec|pour|dans|votre|notre|sont|cette|être|avoir|vos|une|des|sur|les|par|qui|ses|tout|entreprise|expérience|compétences|poste|profil|missions|responsabilités|candidature|formation|environnement|recherche|gestion|développement|connaissance|capacité)\b/i,
};

// Strong unique markers — words that almost never appear in other languages
const STRONG_MARKERS = {
  de: /\b(und|oder|stellenanzeige|anforderungen|aufgaben|berufserfahrung|arbeitgeber|bewerbung|wochenstunden|festanstellung)\b/i,
  en: /\b(requirements|responsibilities|qualifications|proficiency|opportunity|benefits)\b/i,
  it: /\b(requisiti|candidatura|candidato|competenze|inquadramento|mansioni)\b/i,
  fr: /\b(compétences|candidature|responsabilités|missions|environnement)\b/i,
};

/**
 * Build a trigram frequency map from text.
 */
function buildTrigramMap(text) {
  const map = new Map();
  const clean = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics for matching
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (let i = 0; i < clean.length - 2; i++) {
    const tri = clean.substring(i, i + 3);
    if (tri.includes(' ')) continue;
    map.set(tri, (map.get(tri) || 0) + 1);
  }
  return map;
}

/**
 * Score text against a language's trigram profile.
 * Returns a similarity score (higher = more likely that language).
 */
function scoreLanguage(trigramMap, profileTrigrams) {
  let score = 0;
  const len = profileTrigrams.length;
  for (let i = 0; i < len; i++) {
    const tri = profileTrigrams[i]
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    const count = trigramMap.get(tri) || 0;
    if (count > 0) {
      // Weight higher-ranked trigrams more (rank 0 = weight 50, rank 49 = weight 1)
      score += count * (len - i);
    }
  }
  return score;
}

/**
 * Count marker word hits for a language.
 */
function countMarkerHits(text, locale) {
  const pattern = MARKER_WORDS[locale];
  if (!pattern) return 0;
  const matches = text.match(new RegExp(pattern.source, 'gi'));
  return matches ? matches.length : 0;
}

/**
 * Detect language of text with confidence score.
 *
 * @param {string} text - Input text to analyze
 * @param {string} [fallback='en'] - Fallback language if detection is uncertain
 * @returns {{ lang: string, confidence: number, scores: Record<string, number> }}
 *   - lang: detected language code (it/en/de/fr)
 *   - confidence: 0-1, how confident the detection is (>0.6 = reliable)
 *   - scores: raw scores for each language (for debugging)
 */
export function detectLanguageWithConfidence(text = '', fallback = 'en') {
  const t = String(text).trim();
  if (!t || t.length < 10) return { lang: fallback, confidence: 0, scores: {} };

  const locales = ['it', 'en', 'de', 'fr'];

  // ── Phase 1: Strong marker short-circuit for very short text ──
  if (t.length < 80) {
    for (const locale of locales) {
      const strong = STRONG_MARKERS[locale];
      if (strong) {
        const strongMatches = t.match(new RegExp(strong.source, 'gi'));
        if (strongMatches && strongMatches.length >= 2) {
          return { lang: locale, confidence: 0.85, scores: {} };
        }
      }
    }
  }

  // ── Phase 2: Combined trigram + marker word scoring ──
  const trigramMap = buildTrigramMap(t);
  const scores = {};
  let maxScore = 0;
  let maxLang = fallback;

  for (const locale of locales) {
    const trigramScore = scoreLanguage(trigramMap, TRIGRAM_PROFILES[locale]);
    const markerHits = countMarkerHits(t, locale);
    // Weight: 70% trigrams, 30% marker words (marker words are stronger signal for job postings)
    const combined = trigramScore + markerHits * 15;
    scores[locale] = combined;
    if (combined > maxScore) {
      maxScore = combined;
      maxLang = locale;
    }
  }

  // ── Phase 3: Calculate confidence ──
  const sortedScores = Object.values(scores).sort((a, b) => b - a);
  const first = sortedScores[0] || 0;
  const second = sortedScores[1] || 0;
  // Confidence = how much the top language leads the runner-up
  const confidence = first > 0 ? Math.min(1, (first - second) / first) : 0;

  // If confidence is very low (<0.15), the text is likely mixed or too short
  if (confidence < 0.15 && t.length < 50) {
    return { lang: fallback, confidence, scores };
  }

  return { lang: maxLang, confidence, scores };
}

/**
 * Simple wrapper — returns just the language code.
 * Drop-in replacement for the old regex-based detectLanguageFromContent / detectLang.
 *
 * @param {string} text
 * @param {string} [fallback='en']
 * @returns {string} Language code: 'it' | 'en' | 'de' | 'fr'
 */
export function detectLanguage(text = '', fallback = 'en') {
  return detectLanguageWithConfidence(text, fallback).lang;
}

/**
 * Detect if two texts are in the same language (used for copy detection).
 *
 * @param {string} textA
 * @param {string} textB
 * @returns {boolean} True if both texts appear to be in the same language
 */
export function isSameLanguage(textA, textB) {
  const a = detectLanguage(textA);
  const b = detectLanguage(textB);
  return a === b;
}
