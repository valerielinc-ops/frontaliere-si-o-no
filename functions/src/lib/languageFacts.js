/**
 * Language names in CVs and application questions. Only a complete list of
 * individually recognized CV entries supports inferring that an unlisted
 * language is absent; ambiguous entries remain unknown. This does not infer
 * proficiency levels.
 */

const LANGUAGE_NAMES = {
  de: ['deutsch', 'tedesco', 'allemand', 'german'],
  en: ['englisch', 'inglese', 'anglais', 'english'],
  fr: ['französisch', 'franzoesisch', 'francese', 'français', 'francais', 'french'],
  it: ['italienisch', 'italiano', 'italien', 'italian'],
  es: ['español', 'espanol', 'spagnolo', 'spanisch', 'espagnol', 'spanish', 'castilian'],
  pt: ['português', 'portugues', 'portoghese', 'portugiesisch', 'portuguese'],
  rm: ['romansh', 'romancio', 'romanche', 'rätoromanisch', 'raetoromanisch'],
  sq: ['shqip', 'albanese', 'albanisch', 'albanais', 'albanian'],
  ar: ['arabic', 'arabo', 'arabisch', 'arabe'],
  bs: ['bosnian', 'bosniaco', 'bosniakisch', 'bosniaque'],
  hr: ['croatian', 'croato', 'kroatisch', 'croate'],
  sr: ['serbian', 'serbo', 'serbisch', 'serbe'],
  ru: ['russian', 'russo', 'russisch', 'russe'],
  ro: ['romanian', 'rumeno', 'rumänisch', 'rumaenisch', 'roumain'],
  tr: ['turkish', 'turco', 'türkisch', 'turkisch', 'turc'],
  zh: ['chinese', 'cinese', 'chinesisch', 'chinois', 'mandarin', 'putonghua'],
  ja: ['japanese', 'giapponese', 'japanisch', 'japonais'],
  nl: ['dutch', 'olandese', 'niederländisch', 'niederlaendisch', 'néerlandais', 'neerlandais'],
  el: ['greek', 'greco', 'griechisch', 'grec'],
  pl: ['polish', 'polacco', 'polnisch', 'polonais'],
  sv: ['swedish', 'svedese', 'schwedisch', 'suédois', 'suedois'],
  da: ['danish', 'danese', 'dänisch', 'daenisch', 'danois'],
  no: ['norwegian', 'norvegese', 'norwegisch', 'norvégien', 'norvegien'],
  fi: ['finnish', 'finlandese', 'finnisch', 'finnois'],
  hu: ['hungarian', 'ungherese', 'ungarisch', 'hongrois'],
  cs: ['czech', 'ceco', 'tschechisch', 'tchèque', 'tcheque'],
  sk: ['slovak', 'slovacco', 'slowakisch', 'slovaque'],
  uk: ['ukrainian', 'ucraino', 'ukrainisch', 'ukrainien'],
  he: ['hebrew', 'ebraico', 'hebräisch', 'hebraeisch', 'hébreu'],
  hi: ['hindi'],
  fa: ['persian', 'farsi', 'persiano', 'persisch', 'perse'],
  ur: ['urdu'],
  vi: ['vietnamese', 'vietnamita', 'vietnamesisch', 'vietnamien'],
  ko: ['korean', 'coreano', 'koreanisch', 'coréen'],
  th: ['thai', 'tailandese', 'thailändisch', 'thailandais'],
  id: ['indonesian', 'indonesiano', 'indonesisch', 'indonésien'],
  sw: ['swahili', 'kiswahili'],
};

const LANGUAGE_SECTION_TITLE_RE = /^(?:languages?|spoken languages?|foreign languages?|language skills?|language proficiency|lingue?|lingue? parlate|lingue? straniere|conoscenze linguistiche|langues?|langues? parlees|langues? etrangeres|competences linguistiques|sprachen?|sprachkenntnisse|fremdsprachen)$/i;
const LANGUAGE_PREFERENCE_RE = /\b(?:enjoy\w*|like\w*|love\w*|dislike\w*|fond\s+of|gern(?:e)?|lieb\w*|mog\w*|aim\w*|ador\w*|plais\w*|piac\w*|gust\w*|gost\w*)\b/i;
const STRONG_LANGUAGE_INTENT_RE = /\b(?:willing(?:ness)?|learn\w*|study\w*|prefer\w*|interested|interest|want|plan\w*|hope|bereit|mocht\w*|woll\w*|soll\w*|lern\w*|apprend\w*|impar\w*|studier\w*|etudier\w*|dispos\w*|interess\w*|desir\w*|sper\w*|souhait\w*|vuoi|vuol\w*|vogli\w*|vorrei|vorrest\w*|voler\w*|voul\w*|voudr\w*|veu(?:x|t|lent)|pret\w*)\b/i;
const MODAL_LANGUAGE_INTENT_RE = /\b(?:would|will\w*|wurd\w*)\b/i;
const LANGUAGE_CAPABILITY_AUX_RE = /\b(?:be\s+able(?:\s+to)?|able\s+to|can|could|kann\w*|konn\w*|pouv\w*|peux|peut|pode\w*|pued\w*|podr\w*|puoi|puo|posso|potete|consegue\w*)\b/i;
const LANGUAGE_ABILITY_QUESTION_RE = /\b(?:speak(?:ing)?|spoken|sprech\w*|parl\w*|conosc\w*|connaiss\w*|kenntnis\w*|know(?:ledge)?|skill\w*|proficien(?:cy|t)|fluenc\w*|fluent|level|niveau|livello|ability|able|communicat\w*|written|writ\w*|oral|mundlich|schriftlich|ecrit|native|mother tongue|muttersprache|sprachkenntnis\w*|[abc][12])\b/i;

const fold = (value) => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/ß/gi, 'ss').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function includesName(text, name) {
  const normalizedName = fold(name).replace(/\s+/g, ' ');
  const escaped = normalizedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(?<![\\p{L}])${escaped}(?![\\p{L}])`, 'u').test(text);
}

/** Language codes named in a question or CV entry. */
export function languageCodesIn(value) {
  const text = fold(value);
  if (!text) return [];
  return Object.entries(LANGUAGE_NAMES)
    .filter(([, names]) => names.some((name) => includesName(text, name)))
    .map(([code]) => code);
}

/** The language code of a profile entry such as "Deutsch B2" or "de-CH". */
export function languageCodeOf(value) {
  const text = String(value ?? '').trim();
  const exact = /^([a-z]{2})(?:[-_]\w+)?$/i.exec(text)?.[1]?.toLowerCase();
  if (exact && Object.hasOwn(LANGUAGE_NAMES, exact)) return exact;
  const codes = languageCodesIn(text);
  return codes.length === 1 ? codes[0] : '';
}

function languageCodesForEntry(value) {
  const text = fold(value).replace(/\b[abc][12]\b/g, '').replace(/\s+/g, ' ').trim();
  const exactCode = /^([a-z]{2})(?:[-_]\w+)?$/i.exec(String(value ?? '').trim())?.[1]?.toLowerCase();
  if (exactCode && Object.hasOwn(LANGUAGE_NAMES, exactCode)) return [exactCode];
  const codes = languageCodesIn(text);
  if (codes.length !== 1) return [];
  // A single recognized substring is not enough: `German / Xhosa` must not
  // become a complete German-only entry just because Xhosa is unknown here.
  return LANGUAGE_NAMES[codes[0]].some((name) => fold(name) === text) ? codes : [];
}

/** Whether a question asks about current language ability rather than intent or willingness to learn. */
export function isLanguageAbilityQuestion(value) {
  const text = fold(value);
  if (LANGUAGE_PREFERENCE_RE.test(text) || STRONG_LANGUAGE_INTENT_RE.test(text)) return false;
  if (MODAL_LANGUAGE_INTENT_RE.test(text) && !LANGUAGE_CAPABILITY_AUX_RE.test(text)) return false;
  return LANGUAGE_ABILITY_QUESTION_RE.test(text);
}

/** Whether a question asks about language intent rather than current ability. */
export function isLanguageIntentQuestion(value) {
  const text = fold(value);
  const namesLanguages = languageCodesIn(text).length > 0
    || /\b(?:language|languages|lingua|lingue|langue|langues|sprache|sprachen|fremdsprache|fremdsprachen|idioma|idiomas|linguagem)\b/i.test(text);
  const preference = LANGUAGE_PREFERENCE_RE.test(text);
  const strongIntent = STRONG_LANGUAGE_INTENT_RE.test(text);
  const modalIntent = MODAL_LANGUAGE_INTENT_RE.test(text) && !LANGUAGE_CAPABILITY_AUX_RE.test(text);
  return namesLanguages && (preference || strongIntent || modalIntent);
}

export function explicitLanguageEntries(profile) {
  return (Array.isArray(profile?.languages) ? profile.languages : [])
    .filter((item) => String(item?.language ?? '').trim());
}

/** Whether the CV has a dedicated heading that introduces its spoken-language list. */
export function hasExplicitLanguageSection(cvText) {
  return String(cvText ?? '').split(/\r?\n/).some((line) => {
    const normalized = fold(line).replace(/\s+/g, ' ').trim();
    if (LANGUAGE_SECTION_TITLE_RE.test(normalized)) return true;
    const inline = /^(.*?)\s*[:\-–—]\s*\S/.exec(normalized);
    return Boolean(inline && LANGUAGE_SECTION_TITLE_RE.test(inline[1].replace(/\s*\([^)]*\)\s*$/, '').trim()));
  });
}

/**
 * Whether a current-ability question names one language absent from a
 * non-empty list of individually recognized entries. Missing or ambiguous
 * entries keep absence unknown.
 */
export function languageExplicitlyAbsent(profile, question) {
  if (profile?.languagesExplicitList !== true) return false;
  const entries = explicitLanguageEntries(profile);
  if (!entries.length) return false;
  const text = String(question ?? '');
  if (!isLanguageAbilityQuestion(text)) return false;
  const requested = languageCodesIn(text);
  if (requested.length !== 1) return false;
  const listedCodes = entries.map((item) => languageCodesForEntry(item.language));
  if (listedCodes.some((codes) => codes.length !== 1)) return false;
  const listed = new Set(listedCodes.map(([code]) => code));
  return !listed.has(requested[0]);
}

/** The one explicitly listed entry for a language, if its name is recognized. */
export function explicitLanguageEntry(profile, code) {
  if (!code) return null;
  return explicitLanguageEntries(profile).find((item) => languageCodeOf(item.language) === code) || null;
}
