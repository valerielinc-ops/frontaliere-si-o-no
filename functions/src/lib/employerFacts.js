/** Employer facts are citations, never evidence of the applicant's skills or experience. */
const escaped = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SENTENCE_END = /[.!?;\n]/;
function sentenceAt(text, index) {
  let start = index;
  let end = index;
  while (start > 0 && !SENTENCE_END.test(text[start - 1])) start -= 1;
  while (end < text.length && !SENTENCE_END.test(text[end])) end += 1;
  return text.slice(start, end);
}

/** Only an exact acronym already present in the canonical employer name, in employer prose. */
export function employerReferenceSpans(text, employerName = '') {
  const aliases = [...new Set(String(employerName).match(/\b[A-Z][A-Z0-9]{2,}\b/g) || [])];
  return aliases.flatMap((alias) => {
    const pattern = new RegExp(`\\b(?:visione|missione|valori|storia|vision|mission|values|history|werte|geschichte|valeurs|histoire)\\s+(?:di|of|von|de|d['’])\\s*(${escaped(alias)})(?![\\p{L}\\p{N}])`, 'giu');
    return [...String(text).matchAll(pattern)].map((match) => [match.index + match[0].lastIndexOf(match[1]), match[1].length]);
  });
}

const COMPANY_NOUN = /(?<![\p{L}\p{N}])(?:società|societa|azienda|gruppo|company|unternehmen|entreprise|société)(?![\p{L}\p{N}])/iu;
const PERSONAL_OR_NEGATED = /\b(?:ho|avevo|mio|mia|miei|mie|nostro|nostra|my|our|i have|i had|ich habe|mein\w*|j['’]ai|mon|mes|non|not|never|nicht|kein\w*|pas|candidate|candidat\w*|richiest\w*|required|must|you|votre|vostri)\b/iu;
const THIRD_PARTY_SUBJECT = /\b(?:partner|clienti?|customers?|suppliers?|fornitor\w*|altra|other|autre)\b/iu;
const COMPANY_YEARS = /\b(?:(?:da|for|seit|depuis|von)\s+)?(?:(?:oltre|over|more than|über|plus de)\s+)?(\d+)\s+(?:anni|years|jahren|jahre|ans)\b/giu;
const EXPERIENCE_YEARS = /\b(?:anni\s+di\s+esperienza|years?\s+of\s+experience|jahre?n?\s+(?:an\s+)?erfahrung|ans\s+d['’]expérience)\b/iu;
const RECRUITING_OR_REQUIREMENT = /\b(?:cerca|cercano|ricerca|ricercano|richiede|richiedono|assume|assumono|seeks?|requires?|recruit(?:s|ed|ing)?|looking|hiring|sucht|suchen|fordert|fordern|cherche|recherche)\b/iu;
function companyAges(text) {
  return [...String(text).matchAll(COMPANY_YEARS)].flatMap((match) => {
    const sentence = sentenceAt(String(text), match.index);
    const before = String(text).slice(0, match.index);
    const sentenceBefore = sentenceAt(before, Math.max(0, before.length - 1));
    if (PERSONAL_OR_NEGATED.test(sentence) || THIRD_PARTY_SUBJECT.test(sentenceBefore)
      || EXPERIENCE_YEARS.test(sentence) || RECRUITING_OR_REQUIREMENT.test(sentence)
      || !COMPANY_NOUN.test(sentenceBefore)) return [];
    return [{ value: match[1], index: match.index + match[0].indexOf(match[1]), length: match[1].length }];
  });
}

/** A number about the employer's age must have that same employer-age meaning in the posting. */
export function quotedEmployerAge(text, index, posting = '') {
  const age = companyAges(text).find((item) => index >= item.index && index < item.index + item.length);
  return Boolean(age && companyAges(posting).some((item) => item.value === age.value));
}
