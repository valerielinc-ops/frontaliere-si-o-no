/**
 * Language names in CVs and application questions. A non-empty extracted CV
 * language list is treated as the candidate's declared list: a language not
 * on it is not claimed. This supports negative answers only where the form
 * names one specific language; it does not infer proficiency levels.
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
  return exact && Object.hasOwn(LANGUAGE_NAMES, exact) ? exact : languageCodesIn(text)[0] || '';
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
 * Whether a question names a specific language that is absent from a
 * non-empty language list. An empty list means the CV did not establish an
 * exhaustive list, so absence stays unknown.
 */
export function languageExplicitlyAbsent(profile, question) {
  if (profile?.languagesExplicitList !== true) return false;
  const entries = explicitLanguageEntries(profile);
  if (!entries.length) return false;
  const text = String(question ?? '');
  if (!/\b(?:language|lingua|langue|sprach|speak|spoken|parl\w*|fluenc\w*|kenntnis\w*|conoscenz\w*|connaiss\w*|proficiency|level|niveau|madrelingua|muttersprache|communicat\w*|use)\b|\bwork\s+in\b|\b[abc][12]\b/i.test(text)) return false;
  const requested = languageCodesIn(text);
  if (requested.length !== 1) return false;
  const listed = new Set(entries.map((item) => languageCodeOf(item.language)).filter(Boolean));
  return !listed.has(requested[0]);
}

/** The one explicitly listed entry for a language, if its name is recognized. */
export function explicitLanguageEntry(profile, code) {
  if (!code) return null;
  return explicitLanguageEntries(profile).find((item) => languageCodeOf(item.language) === code) || null;
}
