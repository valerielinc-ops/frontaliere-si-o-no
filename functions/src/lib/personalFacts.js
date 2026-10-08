/**
 * What a candidate's CV says of them in its own words, beyond the profile the
 * model reads: the civil status where it is written («Marié», «Stato civile:
 * coniugata», «Verheiratet, 2 Kinder») and the gender where the language
 * itself says it («Né le», «Mariée», «Nata a», «Sesso: F»).
 *
 * Owner question of 2026-10-08: an order whose CV said «Né le …» and «Marié»
 * was asked «Quelle civilité indiquer dans les formulaires de candidature ?»,
 * because the form of address was asked on every portal application as if no
 * CV ever said it. What the CV says is no longer asked: it is shown among the
 * form fields, where the candidate can correct it.
 *
 * Never a guess: not from a first name, not from a photo, not from a trade
 * («Vendeur») nor from the posting's wording («Vendeuse/Vendeur»).
 * Only a whole personal-data entry counts — a short line, or one of its parts
 * between commas or bars — so prose is never read; an inclusive form
 * («Marié(e)», «nato/a») gives the status and no gender; two entries that
 * disagree say nothing.
 *
 * Pure JavaScript: imported by the functions and by the runner scripts.
 */

const LETTER = String.raw`\p{L}\p{M}`;
/** `source` as whole words. JavaScript's \b knows ASCII letters only: «marié» has no boundary after its é. */
const words = (source, flags = 'iu') => new RegExp(String.raw`(?<![${LETTER}])(?:${source})(?![${LETTER}])`, flags);

// One civil status in the four languages, as a CV writes it or as a portal's list offers it («Married
// (Switzerland)», «Coniugato/a», «Partnership Dissolved (Switzerland)»).
const STATUS_WORDS = {
  partnership_dissolved: String.raw`partnership dissolved|dissolved (?:civil |registered )?partnership|aufgel[öo]ste partnerschaft|partenariat dissous|unione (?:domestica|civile)(?: registrata)? sciolta`,
  partnership: String.raw`registered partner(?:ship)?|civil (?:union|partnership)|(?:in )?eingetragener? partnerschaft|partenariat enregistr[ée]|pacs[ée]e?|unione (?:domestica|civile)(?: registrata)?`,
  single: String.raw`single|unmarried|ledig|unverheiratet|c[ée]libataire|celibe|nubile`,
  married: String.raw`married|verheiratet|mari[ée]e?|sposat[oa]|coniugat[oa]`,
  divorced: String.raw`divorced|geschieden|divorc[ée]e?|divorziat[oa]`,
  widowed: String.raw`widow(?:ed|er)?|verwitwet|veuf|veuve|vedov[oa]`,
  separated: String.raw`separated|getrennt(?: lebend)?|s[ée]par[ée]e?|separat[oa]`,
};
const STATUS_RE = Object.fromEntries(Object.entries(STATUS_WORDS).map(([code, source]) => [code, words(source)]));
// «Not married» is single, never married.
const NEGATED_RE = words(String.raw`(?:not|never) married|nicht verheiratet|non (?:sposat[oa]|coniugat[oa])|(?:non|pas) mari[ée]e?`, 'giu');

const tidy = (value, max = 200) => String(value ?? '').normalize('NFC').replace(/\s+/g, ' ').trim().slice(0, max);

/** The civil statuses a text names (an option may offer two: «Verheiratet / eingetragene Partnerschaft»). */
export function civilStatusCodes(label) {
  const text = tidy(label).toLowerCase().replace(NEGATED_RE, ' single ');
  const found = new Set(Object.entries(STATUS_RE).filter(([, re]) => re.test(text)).map(([code]) => code));
  // «Dissolved partnership» names no partnership in force.
  if (found.has('partnership_dissolved')) found.delete('partnership');
  return found;
}

/** The one civil status a text names, '' when it names none or several. */
export function civilStatusCode(label) {
  const codes = civilStatusCodes(label);
  return codes.size === 1 ? [...codes][0] : '';
}

const CIVIL_LABEL = String.raw`[ée]tat[ -]civil|[ée]tat matrimonial|situation (?:de famille|familiale|matrimoniale)|stato civile|zivilstand|familienstand|personenstand|marital status|civil status|family status`;
const CIVIL_FIELD_RE = words(CIVIL_LABEL);

/** A form field or a question that asks the civil status. */
export function isCivilStatusField(label) {
  return CIVIL_FIELD_RE.test(tidy(label, 400));
}

/**
 * The option of a list that says this civil status: the one option that names it (alone, or with another:
 * «Verheiratet / eingetragene Partnerschaft»). '' when none does, or when two do.
 * @param {Array<string>} options the list's labels
 */
export function civilStatusOption(options, status) {
  const code = civilStatusCode(status);
  if (!code) return '';
  const matching = (options || []).map((option) => String(option ?? '')).filter((option) => civilStatusCodes(option).has(code));
  return matching.length === 1 ? matching[0] : '';
}

const STATUS_LABELS = {
  it: { single: 'Celibe/Nubile', married: 'Coniugato/a', divorced: 'Divorziato/a', widowed: 'Vedovo/a', separated: 'Separato/a', partnership: 'Unione domestica registrata', partnership_dissolved: 'Unione domestica sciolta' },
  de: { single: 'Ledig', married: 'Verheiratet', divorced: 'Geschieden', widowed: 'Verwitwet', separated: 'Getrennt', partnership: 'Eingetragene Partnerschaft', partnership_dissolved: 'Aufgelöste Partnerschaft' },
  fr: { single: 'Célibataire', married: 'Marié(e)', divorced: 'Divorcé(e)', widowed: 'Veuf/Veuve', separated: 'Séparé(e)', partnership: 'Partenariat enregistré', partnership_dissolved: 'Partenariat dissous' },
  en: { single: 'Single', married: 'Married', divorced: 'Divorced', widowed: 'Widowed', separated: 'Separated', partnership: 'Registered partnership', partnership_dissolved: 'Dissolved partnership' },
};
const languageOf = (locale) => String(locale || '').slice(0, 2).toLowerCase();

/** The civil statuses a candidate may choose on the review page, in their language. */
export function civilStatusOptions(locale = 'it') {
  return Object.values(STATUS_LABELS[languageOf(locale)] || STATUS_LABELS.it);
}

// The form of address in the four languages: for a man, for a woman, for neither. The question that asks it
// (assistedApplicationAiDraftCore.js salutationQuestion) offers the same three.
export const SALUTATIONS = {
  it: ['Signor', 'Signora', 'Altro'],
  de: ['Herr', 'Frau', 'Andere'],
  fr: ['Monsieur', 'Madame', 'Autre'],
  en: ['Mr', 'Ms', 'Other'],
};

/** The forms of address a candidate may choose, in their language. */
export function salutationOptions(locale = 'it') {
  return SALUTATIONS[languageOf(locale)] || SALUTATIONS.it;
}

/** The form of address of a gender the CV states ('m' or 'f'), in the candidate's language; '' for none. */
export function salutationFor(gender, locale = 'it') {
  const options = salutationOptions(locale);
  return gender === 'm' ? options[0] : gender === 'f' ? options[1] : '';
}

// The names of the two fields on the review page, in the candidate's language: sent with the field, next to
// its list (the page shows the server's label for a field it has no name of its own for).
const FIELD_LABELS = {
  salutation: { it: 'Appellativo', de: 'Anrede', fr: 'Civilité', en: 'Form of address' },
  civilStatus: { it: 'Stato civile', de: 'Zivilstand', fr: 'État civil', en: 'Marital status' },
};

/** The review page's name of a personal field ('salutation', 'civilStatus'); '' for any other field. */
export function personalFieldLabel(key, locale = 'it') {
  const labels = Object.hasOwn(FIELD_LABELS, key) ? FIELD_LABELS[key] : null;
  return labels ? labels[languageOf(locale)] || labels.it : '';
}

/** One of the forms of address above, in any of the four languages. */
export function isSalutation(text) {
  const value = tidy(text, 40);
  return Boolean(value) && Object.values(SALUTATIONS).some((options) => options.includes(value));
}

// The grammatical gender of a civil status or of a birth, in French and Italian: «marié»/«mariée»,
// «celibe»/«nubile», «nato»/«nata». German and English say none.
const MASCULINE_RE = words(String.raw`mari[ée]|divorc[ée]|s[ée]par[ée]|pacs[ée]|veuf|sposato|coniugato|divorziato|separato|vedovo|celibe`);
const FEMININE_RE = words(String.raw`mari[ée]e|divorc[ée]e|s[ée]par[ée]e|pacs[ée]e|veuve|sposata|coniugata|divorziata|separata|vedova|nubile`);
// «Marié(e)», «Coniugato/a», «Celibe/Nubile», «Veuf/Veuve»: a form's own wording, left as it was.
const INCLUSIVE_RE = /\([ae]\)|\/\s*\p{L}/u;
// Without its accent a French status is also a first name or another word («Marie», «Divorce»): alone on a
// line it says nothing; after its label («Etat civil: Marie») it is the status.
const UNACCENTED_RE = words('mariee?|divorcee?|separee?|pacsee?');
const BORN_MASCULINE_RE = new RegExp(String.raw`^(?:né\s+(?:le|en|à|au)|nato\s+(?:il|a|ad|nel|in|l['’]))(?![${LETTER}])`, 'iu');
const BORN_FEMININE_RE = new RegExp(String.raw`^(?:née\s+(?:le|en|à|au)|nata\s+(?:il|a|ad|nel|in|l['’]))(?![${LETTER}])`, 'iu');

const ANY_STATUS = Object.values(STATUS_WORDS).join('|');
const CIVIL_LABELLED_RE = new RegExp(String.raw`^(?:${CIVIL_LABEL})\s*[:=–-]?\s*(.{1,60})$`, 'iu');
// The whole entry is a status, with what often follows it: «Marié», «Sposato con due figli», «Married with two children».
const CIVIL_ALONE_RE = new RegExp(String.raw`^((?:${ANY_STATUS})(?:\s*\([ae]\)|\s*\/\s*[${LETTER}]+)?)(?:\s+(?:con|senza|avec|et|sans|mit|und|ohne|with|and|without|e)\s+.{1,40})?$`, 'iu');
const SEX_LABELLED_RE = new RegExp(String.raw`^(?:sexe|sesso|geschlecht|gender|genre|sex)\s*[:=–-]?\s*([${LETTER}]{1,12})$`, 'iu');
const MALE_RE = /^(?:m|h|masculin|homme|maschio|maschile|uomo|m[äa]nnlich|mann|male|man)$/iu;
const FEMALE_RE = /^(?:f|w|f[ée]minin|femme|femmina|femminile|donna|weiblich|frau|female|woman)$/iu;

const MAX_LINE = 200;
/** The entries of a personal-data line: «Né le 3 avril 1990 à Lyon, marié, 2 enfants», «Sposato | Patente B». */
const entriesOf = (line) => line.split(/\s*[|•·;,]\s*|\s+[–—/-]\s+/u).map((part) => part.trim()).filter(Boolean);

/**
 * @param {string} cvText the CV's text, line by line as it was read
 * @returns {{gender:''|'m'|'f', civilStatus:string, civilStatusText:string}} the gender the CV's own
 *   grammar states, the code of the civil status it states and the CV's own words for it; '' for whatever
 *   it does not say, or says in two ways
 */
export function cvPersonalFacts(cvText) {
  const genders = new Set();
  const statuses = new Map();
  for (const raw of String(cvText ?? '').normalize('NFC').split(/\r?\n/)) {
    const line = raw.replace(/^[\s•·▪●○■□*–—-]+/u, '').trim();
    if (!line || line.length > MAX_LINE) continue;
    for (const entry of entriesOf(line)) {
      const labelled = CIVIL_LABELLED_RE.exec(entry);
      const alone = labelled ? null : CIVIL_ALONE_RE.exec(entry);
      const said = labelled ? labelled[1] : alone && !UNACCENTED_RE.test(alone[1]) ? alone[1] : '';
      const code = said ? civilStatusCode(said) : '';
      if (code) {
        if (!statuses.has(code)) statuses.set(code, tidy(said, 60));
        if (!INCLUSIVE_RE.test(said)) {
          if (FEMININE_RE.test(said)) genders.add('f');
          else if (MASCULINE_RE.test(said)) genders.add('m');
        }
        continue;
      }
      // «NATO» in capitals is the alliance, unless the whole line is written in capitals.
      const alliance = /^NATO(?![\p{L}])/u.test(entry) && line !== line.toUpperCase();
      if (BORN_FEMININE_RE.test(entry)) genders.add('f');
      else if (!alliance && BORN_MASCULINE_RE.test(entry)) genders.add('m');
      const sex = SEX_LABELLED_RE.exec(entry);
      if (sex && MALE_RE.test(sex[1])) genders.add('m');
      else if (sex && FEMALE_RE.test(sex[1])) genders.add('f');
    }
  }
  const [civilStatus = '', civilStatusText = ''] = statuses.size === 1 ? [...statuses.entries()][0] : [];
  return { gender: genders.size === 1 ? [...genders][0] : '', civilStatus, civilStatusText };
}
