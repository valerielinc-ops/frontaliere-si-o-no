/**
 * The candidate's Swiss status and nationality in the assisted application
 * (owner decisions of 2026-10-03 and 2026-10-04, on the SEM, cantonal and
 * SDBB/CSFO sources of the close-out study): only facts the candidate states,
 * never a promise. No permit «to be requested», pending, due, guaranteed or
 * not needed is ever printed or written: a permit follows a contract, the
 * canton decides, and up to three months no permit is involved at all.
 *
 * One module for the Cloud Functions, the runner and (if ever needed) the
 * browser: the status codes and their labels per candidate language, the CV
 * wording per CV language, the planner's sentence, the nationality table, the
 * lookups that read stored values (legacy ones included), the permit and
 * citizenship mentions the fact gate reads, and the form-field wordings the
 * portal guard and the question backstop share.
 *
 * Catalogue rule: a label once offered is never removed from the lookups; a
 * reworded label keeps its old text as an alias (answers store the label).
 *
 * Pure JavaScript, no import.
 */

// Select order of the six statuses.
export const PERMIT_STATUSES = ['swiss', 'permit_c', 'permit_b', 'permit_l', 'permit_g', 'none'];
export const HELD_PERMITS = new Set(['permit_c', 'permit_b', 'permit_l', 'permit_g']);

// The options the candidate chooses from, stored as chosen (the visible label). A held permit is one
// valid today; G names the job it depends on (whether a card is still valid after the job ended differs
// by canton). Nothing about what a permit allows.
const LABELS = {
  it: {
    swiss: 'Ho la cittadinanza svizzera',
    permit_c: 'Ho un permesso C (domicilio) valido oggi',
    permit_b: 'Ho un permesso B (dimora) valido oggi',
    permit_l: 'Ho un permesso L (dimoranti temporanei) valido oggi',
    permit_g: 'Lavoro oggi in Svizzera con un permesso G (frontalieri) valido',
    none: 'Oggi non ho un permesso svizzero',
  },
  de: {
    swiss: 'Ich habe das Schweizer Bürgerrecht',
    permit_c: 'Ich habe eine heute gültige Niederlassungsbewilligung C',
    permit_b: 'Ich habe eine heute gültige Aufenthaltsbewilligung B',
    permit_l: 'Ich habe eine heute gültige Kurzaufenthaltsbewilligung L',
    permit_g: 'Ich arbeite heute in der Schweiz mit gültiger Grenzgängerbewilligung G',
    none: 'Ich habe heute keine Schweizer Bewilligung',
  },
  fr: {
    swiss: 'J’ai la nationalité suisse',
    permit_c: 'J’ai une autorisation d’établissement (permis C) valable aujourd’hui',
    permit_b: 'J’ai une autorisation de séjour (permis B) valable aujourd’hui',
    permit_l: 'J’ai une autorisation de courte durée (permis L) valable aujourd’hui',
    permit_g: 'Je travaille aujourd’hui en Suisse avec un permis G (frontalier) valable',
    none: 'Je n’ai aujourd’hui aucun permis suisse',
  },
  en: {
    swiss: 'I am a Swiss citizen',
    permit_c: 'I hold a settlement permit C, valid today',
    permit_b: 'I hold a residence permit B, valid today',
    permit_l: 'I hold a short-stay permit L, valid today',
    permit_g: 'I work in Switzerland today with a valid cross-border permit G',
    none: 'I hold no Swiss permit today',
  },
};

// The permit as the CV prints it: the official name (SEM), never a bare letter (B and C are also
// driving-licence categories).
const CV_WORDING = {
  de: { permit_c: 'Niederlassungsbewilligung C', permit_b: 'Aufenthaltsbewilligung B', permit_l: 'Kurzaufenthaltsbewilligung L', permit_g: 'Grenzgängerbewilligung G' },
  fr: { permit_c: "autorisation d'établissement (permis C)", permit_b: 'autorisation de séjour (permis B)', permit_l: 'autorisation de courte durée (permis L)', permit_g: 'autorisation frontalière (permis G)' },
  it: { permit_c: 'permesso di domicilio (C)', permit_b: 'permesso di dimora (B)', permit_l: 'permesso per dimoranti temporanei (L)', permit_g: 'permesso per frontalieri (G)' },
  en: { permit_c: 'settlement permit C', permit_b: 'residence permit B', permit_l: 'short-stay permit L', permit_g: 'cross-border commuter permit G' },
};

/** "de-CH" reads "de"; an unknown language reads Italian. */
const languageOf = (locale) => {
  const code = String(locale || '').slice(0, 2).toLowerCase();
  return LABELS[code] ? code : 'it';
};

/** Lowercase, no accents, Swiss «ss», every other sign a single space. */
const fold = (text) => String(text ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, ' ').trim();

/** The six options in the candidate's language, in select order. */
export function permitOptions(locale) {
  const labels = LABELS[languageOf(locale)];
  return PERMIT_STATUSES.map((code) => labels[code]);
}

// A wording that speaks of a permit to come, or of needing none: never a status, never printed, always
// flagged in a generated text. Read only on a stored value or on the clause of a permit mention, so a
// general «not needed» elsewhere in a letter is never read.
export const EXPECTATION_RE = new RegExp([
  // it
  String.raw`da richiedere`, String.raw`richieder[oò]`, String.raw`ho richiesto`, String.raw`(?:è|e) stato richiesto`, String.raw`in attesa d`,
  String.raw`in corso di rilascio`, String.raw`in rinnovo`, String.raw`da rinnovare`, String.raw`scadut`, String.raw`(?:verr|sar)(?:à|a) (?:rilasciat|concess)`,
  String.raw`diritto al`, String.raw`ho diritto`, String.raw`idone[oaie]`, String.raw`garantit`, String.raw`non (?:mi )?serv`, String.raw`non (?:ho|avr[oò]) bisogno`,
  String.raw`non (?:è|e) necessari`,
  // de
  String.raw`beantrag`, String.raw`in bearbeitung`, String.raw`h(?:ä|ae)ngig`, String.raw`ausstehend`, String.raw`anspruch auf`, String.raw`anspruchsberechtigt`,
  String.raw`garantiert`, String.raw`abgelaufen`, String.raw`(?:wird|werde) (?:\S+ )?(?:erteilt|ausgestellt|verl(?:ä|ae)ngert)`,
  String.raw`(?:nicht|keine?n?) (?:\S+ )?(?:n(?:ö|oe)tig|notwendig|erforderlich)`, String.raw`(?:ben(?:ö|oe)tige|brauche) keine`,
  // fr
  String.raw`(?:à|a) demander`, String.raw`j['’]ai demand`, String.raw`en cours d['’](?:obtention|octroi)`, String.raw`en attente d`, String.raw`en renouvellement`,
  String.raw`expir`, String.raw`sera (?:délivr|accord|octroy)`, String.raw`(?:é|e)ligible`, String.raw`droit (?:au|à un|a un) permis`, String.raw`j['’]ai droit`,
  String.raw`garanti`, String.raw`pas n(?:é|e)cessaire`, String.raw`pas besoin`,
  // en
  String.raw`to be requested`, String.raw`will (?:apply|request|be (?:granted|issued))`, String.raw`applied for`, String.raw`pending`, String.raw`being processed`,
  String.raw`under renewal`, String.raw`expired`, String.raw`entitled`, String.raw`eligib`, String.raw`guaranteed`, String.raw`not (?:needed|necessary|required)`,
  String.raw`no need`, String.raw`need no`, String.raw`(?:do not|don['’]t) need`,
].join('|'), 'iu');

// ── Stored values (answers, overrides, the owner's text) → status ────────

const ALIASES = new Map();
const alias = (code, ...texts) => { for (const text of texts) ALIASES.set(fold(text), code); };
for (const code of PERMIT_STATUSES) alias(code, code);
for (const labels of Object.values(LABELS)) for (const code of PERMIT_STATUSES) alias(code, labels[code]);
for (const wordings of Object.values(CV_WORDING)) for (const [code, text] of Object.entries(wordings)) alias(code, text);
const LETTER_CODES = { b: 'permit_b', c: 'permit_c', g: 'permit_g', l: 'permit_l' };
for (const [letter, code] of Object.entries(LETTER_CODES)) {
  alias(code, letter);
  for (const word of ['permit', 'permesso', 'permis', 'ausweis', 'bewilligung', 'livret', 'libretto']) alias(code, `${word} ${letter}`, `${letter} ${word}`);
}
// The official names without the letter (SEM).
alias('permit_c', 'Niederlassungsbewilligung', 'permesso di domicilio', "autorisation d'établissement", 'settlement permit', 'settled foreign nationals');
alias('permit_b', 'Aufenthaltsbewilligung', 'permesso di dimora', 'autorisation de séjour', 'residence permit', 'resident foreign nationals');
alias('permit_l', 'Kurzaufenthaltsbewilligung', 'permesso per dimoranti temporanei', 'autorisation de courte durée', 'short-stay permit', 'short-term permit', 'short-term residents');
alias('permit_g', 'Grenzgängerbewilligung', 'permesso per frontalieri', 'autorisation frontalière', 'cross-border commuter permit', 'cross-border permit', 'cross-border commuters');
alias('swiss', 'CH', 'Cittadinanza svizzera', 'cittadino svizzero', 'cittadina svizzera', 'Schweizer Bürgerrecht', 'Schweizer Bürger', 'Schweizer Bürgerin',
  'Schweizer/in', 'Schweizerin', 'Swiss citizen', 'Swiss citizenship', 'nationalité suisse', 'citoyen suisse', 'citoyenne suisse');
alias('none', 'none', 'Non ancora', 'nessuno', 'nessuna', 'nessun permesso', 'noch nicht', 'noch keine', 'keine', 'keine Bewilligung', 'pas encore', 'aucun',
  'aucun permis', 'not yet', 'no permit');
const LABEL_FOLDS = new Set(Object.values(LABELS).flatMap((labels) => Object.values(labels)).map(fold));

/**
 * The status a stored answer or field value names, or '' (decision 10):
 * conservative. The exact codes, labels, CV wordings and legacy values
 * («G», «CH», «none», «Permesso G», «Non ancora»); never a value that speaks
 * of a permit to come («Permesso G (da richiedere)», «Bewilligung beantragt»);
 * a value with parts («G - Grenzgänger», «Frontaliere (permesso G)») only
 * when exactly one status is among them.
 */
export function permitStatusOf(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const exact = ALIASES.get(fold(text));
  if (exact) return exact;
  if (EXPECTATION_RE.test(text)) return '';
  const bare = ALIASES.get(fold(text.replace(/\([^)]*\)/g, ' ')));
  if (bare) return bare;
  const codes = new Set(text.split(/[/|;,()–—]|\s-\s/).map((part) => ALIASES.get(fold(part))).filter(Boolean));
  return codes.size === 1 ? [...codes][0] : '';
}

/** A stored value as the candidate's language shows it: its status's label, else the value as written. */
export function permitLabel(value, locale) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const code = permitStatusOf(text);
  return code ? LABELS[languageOf(locale)][code] : text;
}

/** The status as one full sentence in the form's language, for the portal planner. '' when none is chosen. */
export function permitStatement(status, language) {
  return PERMIT_STATUSES.includes(status) ? `${LABELS[languageOf(language)][status]}.` : '';
}

// ── Nationality (decision 4) ─────────────────────────────────────────────

/** The day the table was checked: a new EU member joins the free movement agreement only by protocol. */
export const NATIONALITIES_AS_OF = '2026-10-04';

// EU-27 and EFTA as ch.ch lists them (Croatia included); the United Kingdom is not in it. Print forms
// checked on 2026-10-04 against the federal list of state names of the EDA (Direktion für Völkerrecht,
// 21.08.2026: «Liste der Staatenbezeichnungen», «Liste des dénominations d'États», «Lista delle
// denominazioni degli Stati»): German prints the list's short form, French and Italian the list's
// adjective in the feminine, agreeing with «nationalité» and «nazionalità» (the list gives «hellénique»,
// «ellenico» for Greece and «neerlandese» for the Netherlands; no Italian adjective for Liechtenstein, so
// its short form). English has no federal list: the usual English adjective.
// [key, group, [de, fr, it, en], the other forms read (nouns and adjectives of the four languages)]
const NATIONALITY_TABLE = [
  ['AT', 'eu', ['Österreich', 'autrichienne', 'austriaca', 'Austrian'], 'Autriche|Austria|österreichisch|Österreicher|Österreicherin|autrichien|austriaco'],
  ['BE', 'eu', ['Belgien', 'belge', 'belga', 'Belgian'], 'Belgique|Belgio|Belgium|belgisch|Belgier|Belgierin'],
  ['BG', 'eu', ['Bulgarien', 'bulgare', 'bulgara', 'Bulgarian'], 'Bulgarie|Bulgaria|bulgarisch|Bulgare|Bulgarin|bulgaro'],
  ['CY', 'eu', ['Zypern', 'chypriote', 'cipriota', 'Cypriot'], 'Chypre|Cipro|Cyprus|zyprisch|Zypriot|Zypriotin|Zyprer|Zyprerin'],
  ['CZ', 'eu', ['Tschechien', 'tchèque', 'ceca', 'Czech'], 'Tchéquie|République tchèque|Cechia|Repubblica Ceca|Czechia|Czech Republic|tschechisch|Tscheche|Tschechin|ceco'],
  ['DE', 'eu', ['Deutschland', 'allemande', 'tedesca', 'German'], 'Allemagne|Germania|Germany|deutsch|Deutsche|Deutscher|allemand|tedesco'],
  ['DK', 'eu', ['Dänemark', 'danoise', 'danese', 'Danish'], 'Danemark|Danimarca|Denmark|dänisch|Däne|Dänin|danois'],
  ['EE', 'eu', ['Estland', 'estonienne', 'estone', 'Estonian'], 'Estonie|Estonia|estnisch|Este|Estin|estonien'],
  ['ES', 'eu', ['Spanien', 'espagnole', 'spagnola', 'Spanish'], 'Espagne|Spagna|Spain|spanisch|Spanier|Spanierin|espagnol|spagnolo'],
  ['FI', 'eu', ['Finnland', 'finlandaise', 'finlandese', 'Finnish'], 'Finlande|Finlandia|Finland|finnisch|Finne|Finnin|finlandais'],
  ['FR', 'eu', ['Frankreich', 'française', 'francese', 'French'], 'France|Francia|französisch|Franzose|Französin|français'],
  ['GR', 'eu', ['Griechenland', 'hellénique', 'ellenica', 'Greek'], 'Grèce|Grecia|Greece|griechisch|hellenisch|Grieche|Griechin|grec|grecque|greco|greca|ellenico|Hellenic'],
  ['HR', 'eu', ['Kroatien', 'croate', 'croata', 'Croatian'], 'Croatie|Croazia|Croatia|kroatisch|Kroate|Kroatin|croato'],
  ['HU', 'eu', ['Ungarn', 'hongroise', 'ungherese', 'Hungarian'], 'Hongrie|Ungheria|Hungary|ungarisch|Ungar|Ungarin|hongrois'],
  ['IE', 'eu', ['Irland', 'irlandaise', 'irlandese', 'Irish'], 'Irlande|Irlanda|Ireland|irisch|Ire|Irin|irlandais'],
  ['IT', 'eu', ['Italien', 'italienne', 'italiana', 'Italian'], 'Italie|Italia|Italy|italienisch|Italiener|Italienerin|italien|italiano'],
  ['LT', 'eu', ['Litauen', 'lituanienne', 'lituana', 'Lithuanian'], 'Lituanie|Lituania|Lithuania|litauisch|Litauer|Litauerin|lituanien|lituano'],
  ['LU', 'eu', ['Luxemburg', 'luxembourgeoise', 'lussemburghese', 'Luxembourgish'], 'Luxembourg|Lussemburgo|luxemburgisch|Luxemburger|Luxemburgerin|luxembourgeois|Luxembourger'],
  ['LV', 'eu', ['Lettland', 'lettone', 'lettone', 'Latvian'], 'Lettonie|Lettonia|Latvia|lettisch|Lette|Lettin|letton'],
  ['MT', 'eu', ['Malta', 'maltaise', 'maltese', 'Maltese'], 'Malte|maltesisch|Malteser|Malteserin|maltais'],
  ['NL', 'eu', ['Niederlande', 'néerlandaise', 'neerlandese', 'Dutch'], 'Pays-Bas|Paesi Bassi|Olanda|Netherlands|The Netherlands|Holland|niederländisch|holländisch|Niederländer|Niederländerin|Holländer|Holländerin|néerlandais|hollandais|hollandaise|olandese'],
  ['PL', 'eu', ['Polen', 'polonaise', 'polacca', 'Polish'], 'Pologne|Polonia|Poland|polnisch|Pole|Polin|polonais|polacco'],
  ['PT', 'eu', ['Portugal', 'portugaise', 'portoghese', 'Portuguese'], 'Portogallo|portugiesisch|Portugiese|Portugiesin|portugais'],
  ['RO', 'eu', ['Rumänien', 'roumaine', 'romena', 'Romanian'], 'Roumanie|Romania|rumänisch|Rumäne|Rumänin|roumain|romeno|rumeno|rumena'],
  ['SE', 'eu', ['Schweden', 'suédoise', 'svedese', 'Swedish'], 'Suède|Svezia|Sweden|schwedisch|Schwede|Schwedin|suédois'],
  ['SI', 'eu', ['Slowenien', 'slovène', 'slovena', 'Slovenian'], 'Slovénie|Slovenia|slowenisch|Slowene|Slowenin|sloveno|Slovene'],
  ['SK', 'eu', ['Slowakei', 'slovaque', 'slovacca', 'Slovak'], 'Slovaquie|Slovacchia|Slovakia|slowakisch|Slowake|Slowakin|slovacco|Slovakian'],
  ['IS', 'efta', ['Island', 'islandaise', 'islandese', 'Icelandic'], 'Islande|Islanda|Iceland|isländisch|Isländer|Isländerin|islandais'],
  ['LI', 'efta', ['Liechtenstein', 'liechtensteinoise', 'Liechtenstein', 'Liechtenstein'], 'liechtensteinisch|Liechtensteiner|Liechtensteinerin|liechtensteinois|liechtensteinese'],
  ['NO', 'efta', ['Norwegen', 'norvégienne', 'norvegese', 'Norwegian'], 'Norvège|Norvegia|Norway|norwegisch|Norweger|Norwegerin|norvégien'],
  ['CH', 'ch', ['Schweiz', 'suisse', 'svizzera', 'Swiss'], 'Svizzera|Switzerland|schweizerisch|Schweizer|Schweizerin|Schweizer/in|svizzero'],
];
const FORM_LANGUAGES = ['de', 'fr', 'it', 'en'];
const NATIONALITY_TAGS = { eu: { de: 'EU', en: 'EU', fr: 'UE', it: 'UE' }, efta: { de: 'EFTA', en: 'EFTA', fr: 'AELE', it: 'AELS' } };
// Swiss first, then the other nationality (decision of 2026-10-04 on dual nationals).
const AND = { de: 'und', fr: 'et', it: 'e', en: 'and' };
const foldName = (text) => fold(text).replace(/\d+/g, ' ').replace(/\s+/g, ' ').trim();

const NATIONALITIES = new Map();
const NATIONALITY_BY_FORM = new Map();
for (const [code, group, forms, others] of NATIONALITY_TABLE) {
  NATIONALITIES.set(code, { code, group, forms: Object.fromEntries(FORM_LANGUAGES.map((language, index) => [language, forms[index]])) });
  for (const form of [...forms, ...others.split('|')]) {
    const key = foldName(form);
    NATIONALITY_BY_FORM.set(key, code);
    // The German adjective as a sentence inflects it: «italienische Staatsangehörigkeit».
    if (key.endsWith('isch')) for (const ending of ['e', 'er', 'en']) NATIONALITY_BY_FORM.set(`${key}${ending}`, code);
  }
}
const NATIONALITY_TAG_RE = /\s*\(\s*(?:eu|ue|efta|aele|aels)\s*\)\s*$/i;
const NATIONALITY_AFFIX = /^(?:cittadinanza|nazionalita|nationalite|nationalitat|staatsangehorigkeit|staatsburgerschaft|citizenship|nationality|cittadin[oa]|citoyenne?)\s+|\s+(?:citizen|national|staatsburger(?:in)?|staatsangehorigkeit|staatsburgerschaft|nationalitat)$/;
// Two nationalities written together: «italiana e svizzera», «Schweiz / Kroatien», «Italian and Swiss».
const NATIONALITY_PARTS = /\s*(?:[/,;&+]|\s(?:e|ed|und|et|and)\s|\s[-–—]\s)\s*/i;

/**
 * One nationality of the table, as the candidate wrote it in any of the four
 * languages («italiana», «Italien», «Italian citizen», «cittadinanza
 * italiana», «Italiana (UE)»): its key and group, or null for anything else
 * (two nationalities, a third country, an unknown form).
 * @returns {{code:string, group:'eu'|'efta'|'ch'}|null}
 */
export function nationalityOf(text) {
  let key = foldName(String(text ?? '').replace(NATIONALITY_TAG_RE, ''));
  for (let round = 0; round < 2; round += 1) key = key.replace(NATIONALITY_AFFIX, '').trim();
  const code = NATIONALITY_BY_FORM.get(key);
  return code ? { code, group: NATIONALITIES.get(code).group } : null;
}

/** Every nationality of the table a text names: the whole, else each of its parts («italiana e albanese» → IT). */
export function nationalityCodes(text) {
  const whole = nationalityOf(text);
  if (whole) return new Set([whole.code]);
  return new Set(String(text ?? '').split(NATIONALITY_PARTS).map((part) => nationalityOf(part)?.code).filter(Boolean));
}

/** Whether a nationality the candidate gave is one of the EU or EFTA (the free movement agreement). */
export function euEftaNational(nationality) {
  return [...nationalityCodes(nationality)].some((code) => NATIONALITIES.get(code).group !== 'ch');
}

const formOf = (code, language) => {
  const entry = NATIONALITIES.get(code);
  const tag = NATIONALITY_TAGS[entry.group]?.[language];
  return tag ? `${entry.forms[language]} (${tag})` : entry.forms[language];
};

/**
 * The nationality line of the CV (decision 4): the nationalities of the table
 * in the CV's language, each with its EU/EFTA tag, derived in code — one, or
 * several written together («Italian and Swiss», «Schweiz / Kroatien») — with
 * Swiss first (decision of 2026-10-04 on dual nationals), and Swiss added for
 * the status `swiss`. A text with any part outside the table is printed as the
 * candidate wrote it, no tag, with Swiss in front for the status `swiss` when
 * the text does not name it.
 */
export function nationalityCvValue(nationality, { status = '', language = 'it' } = {}) {
  const lang = languageOf(language);
  const text = String(nationality ?? '').replace(/\s+/g, ' ').trim();
  const whole = nationalityOf(text);
  const codes = whole ? [whole.code] : (text ? text.split(NATIONALITY_PARTS).map((part) => nationalityOf(part)?.code ?? null) : []);
  if (status === 'swiss' || (codes.length > 0 && codes.every(Boolean))) {
    if (codes.every(Boolean)) {
      const known = [...new Set(codes)];
      if (status === 'swiss' && !known.includes('CH')) known.push('CH');
      const ordered = [...known.filter((code) => code === 'CH'), ...known.filter((code) => code !== 'CH')].map((code) => formOf(code, lang));
      return ordered.length > 2 ? `${ordered.slice(0, -1).join(', ')} ${AND[lang]} ${ordered[ordered.length - 1]}` : ordered.join(` ${AND[lang]} `);
    }
    return nationalityCodes(text).has('CH') ? text : `${formOf('CH', lang)} ${AND[lang]} ${text}`;
  }
  return text;
}

// ── What the CV prints (decisions 2, 3) ──────────────────────────────────

/**
 * The permit line of the CV: a held permit by its official name in the CV's
 * language; '' for `swiss`, `none` and nothing chosen (never a negative
 * statement), and for a permit G without an EU/EFTA nationality: a
 * third-country G is tied to one employer and one border zone, so printing it
 * for another employer could mislead.
 */
export function permitCvValue(status, { nationality = '', language = 'it' } = {}) {
  if (!HELD_PERMITS.has(status)) return '';
  if (status === 'permit_g' && !euEftaNational(nationality)) return '';
  return CV_WORDING[languageOf(language)][status];
}

/** The permit G left out of the CV (the review page says why). */
export function permitOmitted(status, nationality) {
  return status === 'permit_g' && !euEftaNational(nationality);
}

/**
 * The CV's own words on the permit, printed when no status is chosen: never
 * a permit to come, never «no permit», never an option label as free text.
 */
export function printedPermitText(text) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!value || EXPECTATION_RE.test(value) || permitStatusOf(value) === 'none' || LABEL_FOLDS.has(fold(value))) return '';
  return value;
}

// ── Portal options → status (decision 9) ─────────────────────────────────

// Words every option may carry; for every status but `swiss` the Swiss words too.
const GENERIC_OPTION_WORDS = new Set(('ausweis bewilligung arbeitsbewilligung permis permesso permit autorisation autorizzazione livret libretto carta typ type tipo '
  + 'eu efta ue aele aels de di du d per of the a in valid valida valido valable gultig gultige gultiger foreign national nationals status statut stato work '
  + 'kategorie category categorie categoria').split(' '));
const SWISS_WORDS = new Set(['schweizer', 'schweizerin', 'schweizerische', 'swiss', 'svizzero', 'svizzera', 'suisse', 'ch', 'schweiz']);
// The nouns of a permit, and the «no» that with one of them says «no permit».
const PERMIT_NOUNS = new Set(['ausweis', 'bewilligung', 'arbeitsbewilligung', 'permis', 'permesso', 'permit', 'autorisation', 'autorizzazione', 'livret', 'libretto']);
const NO_WORDS = new Set(['no', 'non']);
// [allowed, identifying]: an option's other words all allowed, one of them identifying.
const OPTION_WORDS = {
  permit_g: ['cross border', 'g grenzganger grenzgangerin grenzgangerbewilligung frontalier frontaliere frontaliera frontalieri frontaliers frontalieres commuter commuters crossborder'],
  permit_b: ['aufenthalt residence resident residents', 'b aufenthaltsbewilligung aufenthalter aufenthalterin sejour dimora'],
  permit_c: ['', 'c niederlassungsbewilligung niederlassung niedergelassene niedergelassener etablissement domicilio settlement settled'],
  permit_l: ['courte duree short stay term resident residents', 'l kurzaufenthaltsbewilligung kurzaufenthalt kurzaufenthalter kurzaufenthalterin dimoranti temporanei'],
  swiss: [
    'citizen citizenship burger burgerin staatsangehorig staatsangehorige staatsangehoriger staatsangehorigkeit cittadino cittadina citoyen citoyenne nationalite nazionalita nationalitat nationality',
    `${[...SWISS_WORDS].join(' ')} cittadinanza staatsburgerschaft burgerrecht`,
  ],
  none: ['', 'keine kein keinen none nessuno nessun nessuna aucun aucune'],
};
const OPTION_SETS = Object.fromEntries(Object.entries(OPTION_WORDS).map(([code, [allowed, identifying]]) => {
  const ident = new Set(identifying.split(' ').filter(Boolean));
  return [code, { allowed: new Set([...ident, ...allowed.split(' ').filter(Boolean)]), ident }];
}));

/**
 * The status a portal's option says exactly («G (Grenzgänger)», «Ausweis G
 * EU/EFTA», «C – Settled foreign nationals», «Keine»), or '' when it says
 * more or less («B oder C», «Keine (Bewilligung wird beantragt)», «Permis de
 * conduire B») or depends on the question («Ja», «Nein»).
 */
export function permitOptionCode(label) {
  const words = fold(String(label ?? '').replace(/\*+/g, ' ')).split(' ').filter(Boolean);
  // «No permit», «No work permit»: «no» names the status only beside a permit noun; alone it answers a question.
  const noPermit = words.some((word) => PERMIT_NOUNS.has(word));
  const hits = PERMIT_STATUSES.filter((code) => {
    const rest = words.filter((word) => !GENERIC_OPTION_WORDS.has(word) && (code === 'swiss' || !SWISS_WORDS.has(word)));
    const { allowed, ident } = OPTION_SETS[code];
    const identifies = (word) => ident.has(word) || (code === 'none' && noPermit && NO_WORDS.has(word));
    return rest.length > 0 && rest.every((word) => allowed.has(word) || identifies(word)) && rest.some(identifies);
  });
  return hits.length === 1 ? hits[0] : '';
}

// ── Mentions in a text (the fact gate, decision 8 and the decision of 2026-10-04 on citizenship) ──

const NAMED_PERMITS = [
  // L first: «Kurzaufenthaltsbewilligung» holds «Aufenthaltsbewilligung».
  ['permit_l', /kurzaufenthaltsbewilligung|permesso per dimoranti temporanei|autorisation de courte dur[ée]e|short[- ](?:stay|term) permit/giu],
  ['permit_c', /niederlassungsbewilligung|permesso di domicilio|autorisation d['’][ée]tablissement|settlement permit/giu],
  ['permit_b', /aufenthaltsbewilligung|permesso di dimora|autorisation de s[ée]jour|residence permit/giu],
  ['permit_g', /grenzg(?:ä|ae|a)ngerbewilligung|permesso per frontalieri|autorisation frontali[èe]re|cross[- ]border (?:commuter )?permit/giu],
];
const LETTER_PERMIT = /(?<![\p{L}\p{N}])(?:(?:permesso|permessi|permis|permit|ausweis|bewilligung|arbeitsbewilligung|livret|libretto)\s+\(?([BCGL])\)?|([BCGL])[- ](?:permit|ausweis|bewilligung))(?![\p{L}\p{N}])/giu;
const GENERIC_PERMIT = /(?<![\p{L}\p{N}])(?:arbeitsbewilligung|arbeitserlaubnis|aufenthaltserlaubnis|permesso di (?:lavoro|soggiorno)|permis de (?:travail|s[ée]jour)|titre de s[ée]jour|autorisation de travail|work permit|work authori[sz]ation|right to work|authori[sz]ed to work|schweizer bewilligung|permesso svizzero|permis suisse|swiss permit)(?![\p{L}\p{N}])/giu;
// B and C are also driving-licence categories: a letter in a sentence about driving names a licence.
const DRIVING = /conduire|conduite|driving|driver|licen[cs]e|patente|guida|f[üu]hrer|fahr|v[ée]hicul|voiture|auto\b/i;
// «I am Swiss.», «Sono svizzera e italiana»: the state said alone, never «Schweizer Meister».
const SAID_ALONE = String.raw`(?=\s*(?:[.,;:!?)]|$)|\s+(?:e|ed|und|et|and)\s)`;
const CITIZENSHIP = new RegExp(String.raw`(?<![\p{L}\p{N}])(?:${[
  // it
  String.raw`cittadinanza\s*:?\s*svizzera`, String.raw`cittadin[oaie]\s+svizzer[oaie]`, String.raw`nazionalit(?:à|a)\s*:?\s*svizzer[oa]`, String.raw`passaporto\s+svizzero`,
  String.raw`sono\s+svizzer[oa]${SAID_ALONE}`,
  // de
  String.raw`schweizer(?:ische[nrs]?)?\s+(?:b(?:ü|ue)rgerrecht|staatsb(?:ü|ue)rger(?:in|schaft)?|staatsangeh(?:ö|oe)rigkeit|nationalit(?:ä|ae)t|b(?:ü|ue)rger(?:in)?|pass)`,
  String.raw`(?:nationalit(?:ä|ae)t|staatsangeh(?:ö|oe)rigkeit|staatsb(?:ü|ue)rgerschaft)\s*:?\s*schweiz(?:erisch)?`, String.raw`ich\s+bin\s+schweizer(?:in)?${SAID_ALONE}`,
  // fr
  String.raw`nationalit(?:é|e)\s*:?\s*suisse`, String.raw`citoyen(?:ne)?s?\s+suisses?`, String.raw`citoyennet(?:é|e)\s+suisse`, String.raw`passeport\s+suisse`,
  String.raw`je\s+suis\s+suisse${SAID_ALONE}`,
  // en
  String.raw`swiss\s+(?:citizen(?:ship)?|national(?:ity)?|passport)`, String.raw`(?:nationality|citizenship)\s*:?\s*swiss`, String.raw`i(?:\s+am|['’]m)\s+swiss${SAID_ALONE}`,
].join('|')})(?![\p{L}])`, 'giu');

function sentenceAround(text, index) {
  let start = 0;
  let end = text.length;
  for (const match of text.matchAll(/[.!?\n]/g)) {
    if (match.index < index) start = match.index + 1;
    else { end = match.index; break; }
  }
  return text.slice(start, end);
}

/**
 * Every Swiss permit a text names: the official names, a letter after a
 * permit word («permesso G», «Ausweis B», «G-Bewilligung») unless the
 * sentence is about driving, and a work permit in general (`generic`). Bare
 * «permesso», «permis», «permit» (permission, licence, the verb) and
 * «frontaliere» alone are no mention.
 * @returns {Array<{code:string, token:string, index:number, length:number}>} code: a held permit or 'generic'
 */
export function permitMentions(text) {
  const source = String(text ?? '');
  const out = [];
  const overlaps = (index, length) => out.some((hit) => index < hit.index + hit.length && index + length > hit.index);
  for (const [code, pattern] of NAMED_PERMITS) {
    for (const match of source.matchAll(pattern)) if (!overlaps(match.index, match[0].length)) out.push({ code, token: match[0], index: match.index, length: match[0].length });
  }
  for (const match of source.matchAll(LETTER_PERMIT)) {
    const letter = match[1] || match[2];
    // The letter as written: «permis b» is no permit category.
    if (letter !== letter.toUpperCase() || overlaps(match.index, match[0].length) || DRIVING.test(sentenceAround(source, match.index))) continue;
    out.push({ code: LETTER_CODES[letter.toLowerCase()], token: match[0], index: match.index, length: match[0].length });
  }
  for (const match of source.matchAll(GENERIC_PERMIT)) {
    if (!overlaps(match.index, match[0].length)) out.push({ code: 'generic', token: match[0], index: match.index, length: match[0].length });
  }
  return out.sort((left, right) => left.index - right.index);
}

/**
 * Every Swiss citizenship a text claims («cittadinanza svizzera», «Schweizer
 * Bürgerrecht», «nationalité suisse», «Swiss citizen», «Nationalität:
 * Schweiz», «I am Swiss.»), never the adjective of a place or a firm
 * («mercato svizzero», «Swiss company»).
 * @returns {Array<{code:'swiss', token:string, index:number, length:number}>}
 */
export function citizenshipMentions(text) {
  return [...String(text ?? '').matchAll(CITIZENSHIP)].map((match) => ({ code: 'swiss', token: match[0], index: match.index, length: match[0].length }));
}

// ── Form-field wordings (one source: the portal guard, the agent and the question backstop) ──

export const WORK_AUTHORISATION_RE = new RegExp(String.raw`arbeitserlaubnis|aufenthaltserlaubnis|aufenthaltsstatus|aufenthaltstitel|ausl(?:ä|ae)nderausweis|ausweis(?:typ|art|kategorie)|\bausweis\b(?!\s*-?\s*(?:nr|nummer|no)\b)|grenzg(?:ä|ae)nger|frontali(?:e|è)r|autorizzazione (?:al|di|per il) lavoro|autorizzat[oa] a lavorare|diritto (?:al|di) lavor|titolo di soggiorno|stato di soggiorno|permis de (?:travail|s(?:é|e)jour)|autorisation (?:de travail|de s(?:é|e)jour|frontali(?:è|e)re|d['’](?:é|e)tablissement|de courte dur(?:é|e)e)|titre de s(?:é|e)jour|statut de s(?:é|e)jour|autoris(?:é|e)e? (?:à|a) travailler|droit de travailler|work authori[sz]ation|authori[sz]ed to work|right to work|eligib(?:le|ility) to work|legally (?:able|allowed|entitled|permitted) to work|sponsorship|residence status|immigration status`, 'i');
export const PERMIT_FIELD_RE = new RegExp(String.raw`permit|bewilligung|permesso|\bvisa\b|\bvisum|${WORK_AUTHORISATION_RE.source}`, 'i');
export const NATIONALITY_FIELD_RE = /nationalit|nazionalit|cittadinanz|citizen|staatsangeh|staatsb(?:ü|ue)rger|citoyennet/i;
// The date of birth (JOIN: «Quando sei nato?»).
export const BIRTH_FIELD_RE = /birth|geburt|nascita|\bnat[oa]\b|naissance/i;
// A licence to practise or to drive is no residence permit.
const NOT_RESIDENCE = /berufsaus(?:ü|ue)bung|practi[cs]e permit|permis de conduire|f[üu]hrerausweis|fahrausweis|driving|patente|permesso di guida/i;
// A field that asks what the candidate needs or applies for, not what they hold.
const NEEDS = /ben(?:ö|oe)tig|brauch|beantrag|sponsor|\bneed|requir|richied|serve un|bisogno|besoin|demander/i;

/** A field that asks the Swiss permit, the work authorisation or the residence status. */
export function isPermitField(label) {
  const text = String(label ?? '');
  return PERMIT_FIELD_RE.test(text) && !NOT_RESIDENCE.test(text);
}

/** A field that asks the nationality or the citizenship. */
export function isNationalityField(label) {
  return NATIONALITY_FIELD_RE.test(String(label ?? ''));
}

/** false when the field asks what the candidate needs or applies for (a permit, a visa, a sponsorship). */
export function asksHeldStatus(label) {
  return !NEEDS.test(String(label ?? ''));
}
