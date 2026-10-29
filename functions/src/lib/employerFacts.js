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
const COMPANY_NAME_AFTER_NOUN = /^[\s:,(“"«]+((?:[\p{L}][\p{L}\p{M}\p{N}&'’.-]*)(?:\s+[\p{L}][\p{L}\p{M}\p{N}&'’.-]*){0,2})/u;
const COMPANY_LEGAL_SUFFIX = /\b(?:SA|AG|GmbH|Sàrl|Sarl|Ltd|Inc|SAS|Srl)\b/iu;
const PERSONAL_OR_NEGATED = /\b(?:ho|avevo|mio|mia|miei|mie|nostro|nostra|my|our|i have|i had|ich habe|mein\w*|j['’]ai|mon|mes|non|not|never|nicht|kein\w*|pas|candidate|candidat\w*|richiest\w*|required|must|you|votre|vostri)\b/iu;
const THIRD_PARTY_SUBJECT = /\b(?:partner|clienti?|customers?|suppliers?|fornitor\w*|altra|other|autre)\b/iu;
const COMPANY_YEARS = /\b(?:(?:da|for|seit|depuis|von)\s+)?(?:(?:oltre|over|more than|über|plus de)\s+)?(\d+)\s+(?:anni|years|jahren|jahre|ans)\b/giu;
const EXPERIENCE_YEARS = /\b(?:anni\s+di\s+esperienza|years?\s+of\s+experience|jahre?n?\s+(?:an\s+)?erfahrung|ans\s+d['’]expérience)\b/iu;
const RECRUITING_OR_REQUIREMENT = /\b(?:cerc\w*|ricerc\w*|richied\w*|assum\w*|seeks?|requires?|recruit(?:s|ed|ing)?|looking|hiring|sucht|suchen|fordert|fordern|cherche|recherche)\b/iu;
function companyAges(text) {
  return [...String(text).matchAll(COMPANY_YEARS)].flatMap((match) => {
    const sentence = sentenceAt(String(text), match.index);
    const before = String(text).slice(0, match.index);
    const sentenceBefore = sentenceAt(before, Math.max(0, before.length - 1));
    if (PERSONAL_OR_NEGATED.test(sentence) || THIRD_PARTY_SUBJECT.test(sentenceBefore)
      || EXPERIENCE_YEARS.test(sentence) || RECRUITING_OR_REQUIREMENT.test(sentence)
      || !COMPANY_NOUN.test(sentenceBefore)) return [];
    return [{ value: match[1], index: match.index + match[0].indexOf(match[1]), length: match[1].length, sentence }];
  });
}

function sameCanonicalEmployer(sentence, employerName) {
  const normalize = (value) => String(value).normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const canonical = normalize(employerName);
  const aliases = new Set(String(employerName).match(/\b[A-Z][A-Z0-9]{2,}\b/g) || []);
  const names = explicitCompanyNames(sentence);
  return names.every((name) => normalize(name) === canonical || (aliases.has(name) && normalize(name) === normalize(name.toUpperCase())));
}

function explicitCompanyNames(sentence) {
  const nouns = new RegExp(COMPANY_NOUN.source, 'giu');
  return [...String(sentence).matchAll(nouns)].flatMap((match) => {
    const afterNoun = String(sentence).slice(match.index + match[0].length);
    const tokens = afterNoun.match(COMPANY_NAME_AFTER_NOUN)?.[1]?.split(/\s+/u) || [];
    if (!tokens.length) return [];
    const suffixIndex = tokens.findIndex((token) => COMPANY_LEGAL_SUFFIX.test(token));
    let lastNameToken = suffixIndex;
    if (lastNameToken < 0 && (/^\p{Lu}/u.test(tokens[0]) || /[\p{Ll}][\p{Lu}]/u.test(tokens[0]))) {
      lastNameToken = 0;
      while (lastNameToken + 1 < tokens.length && /^\p{Lu}/u.test(tokens[lastNameToken + 1])) lastNameToken += 1;
    }
    return lastNameToken < 0 ? [] : [tokens.slice(0, lastNameToken + 1).join(' ')];
  });
}

const CANONICAL_LEGAL_SUFFIX = /\s+(?:SA|AG|GmbH|Sagl|Srl|SRL|SpA|Ltd|Inc|LLC)\.?$/iu;
const identityKey = value => String(value).trim().replace(CANONICAL_LEGAL_SUFFIX, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
function containsCanonicalIdentity(sentence, employerName) {
  const canonical = identityKey(employerName);
  return canonical.length >= 3 && ` ${identityKey(sentence)} `.includes(` ${canonical} `);
}
function namesCanonicalEmployer(sentence, employerName) {
  if (containsCanonicalIdentity(sentence, employerName)) return true;
  const aliases = String(employerName).match(/\b[A-Z][A-Z0-9]{2,}\b/g) || [];
  return aliases.some((alias) => new RegExp(`(?<![\\p{L}\\p{N}])${escaped(alias)}(?![\\p{L}\\p{N}])`, 'iu').test(sentence));
}
function hasOtherClosedEmployer(sentence, employerName) {
  const names = /(?:\p{Lu}[\p{L}\p{N}'’.-]*\s+){1,5}(?:SA|AG|GmbH|Sagl|Srl|SRL|SpA|Ltd|Inc|LLC)(?![\p{L}\p{N}])/gu;
  return [...sentence.matchAll(names)].some(match => !containsCanonicalIdentity(match[0], employerName));
}

/** A number about the employer's age must cite the canonical employer and same fact in the posting. */
export function quotedEmployerAge(text, index, posting = '', employerName = '') {
  const age = companyAges(text).find((item) => index >= item.index && index < item.index + item.length);
  return Boolean(employerName && age && sameCanonicalEmployer(age.sentence, employerName)
    && !hasOtherClosedEmployer(age.sentence, employerName)
    && companyAges(posting).some((item) => item.value === age.value
      && (!namesCanonicalEmployer(item.sentence, employerName) || namesCanonicalEmployer(age.sentence, employerName))
      && !hasOtherClosedEmployer(item.sentence, employerName)
      && sameCanonicalEmployer(item.sentence, employerName)));
}
