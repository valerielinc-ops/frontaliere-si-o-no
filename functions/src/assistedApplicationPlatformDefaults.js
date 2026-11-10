/**
 * Candidate facts that can be demonstrated by an explicit answer or profile
 * value, plus the small set of policy-approved soft defaults. Missing facts
 * stay empty so the candidate can answer them in the review screen.
 *
 * Pure JavaScript: imported by the functions and by the runner scripts.
 */
import { addressContextContract } from './lib/addressContextContract.js';
import { isoDateOf } from './lib/cvPeriod.js';
import { languageCodesIn } from './lib/languageFacts.js';
import { civilStatusCode, civilStatusOption, civilStatusOptions, isCivilStatusField, salutationFor } from './lib/personalFacts.js';
import { asksHeldStatus, isNationalityField, isPermitField, nationalityLabelOf, nationalityOf, permitLabel, permitOptionCode, permitStatusOf } from './lib/permitStatus.js';
import { zurichToday } from './lib/assistedApplicationQuestionConstraints.js';

export const PLATFORM_DEFAULTS_VERSION = 'platform-defaults-v2';

const fold = (value) => String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const clean = (value, max = 200) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const languageOf = (locale) => (['it', 'en', 'de', 'fr'].includes(String(locale || '').slice(0, 2)) ? String(locale).slice(0, 2) : 'it');

const COUNTRY_NAMES = {
  IT: { it: 'Italia', en: 'Italy', de: 'Italien', fr: 'Italie' },
  CH: { it: 'Svizzera', en: 'Switzerland', de: 'Schweiz', fr: 'Suisse' },
  DE: { it: 'Germania', en: 'Germany', de: 'Deutschland', fr: 'Allemagne' },
  FR: { it: 'Francia', en: 'France', de: 'Frankreich', fr: 'France' },
  AT: { it: 'Austria', en: 'Austria', de: 'Österreich', fr: 'Autriche' },
  LI: { it: 'Liechtenstein', en: 'Liechtenstein', de: 'Liechtenstein', fr: 'Liechtenstein' },
};
const COUNTRY_BY_NAME = new Map();
for (const [code, names] of Object.entries(COUNTRY_NAMES)) {
  COUNTRY_BY_NAME.set(code.toLowerCase(), code);
  for (const name of Object.values(names)) COUNTRY_BY_NAME.set(fold(name), code);
}
COUNTRY_BY_NAME.set('italien', 'IT');

/** ISO code of an explicit country name or code, '' otherwise. */
export function countryCodeOf(value) {
  return COUNTRY_BY_NAME.get(fold(value)) || '';
}

/** A birth date is available only when the candidate's profile states one. */
export function platformDateOfBirth(profile = {}) {
  const stated = isoDateOf(profile?.dateOfBirth);
  return stated ? { value: stated, estimated: false } : null;
}

export function ageOn(dateOfBirth, nowMs = Date.now()) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateOfBirth || ''));
  if (!match) return null;
  const [year, month, day] = zurichToday(nowMs).split('-').map(Number);
  let age = year - Number(match[1]);
  if (month < Number(match[2]) || (month === Number(match[2]) && day < Number(match[3]))) age--;
  return age;
}

/**
 * Candidate values used by form mapping. `profile`, `personal` and `answers`
 * are candidateWithEdits()'s; no address, age, gender, salary or availability
 * fact is manufactured from the name, education, job offer, or locality.
 */
export function platformCandidateFacts({ order = {}, profile = {}, identity = {}, personal = {}, answers = {}, locale = 'it', nowMs = Date.now(), seed = '' } = {}) {
  const language = languageOf(locale);
  const birth = platformDateOfBirth(profile);
  const age = birth ? ageOn(birth.value, nowMs) : null;
  const civilStatus = civilStatusCode(personal?.civilStatus) || '';
  const salutation = clean(answers?.salutation || personal?.salutation, 40);
  const languages = profile?.languagesExplicitList === true && Array.isArray(profile?.languages) ? profile.languages
    .map((entry) => ({ code: languageCodesIn(entry?.language || '')[0] || '', level: clean(entry?.level, 80) }))
    .filter((entry) => entry.code) : [];
  const uploaded = order?.candidateFacts && typeof order.candidateFacts === 'object' ? order.candidateFacts : {};
  const permitStatus = permitStatusOf(profile?.permitStatus) || permitStatusOf(answers?.work_permit) || permitStatusOf(uploaded.workPermit);
  const nationality = clean(profile?.nationality, 80) || clean(uploaded.nationality, 80);
  const passport = passportOf({ passport: uploaded.passport });
  return {
    version: PLATFORM_DEFAULTS_VERSION,
    locale: language,
    salutation,
    dateOfBirth: birth?.value || '',
    dateOfBirthEstimated: false,
    age,
    civilStatus,
    civilStatusLabel: civilStatus ? civilStatusOptions(language)[CIVIL_STATUS_ORDER.indexOf(civilStatus)] || '' : '',
    civilStatusEstimated: false,
    languages,
    permitStatus,
    nationality,
    passport,
  };
}

/** The upload-time answers (order.candidateFacts, owner decision 2026-11-09). */
export const CANDIDATE_PASSPORTS = Object.freeze(['swiss', 'eu_efta', 'other']);
const UPLOAD_PERMITS = new Set(['swiss', 'permit_c', 'permit_b', 'permit_l', 'permit_g', 'none']);

/** The candidate's upload answers as stored, or null when the input is not a complete, valid set. */
export function sanitizeCandidateFacts(value) {
  if (!value || typeof value !== 'object') return null;
  const workPermit = clean(value.workPermit, 20);
  const passport = clean(value.passport, 20);
  const nationality = clean(value.nationality, 80);
  if (!UPLOAD_PERMITS.has(workPermit) || !CANDIDATE_PASSPORTS.includes(passport) || !nationality) return null;
  return { workPermit, passport, nationality };
}

/** A passport is available only from the candidate's explicit upload answer. */
export function passportOf({ passport = '' } = {}) {
  return CANDIDATE_PASSPORTS.includes(passport) ? passport : '';
}

/** No candidate-specific defaults are introduced by this baseline. */
export function basePlatformFacts(nowMs = Date.now(), locale = 'it') {
  return platformCandidateFacts({ nowMs, locale, seed: 'none' });
}

// ── Questions ───────────────────────────────────────────────────────────────

const label = (question) => fold([question?.applicationQuestion, question?.question, question?.label]
  .filter((value) => typeof value === 'string' && value.trim()).join(' '));
function optionsOf(question) {
  const raw = question?.options?.length ? question.options : question?.applicationOptions || [];
  return raw.map((option) => (typeof option === 'string' ? option : option?.label ?? option?.value))
    .map((option) => String(option ?? '').trim())
    .filter((option) => option && !/^(?:-+|seleziona\w*|select\w*|please select|bitte (?:wahlen|waehlen|auswahlen)|choisir|choose|aucune selection|selezionare)\b/i.test(fold(option) || '-'));
}
const typeOf = (question) => String(question?.type || question?.kind || question?.inputType || '').toLowerCase();
// A yes/no field: its type says so, or every option is a bare yes or no («Sì, ho un permesso…» is a choice).
const isBinary = (question) => ['yes_no', 'checkbox', 'boolean'].includes(typeOf(question))
  || (optionsOf(question).length >= 2 && optionsOf(question).length <= 3
    && optionsOf(question).every((option) => /^(?:si|yes|ja|oui|no|nein|non|true|false)$/.test(fold(option))));

const YES = /^(?:si|yes|ja|oui|true|1|y)\b/;
const NO = /^(?:no|nein|non|false|0|n)\b/;

const BIRTH = /\b(?:nascit\w*|nat[oa] il|data di nascita|geburt\w*|geboren|birth\w*|born|naissance|ne le|nee le|dob)\b/;
const EMAIL_LIKE = /\b(?:e ?mail|email|courriel|web|website|url|ip)\b/;
const POSTAL = /\b(?:cap|npa|nap|plz|postleitzahl|zip|zip code|postal code|post code|postcode|code postal|codice postale)\b/;
const HOUSE_NUMBER = /\b(?:numero civico|n civico|civico|hausnummer|haus nr|house number|street number|numero de rue|no de rue|numero)\b/;
const STREET = /\b(?:via|strasse|street|rue|indirizzo|adresse|address|anschrift)\b/;
const STREET_STRICT = /\b(?:via|strada|strasse|street|rue)\b/;
const STREET_NAME_ONLY = /\b(?:nome (?:della )?(?:sua |tua )?via|street name|strassenname|nom de (?:la )?rue)\b/;
const NOT_ADDRESS = /\b(?:whatsapp|sms|telefon\w*|phone|cellulare|mobile|handy|e ?mail|email|courriel)\b/;
const AGE_LIMIT = /\b(?:(meno di|under|unter|moins de|almeno|at least|mindestens|au moins|piu di|over|uber|plus de))\s+(\d{1,2})\s+(?:anni|years?|jahre?|ans)\b/;
const CITY = /\b(?:citta|city|ort|wohnort|localita|ville|town|comune|lieu|gemeinde)\b/;
const COUNTRY = /\b(?:paese|nazione|country|land|pays|stato)\b/;
const RESIDENCE = /\b(?:residen\w*|domicil\w*|wohn\w*|vivi|abiti|live|living|reside)\b/;
const CITIZENSHIP = /\b(?:nazionalita|nationalit\w*|staatsangeh\w*|citizenship|cittadinanza|citoyennete|passport|passaporto|passeport|pass|nascita|birth|geburt)\b/;
const SALUTATION = /\b(?:appellativo|anrede|civilite|salutation|form of address|forma di cortesia|titolo|title)\b/;
const SALARY = /\b(?:salar\w*|stipendi\w*|retribuz\w*|remunera\w*|lohn\w*|gehalt\w*|lohnvorstellung|pretention\w* salariale\w*|compensation|pay expectation\w*|tariffa|rate)\b/;
// A start date asked as such. «Available» alone is not one: «Available from Monday to Friday» is a schedule.
const START = /\b(?:start(?:ing)? date|date of (?:start|entry)|earliest (?:possible )?start\w*|when can you start|available from|availability date|data di (?:inizio|entrata|assunzione)|prima data|da quale data|a partire da quale data|quando potresti iniziare|quando puoi iniziare|disponibilita a iniziare|disponibile a iniziare|entrata in servizio|ab wann|eintritts?datum|fruhest\w* eintritt\w*|stellenantritt|arbeitsbeginn|date de debut|date d entree|a partir de quand|prise de poste|disponible a partir)\b/;
const SCHEDULE = /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekdays?|lunedi|martedi|mercoledi|giovedi|venerdi|sabato|domenica|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|orari\w*|hours?|ore|stunden|heures|uhr|shift\w*|turn\w*|schicht\w*)\b/;
const RELOCATION = /\b(?:trasferir\w*|trasferiment\w*|relocat\w*|umzug\w*|umzieh\w*|demenag\w*|willing to move)\b/;
const HYBRID = /\b(?:ibrid\w*|hybrid\w*|hybride|homeoffice|home office|telelavoro|smart working|presenza (?:presso|in) (?:la )?sede)\b/;
const ON_CALL = /\b(?:picchett\w*|pikett\w*|reperibil\w*|on call|bereitschaft\w*|astreinte|permanence|turni di guardia)\b/;
const RECORDING = /\b(?:registrazion\w*|recording|recorded|aufnahme\w*|aufzeichn\w*|enregistr\w*|audio)\b/;
const CONSENT = /\b(?:consens\w*|acconsent\w*|consent\w*|einwillig\w*|zustimm\w*|autoris\w*|accett\w*|accept\w*|informato|informed)\b/;
const MARKETING = /\b(?:newsletter\w*|marketing|promozional\w*|pubblicit\w*|werbung|werbe\w*|publicit\w*|offerte commerciali|job alert\w*|talent pool|talent community|corsi|academy|opportunita di formazione|weitere angebote|offres commerciales|informazioni (?:su|sulle|riguardo))\b/;
const PRIVACY = /\b(?:informativa|privacy|datenschutz\w*|protection des donnees|donnees personnelles|trattamento dei (?:tuoi )?dati|dati personali|data protection|personal data|privacy notice|privacy policy)\b/;
const LANGUAGE_LEVEL = /\b(?:livello|level|niveau|proficiency|fluency|fluent|conoscenz\w*|kenntnis\w*|competenz\w*|parli|speak|sprechen|parlez|sprachkenntnisse)\b/;

// One subject per answer. A prompt that joins two subjects («notice period and start date», «WhatsApp
// contact and data processing», «processing for marketing») is the candidate's: no single platform value
// answers both halves. The families below are the subjects; a topic belongs to exactly one of them.
const SUBJECT_FAMILIES = {
  notice: /\b(?:notice period|notice time|preavviso|kundigungsfrist|preavis)\b/,
  start: /\b(?:start\w*|inizi\w*|entrata in servizio|beginn|eintritt\w*|antritt|debut|prise de poste|earliest|disponibil\w* (?:a|per) (?:iniziare|entrare))\b/,
  salary: SALARY,
  workload: /\b(?:workload|pensum|beschaftigungsgrad|grado di occupazione|grado d impiego|carico di lavoro|taux d (?:activite|occupation))\b/,
  contact: /\b(?:whatsapp|sms|newsletter|e ?mail|telefon\w*|phone)\b/,
  privacy: /\b(?:privacy|datenschutz\w*|protezione dei dati|protection des donnees|data protection|trattamento|processing|verarbeitung|traitement|personal data|dati personali|personenbezogen\w*|donnees personnelles)\b/,
  marketing: MARKETING,
  terms: /\b(?:terms|conditions|condizioni generali|agb|cgu|subscription|abbonamento|third parties|terze parti|dritte|tiers)\b/,
  experience: /\b(?:experience|esperienz\w*|erfahrung|years of|anni di)\b/,
};
const TOPIC_FAMILY = {
  salary_expectation: 'salary', start_date: 'start', marketing_opt_in: 'marketing', recording_consent: 'privacy',
};

/**
 * Native identifiers (a control's id or semantic name) that name a fact: the
 * field asks that fact whatever its visible label says, so no other platform
 * topic may answer it.
 */
const NATIVE_FACT_ID = /\b(?:country|nation\w*|permit|workpermit|work_permit|qualification|experience\w*|birth\w*|dob|address|street|postal|zip|city|salary|phone|email)\b/i;

function nativeIdentifiers(question) {
  return ['semanticId', 'controlId', 'name', 'nativeId', 'autocomplete']
    .map((key) => question?.[key]).filter((value) => typeof value === 'string' && value.trim())
    .join(' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
}

/** The platform topic of a question, or null for one the platform does not answer. */
export function platformQuestionTopic(question) {
  const topic = classifyPlatformTopic(question);
  if (!topic) return null;
  const text = label(question);
  const family = TOPIC_FAMILY[topic] || null;
  const subjects = Object.entries(SUBJECT_FAMILIES).filter(([name, re]) => name !== family && re.test(text)).map(([name]) => name);
  // An address, a birth date, a permit, a language level … carry no second subject of the list. A marketing
  // request names its channel («newsletter by e-mail»); declining it declines both.
  const compatible = { marketing_opt_in: ['contact'] }[topic] || [];
  if (subjects.some((name) => !compatible.includes(name))) return null;
  const identifiers = nativeIdentifiers(question);
  if (identifiers && NATIVE_FACT_ID.test(identifiers)) {
    const expected = { residence_country: /country/i, work_permit: /permit/i, nationality: /nation/i, birth_date: /birth|dob/i,
      birth_day: /birth|dob/i, birth_month: /birth|dob/i, birth_year: /birth|dob/i, address_street: /address|street/i,
      address_street_name: /address|street/i, address_house_number: /address|street/i, residence_postal_code: /postal|zip|address/i,
      residence_city: /city|address/i, salary_expectation: /salary/i }[topic];
    if (!expected || !expected.test(identifiers)) return null;
  }
  return topic;
}

const ADDRESS_TOPICS = new Set(['residence_postal_code', 'residence_country', 'residence_city', 'address_street', 'address_street_name', 'address_house_number']);
const OTHER_PARTY = /\b(?:datore|employer\w*|arbeitgeber\w*|azienda|company|firma|entreprise|employeur|referenz\w*|reference\w*|referee|contatto di emergenza|emergency|notfall\w*|urgence|genitor\w*|parent\w*|eltern|tutore|guardian|fatturazione|billing|rechnung\w*|facturation|consegna|delivery|lieferung|livraison|lavoro precedente|previous job|ultimo impiego)\b/;
const SELF_OWNER = /\b(?:personal\w*|persona\w*|personlich\w*|personnel\w*|candidat\w*|applicant\w*|bewerber\w*|your|tu[oa]i?|dati anagrafici|anagrafica|contact (?:details|information)|kontakt\w*|coordonnees|residen\w*|wohn\w*|domicil\w*)\b/;

/**
 * An address field is the candidate's only when nothing says otherwise: its
 * visible context (section, fieldset, nearby heading) and its native ownership
 * contract (lib/addressContextContract.js) must not name another party, and an
 * unreadable contract is not ownership.
 */
function candidateOwnsAddress(question) {
  const around = fold([question?.context, question?.section].filter((value) => typeof value === 'string').join(' '));
  if (OTHER_PARTY.test(around) || OTHER_PARTY.test(label(question))) return false;
  const contract = addressContextContract(question);
  if (contract === undefined) return true;
  if (contract === null || contract.unknown) return false;
  const owners = [contract.section, ...contract.owners].map(fold).filter(Boolean);
  return owners.every((owner) => !OTHER_PARTY.test(owner)) && (owners.length === 0 || owners.some((owner) => SELF_OWNER.test(owner)));
}

function classifyPlatformTopic(question) {
  const topic = classifyPlatformSubject(question);
  return topic && ADDRESS_TOPICS.has(topic) && !candidateOwnsAddress(question) ? null : topic;
}

function classifyPlatformSubject(question) {
  const text = label(question);
  if (!text) return null;
  const id = String(question?.id || '');
  const type = typeOf(question);
  // A residence condition left by lib/mobilityRequirements.js is a fact (where the candidate lives), not a
  // willingness: the platform's relocation declaration already met every clause relocation satisfies.
  if (/^mobility_requirement_/.test(id)) return null;
  if (id === 'salutation' || /\bcome vuoi essere indicat\w*\b|\bform of address\b/.test(text)) return 'salutation';
  if (BIRTH.test(text) && !CITY.test(text) && !COUNTRY.test(text) && !/\bluogo\b|\bort\b|\bplace\b|\blieu\b/.test(text)) {
    const options = optionsOf(question);
    if (options.length >= 12 && options.every((option) => /^\d{4}$/.test(option.replace(/\D/g, '')) || !/\d/.test(option))
      && options.filter((option) => /^\d{4}$/.test(option)).length >= 10) return 'birth_year';
    if (/\b(?:jahr|year|anno|annee)\b/.test(text)) return 'birth_year';
    if (/\b(?:monat|month|mese|mois)\b/.test(text)) return 'birth_month';
    if (/\b(?:tag|day|giorno|jour)\b/.test(text) && !/\bgeburtstag\b/.test(text)) return 'birth_day';
    if (/\bgeburtstag\b/.test(text) && options.length >= 28 && options.length <= 32) return 'birth_day';
    return 'birth_date';
  }
  if (isCivilStatusField(text)) return 'civil_status';
  const raw = [question?.applicationQuestion, question?.question, question?.label].filter(Boolean).join(' ');
  const permitOptions = optionsOf(question).filter((option) => permitCodeOf(option)).length;
  if ((isPermitField(raw) && asksHeldStatus(raw)) || permitOptions >= 2) return 'work_permit';
  if (/\bdocumento d identita\b|\bidentity document\b|\bausweis\w*\b|\bpiece d identite\b/.test(text) && permitOptions) return 'work_permit';
  if (isNationalityField(raw) && !/\b(?:passaport\w*|passport|passeport|reisepass)\b/.test(text)) return 'nationality';
  if (/\b(?:passaport\w*|passport|passeport|reisepass)\b/.test(text) && !/\b(?:numero|number|nummer|scadenza|expir\w*|ablauf)\b/.test(text)) {
    if (!isBinary(question)) return 'passport_type';
    const swiss = /\b(?:svizzer\w*|swiss|schweiz\w*|suisse)\b/.test(text);
    const euEfta = /\b(?:ue|eu|efta|aels|aele|europe\w*|europa\w*)\b/.test(text);
    return swiss && euEfta ? 'passport_swiss_eu_efta' : swiss ? 'passport_swiss' : euEfta ? 'passport_eu_efta' : 'passport_type';
  }
  if (SALUTATION.test(text) && !/\b(?:studio|study|job|position|posizione|stelle|poste|lavoro|qualific\w*|academic|accademico)\b/.test(text)) return 'salutation';
  if (EMAIL_LIKE.test(text) || NOT_ADDRESS.test(text)) {
    // fall through to the non-address topics below
  } else {
    const otherParty = /\b(?:datore|employer|arbeitgeber|azienda|company|referenz\w*|reference\w*|contatto di emergenza|emergency)\b/.test(text);
    if (POSTAL.test(text) && !otherParty) return 'residence_postal_code';
    if (COUNTRY.test(text) && !CITIZENSHIP.test(text) && !otherParty && (RESIDENCE.test(text) || text.split(' ').length <= 4)) return 'residence_country';
    if (STREET_STRICT.test(text) && HOUSE_NUMBER.test(text) && !otherParty) return 'address_street';
    if (HOUSE_NUMBER.test(text) && !otherParty && !/\b(?:documento|document|ausweis|passaporto|passport)\b/.test(text)) return 'address_house_number';
    if (STREET_NAME_ONLY.test(text) && !otherParty) return 'address_street_name';
    if (STREET.test(text) && !CITIZENSHIP.test(text) && !otherParty) return 'address_street';
    if (CITY.test(text) && !CITIZENSHIP.test(text) && !otherParty && (RESIDENCE.test(text) || text.split(' ').length <= 5)) return 'residence_city';
  }
  if (MARKETING.test(text) && !PRIVACY.test(text)) return 'marketing_opt_in';
  if (RECORDING.test(text) && CONSENT.test(text)) return 'recording_consent';
  if (/\bconsenso informato\b|\binformed consent\b/.test(text)) return 'recording_consent';
  if (ON_CALL.test(text)) return 'on_call';
  if (HYBRID.test(text)) return 'hybrid';
  if (RELOCATION.test(text)) return 'relocation';
  const languages = languageCodesIn(text);
  if (languages.length === 1 && LANGUAGE_LEVEL.test(text)) return `language:${languages[0]}`;
  if (SALARY.test(text) && !/\b(?:attuale|current|aktuell\w*|actuel\w*)\b/.test(text)) return 'salary_expectation';
  if (AGE_LIMIT.test(text) && isBinary(question)) return 'age_limit';
  if (START.test(text) && !SCHEDULE.test(text) && (type === 'date' || ['text', 'textarea', ''].includes(type))
    && !/\b(?:weekend|sera|night|notte|abend|viagg\w*|travel\w*|trasfert\w*|reisen)\b/.test(text)) return 'start_date';
  return null;
}

// ── Values ──────────────────────────────────────────────────────────────────

const CIVIL_STATUS_ORDER = ['single', 'married', 'divorced', 'widowed', 'separated', 'partnership', 'partnership_dissolved'];

const LEVEL_WORDS = [
  [7, /\b(?:madrelingua|lingua madre|native|mother tongue|muttersprach\w*|langue maternelle|bilingu\w*|c2\b)/],
  [6, /\b(?:c2|proficient|eccellente|excellent|ausgezeichnet|verhandlungssicher|courant)\b/],
  [5, /\b(?:c1|advanced|avanzato|ottim\w*|fluente|fluent\w*|fliessend|flie[sß]end|sehr gut\w*|tres bon\w*|professional\w*|professionale|sicuro)\b/],
  [4, /\b(?:b2|upper|intermedio superiore|buon\w*|good|gut\w*|bon\w*|high)\b/],
  [3, /\b(?:b1|intermedi\w*|discret\w*|conversazional\w*|conversational|mittel\w*)\b/],
  [2, /\b(?:a2|pre intermedio|elementar\w*|elementare|scolastic\w*|grundkenntnis\w*)\b/],
  [1, /\b(?:a1|base|basic|basis|principiante|beginner|debutant|notions)\b/],
  [0, /\b(?:nessun\w*|none|keine|aucune|no knowledge|non parlo|i don t speak)\b/],
];

function levelRank(value) {
  const text = fold(value);
  if (!text) return null;
  const lower = /\b(?:inferiore|below|unter\w*|moins|less than|meno di)\b/.test(text);
  for (const [rank, re] of LEVEL_WORDS) {
    if (re.test(text)) return lower ? rank - 1.5 : rank;
  }
  return null;
}

const permitCodeOf = (option) => permitOptionCode(option) || permitStatusOf(option);

/** Descriptive permit options («Sì, ho un passaporto svizzero.», «No, ma ho la cittadinanza EU/EFTA»). */
function permitOptionFallback(question, status, passport) {
  const options = optionsOf(question);
  const find = (re) => options.filter((option) => re.test(fold(option)));
  if (status === 'swiss') return find(/\b(?:svizzer\w*|swiss|schweizer\w*|suisse)\b.*\b(?:passaport\w*|passport|cittadinanza|citizen\w*|burgerrecht|nationalite)\b|\b(?:passaport\w*|passport|cittadinanza|citizen\w*)\b.*\b(?:svizzer\w*|swiss|suisse)\b/)[0] || '';
  if (status && status !== 'none') {
    const letter = status.slice(-1);
    return find(new RegExp(`\\b(?:permesso|permit|bewilligung|permis|ausweis)\\b.*\\b${letter}\\b`))[0]
      || find(/^(?:si|yes|ja|oui)\b.*\b(?:permesso|permit|bewilligung|permis)\b/)[0] || '';
  }
  if (passport === 'eu_efta') return find(/\b(?:ue|eu|efta|aels)\b/).filter((option) => /^(?:no|nein|non)\b|\bma\b|\bbut\b|\baber\b|\bmais\b/.test(fold(option)))[0] || '';
  return find(/^(?:no|nein|non)\b/)[0] || '';
}

function pickOption(question, predicate) {
  const matches = optionsOf(question).filter(predicate);
  return matches.length ? matches[0] : '';
}

function yesValue(question, locale) {
  const options = optionsOf(question);
  if (options.length) return pickOption(question, (option) => YES.test(fold(option)));
  if (['checkbox'].includes(typeOf(question))) return 'true';
  return { it: 'Sì', en: 'Yes', de: 'Ja', fr: 'Oui' }[languageOf(locale)];
}

function noValue(question, locale) {
  const options = optionsOf(question);
  if (options.length) return pickOption(question, (option) => NO.test(fold(option)));
  if (['checkbox'].includes(typeOf(question))) return 'false';
  return { it: 'No', en: 'No', de: 'Nein', fr: 'Non' }[languageOf(locale)];
}

function choose(question, value) {
  const options = optionsOf(question);
  if (!options.length) return value;
  const wanted = fold(value);
  return options.find((option) => fold(option) === wanted)
    || options.find((option) => fold(option).startsWith(wanted) || wanted.startsWith(fold(option)))
    || '';
}

function dateValue(question, iso, locale) {
  if (!iso) return '';
  if (typeOf(question) === 'date') return iso;
  const [year, month, day] = iso.split('-');
  return languageOf(locale) === 'en' ? `${day}/${month}/${year}` : `${day}.${month}.${year}`;
}

function languageValue(question, code, facts) {
  const entry = (facts?.languages || []).find((item) => item.code === code);
  if (!entry) return '';
  const rank = entry.level === 'native' ? 7 : levelRank(entry.level);
  if (rank === null) return '';
  const options = optionsOf(question);
  if (!options.length) {
    if (isBinary(question)) return rank >= 3 ? yesValue(question, facts?.locale) : noValue(question, facts?.locale);
    return entry.level === 'native' ? { it: 'Madrelingua', en: 'Native', de: 'Muttersprache', fr: 'Langue maternelle' }[facts?.locale || 'it'] : entry.level;
  }
  if (isBinary(question)) return rank >= 3 ? yesValue(question, facts?.locale) : noValue(question, facts?.locale);
  const ranked = options.map((option) => ({ option, rank: levelRank(option) }))
    .filter((item) => item.rank !== null && (rank <= 0 ? true : item.rank > 0));
  if (!ranked.length) return '';
  const atMost = ranked.filter((item) => item.rank <= rank).sort((left, right) => right.rank - left.rank);
  return (atMost[0] || ranked.sort((left, right) => left.rank - right.rank)[0]).option;
}

/** Map an explicit candidate fact to the target field without calling it a policy default. */
export function platformCandidateFactAnswer(question, facts = null, { locale } = {}) {
  const topic = platformQuestionTopic(question);
  if (!topic) return null;
  const known = facts || basePlatformFacts(Date.now(), locale);
  const lang = languageOf(locale || known.locale);
  const withLocale = { ...known, locale: lang };
  const options = optionsOf(question);
  let value = '';
  switch (topic) {
    case 'salutation': {
      const stated = String(known.salutation || '').trim();
      const exact = options.filter((option) => fold(option) === fold(stated));
      if (!options.length) {
        value = stated;
        break;
      }
      if (exact.length === 1) {
        value = exact[0];
        break;
      }
      const gender = /^(?:signora|frau|madame|ms|mrs)$/i.test(known.salutation || '') ? 'f'
        : /^(?:signor|signore|herr|monsieur|mr)$/i.test(known.salutation || '') ? 'm' : '';
      if (!gender) break;
      value = pickOption(question, (option) => (gender === 'f'
        ? /^(?:signora|sig ra|frau|madame|mme|ms|mrs|donna|female|femmina|weiblich)\b/ : /^(?:signor|signore|sig|herr|monsieur|m|mr|uomo|male|maschio|mannlich)\b/).test(fold(option)))
        || salutationFor(gender, lang);
      break;
    }
    case 'birth_date': value = dateValue(question, known.dateOfBirth, lang); break;
    case 'birth_day': value = known.dateOfBirth ? choose(question, String(Number(known.dateOfBirth.slice(8, 10)))) || choose(question, `${Number(known.dateOfBirth.slice(8, 10))}.`) : ''; break;
    case 'birth_month': value = known.dateOfBirth ? choose(question, String(Number(known.dateOfBirth.slice(5, 7)))) || choose(question, `${Number(known.dateOfBirth.slice(5, 7))}.`) : ''; break;
    case 'birth_year': value = known.dateOfBirth ? choose(question, known.dateOfBirth.slice(0, 4)) : ''; break;
    case 'civil_status': {
      const index = CIVIL_STATUS_ORDER.indexOf(known.civilStatus);
      if (index < 0) break;
      const localized = civilStatusOptions(lang)[index];
      value = options.length ? civilStatusOption(options, localized) || civilStatusOption(options, civilStatusOptions('en')[index]) : localized;
      break;
    }
    case 'work_permit': {
      const status = known.permitStatus;
      if (!status) break;
      if (options.length && !isBinary(question)) value = pickOption(question, (option) => permitCodeOf(option) === status)
        || permitOptionFallback(question, status, known.passport);
      else if (isBinary(question)) value = status === 'none' ? noValue(question, lang) : yesValue(question, lang);
      else value = permitLabel(status, lang);
      break;
    }
    case 'nationality': {
      const code = nationalityOf(known.nationality)?.code || (known.passport === 'swiss' ? 'CH' : '');
      // A list needs a recognized nationality: an unknown one never picks an option; a free field takes
      // the candidate's own words.
      if (options.length) {
        if (!code) break;
        value = pickOption(question, (option) => nationalityOf(option)?.code === code || countryCodeOf(option) === code);
      } else value = code ? nationalityLabelOf(code, lang) : known.nationality;
      break;
    }
    case 'passport_type': {
      const passport = known.passport;
      // «Do you hold a Swiss work permit or Swiss passport…?»: a held permit answers it first.
      if (known.permitStatus && optionsOf(question).some((option) => /\b(?:permesso|permit|bewilligung|permis)\b/.test(fold(option)))) {
        value = permitOptionFallback(question, known.permitStatus, passport);
        if (value) break;
      }
      if (!passport) break;
      const want = passport === 'swiss' ? /\b(?:svizzer\w*|swiss|schweiz\w*|suisse|ch)\b/
        : passport === 'eu_efta' ? /\b(?:ue|eu|efta|aels|europe\w*|eu efta)\b/ : /\b(?:altro|other|andere\w*|autre|non ue|non eu|third|drittstaat\w*|extra)\b/;
      value = options.length ? pickOption(question, (option) => want.test(fold(option)))
        : { swiss: { it: 'Svizzero', en: 'Swiss', de: 'Schweizer', fr: 'Suisse' }, eu_efta: { it: 'UE/AELS', en: 'EU/EFTA', de: 'EU/EFTA', fr: 'UE/AELE' }, other: { it: 'Altro', en: 'Other', de: 'Andere', fr: 'Autre' } }[passport][lang];
      break;
    }
    case 'passport_swiss':
    case 'passport_eu_efta':
    case 'passport_swiss_eu_efta': {
      const passport = known.passport;
      if (!passport) break;
      // Yes only for the passport the wording names: a Swiss-only prompt is no for an EU/EFTA passport.
      const held = { passport_swiss: ['swiss'], passport_eu_efta: ['eu_efta'], passport_swiss_eu_efta: ['swiss', 'eu_efta'] }[topic];
      value = held.includes(passport) ? yesValue(question, lang) : noValue(question, lang);
      break;
    }
    case 'age_limit': {
      if (known.age === null || known.age === undefined) break;
      const [, word, limit] = AGE_LIMIT.exec(label(question));
      const n = Number(limit);
      const under = /^(?:meno di|under|unter|moins de)$/.test(word);
      const over = /^(?:piu di|over|uber|plus de)$/.test(word);
      const holds = under ? known.age < n : over ? known.age > n : known.age >= n;
      value = holds ? yesValue(question, lang) : noValue(question, lang);
      break;
    }
    default:
      if (topic.startsWith('language:')) value = languageValue(question, topic.slice('language:'.length), withLocale);
  }
  value = String(value ?? '').trim();
  if (!value) return null;
  if (options.length && !options.includes(value) && !['true', 'false'].includes(value)) return null;
  return { value, topic: `candidate:${topic}`, source: 'profile', version: PLATFORM_DEFAULTS_VERSION };
}

/** Only the conservative decline of optional marketing is automatic. */
export function platformDefaultAnswer(question, facts = null, { locale } = {}) {
  if (platformQuestionTopic(question) !== 'marketing_opt_in'
    || ['checkbox'].includes(typeOf(question)) || question?.required !== false) return null;
  const lang = languageOf(locale || facts?.locale);
  const value = noValue(question, lang);
  if (!value) return null;
  return { value, topic: 'policy:marketing_opt_out', source: 'policy_default', version: PLATFORM_DEFAULTS_VERSION };
}
