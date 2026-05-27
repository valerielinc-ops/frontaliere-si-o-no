// Lightweight locale detection from a short title/keyword.
// Used to tag Reddit candidates that come in mixed languages (Lugano + Ticino
// have IT, Switzerland has DE/EN, italy is mostly IT). Returns one of
// 'it' | 'en' | 'de' | 'fr'. Defaults to 'it' when confidence is low —
// matches the site's primary locale.

const EN_MARKERS_RE =
  /\b(how|what|when|where|why|anyone|does|is|are|can|should|would|could|i'?m|i\s*am|i've|i\s*have|the|and|with|for|from|about|please|thanks|thank\s*you|guys|friends|guy|girl|years\s*old|cheap|good|best|some|any)\b/i;

const DE_MARKERS_RE =
  /\b(wie|was|wann|wo|warum|wieso|ich|du|sie|er|nicht|ja|nein|oder|und|aber|mit|für|von|zu|aus|haben|hat|hatte|sind|ist|war|werden|möchte|kann|soll|braucht|brauche|frage|hilfe|kennen|kenne|weiss|weiß|jemand|leute)\b/i;

const FR_MARKERS_RE =
  /\b(comment|quoi|quand|où|pourquoi|qui|combien|je|tu|il|elle|nous|vous|ils|elles|le|la|les|un|une|des|et|ou|mais|avec|pour|sans|dans|sur|aux|mon|ma|mes|ton|ta|tes|son|sa|ses|c'est|j'ai|merci|s'il|svp)\b/i;

const IT_MARKERS_RE =
  /\b(come|quando|dove|perch[ée]|chi|cosa|quanto|qualcuno|consiglio|consigli|aiuto|domanda|sono|ho|hai|fa|si|no|e|o|ma|con|per|senza|in|su|del|della|delle|dei|degli|gli|grazie|prego|conoscete|sapete|qualcuno|secondo)\b/i;

/**
 * Classify the locale of a short text. Word-overlap heuristic — counts
 * matches per language and picks the highest. Ties default to 'it'.
 */
export function detectLocale(text) {
  if (!text || typeof text !== 'string') return 'it';
  const t = text.toLowerCase();

  // Count distinct unique markers per language. Multiple matches on the
  // same word count as 1.
  const score = (re) => {
    const m = t.match(new RegExp(re.source, re.flags + 'g'));
    if (!m) return 0;
    return new Set(m.map((s) => s.toLowerCase())).size;
  };

  const en = score(EN_MARKERS_RE);
  const de = score(DE_MARKERS_RE);
  const fr = score(FR_MARKERS_RE);
  const it = score(IT_MARKERS_RE);

  const max = Math.max(en, de, fr, it);
  if (max === 0) return 'it';
  // Confidence floor: at least 2 markers needed before tagging non-IT.
  // Mixed-language titles default to IT (the site's primary locale).
  if (en >= 2 && en === max) return 'en';
  if (de >= 2 && de === max) return 'de';
  if (fr >= 2 && fr === max) return 'fr';
  return 'it';
}

export default detectLocale;
