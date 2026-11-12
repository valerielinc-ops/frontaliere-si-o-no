/**
 * Platform defaults of the assisted application (owner decision 2026-11-09).
 *
 * The questions a candidate was asked on every order (census of 2026-11-09:
 * 178 questions on 34 paid orders) are now answered by the platform instead:
 *
 *   - postal code, country of residence: deduced from the town in the CV
 *     (public GeoNames directory, data/platform-postal-codes.json); without a
 *     town nor a country stated by the CV or the order, the country of residence
 *     comes from the upload answers (uploadResidenceCountry, owner 2026-11-10);
 *   - street and house number, when a form requires them and the CV has none:
 *     one of a fixed list of common Italian street names and a number 1-101,
 *     chosen deterministically from the candidate so every run sends the same;
 *   - form of address: from the first name, never asked;
 *   - language levels: from the CV;
 *   - salary expectation: the maximum of the job's salary estimate;
 *   - workload 100%; notice period and start date 3 months after submission
 *     (a start date or a workload the candidate stated in their reply wins: order.candidateStatements);
 *   - privacy notices and audio-recording consent accepted, marketing declined;
 *   - date of birth, when the CV does not state it: the year the candidate
 *     was 18 (end of the Maturità, or start of university), on 1 January;
 *   - civil status: married above 35, single otherwise;
 *   - willing to relocate, to work hybrid, to be on call and to travel for business (travel: 2026-11-10);
 *   - suitable for and interested in the position applied for (2026-11-10), never a fitness of health or law;
 *   - permit G, when the candidate stated no status, the CV's town is in a country bordering Switzerland and
 *     the CV shows a current or recent employment in Switzerland (deducedCrossBorderPermit, 2026-11-10);
 *   - profile visibility / internal forwarding (2026-11-10): the broadest audience inside the same employer
 *     («Alle Recruiter*innen der Stadt Zürich»), never a third party, the public or a marketing list;
 *   - nationality, when the candidate gave none (2026-11-11): the country of the upper secondary school of the
 *     CV, else two concordant signals of the CV (place of birth, mother tongue, compulsory school, confirmed by
 *     university or residence) and no strong one against (deducedNationality, `nationalitySource: 'deduced'`);
 *     the same day, more offline signals: the CV's own declaration is the value (`nationalitySource: 'cv'`), the
 *     codice fiscale's place of birth a strong signal, the phone prefix and the CV's language weak ones that
 *     count only beside a strong one; never the name;
 *   - criminal record (2026-11-11): always no conviction, no entry, no pending proceeding, unless the candidate
 *     said otherwise at upload; never a request for the extract, never the debt-enforcement register;
 *   - a title of study or a certificate asked in a text or a choice field (2026-11-11): the CV's own title
 *     (held_title); an upload of the document stays a document.
 *
 * What no rule here covers goes to the decision engine (assistedApplicationDecisionAnswers.js).
 *
 * Work permit, passport class (Swiss / EU-EFTA / other) and nationality are
 * collected at CV upload (order.candidateFacts). For older orders the class
 * also follows a known nationality from the CV; an explicit passport upload
 * wins and an unknown nationality stays unknown. Also, since
 * 2026-11-10, two legal facts: an entry in the criminal record and one in the
 * debt-enforcement or bankruptcy register. Since 2026-11-11 the criminal record
 * is a platform rule (no conviction, owner decision), which only the
 * candidate's own «yes» at upload overrides; the debt-enforcement register is
 * still answered from the upload answers only (legalRecordValue), and an order
 * uploaded before has none: that question stays the candidate's. The
 * nationality an order uploaded before lacks is deduced from the CV
 * (deducedNationality).
 *
 * Every value here is a platform choice, not a candidate statement: it is
 * projected with `source: 'policy_default'` (assistedApplicationOperationalAnswers.js)
 * and recorded as such, never written to the confirmed-answer ledger, so the
 * candidate can see and change it. The functions are pure and deterministic
 * for one candidate and one day: the runner's submission guard hashes the
 * answers between the plan and the send.
 *
 * Pure JavaScript: imported by the functions and by the runner scripts.
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { addressContextContract } from './lib/addressContextContract.js';
import { isWorkHistoryContext } from './lib/workHistoryContext.js';
import { isOngoingPeriod, isoDateOf, parseEndpoint } from './lib/cvPeriod.js';
import { languageCodesIn } from './lib/languageFacts.js';
import { civilStatusCode, civilStatusOption, civilStatusOptions, isCivilStatusField, salutationFor, salutationGenderFromName } from './lib/personalFacts.js';
import { asksHeldStatus, isNationalityField, isPermitField, nationalityCodes, nationalityLabelOf, nationalityOf, permitLabel, permitOptionCode, permitStatusOf } from './lib/permitStatus.js';
import { phoneCountryCode } from './lib/phoneNormalization.js';
import { isUnknownAnswer } from './lib/unknownAnswer.js';
import { defaultStartDate, zurichToday } from './lib/assistedApplicationQuestionConstraints.js';

// v2 (2026-11-10): business travel and profile visibility inside the employer.
// v3 (2026-11-10): the education level and an unnamed language row («Language» + «Level») from the CV.
// v4 (2026-11-10): first and correspondence language, the Swiss Army school of a candidate who is not Swiss.
// v5 (2026-11-10): the residence canton or province, from the CV town.
// v6 (2026-11-10): an entry in the criminal record or in the debt-enforcement register, from the upload answers.
// v7 (2026-11-10): support to other sites or branches, flexibility of the place of work, guard and piquet duty.
// v8 (2026-11-10): the cross-border permit G deduced from the CV (deducedCrossBorderPermit), the declaration of
// suitability for or interest in the position always yes. (v7 is the other sites and guard duty of #18004.)
// v9 (2026-11-10): the address of the candidate's own form whose labels name a company; the street name beside a
// house-number field.
// v10 (2026-11-11): the nationality deduced from the CV when the candidate gave none (deducedNationality); the
// criminal record always «no conviction» (criminalRecordValue); a title of study or certificate asked in a text or
// a choice field declared from the CV (held_title).
// v11 (2026-11-11): more offline signals for the nationality: the CV's own declaration («Nazionalità: italiana»,
// `nationalitySource: 'cv'`), the place of birth of an Italian codice fiscale, the phone's country prefix and the
// CV's language (these two only beside a strong signal); a dual nationality picks Swiss first on a list.
// v12 (2026-11-11): every address block of the candidate's own (a second extraction of the same form, a postal or
// correspondence address, a second step with the same fields) receives the same address, and the one the candidate
// typed in another block of the order wins over the platform's (candidateAddressTopics, withCandidateAddress).
// v13 (2026-11-12): a known nationality establishes the Swiss, EU/EFTA or other passport class for screening
// questions; a passport stated at upload remains the higher-priority fact, and an unknown nationality stays open.
export const PLATFORM_DEFAULTS_VERSION = 'platform-defaults-v13';

/** The street names a required street field receives when the CV has none (owner list, 2026-11-09). */
export const PLATFORM_STREETS = Object.freeze([
  'Via Roma', 'Via Garibaldi', 'Via Marconi', 'Via Mazzini', 'Via Alighieri', 'Via Cavour', 'Via Matteotti',
  'Via Verdi', 'Via IV Novembre', 'Via Castello', 'Via Papa Giovanni XXIII', 'Via Cesare Battisti',
  'Via Alessandro Manzoni', 'Via Aldo Moro',
]);
export const PLATFORM_HOUSE_NUMBER_MAX = 101;
export const PLATFORM_NOTICE_MONTHS = 3;
export const PLATFORM_WORKLOAD_PERCENT = 100;
/** Age the candidate is assumed to have in the year of the Maturità or of the start of university. */
export const PLATFORM_SCHOOL_LEAVING_AGE = 18;
/** Above this age the civil status is «married», otherwise «single». */
export const PLATFORM_MARRIED_ABOVE_AGE = 35;

const require = createRequire(import.meta.url);
let postalIndex = null;

const fold = (value) => String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const clean = (value, max = 200) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const languageOf = (locale) => (['it', 'en', 'de', 'fr'].includes(String(locale || '').slice(0, 2)) ? String(locale).slice(0, 2) : 'it');

function postalDirectory() {
  if (postalIndex) return postalIndex;
  const data = require('./data/platform-postal-codes.json');
  postalIndex = new Map();
  for (const [country, region, name, code] of Array.isArray(data.entries) ? data.entries : []) {
    if (!postalIndex.has(name)) postalIndex.set(name, []);
    postalIndex.get(name).push({ country, region, code });
  }
  return postalIndex;
}

const COUNTRY_NAMES = {
  IT: { it: 'Italia', en: 'Italy', de: 'Italien', fr: 'Italie' },
  CH: { it: 'Svizzera', en: 'Switzerland', de: 'Schweiz', fr: 'Suisse' },
  DE: { it: 'Germania', en: 'Germany', de: 'Deutschland', fr: 'Allemagne' },
  FR: { it: 'Francia', en: 'France', de: 'Frankreich', fr: 'France' },
  AT: { it: 'Austria', en: 'Austria', de: 'Österreich', fr: 'Autriche' },
  LI: { it: 'Liechtenstein', en: 'Liechtenstein', de: 'Liechtenstein', fr: 'Liechtenstein' },
  // Countries a CV names after the town («…, Spain», «…, Romania»): the country is deduced even where the public
  // postal lists (CH, IT) give no code.
  ES: { it: 'Spagna', en: 'Spain', de: 'Spanien', fr: 'Espagne' },
  PT: { it: 'Portogallo', en: 'Portugal', de: 'Portugal', fr: 'Portugal' },
  RO: { it: 'Romania', en: 'Romania', de: 'Rumänien', fr: 'Roumanie' },
  PL: { it: 'Polonia', en: 'Poland', de: 'Polen', fr: 'Pologne' },
  NL: { it: 'Paesi Bassi', en: 'Netherlands', de: 'Niederlande', fr: 'Pays-Bas' },
  BE: { it: 'Belgio', en: 'Belgium', de: 'Belgien', fr: 'Belgique' },
  GB: { it: 'Regno Unito', en: 'United Kingdom', de: 'Vereinigtes Königreich', fr: 'Royaume-Uni' },
  GR: { it: 'Grecia', en: 'Greece', de: 'Griechenland', fr: 'Grèce' },
  HR: { it: 'Croazia', en: 'Croatia', de: 'Kroatien', fr: 'Croatie' },
  SI: { it: 'Slovenia', en: 'Slovenia', de: 'Slowenien', fr: 'Slovénie' },
  HU: { it: 'Ungheria', en: 'Hungary', de: 'Ungarn', fr: 'Hongrie' },
  CZ: { it: 'Repubblica Ceca', en: 'Czech Republic', de: 'Tschechien', fr: 'Tchéquie' },
  SK: { it: 'Slovacchia', en: 'Slovakia', de: 'Slowakei', fr: 'Slovaquie' },
  BG: { it: 'Bulgaria', en: 'Bulgaria', de: 'Bulgarien', fr: 'Bulgarie' },
  RS: { it: 'Serbia', en: 'Serbia', de: 'Serbien', fr: 'Serbie' },
  AL: { it: 'Albania', en: 'Albania', de: 'Albanien', fr: 'Albanie' },
  UA: { it: 'Ucraina', en: 'Ukraine', de: 'Ukraine', fr: 'Ukraine' },
  TR: { it: 'Turchia', en: 'Turkey', de: 'Türkei', fr: 'Turquie' },
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

export function countryName(code, locale = 'it') {
  return COUNTRY_NAMES[code]?.[languageOf(locale)] || '';
}

/** «Como (CO)», «Lugano, TI», «Varese - Italia» → { town, region, country }. */
export function splitTown(value) {
  let text = clean(value);
  let country = '';
  const countryMatch = /(?:,|\s[-–—]\s)\s*([\p{L}](?:[\p{L} ]|-(?=\p{L}))*)\s*$/u.exec(text);
  if (countryMatch && countryCodeOf(countryMatch[1])) {
    country = countryCodeOf(countryMatch[1]);
    text = text.slice(0, countryMatch.index).trim();
  }
  let region = '';
  const regionMatch = /\s*(?:\(\s*([A-Za-z]{2})\s*\)|,\s*([A-Za-z]{2})|\s[-–—]\s*([A-Za-z]{2}))\s*$/.exec(text);
  if (regionMatch) {
    region = (regionMatch[1] || regionMatch[2] || regionMatch[3]).toUpperCase();
    text = text.slice(0, regionMatch.index).trim();
  }
  // A note in brackets that is no province code («Lugano (Abitazione)») is not part of the town.
  text = text.replace(/\s*\([^)]*\)\s*$/, '').trim();
  // A leading postal code («22100 Como») is not part of the town.
  const postal = /^(\d{4,5})\s+(.+)$/.exec(text);
  let town = (postal ? postal[2] : text).replace(/,\s*$/, '').trim();
  // «Town, Province» with the province written out («…, Como»): the town is the part before the comma when the
  // whole text is no town of the directory and that part is.
  if (town.includes(',') && !postalDirectory().has(fold(town))) {
    const first = town.split(',')[0].trim();
    if (first && postalDirectory().has(fold(first))) town = first;
  }
  return { town, region, country, statedPostal: postal?.[1] || '' };
}

/**
 * The representative postal code of a town: the country hint first, then
 * Italy, then Switzerland; within one, the region when known, then the
 * lowest code. '' for an unknown town.
 */
export function platformPostalCode(town, { region = '', country = '' } = {}) {
  const matches = postalDirectory().get(fold(town)) || [];
  if (!matches.length) return null;
  const rank = (entry) => [
    country && entry.country !== country ? 1 : 0,
    region && entry.region !== region ? 1 : 0,
    entry.country === 'IT' ? 0 : entry.country === 'CH' ? 1 : 2,
    entry.code,
  ];
  const [best] = [...matches].sort((left, right) => {
    const a = rank(left); const b = rank(right);
    for (let index = 0; index < a.length; index++) {
      if (a[index] < b[index]) return -1;
      if (a[index] > b[index]) return 1;
    }
    return 0;
  });
  return best;
}

function seedNumber(seed, salt) {
  return createHash('sha256').update(`${salt}\u0000${seed}`).digest().readUInt32BE(0);
}

const MATURITY_RE = /\b(?:matur\w*|diploma (?:di )?(?:scuola )?(?:media )?superiore|diploma di (?:maturita|liceo|istituto|ragioneria|geometra|perito)|diploma quinquennale|liceo|istituto tecnico|istituto professionale|istituto (?:di istruzione )?superiore|scuola superiore|iis|itis|itc|itg|ipsia|ipsar|ragioneria|perito|geometra|high school|secondary school diploma|upper secondary|technical (?:high )?school|vocational (?:school|diploma)|abitur|baccalaur\w*|gymnas\w*|kantonsschule|liceo cantonale|scuola cantonale di commercio|efz|eidgenossisches fahigkeitszeugnis|afc|attestato federale di capacita|cfc|certificat federal de capacite|lehrabschluss)\b/;
const UNIVERSITY_RE = /\b(?:laurea|universit\w*|politecnico|bachelor|master|msc|bsc|ba|ma|phd|dottorato|ingegneria|degree|hochschule|fachhochschule|supsi|usi|eth|epfl|haute ecole|accademia|academy)\b/;

function yearOf(value) {
  const match = /\b(19[4-9]\d|20[0-4]\d)\b/.exec(String(value ?? ''));
  return match ? Number(match[1]) : null;
}

/**
 * The date of birth: the CV's own when it states one, else 1 January of the
 * year the candidate was 18 at the end of the Maturità (or, failing that, at
 * the start of university). `estimated` says which.
 */
export function platformDateOfBirth(profile = {}) {
  const stated = isoDateOf(profile?.dateOfBirth);
  if (stated) return { value: stated, estimated: false };
  const education = Array.isArray(profile?.education) ? profile.education : [];
  const text = (item) => fold(`${item?.degree || ''} ${item?.institution || ''}`);
  const maturity = education.filter((item) => MATURITY_RE.test(text(item)) && !UNIVERSITY_RE.test(fold(item?.degree)))
    .map((item) => yearOf(item?.end) || (yearOf(item?.start) ? yearOf(item.start) + 5 : null)).filter(Boolean);
  const university = education.filter((item) => UNIVERSITY_RE.test(text(item)))
    .map((item) => yearOf(item?.start)).filter(Boolean);
  // A CV whose titles name neither (an English or a vocational title, «Maintenance and Technical Support»,
  // Damiani 2026-11-10): the same rule over its education as listed. Its first school finished is the
  // school-leaving one; with university-level entries only, the first one started.
  const dated = education.filter((item) => !UNIVERSITY_RE.test(text(item)));
  const leaving = dated.map((item) => yearOf(item?.end)).filter(Boolean);
  const started = education.map((item) => yearOf(item?.start)).filter(Boolean);
  const year = maturity.length ? Math.min(...maturity) - PLATFORM_SCHOOL_LEAVING_AGE
    : university.length ? Math.min(...university) - PLATFORM_SCHOOL_LEAVING_AGE
      : leaving.length ? Math.min(...leaving) - PLATFORM_SCHOOL_LEAVING_AGE
        : started.length ? Math.min(...started) - PLATFORM_SCHOOL_LEAVING_AGE : null;
  return year ? { value: `${year}-01-01`, estimated: true } : null;
}

// The level of a title of study, highest first (owner mandate 2026-11-10: the education level comes from the
// CV, its highest and latest title). A title is read against the most specific level first: «Associate degree»
// is not a bachelor, «Diploma di laurea» is not a school diploma. The same reader ranks a portal's options.
const EDUCATION_LEVELS = [
  [6, /\b(?:phd|ph d|doctorate|doctoral|dottorato|doktor\w*|doctorat)\b/],
  [5, /\b(?:master\w*|msc|mba|laurea (?:magistrale|specialistica)|magistrale|specialistica|diplom ingenieur|lizenziat\w*|licence de master)\b/],
  [3, /\b(?:associate (?:degree|diploma)|higher (?:national )?diploma|istruzione tecnica superiore|ifts|hohere fachschule|hf|eidgenossisch\w* diplom|brevetto federale|diploma federale|federal (?:diploma|certificate)|post ?secondary|technicien es|tecnico superiore|istituto tecnico superiore|its academy|fondazione its)\b/],
  [4, /\b(?:bachelor\w*|bsc|laurea|licence|university degree|college degree|degree|universit\w*|politecnico|fachhochschule|hochschule|haute ecole|hes|supsi|eth|epfl)\b/],
  [2, /\b(?:matur\w*|diploma|liceo|istituto tecnico|istituto professionale|istituto (?:di istruzione )?superiore|scuola superiore|iis|itis|itc|itg|ipsia|perito|ragioneria|geometra|high school|(?<!lower )secondary|abitur|baccalaur\w*|gymnas\w*|kantonsschule|vocational|apprentice\w*|apprendist\w*|lehre|lehrabschluss|efz|afc|cfc|fahigkeitszeugnis|attestato federale di capacita|certificat federal de capacite|qualifica professionale|berufsausbildung|formation professionnelle)\b/],
  [1, /\b(?:licenza media|scuola media|middle school|lower secondary|primary|elementary|sekundarschule|realschule|hauptschule|scuola dell obbligo|compulsory|obligatoire)\b/],
];

/** The level of one title or option, or null when it names none. */
export function educationLevelRank(value) {
  const text = fold(value);
  if (!text) return null;
  for (const [rank, re] of EDUCATION_LEVELS) if (re.test(text)) return rank;
  return null;
}

/** The candidate's highest level of study in the CV (degree first, then institution), or null. */
export function platformEducationLevel(profile = {}) {
  const ranks = (Array.isArray(profile?.education) ? profile.education : [])
    .map((item) => educationLevelRank(item?.degree) ?? educationLevelRank(item?.institution))
    .filter((rank) => rank !== null);
  return ranks.length ? Math.max(...ranks) : null;
}

export function ageOn(dateOfBirth, nowMs = Date.now()) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateOfBirth || ''));
  if (!match) return null;
  const [year, month, day] = zurichToday(nowMs).split('-').map(Number);
  let age = year - Number(match[1]);
  if (month < Number(match[2]) || (month === Number(match[2]) && day < Number(match[3]))) age--;
  return age;
}

/** Same day, three months later, in Zurich: the one definition the review page proposes too. */
export function platformStartDate(nowMs = Date.now()) {
  return defaultStartDate(nowMs);
}

/** The candidate's own statements read from their reply (order.candidateStatements), or {}. */
export function candidateStatementsOf(order = {}) {
  const value = order?.candidateStatements;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * The start date the candidate stated, as a form takes it: their date, or today once it has passed (they are
 * available from then on). '' when they stated none.
 */
export function statedStartDate(order = {}, nowMs = Date.now()) {
  const stated = String(candidateStatementsOf(order).startDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(stated)) return '';
  const today = zurichToday(nowMs);
  return stated < today ? today : stated;
}

/**
 * The workload a workload field takes: the percentage the candidate stated, else the platform's 100 % — which
 * full time, or «full or part time», agrees with. Part time only, with no percentage: null, never 100 %.
 */
export function statedWorkloadPercent(order = {}) {
  const workload = candidateStatementsOf(order).workload;
  if (!workload || typeof workload !== 'object') return PLATFORM_WORKLOAD_PERCENT;
  const percent = Number(workload.percent);
  if (Number.isInteger(percent) && percent >= 10 && percent <= 100) return percent;
  return workload.partTime && !workload.fullTime ? null : PLATFORM_WORKLOAD_PERCENT;
}

/** The maximum of the job's salary estimate, annual: order.salaryMax/baseSalary, written at checkout or by the automation. */
export function platformSalary(order = {}) {
  const base = order?.baseSalary && typeof order.baseSalary === 'object' ? order.baseSalary : null;
  const value = base?.value && typeof base.value === 'object' ? base.value : base;
  const max = Number(order?.salaryMax) || Number(value?.maxValue) || Number(order?.salaryMin) || Number(value?.minValue);
  if (!Number.isFinite(max) || max <= 0) return null;
  const unit = String(value?.unitText || 'YEAR').toUpperCase();
  const annual = unit === 'MONTH' ? max * 12 : unit === 'YEAR' ? max : null;
  if (!annual) return null;
  const currency = String(order?.salaryCurrency || base?.currency || 'CHF').toUpperCase();
  return { annual: Math.round(annual / 500) * 500, currency };
}

/** The first name's gender, else the Italian ending: «-a» is feminine, anything else masculine. */
export function platformSalutationGender(firstName, locale = 'it') {
  const known = salutationGenderFromName(firstName, locale);
  if (known) return known;
  const first = fold(String(firstName ?? '').trim().split(/[\s'’-]/u)[0]);
  if (!first) return '';
  return /a$/.test(first) && !['andrea', 'luca', 'nicola', 'mattia', 'elia', 'enea', 'battista'].includes(first) ? 'f' : 'm';
}

/**
 * Everything the platform answers for one candidate. `profile`, `identity`,
 * `personal` and `answers` are candidateWithEdits()'s; the CV and the
 * candidate's own corrections always win over a platform value.
 */
export function platformCandidateFacts({ order = {}, profile = {}, identity = {}, personal = {}, answers = {}, locale = 'it', nowMs = Date.now(), seed = '', permitDeduction = true, nationalityDeduction = true, cvText = '' } = {}) {
  const language = languageOf(locale);
  const key = clean(seed || order?.userId || order?.orderId || identity?.email || identity?.name || 'candidate', 300);
  const address = profile?.address && typeof profile.address === 'object' ? profile.address : {};
  const fromCity = splitTown(address.city || '');
  const fromLocation = splitTown(profile?.location || order?.applicantLocation || '');
  const town = fromCity.town || fromLocation.town;
  const region = fromCity.region || fromLocation.region;
  const statedCountry = countryCodeOf(address.country) || fromCity.country || fromLocation.country
    || countryCodeOf(order?.applicantLocationCountry);
  const directory = town ? platformPostalCode(town, { region, country: statedCountry }) : null;
  const statedPostal = /^\d{4,5}$/.test(clean(address.postalCode, 10)) ? clean(address.postalCode, 10)
    : fromCity.statedPostal || fromLocation.statedPostal;
  const uploaded = order?.candidateFacts && typeof order.candidateFacts === 'object' ? order.candidateFacts : {};
  // The upload answers name the country only for a CV with no town at all: a town the
  // directory cannot place is not evidence of the permit's or nationality's country.
  const country = statedCountry || directory?.country || (town ? '' : uploadResidenceCountry(uploaded));
  const postalCode = statedPostal || directory?.code || '';
  const statedStreet = /\p{L}/u.test(clean(address.street)) ? clean(address.street) : '';
  const houseNumber = /\b(\d{1,5}[a-z]?)\b/i.exec(statedStreet)?.[1]
    || String(1 + (seedNumber(key, 'house') % PLATFORM_HOUSE_NUMBER_MAX));
  const streetName = statedStreet ? statedStreet.replace(/\s*,?\s*\d{1,5}[a-z]?\s*$/i, '').trim() || statedStreet
    : PLATFORM_STREETS[seedNumber(key, 'street') % PLATFORM_STREETS.length];
  const street = statedStreet && /\d/.test(statedStreet) ? statedStreet : `${streetName} ${houseNumber}`;
  const birth = platformDateOfBirth(profile);
  const age = birth ? ageOn(birth.value, nowMs) : null;
  const statedCivil = civilStatusCode(personal?.civilStatus);
  const civilStatus = statedCivil || (age === null ? '' : age > PLATFORM_MARRIED_ABOVE_AGE ? 'married' : 'single');
  const firstName = identity?.firstName || String(identity?.name || '').trim().split(/\s+/)[0] || '';
  const salutation = clean(answers?.salutation, 40) || salutationFor(platformSalutationGender(firstName, language), language);
  const languages = (Array.isArray(profile?.languages) ? profile.languages : [])
    .map((entry) => ({ code: languageCodesIn(entry?.language || '')[0] || '', level: clean(entry?.level, 80) }))
    .filter((entry) => entry.code);
  const statedPermit = permitStatusOf(profile?.permitStatus) || permitStatusOf(answers?.work_permit) || permitStatusOf(uploaded.workPermit);
  // Nothing stated by the candidate, at upload, in an answer or a correction (even a cleared one: `permitDeduction`
  // false): the cross-border permit the CV implies (owner decision 2026-11-10), from the CV's own town only.
  const deducedPermit = !statedPermit && permitDeduction && !clean(answers?.work_permit) && !clean(uploaded.workPermit)
    ? deducedCrossBorderPermit({ residenceCountry: statedCountry || directory?.country || '', experience: profile?.experience, workPermit: profile?.workPermit, nowMs })
    : '';
  const permitStatus = statedPermit || deducedPermit;
  const statedNationality = clean(profile?.nationality, 80) || clean(uploaded.nationality, 80);
  // Nothing stated by the candidate, at upload, in an answer or a correction (even a cleared one:
  // `nationalityDeduction` false): the nationality the CV implies (owner decision 2026-11-11), like the permit.
  const open = !statedNationality && nationalityDeduction && !clean(answers?.nationality);
  // The CV's own declaration («Nazionalità: italiana») the parser left out is the value, not a deduction.
  const declared = open ? cvDeclaredNationality(cvText) : null;
  const deduced = open && !declared
    ? deducedNationality({
      profile, cvText, residenceCountry: statedCountry || directory?.country || '',
      phoneCountry: candidatePhoneCountry({ identity, order, profile, cvText }),
    }) : null;
  const platformNationality = declared || deduced;
  const nationality = statedNationality
    || (platformNationality ? nationalityLabelOf(platformNationality.code, language) || countryName(platformNationality.code, language) : '');
  // Two nationalities the candidate wrote together («italiana e svizzera»): a single choice takes Swiss first.
  const statedCodes = statedNationality ? [...nationalityCodes(statedNationality)] : [];
  const statedCode = statedNationality ? nationalityOf(statedNationality)?.code || countryCodeOf(statedNationality)
    || (statedCodes.includes('CH') ? 'CH' : statedCodes[0] || '') : '';
  const passport = passportOf({ passport: uploaded.passport, nationality });
  const passportSource = !passport ? ''
    : CANDIDATE_PASSPORTS.includes(uploaded.passport) || statedNationality ? 'candidate'
      : declared ? 'cv' : deduced ? 'deduced' : '';
  // The CV's own language is the mother tongue (owner decision 2026-11-09), also when the parser listed it
  // with a level of its own.
  const cvLanguage = String(profile?.cvLanguage || '').slice(0, 2).toLowerCase();
  if (cvLanguage) {
    const listed = languages.filter((entry) => entry.code === cvLanguage);
    if (listed.length) for (const entry of listed) { entry.level = 'native'; entry.inferred = true; }
    else languages.push({ code: cvLanguage, level: 'native', inferred: true });
  }
  return {
    version: PLATFORM_DEFAULTS_VERSION,
    locale: language,
    address: {
      street,
      streetName,
      houseNumber,
      postalCode,
      city: town,
      country,
      countryName: countryName(country, language),
      // The canton or province of the town: the one the CV states, else the directory's for that town.
      region: region || (directory && (!country || directory.country === country) ? directory.region : '') || '',
      synthesizedStreet: !statedStreet,
    },
    salutation,
    dateOfBirth: birth?.value || '',
    dateOfBirthEstimated: Boolean(birth?.estimated),
    educationLevel: platformEducationLevel(profile),
    // The CV's titles of study and certifications, for a field that asks one (held_title).
    titles: cvTitles(profile),
    age,
    civilStatus,
    civilStatusLabel: civilStatus ? civilStatusOptions(language)[CIVIL_STATUS_ORDER.indexOf(civilStatus)] || '' : '',
    civilStatusEstimated: !statedCivil && Boolean(civilStatus),
    languages,
    salary: platformSalary(order),
    // What the candidate stated in their reply (assistedApplicationCandidateReply.js) wins over the rule.
    startDate: statedStartDate(order, nowMs) || platformStartDate(nowMs),
    startDateStated: Boolean(statedStartDate(order, nowMs)),
    noticeMonths: PLATFORM_NOTICE_MONTHS,
    workloadPercent: statedWorkloadPercent(order),
    permitStatus,
    // 'candidate' for a status the candidate stated, 'deduced' for the one the platform deduced from the CV.
    permitStatusSource: statedPermit ? 'candidate' : deducedPermit ? 'deduced' : '',
    nationality,
    // 'candidate' for a nationality the candidate stated (at upload, in a correction, or as the parser read it from
    // the CV), 'cv' for one the CV text declares and the parser left out, 'deduced' for the one the platform read
    // from the CV's signals.
    nationalitySource: statedNationality ? 'candidate' : declared ? 'cv' : deduced ? 'deduced' : '',
    nationalityCode: statedNationality ? statedCode : platformNationality?.code || '',
    // Every nationality a dual national declared (CV text), the signals of a deduced one: for the record.
    nationalityCodes: statedNationality ? statedCodes : declared ? declared.codes : deduced ? [deduced.code] : [],
    nationalitySignals: declared ? ['cv_declaration'] : deduced ? deduced.signals : [],
    passport,
    passportSource,
    // The candidate's own answers at CV upload, '' when the order predates them (owner decision 2026-11-10).
    criminalRecord: legalRecordAnswer(uploaded.criminalRecord),
    debtRecord: legalRecordAnswer(uploaded.debtRecord),
  };
}

/** The countries bordering Switzerland: a resident who works in Switzerland is a cross-border commuter. */
export const CROSS_BORDER_COUNTRIES = Object.freeze(['IT', 'FR', 'DE', 'AT', 'LI']);
/** How long after a Swiss job ended its cross-border permit is still deduced: «current or recent» (owner). */
export const CROSS_BORDER_RECENT_MONTHS = 12;
// The kinds of role that are no employment: a volunteer post, a taster day of an apprenticeship.
const NOT_EMPLOYMENT = new Set(['volunteer', 'trial_apprenticeship']);
const SWISS_NAME = /\b(?:svizzera|switzerland|schweiz|suisse|svizra|helvetia)\b/;

/**
 * Whether a place the CV writes for a role is in Switzerland: «Lugano», «Mendrisio (TI)», «Zürich, Schweiz»,
 * «Chiasso - Svizzera». Conservative: a town the directory also knows in Italy, with no canton and no country,
 * is not read as Swiss, and «(CH)» after an Italian town is the province of Chieti.
 */
export function isSwissPlace(value) {
  const text = clean(value);
  if (!text) return false;
  const { town, region, country } = splitTown(text);
  const entries = town ? postalDirectory().get(fold(town)) || [] : [];
  if (country) return country === 'CH' && (!entries.length || entries.some((entry) => entry.country === 'CH'));
  if (SWISS_NAME.test(fold(text))) return true;
  if (!entries.length) return false;
  if (region) return entries.some((entry) => entry.country === 'CH' && entry.region === region);
  return platformPostalCode(town)?.country === 'CH';
}

/** Whether a role of the CV is current or ended at most CROSS_BORDER_RECENT_MONTHS before `nowMs`. */
function currentOrRecentRole(role, nowMs) {
  const end = String(role?.end ?? '').trim();
  const endpoint = end ? parseEndpoint(end) : null;
  if (endpoint === 'ongoing' || isOngoingPeriod(role?.start, role?.end)) return true;
  // No end: the role's start, when it is itself recent, dates it; an older start with no end proves nothing.
  const anchor = endpoint || (end ? null : parseEndpoint(role?.start));
  if (!anchor || anchor === 'ongoing') return anchor === 'ongoing';
  const now = new Date(nowMs);
  const months = (now.getUTCFullYear() - anchor.year) * 12 + (now.getUTCMonth() + 1 - (anchor.month || 12));
  // A role ending in the future is no proof of a job held today: only an end within the last months counts.
  return months >= 0 && months <= CROSS_BORDER_RECENT_MONTHS;
}

/**
 * The cross-border permit G the CV implies, or '' (owner decision 2026-11-10: «la persona lavora in Svizzera,
 * quindi sicuramente ha il permesso G siccome vive in Italia»): the CV's town is in Italy or another country
 * bordering Switzerland, and the CV shows an employment in Switzerland, current or ended at most
 * CROSS_BORDER_RECENT_MONTHS ago. Only when the candidate stated no status (platformCandidateFacts): their word
 * always wins. The CV's own permit wording, when it names another status, stops the deduction.
 * @param {{residenceCountry?:string, experience?:object[], workPermit?:string, nowMs?:number}} input
 * @returns {''|'permit_g'}
 */
export function deducedCrossBorderPermit({ residenceCountry = '', experience = [], workPermit = '', nowMs = Date.now() } = {}) {
  if (!CROSS_BORDER_COUNTRIES.includes(residenceCountry)) return '';
  const printed = permitStatusOf(workPermit);
  if (printed && printed !== 'permit_g') return '';
  const swissJob = (Array.isArray(experience) ? experience : []).some((role) => role && typeof role === 'object'
    && !NOT_EMPLOYMENT.has(role.kind) && isSwissPlace(role.location) && currentOrRecentRole(role, nowMs));
  return swissJob ? 'permit_g' : '';
}

/**
 * The country of residence the upload answers say, for a CV that names no town and no country (owner
 * decision 2026-11-10): a Swiss residence permit (B, C, L) lives in Switzerland; any other answer (Swiss
 * citizen, cross-border G, none) the country of the declared nationality. '' when the platform cannot name
 * that country on a form (COUNTRY_NAMES): the field then stays the candidate's question.
 */
export function uploadResidenceCountry(uploaded = {}) {
  if (['permit_b', 'permit_c', 'permit_l'].includes(uploaded?.workPermit)) return 'CH';
  const code = nationalityOf(uploaded?.nationality)?.code || countryCodeOf(uploaded?.nationality);
  // Only Switzerland and the countries bordering it: a nationality from farther away says nothing of where a
  // cross-border commuter lives (the country table also names other countries, for the CV's own locations).
  return UPLOAD_RESIDENCE_COUNTRIES.has(code) ? code : '';
}
const UPLOAD_RESIDENCE_COUNTRIES = new Set(['CH', 'IT', 'DE', 'FR', 'AT', 'LI']);

// ── Nationality deduced from the CV (owner decision 2026-11-11) ──────────────
// «Se ha studiato il liceo lì la sua nazionalità è di quel paese, utilizza regole multiple per avere più segnali
// di deduzione.» Only the CV is read: the candidate's name never leaves the platform (no web search).
//
//   - upper secondary school (liceo, maturità, istituto tecnico, Gymnasium, Matura, Abitur, baccalauréat, lycée,
//     high school, A-levels, EFZ…): the country it is in gives the nationality, whatever else the CV says;
//   - otherwise at least two concordant signals (of two kinds) on one country, and no strong signal for another.
//     Strong: the place of birth the CV writes, a mother tongue spoken in one country only (Italian → IT), the
//     compulsory school. Weak, never against a strong one: the university, the residence. Confirmation only: a
//     mother tongue of several countries (German: DE, AT, CH);
//   - anything less: no nationality, never an invented one.
//
// Second part, the same day («più dati per la deduzione», offline only; cvDeclaredNationality and below):
//   - a nationality the CV declares in so many words is no deduction: it is the value (`nationalitySource: 'cv'`);
//   - the codice fiscale's place of birth is a place of birth: in Italy a strong signal for IT; abroad («Z») names
//     no country and only contradicts a place of birth in Italy the text writes;
//   - the phone's country prefix (weak, like the residence) and the CV's language (weak, like a mother tongue)
//     count only beside a strong signal: two weak signals alone never name a country through them. The prefix
//     and the residence are one kind (both say where the candidate lives), the CV's language and the mother
//     tongue one kind too (an Italian CV of an Italian mother tongue is one fact, and a Ticinese writes both);
//   - the Swiss AHV/AVS number (756.…) is not read: it says the candidate was insured in Switzerland, which a
//     cross-border commuter is as well, never a nationality, and as a signal against one it would be wrong for
//     every Italian frontaliere;
//   - never the name or the surname: their origin is no evidence, and reading it would discriminate.

/** The country of a place as a CV writes it («Como (CO)», «Lugano», «Annecy, France»), '' when not unique. */
export function placeCountry(value) {
  const text = clean(value, 200);
  if (!text) return '';
  const { town, region, country } = splitTown(text);
  if (country) return country;
  const whole = countryCodeOf(text);
  if (whole) return whole;
  const entries = (town ? postalDirectory().get(fold(town)) || [] : []).filter((entry) => !region || entry.region === region);
  const countries = new Set(entries.map((entry) => entry.country));
  return countries.size === 1 ? [...countries][0] : '';
}

// Words of a school's name that are no place («Liceo Scientifico Statale»), never looked up as a town.
const SCHOOL_WORDS = new Set(`liceo licei scientifico classico linguistico artistico musicale coreutico statale paritario
istituto istituti tecnico tecnica tecnologico professionale professionali superiore superiori istruzione scuola scuole media
medie secondaria secondo primo grado commerciale commercio industriale magistrale agrario alberghiero ragioneria geometri
geometra perito periti diploma diplomi maturita matura esame stato quinquennale cantonale cantonali universita university
universitat politecnico high school college academy accademia gymnasium gymnase kantonsschule kantonale berufsschule
gewerbliche handelsschule berufsfachschule fachmittelschule lycee college ecole secondaire baccalaureat abitur santa santo
san sankt saint sainte via viale piazza corso`.split(/\s+/).filter(Boolean));
// Words only a Swiss school or title uses.
const SWISS_SCHOOL = /\b(?:kantonsschule\w*|kantonale\w* (?:schule|gymnasium|mittelschule)|liceo cantonale|licei cantonali|scuola cantonale|scuola media cantonale|scuola professionale (?:commerciale|artigianale|industriale)|spai|spc|cpt|gymnase cantonal|eidgenossisch\w*|schweizerisch\w*|efz|eba|afc|cfc|aff|eff|berufsmaturit\w*|maturita (?:federale|professionale federale|cantonale|liceale)|maturite (?:federale|gymnasiale|professionnelle federale)|attestato federale|certificat federal|fahigkeitszeugnis)\b/;
// Words only an Italian, a German, a French or a British school uses (after the place, which wins).
const SCHOOL_COUNTRY_WORDS = [
  ['IT', /\b(?:liceo (?:scientifico|classico|linguistico|artistico|musicale|delle scienze umane|economico)|liceo statale|istituto tecnico|istituto professionale|istituto (?:di istruzione|d istruzione) (?:secondaria )?superiore|istituto statale|itis|itc|itg|itcg|itt|ipsia|ipsar|ipsc|iis|isis|iiss|esame di stato|diploma di (?:maturita|ragioneria|geometra|perito)|perito (?:industriale|commerciale|aziendale|tecnico|informatico|elettronico|meccanico|chimico|agrario)|ragioniere|geometra|scuola secondaria di (?:primo|secondo) grado|licenza media|terza media)\b/],
  ['DE', /\b(?:abitur|allgemeine hochschulreife|fachhochschulreife|realschulabschluss|hauptschulabschluss)\b/],
  ['FR', /\b(?:baccalaureat|bac (?:general|technologique|professionnel|s|es|l|pro)|brevet des colleges)\b/],
  ['GB', /\b(?:a levels?|gcse\w*)\b/],
];

/** The country of the school or university an education entry names, '' when unknown or not unique. */
export function institutionCountry(value) {
  const text = fold(value);
  if (!text) return '';
  // A country written out («Liceo Italiano – Italia», «Gymnasium, Deutschland»).
  const named = new Set();
  for (const [name, code] of COUNTRY_BY_NAME) if (name.length > 3 && new RegExp(`\\b${name}\\b`).test(text)) named.add(code);
  if (named.size === 1) return [...named][0];
  if (named.size > 1) return '';
  if (SWISS_SCHOOL.test(text)) return 'CH';
  // A town of the public directory, read from the parts the CV separates («…, Como», «… di Varese», «(VA)»), else
  // from the words of the name that are no school word.
  const raw = clean(value, 300);
  const parts = raw.split(/\s*(?:[,;|()]|\s[-–—]\s)\s*/).filter(Boolean);
  const after = [...raw.matchAll(/\b(?:di|a|in|de|du|von|zu|at)\s+((?:\p{Lu}[\p{L}'’-]*\s*){1,3})/gu)].map((match) => match[1].trim());
  const found = new Set();
  for (const part of [...parts.slice(1), ...after]) {
    const code = placeCountry(part);
    if (code) found.add(code);
  }
  if (!found.size) {
    const words = text.split(' ').filter((word) => word.length >= 4 && !SCHOOL_WORDS.has(word));
    for (let size = 3; size >= 1 && !found.size; size -= 1) {
      for (let index = 0; index + size <= words.length; index += 1) {
        const entries = postalDirectory().get(words.slice(index, index + size).join(' ')) || [];
        const countries = new Set(entries.map((entry) => entry.country));
        if (countries.size === 1) found.add([...countries][0]);
      }
    }
  }
  if (found.size === 1) return [...found][0];
  if (found.size > 1) return '';
  const typical = SCHOOL_COUNTRY_WORDS.filter(([, re]) => re.test(text)).map(([code]) => code);
  return typical.length === 1 ? typical[0] : '';
}

// The place of birth the CV writes: «Luogo di nascita: Como», «Nato a Varese il 3.4.1990», «Geburtsort: Zürich»,
// «born in Milan», «née à Annecy», «Data e luogo di nascita: 03/04/1990, Como».
const BIRTHPLACE_LABELLED = /^(?:luogo (?:e data )?di nascita|data e luogo di nascita|place (?:and date )?of birth|date and place of birth|birthplace|place of origin|geburtsort|geburtsdatum (?:und|\/) ?-?ort|geburtsdatum,? (?:und )?geburtsort|lieu (?:et date )?de naissance|date et lieu de naissance)\s*[:\-–]?\s*(.+)$/iu;
const BORN_AT = /(?<![\p{L}])(?:[Nn]at[oa]|[Bb]orn|[Gg]eboren|[Nn][ée]e?)(?![\p{L}])(?:\s+(?:il|on|am|le)\s+[\p{L}\d./ -]{4,24}?)?\s+(?:a|ad|in|at|à)\s+(\p{Lu}[\p{L}'’ .-]*(?:\s*\(\s*[A-Z]{2}\s*\))?)/u;
const DATE_WORDS = /\b(?:\d{1,4}(?:[./-]\d{1,2}(?:[./-]\d{2,4})?)?|il|on|am|le|the|del|der|des|de|gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre|januar|februar|marz|mai|juni|juli|oktober|dezember|january|february|march|april|may|june|july|august|september|october|november|december|janvier|fevrier|mars|avril|juin|juillet|aout|septembre|octobre|decembre)\b/giu;

/** The country of the place of birth the CV writes, '' when it writes none or the place is not unique. */
export function cvBirthplaceCountry(cvText) {
  for (const raw of String(cvText ?? '').normalize('NFC').split(/\r?\n/)) {
    const line = raw.replace(/^[\s•·▪●○■□*–—-]+/u, '').trim();
    if (!line || line.length > 200) continue;
    const labelled = BIRTHPLACE_LABELLED.exec(line);
    const born = labelled ? null : BORN_AT.exec(line);
    const said = labelled ? labelled[1] : born ? born[1].split(/\s+(?:il|on|am|le|the)\s+/u)[0] : '';
    if (!said) continue;
    for (const part of said.split(/\s*[,;|]\s*/)) {
      const place = part.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(DATE_WORDS, ' ').replace(/\s+/g, ' ').trim();
      const code = /\p{L}{2}/u.test(place) ? placeCountry(place) : '';
      if (code) return code;
    }
  }
  return '';
}

// ── More offline signals (owner decision 2026-11-11, second part) ────────────
// Only what the CV or the order already holds. The candidate's name is never read for a nationality (its origin
// is no evidence of one, and reading it would discriminate), and it never leaves the platform (no web search).

// «Nazionalità: italiana», «Cittadinanza italiana e svizzera», «Nationality: Swiss / Italian»,
// «Staatsangehörigkeit: deutsch», «Nationalité : française», on a line of its own or between separators.
const NATIONALITY_LABEL = /(?:^|[|•·;\t]\s*)(?:doppia |dual |double |doppelte )?(?:nazionalita|cittadinanza|cittadinanze|nationality|nationalities|citizenship|citizenships|staatsangehorigkeit(?:en)?|staatsburgerschaft|nationalite|nationalites|nationalitat(?:en)?)(\s*[:\-–]\s*|\s+)([^|•·;\t]{2,80})/iu;
const declarationFold = (value) => String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss');
// The words around a declared nationality that name none («italiana (UE)», «Swiss citizen», «cittadino italiano»).
const DECLARATION_NOISE = /\s*\((?:eu|ue|efta|aele|aels)\)\s*|\b(?:citizen|cittadin[oa]|staatsburger(?:in)?|national)\b/giu;
const DECLARATION_PARTS = /\s*(?:[/,&+]|\s(?:e|ed|und|et|and)\s|\s[-–—]\s)\s*/i;

/**
 * The nationality the CV declares in so many words, or null: every country it names, and the one a single-choice
 * field takes (Swiss first, decision of 2026-10-04 on dual nationals, else the first written). Every part of the
 * declaration must be a nationality or a country the tables know, and two declarations must agree: a declaration
 * with a part the tables do not know («Nazionalità: italiana e marziana») makes the whole CV give none, whatever
 * another line says (review of #18097). A label without a colon and without a known nationality («Cittadinanza
 * attiva e Costituzione») is no declaration. The parser reads the same line into `profile.nationality`, which
 * wins: this reads the CV text of an order whose profile has none.
 * @returns {{code:string, codes:string[]}|null}
 */
export function cvDeclaredNationality(cvText) {
  let found = null;
  for (const raw of String(cvText ?? '').normalize('NFC').split(/\r?\n/)) {
    const line = declarationFold(raw.replace(/^[\s•·▪●○■□*–—-]+/u, '').trim());
    if (!line || line.length > 200) continue;
    const match = NATIONALITY_LABEL.exec(line);
    if (!match) continue;
    // Up to the next column («Nazionalità: italiana     Patente: B») or label («…, Patente: B»).
    const said = match[2].split(/\s{3,}|,\s*[\p{L} ]{2,30}:/u)[0];
    const value = said.replace(DECLARATION_NOISE, ' ').replace(/[.\s]+$/u, '').replace(/\s+/g, ' ').trim();
    const parts = value.split(DECLARATION_PARTS).filter(Boolean);
    const codes = parts.map((part) => nationalityOf(part)?.code || (part.length > 3 ? countryCodeOf(part) : ''));
    // A declaration: the label with a colon, or a nationality the tables know after it.
    const declaration = /[:\-–]/.test(match[1]) || codes.some(Boolean);
    if (!declaration) continue;
    // A part the tables do not know: the CV's declaration is ambiguous, and no other line overrides it.
    if (!codes.length || codes.some((code) => !code)) return null;
    const unique = [...new Set(codes)];
    const declared = { code: unique.includes('CH') ? 'CH' : unique[0], codes: unique };
    if (found && [...found.codes].sort().join() !== [...declared.codes].sort().join()) return null;
    found = found || declared;
  }
  return found;
}

// The Italian codice fiscale: 16 characters, digits replaceable by letters (omocodia). Its 12th–15th characters are
// the cadastral code of the place of birth: a letter other than Z is an Italian municipality, Z a foreign country.
const CODICE_FISCALE = /(?<![A-Z0-9])[A-Z]{6}[0-9LMNPQRSTUV]{2}[ABCDEHLMPRST][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z](?![A-Z0-9])/g;
const CF_ODD = [1, 0, 5, 7, 9, 13, 15, 17, 19, 21, 2, 4, 18, 20, 11, 3, 6, 8, 12, 14, 16, 10, 22, 25, 24, 23];
const cfValue = (char) => (/\d/.test(char) ? Number(char) : char.charCodeAt(0) - 65);

/**
 * Whether the 16th character is the check character of the first 15 (the ministerial algorithm, DM 23/12/1976).
 * The check is computed on the characters as written: an omocodia letter counts as a letter, because the check
 * character of an omocodic code is computed again on the substituted code (the variant of a code that keeps the
 * original's check character is no valid code; review of #18097, verified).
 */
export function codiceFiscaleValid(code) {
  const text = String(code ?? '').toUpperCase();
  if (!/^[A-Z0-9]{16}$/.test(text)) return false;
  let sum = 0;
  for (let index = 0; index < 15; index += 1) sum += index % 2 === 0 ? CF_ODD[cfValue(text[index])] : cfValue(text[index]);
  return String.fromCharCode(65 + (sum % 26)) === text[15];
}

/**
 * Where the codice fiscale in the CV says the candidate was born: 'IT' for an Italian municipality, 'abroad' for a
 * foreign country (the repository holds no public table of the Z codes, so the country is not named), '' with no
 * valid code or with two different ones (another person's code is no evidence). The code is read here only, for
 * this signal: never returned, stored, logged or printed.
 * @returns {''|'IT'|'abroad'}
 */
export function codiceFiscaleBirthCountry(cvText) {
  const codes = new Set();
  for (const match of String(cvText ?? '').toUpperCase().matchAll(CODICE_FISCALE)) {
    if (codiceFiscaleValid(match[0])) codes.add(match[0]);
  }
  if (codes.size !== 1) return '';
  return [...codes][0][11] === 'Z' ? 'abroad' : 'IT';
}

// A phone line of the CV («Tel. +39 …», «Mobile: 0041 …»); only an international prefix names a country.
const PHONE_LINE = /\b(?:tel|telefono|telephone|telefon|phone|cell|cellulare|mobile|mobil|handy|natel|portable|cellphone|whatsapp)\b/i;
const INTERNATIONAL_NUMBER = /(?:\+|(?<!\d)00)\s?\d[\d\s./()-]{6,20}\d/g;

/**
 * The country of the candidate's phone prefix (+39, 0041…), '' for a national number or none: the phone the
 * candidate gave or corrected first, then the order's, then the parser's, then the phone lines of the CV text
 * (one country only). A prefix is never guessed from a national number (lib/phoneNormalization.js).
 */
export function candidatePhoneCountry({ identity = {}, order = {}, profile = {}, cvText = '' } = {}) {
  for (const value of [identity?.phone, order?.applicantPhone, profile?.phone]) {
    const code = phoneCountryCode(clean(value, 80));
    if (code) return code;
  }
  const countries = new Set();
  for (const line of String(cvText ?? '').split(/\r?\n/)) {
    if (!PHONE_LINE.test(line)) continue;
    for (const match of line.matchAll(INTERNATIONAL_NUMBER)) {
      const code = phoneCountryCode(match[0]);
      if (code) countries.add(code);
    }
  }
  return countries.size === 1 ? [...countries][0] : '';
}

// A mother tongue spoken as such in one country only names it; one of several countries only confirms.
const MOTHER_TONGUE = /\b(?:madrelingua|lingua madre|native|mother tongue|muttersprach\w*|erstsprache|langue maternelle|first language|prima lingua)\b/;
const LANGUAGE_COUNTRY = { it: 'IT', pl: 'PL', hu: 'HU', cs: 'CZ', sk: 'SK', sl: 'SI', bg: 'BG', ro: 'RO', hr: 'HR', lt: 'LT', lv: 'LV', et: 'EE', fi: 'FI', da: 'DK', sv: 'SE' };
const LANGUAGE_COUNTRIES = { de: ['DE', 'AT', 'CH', 'LI'], fr: ['FR', 'CH', 'BE', 'LU'], nl: ['NL', 'BE'], el: ['GR', 'CY'], es: ['ES'], pt: ['PT'], en: ['GB', 'IE'], no: ['NO'] };

const schoolText = (item) => fold(`${item?.degree || ''} ${item?.institution || ''}`);
const isUpperSecondary = (item) => MATURITY_RE.test(schoolText(item)) && !UNIVERSITY_RE.test(fold(item?.degree));
const isCompulsory = (item) => !isUpperSecondary(item) && (educationLevelRank(item?.degree) ?? educationLevelRank(item?.institution)) === 1;
const isUniversity = (item) => !isUpperSecondary(item) && UNIVERSITY_RE.test(schoolText(item));

/**
 * The nationality the CV implies, or null (owner decision 2026-11-11). `signals` lists the signals read, for the
 * record; the value is a country code of the platform's tables. `phoneCountry` is candidatePhoneCountry()'s.
 * @returns {{code:string, signals:string[]}|null}
 */
export function deducedNationality({ profile = {}, cvText = '', residenceCountry = '', phoneCountry = '' } = {}) {
  const education = (Array.isArray(profile?.education) ? profile.education : []).filter((item) => item && typeof item === 'object');
  const located = (predicate) => [...new Set(education.filter(predicate)
    .map((item) => institutionCountry(`${item.institution || ''}, ${item.degree || ''}`)).filter(Boolean))];
  const schools = located(isUpperSecondary);
  if (schools.length === 1) return { code: schools[0], signals: ['upper_secondary_school'] };
  const strong = [];
  const confirming = [];
  // Weak signals that count only beside a strong one (second part of the decision), each of the kind it repeats.
  const besideStrong = [];
  for (const code of schools) strong.push({ kind: 'upper_secondary_school', codes: [code] });
  const birth = cvBirthplaceCountry(cvText);
  const fiscalBirth = codiceFiscaleBirthCountry(cvText);
  // A codice fiscale of a birth abroad contradicts a place of birth in Italy the text writes: neither is read.
  if (birth && !(fiscalBirth === 'abroad' && birth === 'IT')) strong.push({ kind: 'birthplace', codes: [birth] });
  if (fiscalBirth === 'IT') strong.push({ kind: 'birthplace', name: 'codice_fiscale_birthplace', codes: ['IT'] });
  for (const code of located(isCompulsory)) strong.push({ kind: 'compulsory_school', codes: [code] });
  for (const entry of Array.isArray(profile?.languages) ? profile.languages : []) {
    if (!MOTHER_TONGUE.test(fold(entry?.level)) || /\bbilingu/.test(fold(entry?.level))) continue;
    const [language] = languageCodesIn(entry?.language || '');
    if (LANGUAGE_COUNTRY[language]) strong.push({ kind: 'mother_tongue', codes: [LANGUAGE_COUNTRY[language]] });
    else if (LANGUAGE_COUNTRIES[language]) confirming.push({ kind: 'mother_tongue', codes: LANGUAGE_COUNTRIES[language] });
  }
  for (const code of located(isUniversity)) confirming.push({ kind: 'university', codes: [code] });
  if (residenceCountry) confirming.push({ kind: 'residence', codes: [residenceCountry] });
  // The phone's prefix says where the candidate lives, as the residence does; the CV's language what they speak,
  // as a mother tongue does (lists of several countries, like German, only confirm).
  if (phoneCountry) besideStrong.push({ kind: 'residence', name: 'phone_prefix', codes: [phoneCountry] });
  const cvLanguage = String(profile?.cvLanguage || '').slice(0, 2).toLowerCase();
  const cvLanguageCodes = LANGUAGE_COUNTRY[cvLanguage] ? [LANGUAGE_COUNTRY[cvLanguage]] : LANGUAGE_COUNTRIES[cvLanguage] || [];
  if (cvLanguageCodes.length) besideStrong.push({ kind: 'mother_tongue', name: 'cv_language', codes: cvLanguageCodes });
  // A strong signal for another country stops the deduction; without a strong one, the country a weak signal
  // names (a university, the residence) may still gather two, and the phone and the CV's language are not read.
  const strongCodes = new Set(strong.flatMap((signal) => signal.codes));
  if (strongCodes.size > 1) return null;
  const countries = strongCodes.size ? [...strongCodes]
    : [...new Set(confirming.filter((signal) => signal.codes.length === 1).map((signal) => signal.codes[0]))];
  const signals = [...strong, ...confirming, ...(strongCodes.size ? besideStrong : [])];
  // Kinds, not entries: two universities in one country are one signal, the prefix beside the residence too.
  const supported = countries.map((code) => {
    const naming = signals.filter((signal) => signal.codes.includes(code));
    return { code, kinds: new Set(naming.map((signal) => signal.kind)), names: [...new Set(naming.map((signal) => signal.name || signal.kind))] };
  }).filter((item) => item.kinds.size >= 2);
  if (supported.length !== 1) return null;
  const [{ code, names }] = supported;
  // Only a country the forms can name (nationality table, country names).
  if (!nationalityLabelOf(code, 'en') && !countryName(code, 'en')) return null;
  return { code, signals: names };
}

/** The upload-time answers (order.candidateFacts, owner decision 2026-11-09). */
export const CANDIDATE_PASSPORTS = Object.freeze(['swiss', 'eu_efta', 'other']);
const UPLOAD_PERMITS = new Set(['swiss', 'permit_c', 'permit_b', 'permit_l', 'permit_g', 'none']);

/**
 * The two legal facts asked at CV upload (owner decision 2026-11-10): an entry in the criminal record, an entry
 * in the debt-enforcement or bankruptcy register. Each is 'no' or 'yes'; an order uploaded before has neither.
 */
export const CANDIDATE_LEGAL_FACTS = Object.freeze(['criminalRecord', 'debtRecord']);
const LEGAL_RECORD_ANSWERS = Object.freeze(['no', 'yes']);
const legalRecordAnswer = (value) => (LEGAL_RECORD_ANSWERS.includes(value) ? value : '');

/**
 * The candidate's upload answers as stored, or null when the input is not a complete, valid set. The legal facts
 * are optional (an order or a page opened before they were asked), but a value given must be 'no' or 'yes'.
 */
export function sanitizeCandidateFacts(value) {
  if (!value || typeof value !== 'object') return null;
  const workPermit = clean(value.workPermit, 20);
  const passport = clean(value.passport, 20);
  const nationality = clean(value.nationality, 80);
  if (!UPLOAD_PERMITS.has(workPermit) || !CANDIDATE_PASSPORTS.includes(passport) || !nationality) return null;
  const legal = {};
  for (const key of CANDIDATE_LEGAL_FACTS) {
    const answer = clean(value[key], 5);
    if (!answer) continue;
    if (!LEGAL_RECORD_ANSWERS.includes(answer)) return null;
    legal[key] = answer;
  }
  return { workPermit, passport, nationality, ...legal };
}

/**
 * The passport class used by screening forms: an explicit upload answer wins; otherwise a known nationality
 * (including one declared or deduced from the CV) gives the Swiss, EU/EFTA or other catalog option. A permit
 * never establishes citizenship. Unknown or unrecognized nationality stays unknown and is asked.
 */
export function passportOf({ passport = '', nationality = '' } = {}) {
  if (CANDIDATE_PASSPORTS.includes(passport)) return passport;
  const countryCode = countryCodeOf(nationality);
  const codes = new Set([...nationalityCodes(nationality), ...(countryCode ? [countryCode] : [])]);
  if (codes.has('CH')) return 'swiss';
  if ([...codes].some((item) => {
    const group = nationalityOf(nationalityLabelOf(item, 'en'))?.group;
    return group === 'eu' || group === 'efta';
  })) return 'eu_efta';
  if (codes.size) return 'other';
  return '';
}

/** Facts that need no candidate: dates, consents, availabilities. */
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
const HOUSE_NUMBER_FIELD = /\b(?:numero civico|n civico|civico|hausnummer|haus nr|house number|street number|numero de rue|no de rue)\b/;
const STREET = /\b(?:via|strasse|street|rue|indirizzo|adresse|address|anschrift)\b/;
const STREET_STRICT = /\b(?:via|strada|strasse|street|rue)\b/;
const STREET_NAME_ONLY = /\b(?:nome (?:della )?(?:sua |tua )?via|street name|strassenname|nom de (?:la )?rue)\b/;
const NOT_ADDRESS = /\b(?:whatsapp|sms|telefon\w*|phone|cellulare|mobile|handy|e ?mail|email|courriel)\b/;
const AGE_LIMIT = /\b(?:(meno di|under|unter|moins de|almeno|at least|mindestens|au moins|piu di|over|uber|plus de))\s+(\d{1,2})\s+(?:anni|years?|jahre?|ans)\b/;
const CITY = /\b(?:citta|city|ort|wohnort|localita|ville|town|comune|lieu|gemeinde)\b/;
// The canton or province of the address («State», «Kanton», «Canton», «Provincia», «Region»); never «Stato», the country.
const REGION = /\b(?:state|province|provinz|provincia|kanton|canton|cantone|region|regione|bundesland|county|departement|department)\b/;
// A region the candidate would work in is a preference, not the address («Preferred region», «Arbeitsregion»).
const REGION_PREFERENCE = /\b(?:prefer\w*|desired|wish\w*|wunsch\w*|gewunscht\w*|bevorzug\w*|preferit\w*|desiderat\w*|souhait\w*|einsatz\w*|arbeits\w*|work\w*|lavoro|travail|job|stelle|mobilit\w*)\b/;
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
// A declaration of suitability for, or of interest in, the position the candidate applies for (owner decision
// 2026-11-10: «Dichiara la propria idoneità alla funzione prevista dal bando?» is always yes: they are applying).
// Never a fitness that is a fact of health or law (medical, physical, conduct, criminal record), never a conflict
// of interest, never other or future positions (a job alert), never a workload.
const SUITABILITY = /\b(?:idone\w*|suitab\w*|suited|geeignet\w*|eignung|apte|aptitude|interess\w*|interest\w*|interet\w*)\b/;
const APPLIED_FUNCTION = /\b(?:funzion\w*|posizion\w*|ruolo|mansion\w*|posto|bando|concorso|incarico|position|role|job|post|vacancy|stelle|funktion|ausschreibung|poste|fonction|emploi)\b/;
const NOT_SUITABILITY = /\b(?:job ?alerts?|alerts?|avvis\w*|notific\w*|newsletter\w*|talent ?pool\w*|jobabo\w*|benachrichtig\w*|sanitar\w*|fisic\w*|psic\w*|medic\w*|salute|health\w*|physical\w*|mental\w*|gesundheit\w*|korperlich\w*|arztlich\w*|psychisch\w*|sante|physique\w*|condott\w*|casellario|penal\w*|criminal\w*|moral\w*|giuridic\w*|legal\w*|vaccin\w*|leumund\w*|strafregister\w*|casier|conduct\w*|record|judiciaire|conflitt\w*|conflict\w*|\w*konflikt\w*|conflit\w*|altr[aeio]|other|weitere\w*|andere\w*|autres?|futur\w*|ulterior\w*|simil\w*|similar|part ?time|tempo parziale|teilzeit|temps partiel|full ?time|tempo pieno|vollzeit|temps plein|pensum|percent\w*|percentuale)\b/;
// Guard or standby duty asked as an availability (owner decision 2026-11-10: on-call duty in every wording is
// always yes). Only with an availability word: «Hai svolto servizio di guardia?» asks a fact of the past.
// French «piquet» also names a past duty («Avez-vous effectué un service de piquet ?»): only its availability is ours.
const GUARD_DUTY = /\b(?:piquet\w*|servizi\w* di guardia|turn\w* di guardia|service de garde|services de garde|notfalldienst\w*|stand ?by)\b/;
// Support to other sites or branches of the employer, or flexibility on the place of work (owner decision
// 2026-11-10: the same family as relocation, hybrid work and on-call duty, always yes). A yes/no availability
// only: «Hai lavorato in una succursale?» is a fact, «In quale sede preferisci lavorare?» a choice.
const OTHER_SITES = /\b(?:succursal\w*|filial\w*|altre sedi|altra sede|diverse sedi|piu sedi|tutte le sedi|nostre sedi|sedi (?:di|del|della|dei|delle|in|a)|sede (?:di|del|della|in|a)|other (?:sites|locations|branches|offices)|(?:several|multiple|different|all (?:our )?|our) (?:sites|locations|branches|offices)|branch(?:es)?|branch offices?|standort\w*|zweigstelle\w*|geschaftsstelle\w*|niederlassung\w*|agences?|autres sites|plusieurs sites|differents sites|(?:tous )?(?:nos|les) sites|sites? de)\b/;
const SITE_FLEXIBILITY = /\b(?:flessibilit\w* (?:di|della|sulla|sul|riguardo alla) (?:sede|luogo di lavoro)|mobilit\w* (?:tra|fra) (?:le )?sedi|standortflexib\w*|ortsflexib\w*|flexib\w* (?:beim|hinsichtlich des) (?:arbeitsort|einsatzort|standort)|flexibilit\w* (?:quant au|du|sur le) (?:lieu|site)|flexib\w* (?:on|about|regarding) (?:the )?(?:work ?place|place of work|location|work location))\b/;
const RECORDING = /\b(?:registrazion\w*|recording|recorded|aufnahme\w*|aufzeichn\w*|enregistr\w*|audio)\b/;
const CONSENT = /\b(?:consens\w*|acconsent\w*|consent\w*|einwillig\w*|zustimm\w*|autoris\w*|accett\w*|accept\w*|informato|informed)\b/;
const MARKETING = /\b(?:newsletter\w*|marketing|promozional\w*|pubblicit\w*|werbung|werbe\w*|publicit\w*|offerte commerciali|job ?alert\w*|jobabo\w*|talent ?pool\w*|talent community|corsi|academy|opportunita di formazione|weitere angebote|offres commerciales|informazioni (?:su|sulle|riguardo))\b/;
const PRIVACY = /\b(?:informativa|privacy|datenschutz\w*|protection des donnees|donnees personnelles|trattamento dei (?:tuoi )?dati|dati personali|data protection|personal data|privacy notice|privacy policy)\b/;
const LANGUAGE_LEVEL = /\b(?:livello|level|niveau|proficiency|fluency|fluent|conoscenz\w*|kenntnis\w*|competenz\w*|parli|speak|sprechen|parlez|sprachkenntnisse)\b/;
// Business travel (owner decision 2026-11-10: availability is always yes, like relocation and on-call duty).
const TRAVEL = /\b(?:business travel\w*|travel\w*|trasfert\w*|viagg\w*|reisebereitschaft|reisetatigkeit\w*|reisen|dienstreise\w*|geschaftsreise\w*|deplacement\w*|voyag\w*)\b/;
const AVAILABLE = /\b(?:availab\w*|willing\w*|ready|prepared|open to|dispost\w*|disponibil\w*|bereit\w*|bereitschaft|disponible\w*|pret\w*|can you|are you able|potresti|sei in grado|konnen sie|pouvez vous)\b/;
const TRAVEL_NOT_AVAILABILITY = /\b(?:cost\w*|spes\w*|kosten|frais|reimburs\w*|rimbors\w*|ruckerstatt\w*|visa|visto|percent\w*|percentuale|prozent|pour ?cent|how often|quanto spesso|wie oft|combien de fois|how much|quanti giorni|wie viele tage)\b/;

// Visibility of the candidate's profile, or forwarding of the application, inside the employer (owner decision
// 2026-11-10, Stadt Zürich: «Eigenes Profil sichtbar machen für: Alle Recruiter*innen der Stadt Zürich …
// erforderlich, damit Ihre Bewerbung stadtintern weitergeleitet werden kann»). It serves the application and is
// not marketing: the broadest audience inside the same employer is chosen. Never a third party, the public,
// another company of a group or a marketing list.
const VISIBILITY = /\b(?:profil\w* (?:\w+ )?(?:sichtbar\w*|visib\w*)|sichtbar\w* (?:machen )?fur|sichtbarkeit|visibilit\w*|visible (?:to|for|a|pour|per)|rendere visibile|rendre (?:\w+ )?(?:profil|candidature|dossier) visible|chi puo vedere|who can (?:see|view)|wer (?:darf|kann) (?:\w+ ){0,2}(?:sehen|einsehen))\b/;
const FORWARD_INTERNAL = /\b(?:stadtintern\w*|verwaltungsintern\w*|unternehmensintern\w*|firmenintern\w*|hausintern\w*|intern\w* weiter\w*|weiterleit\w* (?:\w+ ){0,3}intern\w*|inoltrat\w* internamente|inoltr\w* (?:\w+ ){0,3}intern\w*|forward\w* internally|internally forward\w*|shared internally|condivis\w* internamente|transmis\w* en interne|transmettre en interne)\b/;
// Other positions or units of the same employer: an audience inside it in an option, never enough alone for a
// yes/no («informed about other positions» is a job alert, which the owner declines).
const OTHER_POSITIONS = /\b(?:other (?:open )?(?:positions|vacancies|departments|roles|jobs)|altre (?:posizioni|funzioni|unita|offerte)|weitere (?:offene )?stellen|andere (?:stellen|abteilungen|organisationseinheiten|dienstabteilungen)|autres (?:postes|services|departements))\b/;
const NOTIFICATION = /\b(?:informier\w*|informazion\w*|information(?:s|en)?|informed|inform|benachrichtig\w*|notif\w*|avvis\w*|aggiornament\w*|updates?|alert\w*|abonn\w*|subscri\w*|iscriv\w*)\b/;
const EMPLOYER_RECRUITERS = /\b(?:recruiter\w*|recruiting|recruteu\w*|recrutement|personalverantwortlich\w*|personalabteilung\w*|personaldienst\w*|personalfachleute|hr|human resources|risorse umane|ressources humaines|selezionator\w*|reclutator\w*|hiring (?:managers?|team)|responsabil\w* (?:della )?selezione|organisationseinheit\w*|unita organizzativ\w*)\b/;
const OUTSIDE_EMPLOYER = /\b(?:dritt\w*|third part\w*|terze parti|terzi|tiers|extern\w*|esterni|partner\w*|agenz\w*|agenc\w*|agences?|personalvermittl\w*|headhunter\w*|publicly|pubblicamente|publiquement|offentlich sichtbar|public profile|profilo pubblico|profil public|everyone|tutti gli utenti|all users|alle (?:nutzer\w*|besucher\w*)|altre aziende|other (?:companies|employers)|andere (?:unternehmen|firmen|arbeitgeber)|autres (?:entreprises|employeurs)|gruppo|group companies|konzern\w*|tochtergesellschaft\w*|filiale\w*|affiliat\w*|consociat\w*)\b/;
const BROAD_AUDIENCE = /\b(?:alle|all|tutti|tutte|tous|toutes|samtlich\w*|gesamt\w*|entire|whole|ogni|jede\w*|qualsiasi|stadtintern\w*|verwaltungsintern\w*|unternehmensintern\w*|internamente|internally|en interne|organisationseinheit\w*|unita organizzativ\w*)\b/;
const NARROW_AUDIENCE = /\b(?:nur|only|solo|soltanto|unicamente|seulement|uniquement|ausschliesslich|exclusively|esclusivamente)\b/;

function visibilityPrompt(question) {
  const owners = Array.isArray(question?.addressContext?.owners) ? question.addressContext.owners : [];
  return fold([question?.applicationQuestion, question?.question, question?.label, question?.context, ...owners]
    .filter((value) => typeof value === 'string').join(' '));
}

/** Both catalogues of a choice: the one the candidate reads and the portal's own, index by index. */
function bilingualOptions(question) {
  const shown = optionsOf(question);
  const native = (Array.isArray(question?.applicationOptions) ? question.applicationOptions : [])
    .map((option) => String((typeof option === 'string' ? option : option?.label ?? option?.value) ?? '').trim());
  return shown.map((option, index) => fold(`${option} ${native.length === shown.length ? native[index] : ''}`));
}

/**
 * The audience inside the employer an option opens the profile to: higher is broader, null for an option that
 * reaches outside the employer or a marketing list.
 */
function internalAudienceRank(text) {
  if (OUTSIDE_EMPLOYER.test(text) || MARKETING.test(text) || NOTIFICATION.test(text)) return null;
  const forwarded = FORWARD_INTERNAL.test(text) || OTHER_POSITIONS.test(text);
  if (!EMPLOYER_RECRUITERS.test(text) && !forwarded) return null;
  return (BROAD_AUDIENCE.test(text) ? 2 : 0) + (forwarded ? 1 : 0) - (NARROW_AUDIENCE.test(text) ? 2 : 0);
}

/** Whether the field asks who inside the employer may see the profile or receive the application. */
function isProfileVisibilityQuestion(question) {
  const prompt = visibilityPrompt(question);
  const own = label(question);
  if (MARKETING.test(own) || OUTSIDE_EMPLOYER.test(own) || NOTIFICATION.test(own)) return false;
  if (isBinary(question)) {
    return (VISIBILITY.test(own) && (EMPLOYER_RECRUITERS.test(own) || FORWARD_INTERNAL.test(own) || OTHER_POSITIONS.test(own)))
      || FORWARD_INTERNAL.test(own);
  }
  const options = bilingualOptions(question);
  if (options.length < 2) return false;
  const signalled = VISIBILITY.test(prompt) || options.some((option) => FORWARD_INTERNAL.test(option));
  return signalled && options.some((option) => internalAudienceRank(option) !== null);
}

/** The broadest option inside the employer, or '' when two are equally broad or none is internal. */
function profileVisibilityOption(question) {
  const shown = optionsOf(question);
  const ranked = bilingualOptions(question).map((text, index) => ({ option: shown[index], rank: internalAudienceRank(text) }))
    .filter((item) => item.rank !== null)
    .sort((left, right) => right.rank - left.rank);
  if (!ranked.length || (ranked.length > 1 && ranked[0].rank === ranked[1].rank)) return '';
  return ranked[0].option;
}

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
  profile_visibility: 'privacy',
};
const HISTORY_AVAILABILITY_TOPICS = new Set([
  'start_date', 'notice_period', 'preferred_workload', 'relocation', 'hybrid', 'on_call', 'other_sites', 'business_travel',
]);

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

/**
 * The platform topic of a question, or null for one the platform does not answer.
 * `ownedAddressFields` (platformCandidateFacts' `ownedAddressFields`, from ownedAddressTwinFields): the address
 * fields of a block the order's own questions prove to be the candidate's, by the same set of fields.
 */
export function platformQuestionTopic(question, { ownedAddressFields = null } = {}) {
  const topic = classifyPlatformTopic(question, ownedAddressFields);
  if (!topic) return null;
  if (HISTORY_AVAILABILITY_TOPICS.has(topic) && isWorkHistoryContext(question)) return null;
  const text = label(question);
  const family = TOPIC_FAMILY[topic] || null;
  const subjects = Object.entries(SUBJECT_FAMILIES).filter(([name, re]) => name !== family && re.test(text)).map(([name]) => name);
  // An address, a birth date, a permit, a language level … carry no second subject of the list. A marketing
  // request names its channel («newsletter by e-mail»); declining it declines both.
  const compatible = { marketing_opt_in: ['contact'], profile_visibility: ['contact'] }[topic] || [];
  if (subjects.some((name) => !compatible.includes(name))) return null;
  const identifiers = nativeIdentifiers(question);
  if (identifiers && NATIVE_FACT_ID.test(identifiers)) {
    const expected = { residence_country: /country/i, work_permit: /permit/i, nationality: /nation/i, birth_date: /birth|dob/i,
      birth_day: /birth|dob/i, birth_month: /birth|dob/i, birth_year: /birth|dob/i, address_street: /address|street/i,
      address_street_name: /address|street/i, address_house_number: /address|street/i, residence_postal_code: /postal|zip|address/i,
      residence_city: /city|address/i, residence_region: /state|province|region|canton|kanton|county|address/i, salary_expectation: /salary/i, education_level: /qualification|education|degree/i, held_title: /qualification|education|degree/i }[topic];
    if (!expected || !expected.test(identifiers)) return null;
  }
  return topic;
}

const ADDRESS_TOPICS = new Set(['residence_postal_code', 'residence_country', 'residence_city', 'residence_region', 'address_street', 'address_street_name', 'address_house_number']);
const OTHER_PARTY = /\b(?:datore|employer\w*|arbeitgeber\w*|azienda|aziendale|company|firma|firmen\w*|entreprise|employeur|referenz\w*|reference\w*|referee|contatto di emergenza|emergency|notfall\w*|urgence|genitor\w*|parent\w*|eltern|tutore|guardian|fatturazione|billing|rechnung\w*|facturation|consegna|delivery|lieferung|livraison|lavoro precedente|previous job|ultimo impiego|kontaktperson\w*|ansprechperson\w*|ansprechpartner\w*|contact person|persona di contatto|personne de contact|geschaftsadresse|business address|work address|adresse professionnelle|vorgesetzt\w*)\b/;
// A heading that names an address of the candidate's own, without saying whose («Postadresse»,
// «Korrespondenzadresse», «Adresse», «Indirizzo postale», «Mailing address»): in the candidate's application
// form it is theirs (owner decision 2026-11-11, Yellowshark 1EpmkrDu). Another party's is named, and OTHER_PARTY
// is read first.
const OWN_ADDRESS = /\b(?:(?:post|wohn|korrespondenz|zustell|privat|heim|haupt)?adresse|address|mailing address|postal address|indirizzo(?: postale| di corrispondenza)?|recapito|anschrift|adresse postale|adresse de correspondance|correspondence|corrispondenza|domicile|domicilio)\b/;
// The candidate's own profile and application form own an address too («Profilinformationen»,
// «Stellenbewerbungsformular», Helsana 2026-11-10; «My profile», «Il mio profilo», «Mon profil»).
const SELF_OWNER = /\b(?:personal\w*|persona\w*|personlich\w*|personnel\w*|candidat\w*|applicant\w*|bewerber\w*|your|tu[oa]i?|dati anagrafici|anagrafica|contact (?:details|information)|kontakt\w*|coordonnees|residen\w*|wohn\w*|domicil\w*|profil\w*|profile\w*|(?:stellen)?bewerbung\w*|application form|modulo di candidatura|formulaire de candidature|my details|meine daten|i miei dati|mes informations)\b/;

/**
 * An address field is the candidate's only when nothing says otherwise: its
 * visible context (section, fieldset, nearby heading) and its native ownership
 * contract (lib/addressContextContract.js) must not name another party, and an
 * unreadable contract is not ownership.
 */
// The candidate's own identity fields among the labels of a form («Vorname · Nachname · E-Mail · Geburtstag»).
const IDENTITY_FIELD_RE = /\b(?:vorname|nachname|first name|last name|surname|nome|cognome|prenom|nom|e ?mail|geburt\w*|date of birth|birth\w*|data di nascita|nascita|naissance)\b/g;

/** The field context lists the labels of the candidate's own form: two identity fields or more. */
function candidateFormContext(context) {
  return new Set(fold(context).match(IDENTITY_FIELD_RE) || []).size >= 2;
}

/** Whether anything around an address field names another party, or its native contract cannot be read. */
function addressNamesOtherParty(question) {
  const context = typeof question?.context === 'string' ? question.context : '';
  const section = typeof question?.section === 'string' ? question.section : '';
  const around = fold([context, section].join(' '));
  // A context that lists the candidate's own form (Yellowshark 1EpmkrDu, 2026-11-10: «Anrede · Company · Frau ·
  // Herr · Vorname · Nachname · E-Mail · Strasse …») is theirs even when a sibling label names a company (here a
  // form-of-address option); the field's own section and label still decide against another party.
  const otherAround = candidateFormContext(context) ? OTHER_PARTY.test(fold(section)) : OTHER_PARTY.test(around);
  if (otherAround || OTHER_PARTY.test(label(question))) return true;
  const contract = addressContextContract(question);
  if (contract === undefined) return false;
  if (contract === null || contract.unknown) return true;
  return [contract.section, ...contract.owners].map(fold).filter(Boolean).some((owner) => OTHER_PARTY.test(owner));
}

function candidateOwnsAddress(question) {
  if (addressNamesOtherParty(question)) return false;
  const contract = addressContextContract(question);
  if (contract === undefined) return true;
  const owners = [contract.section, ...contract.owners].map(fold).filter(Boolean);
  // A native contract that names no party is the candidate's when a heading names their own data or an address of
  // theirs, or when the field sits among the candidate's own identity fields: Yellowshark 1EpmkrDu (2026-11-11)
  // read its second extraction of the same form under the neutral heading «Hier sind Sie richtig», and the
  // candidate was asked street, number, postal code and town a second time.
  return owners.length === 0 || owners.some((owner) => SELF_OWNER.test(owner) || OWN_ADDRESS.test(owner))
    || candidateFormContext(typeof question?.context === 'string' ? question.context : '');
}

/** The address part a field asks, whoever's address it is; '' for no address field. */
function addressFieldTopic(question) {
  const subject = classifyPlatformSubject(question);
  // A street field beside its own house-number field («Strasse · Hausnummer») takes the street name only. Only a
  // real house-number label counts («Numero di telefono» is no such field).
  const topic = subject === 'address_street' && typeof question?.context === 'string'
    && HOUSE_NUMBER_FIELD.test(fold(question.context)) && !HOUSE_NUMBER.test(label(question)) ? 'address_street_name' : subject;
  return topic || '';
}

/**
 * The identity of an address field across the draft and the live form: its native caption, its heading and its
 * ownership contract. The live planner's field (`label`) and the draft's question (`applicationQuestion`) agree.
 */
export function addressFieldSignature(question) {
  const caption = fold(question?.applicationQuestion || question?.label || question?.question);
  if (!caption) return '';
  const contract = addressContextContract(question);
  return `${caption}|${fold(question?.section)}|${contract === undefined ? '' : JSON.stringify(contract)}`;
}

function addressBlockKey(question) {
  const contract = addressContextContract(question);
  return `${fold(question?.section)}|${contract === undefined ? `context:${fold(question?.context)}` : JSON.stringify(contract)}`;
}

function classifyPlatformTopic(question, ownedAddressFields = null) {
  const topic = addressFieldTopic(question);
  if (!topic || !ADDRESS_TOPICS.has(topic)) return topic || null;
  if (candidateOwnsAddress(question)) return topic;
  // A block the order proved the candidate's by its fields (ownedAddressTwinFields), never one naming another party.
  const owned = Array.isArray(ownedAddressFields) && ownedAddressFields.includes(addressFieldSignature(question));
  return owned && !addressNamesOtherParty(question) ? topic : null;
}

/**
 * The candidate's address blocks of one order, by question id → address topic (owner decision 2026-11-11): every
 * block the candidate owns (candidateOwnsAddress), and a block whose heading names nobody but whose fields are the
 * same as, or a part of, those of a block of the candidate's (a second step, a postal or correspondence block).
 * A block that names another party (employer, reference, billing…) stays out, and so does a topic a block asks
 * twice (two street lines): which line takes the street is not known.
 * @returns {Map<string, string>}
 */
export function candidateAddressTopics(questions = []) {
  const blocks = new Map();
  for (const question of Array.isArray(questions) ? questions : []) {
    if (!question?.id) continue;
    const topic = addressFieldTopic(question);
    if (!ADDRESS_TOPICS.has(topic) || addressNamesOtherParty(question)) continue;
    const key = addressBlockKey(question);
    if (!blocks.has(key)) blocks.set(key, { owned: false, fields: [] });
    const block = blocks.get(key);
    block.owned ||= candidateOwnsAddress(question);
    block.fields.push({ question, topic });
  }
  const topicsOf = (block) => {
    const counts = new Map();
    for (const { topic } of block.fields) counts.set(topic, (counts.get(topic) || 0) + 1);
    return counts;
  };
  const ownedTopicSets = [...blocks.values()].filter((block) => block.owned).map((block) => new Set(topicsOf(block).keys()));
  const result = new Map();
  for (const block of blocks.values()) {
    const counts = topicsOf(block);
    const twin = !block.owned && counts.size >= 2
      && ownedTopicSets.some((owned) => [...counts.keys()].every((topic) => owned.has(topic)));
    if (!block.owned && !twin) continue;
    for (const { question, topic } of block.fields) if (counts.get(topic) === 1) result.set(String(question.id), topic);
  }
  return result;
}

/** The signatures of the fields candidateAddressTopics adds by twin blocks, for platformQuestionTopic. */
export function ownedAddressTwinFields(questions = []) {
  const topics = candidateAddressTopics(questions);
  return [...new Set((Array.isArray(questions) ? questions : [])
    .filter((question) => topics.has(String(question?.id ?? '')) && !candidateOwnsAddress(question))
    .map(addressFieldSignature).filter(Boolean))].slice(0, 64);
}

/**
 * What the candidate stated about their own address in this order, by address topic: the one value they gave to
 * every field of that topic in their address blocks (candidateAddressTopics), or nothing where they gave none or
 * gave two different ones. Their word wins over the platform's address (withCandidateAddress).
 * @returns {Record<string, string>}
 */
export function candidateAddressStatements(questions = [], answers = {}) {
  const topics = candidateAddressTopics(questions);
  const values = new Map();
  for (const question of Array.isArray(questions) ? questions : []) {
    const topic = topics.get(String(question?.id ?? ''));
    const value = clean(answers?.[question?.id], 200);
    // «non so» states no address: the field stays the candidate's, the platform's facts stay (review of #18103).
    if (!topic || !value || isUnknownAnswer(value)) continue;
    if (!values.has(topic)) values.set(topic, new Map());
    values.get(topic).set(fold(value), value);
  }
  return Object.fromEntries([...values].filter(([, seen]) => seen.size === 1).map(([topic, seen]) => [topic, [...seen.values()][0]]));
}

/**
 * The platform facts with the address the candidate stated (candidateAddressStatements) above the platform's:
 * a second address block of theirs then receives the same street, number, postal code and town they typed in the
 * first. A part they did not state keeps the platform's; a town of theirs takes its own postal code and region.
 */
export function withCandidateAddress(facts, statements = {}) {
  if (!facts || typeof facts !== 'object' || !statements || !Object.keys(statements).length) return facts;
  const address = { ...(facts.address || {}) };
  const stated = (topic) => clean(statements[topic], 200);
  const street = stated('address_street');
  const streetName = stated('address_street_name') || (street ? street.replace(/\s*,?\s*\d{1,5}[a-z]?\s*$/i, '').trim() || street : '');
  const houseNumber = stated('address_house_number') || (/\b(\d{1,5}[a-z]?)\s*$/i.exec(street)?.[1] || '');
  if (streetName || houseNumber) {
    address.streetName = streetName || address.streetName || '';
    address.houseNumber = houseNumber || address.houseNumber || '';
    address.street = street && /\d/.test(street) ? street : [address.streetName, address.houseNumber].filter(Boolean).join(' ');
    address.synthesizedStreet = false;
  }
  const city = stated('residence_city');
  const country = countryCodeOf(stated('residence_country'));
  if (country) {
    address.country = country;
    address.countryName = countryName(country, facts.locale || 'it');
  }
  const town = splitTown(city);
  if (city && fold(town.town || city) !== fold(address.city)) {
    const directory = platformPostalCode(town.town || city, { region: town.region, country: country || town.country });
    address.city = town.town || city;
    address.postalCode = town.statedPostal || directory?.code || '';
    address.region = directory?.region || '';
    if (!country && directory?.country) {
      address.country = directory.country;
      address.countryName = countryName(directory.country, facts.locale || 'it');
    }
  }
  if (stated('residence_postal_code')) address.postalCode = stated('residence_postal_code');
  if (stated('residence_region')) address.region = stated('residence_region');
  return { ...facts, address: { ...address, candidateStated: true } };
}

function classifyPlatformSubject(question) {
  const text = label(question);
  if (!text) return null;
  const id = String(question?.id || '');
  const type = typeOf(question);
  // A residence condition left by lib/mobilityRequirements.js is a fact (where the candidate lives), not a
  // willingness: the platform's relocation declaration already met every clause relocation satisfies.
  if (/^mobility_requirement_/.test(id)) return null;
  const legal = legalRecordTopic(question);
  if (legal) return legal;
  if (isProfileVisibilityQuestion(question)) return 'profile_visibility';
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
  if (/\b(?:passaport\w*|passport\w*|passeport\w*|reisepass\w*)\b/.test(text) && !/\b(?:numero|number|nummer|scadenza|expir\w*|ablauf)\b/.test(text)) {
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
    if (REGION.test(text) && !CITIZENSHIP.test(text) && !REGION_PREFERENCE.test(text) && !otherParty && (RESIDENCE.test(text) || text.split(' ').length <= 4)) return 'residence_region';
  }
  if (MARKETING.test(text) && !PRIVACY.test(text)) return 'marketing_opt_in';
  if (RECORDING.test(text) && CONSENT.test(text)) return 'recording_consent';
  if (/\bconsenso informato\b|\binformed consent\b/.test(text)) return 'recording_consent';
  if (ON_CALL.test(text)) return 'on_call';
  if (GUARD_DUTY.test(text) && AVAILABLE.test(text) && isBinary(question)) return 'on_call';
  if (HYBRID.test(text)) return 'hybrid';
  if (RELOCATION.test(text)) return 'relocation';
  if (((OTHER_SITES.test(text) && AVAILABLE.test(text)) || SITE_FLEXIBILITY.test(text)) && isBinary(question)) return 'other_sites';
  if (TRAVEL.test(text) && AVAILABLE.test(text) && !TRAVEL_NOT_AVAILABILITY.test(text) && isBinary(question)) return 'business_travel';
  if (SUITABILITY.test(text) && APPLIED_FUNCTION.test(text) && !NOT_SUITABILITY.test(text) && isBinary(question)) return 'function_suitability';
  const languages = languageCodesIn(text);
  if (languages.length === 1 && LANGUAGE_LEVEL.test(text)) return `language:${languages[0]}`;
  if (isSwissArmyQuestion(question)) return 'swiss_army_service';
  if (isEducationLevelQuestion(question)) return 'education_level';
  if (isHeldTitleQuestion(question)) return 'held_title';
  if (isFirstLanguageQuestion(question)) return 'first_language';
  if (isCorrespondenceLanguageQuestion(question)) return 'correspondence_language';
  if (isLanguageRowName(question)) return 'language_row_name';
  if (isLanguageRowLevel(question)) return 'language_row_level';
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

// Swiss cantons by the directory's code: a «State» / «Kanton» text field takes the canton's name.
const SWISS_CANTONS = {
  AG: 'Aargau', AI: 'Appenzell Innerrhoden', AR: 'Appenzell Ausserrhoden', BE: 'Bern', BL: 'Basel-Landschaft',
  BS: 'Basel-Stadt', FR: 'Fribourg', GE: 'Genève', GL: 'Glarus', GR: 'Graubünden', JU: 'Jura', LU: 'Luzern',
  NE: 'Neuchâtel', NW: 'Nidwalden', OW: 'Obwalden', SG: 'St. Gallen', SH: 'Schaffhausen', SO: 'Solothurn',
  SZ: 'Schwyz', TG: 'Thurgau', TI: 'Ticino', UR: 'Uri', VD: 'Vaud', VS: 'Valais', ZG: 'Zug', ZH: 'Zürich',
};

/** The residence region for the field: the option naming its code or name, else the canton's name or the province code. */
function regionValue(question, address) {
  const code = String(address?.region || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return '';
  const name = address.country === 'CH' ? SWISS_CANTONS[code] || '' : '';
  const options = optionsOf(question);
  if (!options.length) return name || code;
  return options.find((option) => fold(option) === fold(code))
    || (name && options.find((option) => fold(option) === fold(name)))
    || options.find((option) => new RegExp(`\\(\\s*${code}\\s*\\)`, 'i').test(option))
    || '';
}

function choose(question, value) {
  const options = optionsOf(question);
  if (!options.length) return value;
  const wanted = fold(value);
  return options.find((option) => fold(option) === wanted)
    || options.find((option) => fold(option).startsWith(wanted) || wanted.startsWith(fold(option)))
    || '';
}

function countryValue(question, facts) {
  const code = facts?.address?.country;
  if (!code) return '';
  const options = optionsOf(question);
  if (!options.length) return countryName(code, facts?.locale) || code;
  const names = Object.values(COUNTRY_NAMES[code] || {}).map(fold);
  return options.find((option) => names.includes(fold(option)) || countryCodeOf(option) === code)
    || options.find((option) => names.some((name) => fold(option).includes(name)))
    || '';
}

const DATE_PATTERN = /\b(dd|gg|jj|tt|mm)([./-])(dd|gg|jj|tt|mm)([./-])(yyyy|aaaa|jjjj)\b/i;

function dateValue(question, iso, locale) {
  if (!iso) return '';
  if (typeOf(question) === 'date') return iso;
  const [year, month, day] = iso.split('-');
  // The format the field shows wins over the language's («MM/DD/YYYY», SuccessFactors en_US).
  const pattern = DATE_PATTERN.exec([question?.placeholder, question?.datePattern, question?.label, question?.question]
    .filter((value) => typeof value === 'string').join(' '));
  if (pattern) {
    const part = (token) => (/^mm$/i.test(token) ? month : /^(?:yyyy|aaaa|jjjj)$/i.test(token) ? year : day);
    return `${part(pattern[1])}${pattern[2]}${part(pattern[3])}${pattern[4]}${part(pattern[5])}`;
  }
  return languageOf(locale) === 'en' ? `${day}/${month}/${year}` : `${day}.${month}.${year}`;
}

// ── Education level and an unnamed language row (owner mandate 2026-11-10) ──
// SuccessFactors' «Education Level» picklist and its «Language Competencies» row («* Language», «* Level»,
// Damiani 2026-11-10): the CV answers both, the candidate is never asked.

const EDUCATION_LEVEL_LABEL = /\b(?:(?:highest )?(?:level of )?education(?:al)? (?:level|attainment|degree)|(?:highest )?level of (?:education|study|studies)|highest (?:education|degree|qualification)|education|titolo di studio|livello (?:di )?(?:istruzione|studio|studi)|grado (?:di )?istruzione|istruzione|ausbildungsniveau|bildungsniveau|bildungsabschluss|hochste\w* (?:abschluss|ausbildung)|hochster bildungsabschluss|schulabschluss|niveau (?:d )?(?:etudes|formation|education)|diplome le plus eleve|plus haut diplome|formation)\b/;
const EDUCATION_NOT_LEVEL = /\b(?:institut\w*|school name|nome (?:della )?scuola|universit\w* name|major|field|subject|indirizzo|fachrichtung|domaine|year|anno|jahr|annee|start|end|from|to|da|al|grade|voto|note|country|paese|land|pays|city|citta|ort|ville)\b/;

function isEducationLevelQuestion(question) {
  const text = label(question);
  if (!EDUCATION_LEVEL_LABEL.test(text) || EDUCATION_NOT_LEVEL.test(text) || text.split(' ').length > 8) return false;
  // A picklist of levels: its options name at least two different levels, so the field asks a level and not a
  // school (a list of schools names one level only).
  return new Set(optionsOf(question).map(educationLevelRank).filter((rank) => rank !== null)).size >= 2;
}

/** The option of the candidate's level; else the highest one below it (never a title the CV does not hold). */
function educationLevelValue(question, facts) {
  const rank = facts?.educationLevel;
  if (!Number.isFinite(rank)) return '';
  const ranked = optionsOf(question).map((option) => ({ option, rank: educationLevelRank(option) }))
    .filter((item) => item.rank !== null);
  const exact = ranked.filter((item) => item.rank === rank);
  if (exact.length) return exact[0].option;
  const below = ranked.filter((item) => item.rank < rank).sort((left, right) => right.rank - left.rank);
  return below[0]?.option || '';
}

// ── A title of study or a certificate asked in a text or a choice field (owner decision 2026-11-11) ──
// «Attestato» names a title and a paper alike. An upload field takes the paper: the runner attaches the order's
// document of that name when the candidate gave one, and nothing otherwise (a required upload with no file stays
// the candidate's). A text or a choice field asks the title: the CV declares it (profile.education, certifications).
const HELD_TITLE = /\b(?:attestat\w*|diplom\w*|titol\w* di studio|titol\w* conseguit\w*|titre\w* (?:obtenu\w*|d etudes?)|abschluss\w*|berufsabschluss\w*|fahigkeitszeugnis\w*|zeugnis\w*|certificat\w*|certificazion\w*|zertifikat\w*|zertifizierung\w*|degree)\b/;
// Another document of that name, a detail of the title, or a fact no CV title answers.
const NOT_HELD_TITLE = /\b(?:arbeitszeugnis\w*|zwischenzeugnis\w*|schulzeugnis\w*|referenz\w*|reference\w*|pagell\w*|bulletin\w*|transcript\w*|notenausweis\w*|medic\w*|arzt\w*|salute|sante|health|casellario|strafregister\w*|casier|betreibung\w*|patente|fuhrer\w*|permis|anno|year|jahr|annee|data|date|datum|voto|grade|note|punteggio|score|istitut\w*|institut\w*|universit\w*|school|scuola|schule|ecole|ente|rilasciat\w*|issuer|ausgestellt\w*|delivre\w*|numero|number|nummer|scadenz\w*|expir\w*|gultig\w*|valid\w*|paese|country|land|pays|citta|city|ort|ville|experience|esperienz\w*|erfahrung\w*|riconosciut\w*|anerkann\w*|recogni\w*|equivalen\w*|equipollen\w*|gleichwertig\w*)\b/;
const TITLE_ATTACH = /\b(?:allega\w*|alleg[ao]|upload\w*|hochlad\w*|carica\w*|attach\w*|beileg\w*|beifug\w*|joindre|anhang\w*|scan\w*|pdf|file|datei\w*|fichier\w*|kopie|copia|copy|copie|einreich\w*|submit|invia\w*|send|envoy\w*)\b/;
const CERTIFICATION_LABEL = /\b(?:certificazion\w*|certification\w*|zertifizierung\w*|zertifikat\w*)\b/;
// The kinds of title a label or an option may name; the same kind on both sides is the same title.
const TITLE_KINDS = [
  /\b(?:attestat\w* federal\w* di capacita|afc|efz|eidgenossisch\w* fahigkeitszeugnis|fahigkeitszeugnis|cfc|certificat federal de capacite)\b/,
  /\b(?:brevett\w* federal\w*|fachausweis|eidgenossisch\w* fachausweis|brevet federal|diplom\w* federal\w*|eidgenossisch\w* diplom|hohere fachschule|hf|scuola specializzata superiore|ecole superieure)\b/,
  /\b(?:maturit\w*|matura|abitur|baccalaur\w*|diploma di (?:scuola )?(?:media )?superiore|high school diploma|a levels?)\b/,
  /\b(?:laurea|bachelor\w*|master\w*|msc|bsc|mba|degree|dottorato|phd|doktor\w*|diplome universitaire|hochschulabschluss)\b/,
];

// A caption of documents: the slot of an upload a runner reported as text («Lebenslauf - Zeugnisse - Diplome»,
// Helsana s2Tbwwjd), never a title to write.
const DOCUMENT_CAPTION = /\b(?:zeugnisse|diplome|diplomi|diplomas|attestati|certificati|certificates|zertifikate|certificats|attestations|diplomes|lebenslauf|curriculum|cv|resume|unterlagen|dokument\w*|documents?|document[io]|allegat\w*|beilage\w*|anhange|attachments?|dossier|pieces jointes)\b/;

function isHeldTitleQuestion(question) {
  const text = label(question);
  if (!HELD_TITLE.test(text) || NOT_HELD_TITLE.test(text) || TITLE_ATTACH.test(text) || text.split(' ').length > 12) return false;
  if (isBinary(question) || UPLOAD_TYPES.has(typeOf(question)) || typeOf(question) === 'checkbox') return false;
  if (optionsOf(question).length >= 2) return true;
  return ['text', 'textarea', ''].includes(typeOf(question)) && !DOCUMENT_CAPTION.test(text);
}

/** The CV's titles: each degree of its education (with its level), then each certification. */
function cvTitles(profile = {}) {
  const education = (Array.isArray(profile?.education) ? profile.education : [])
    .map((item, index) => ({ title: clean(item?.degree, 200), rank: educationLevelRank(item?.degree) ?? educationLevelRank(item?.institution), index, certification: false }))
    .filter((item) => item.title);
  const certifications = (Array.isArray(profile?.certifications) ? profile.certifications : [])
    .map((item, index) => ({ title: clean(item, 200), rank: null, index, certification: true }))
    .filter((item) => item.title);
  return [...education, ...certifications];
}

/** The CV's title a field asks: the kind it names, else the certifications it names, else the highest title. */
function heldTitleValue(question, facts) {
  const titles = Array.isArray(facts?.titles) ? facts.titles : [];
  if (!titles.length) return '';
  const text = label(question);
  const kind = TITLE_KINDS.find((re) => re.test(text));
  const options = optionsOf(question);
  if (!options.length) {
    if (kind) return titles.find((item) => kind.test(fold(item.title)))?.title || '';
    // The word the label asks by («Attestato», «Diploma», «Zertifikat»): the CV's title called so.
    const asked = (text.match(new RegExp(HELD_TITLE.source, 'g')) || []).map((word) => word.slice(0, 6));
    const named = titles.find((item) => fold(item.title).split(' ').some((word) => asked.some((stem) => stem.length >= 5 && word.startsWith(stem))));
    if (CERTIFICATION_LABEL.test(text)) return clean(titles.filter((item) => item.certification).map((item) => item.title).join('; '), 200);
    if (named) return named.title;
    const ranked = titles.filter((item) => !item.certification && item.rank !== null).sort((left, right) => right.rank - left.rank || left.index - right.index);
    return ranked[0]?.title || titles.find((item) => !item.certification)?.title || '';
  }
  // A choice: the option the CV's title holds word for word, else the one of the same kind, else the one of the
  // level of the CV's highest title. Only one option, never a guess between two.
  const unique = (list) => (list.length === 1 ? list[0] : '');
  const folded = titles.map((item) => fold(item.title));
  const verbatim = unique(options.filter((option) => fold(option).length >= 3
    && folded.some((title) => title.includes(fold(option)) || fold(option).includes(title))));
  if (verbatim) return verbatim;
  // The same kind («AFC» and «Attestato federale di capacità»), and every other word of the option in that title
  // («AFC impiegato di commercio», never «AFC logistica»).
  const rest = (value, re) => fold(value).replace(new RegExp(re.source, 'g'), ' ').split(' ')
    .filter((word) => word.length >= 3 && !SCHOOL_WORDS.has(word) && !['del', 'della', 'des', 'der', 'die', 'das', 'und', 'and', 'the', 'per', 'pour', 'fur', 'ramo'].includes(word));
  const sameKind = unique(options.filter((option) => TITLE_KINDS.some((re) => re.test(fold(option))
    && folded.some((title) => re.test(title) && rest(option, re).every((word) => title.split(' ').includes(word))))));
  if (sameKind) return sameKind;
  const highest = Math.max(-1, ...titles.map((item) => item.rank ?? -1));
  return highest >= 0 ? unique(options.filter((option) => educationLevelRank(option) === highest)) : '';
}

const BARE_LANGUAGE = /^(?:language|lingua|sprache|langue|idioma|foreign language|lingua straniera|fremdsprache|langue etrangere)$/;
const BARE_LEVEL = /^(?:level|livello|niveau|stufe|proficiency(?: level)?|language level|livello (?:linguistico|di conoscenza)|sprachniveau|niveau de langue|competenza|kenntnisstand)$/;
const LANGUAGE_SECTION = /\b(?:language\w*|lingu\w*|sprach\w*|langue\w*|idiom\w*)\b/;
// A selector of the site's own language is no competency row.
const INTERFACE_LANGUAGE = /\b(?:interface|website|site|display|anzeige\w*|sito|correspondence|corrispondenza|korrespondenz\w*|communication|kommunikation)\b/;

function rowScope(question) {
  const owners = Array.isArray(question?.addressContext?.owners) ? question.addressContext.owners : [];
  return fold([question?.context, question?.section, question?.addressContext?.section, ...owners]
    .filter((value) => typeof value === 'string').join(' '));
}

// An optional bare «Language» is the site's own selector (SuccessFactors' header, Damiani 2026-11-10): only a
// required row is one the application asks.
function isLanguageRowName(question) {
  if (question?.required === false || !BARE_LANGUAGE.test(label(question)) || INTERFACE_LANGUAGE.test(rowScope(question))) return false;
  return optionsOf(question).filter((option) => languageCodesIn(option).length === 1).length >= 2;
}

function isLanguageRowLevel(question) {
  if (question?.required === false || !BARE_LEVEL.test(label(question)) || !LANGUAGE_SECTION.test(rowScope(question))) return false;
  return optionsOf(question).filter((option) => levelRank(option) !== null).length >= 2;
}

/** The CV's strongest language (its own language first, the mother tongue): the one a single row names. */
function primaryLanguage(facts) {
  return rankedLanguages(facts)[0] || null;
}

/** The CV's languages, strongest first (the mother tongue, then by level, then in the CV's order). */
function rankedLanguages(facts) {
  const entries = (facts?.languages || []).map((entry, index) => ({
    ...entry, index, rank: entry.level === 'native' ? 7 : levelRank(entry.level) ?? -1,
  }));
  return entries.sort((left, right) => right.rank - left.rank || left.index - right.index);
}

// ── Federal portal (Stellenportal Bund, eHSYErA1, 2026-11-10) ──
const languageOptionOf = (question, code) => pickOption(question, (option) => languageCodesIn(option).length === 1 && languageCodesIn(option)[0] === code);
const OTHER_LANGUAGE_OPTION = /^(?:andere\w*|other\w*|altr[ae]|autre\w*|weitere)\b/;
const languageOptions = (question) => optionsOf(question).filter((option) => languageCodesIn(option).length === 1);

const FIRST_LANGUAGE = /^(?:erstsprache|muttersprache|mother tongue|first language|native language|lingua madre|madrelingua|prima lingua|langue maternelle|premiere langue)$/;
function isFirstLanguageQuestion(question) {
  return FIRST_LANGUAGE.test(label(question)) && languageOptions(question).length >= 2;
}

/** The mother tongue (the CV's own language, owner decision 2026-11-09); not offered: «Andere», never another language. */
function firstLanguageValue(question, facts) {
  const native = (facts?.languages || []).find((entry) => entry.level === 'native');
  if (!native) return '';
  return languageOptionOf(question, native.code) || pickOption(question, (option) => OTHER_LANGUAGE_OPTION.test(fold(option)));
}

const CORRESPONDENCE_LANGUAGE = /^(?:korrespondenzsprache|sprache (?:der|fur die) korrespondenz|correspondence language|language (?:of|for) correspondence|preferred (?:communication |correspondence )?language|lingua (?:di|per la) corrispondenza|lingua di comunicazione|langue de correspondance|langue de communication)$/;
function isCorrespondenceLanguageQuestion(question) {
  return CORRESPONDENCE_LANGUAGE.test(label(question)) && languageOptions(question).length >= 2;
}

/**
 * The language the employer writes to the candidate in (rule of 2026-11-10, proposed with the federal portal): the
 * mother tongue when the list offers it; else the posting's language when the CV lists it; else the strongest
 * language of the CV the list offers; else the posting's language, the one the candidate applied in.
 */
function correspondenceLanguageValue(question, facts) {
  const native = (facts?.languages || []).find((entry) => entry.level === 'native');
  const posting = String(facts?.applicationLanguage || '').slice(0, 2).toLowerCase();
  const listed = new Set((facts?.languages || []).map((entry) => entry.code));
  if (native && languageOptionOf(question, native.code)) return languageOptionOf(question, native.code);
  if (posting && listed.has(posting) && languageOptionOf(question, posting)) return languageOptionOf(question, posting);
  for (const entry of rankedLanguages(facts)) {
    const option = languageOptionOf(question, entry.code);
    if (option) return option;
  }
  return posting ? languageOptionOf(question, posting) : '';
}

// The Swiss Army's recruit school, NCO or officer school: only a Swiss citizen serves, so a candidate known not to
// be Swiss has not attended it (a fact, deterministic). A Swiss citizen, or an unknown nationality, is left to the
// decision engine (plausible deduction from the CV).
const SWISS_ARMY = /\b(?:rekrutenschule|unteroffiziers\w*|offiziersschule|schweizer armee|militardienst|militaerdienst|scuola reclute|scuola (?:sottufficiali|ufficiali)|esercito svizzero|ecole de recrues|ecole (?:de sous officiers|d officiers)|armee suisse|swiss army|swiss armed forces|military service in switzerland)\b/;
function isSwissArmyQuestion(question) {
  return SWISS_ARMY.test(label(question)) && isBinary(question);
}

function swissArmyValue(question, facts, lang) {
  // A fact for a candidate who said they are not Swiss: a nationality deduced from the CV is no such statement.
  // The CV's own declaration ('cv') is the candidate's statement; a dual one carries Swiss first.
  const nationality = facts?.nationalitySource === 'deduced' ? '' : nationalityOf(facts?.nationality)?.code || facts?.nationalityCode || '';
  const passport = facts?.passportSource === 'deduced' ? '' : facts?.passport;
  const swiss = passport === 'swiss' || facts?.permitStatus === 'swiss' || nationality === 'CH';
  const knownForeign = !swiss && (Boolean(nationality) || ['eu_efta', 'other'].includes(passport));
  return knownForeign ? noValue(question, lang) : '';
}

// ── Criminal record and debt-enforcement register (owner decision 2026-11-10) ──
// SBB ifB89NW2: «* Hast du einen Eintrag im Strafregister oder im Betreibungsregister?» (Nein/Ja). A legal fact
// nobody may deduce: answered only from the candidate's answers at CV upload (order.candidateFacts). Only the
// question whether the register holds an entry: never a request for the extract, a pending proceeding, a
// conviction asked as such («Have you ever been convicted…?») nor a statement to confirm or sign.
const CRIMINAL_REGISTER = /\b(?:strafregister\w*|vorstraf\w*|vorbestraft\w*|casellario\w*|precedenti penali|fedina penale|criminal records?|police records?|casier judiciaire)\b/;
const DEBT_REGISTER = /\b(?:betreibung\w*|konkurs\w*|verlustschein\w*|registro (?:delle )?esecuzion\w*|esecuzioni (?:forzate|e fallimenti|o fallimenti)|fallimen\w*|poursuites?|faillites?|actes? de defaut de biens|debt enforcement\w*|debt collection register\w*|bankrupt\w*)\b/;
const LEGAL_PENDING = /\b(?:hangig\w*|laufend\w*|pending|ongoing|in corso|pendent\w*|en cours|\w*verfahren\w*|procediment\w*|procedur\w*|proceeding\w*|investigat\w*|ermittlung\w*|untersuchung\w*|indagin\w*|enquete\w*|anklage\w*|accusat\w*|charged)\b/;
const LEGAL_DOCUMENT_REQUEST = /\b(?:\w*auszug\w*|extracts?|estratt\w*|extraits?|certificat\w*|certificate\w*|zeugnis\w*|bescheinigung\w*|vorleg\w*|vorweis\w*|einreich\w*|beileg\w*|beibring\w*|bring|provide|submit|present|presentar\w*|furnish|fornir\w*|produrr\w*|upload\w*|hochlad\w*|carica\w*|allega\w*|joindre|fournir|copy|kopie|copia|copie|obtain|bestell\w*|richied\w*|richiest\w*|proofs?|prove|nachweis\w*|beleg\w*|prova|prove|preuves?|justificati\w*|evidence|attestat\w*|documentation|dokumentation|documentazione)\b/;
const LEGAL_STATEMENT = /\b(?:kein\w*|nicht|not|non|nessun\w*|senza|sans|aucun\w*|without|ohne|frei|free|privo|priva|exempt\w*|libero|libera|vierge|never|nie|niemals|mai|jamais|leer\w*|clean|einwandfrei\w*|unbescholten\w*|sauber\w*|bestatig\w*|confirm\w*|conferm\w*|dichiar\w*|declar\w*|erklar\w*|atteste\w*|certif\w*|versicher\w*|garant\w*|eidesstattlich\w*|sworn|signature|unterschrift\w*|firma)\b/;

// The criminal record alone (owner decision 2026-11-11, SBB ifB89NW2): always «no conviction». A question on a
// conviction, an entry in the register or a pending criminal proceeding is answered «no»; a statement that there
// is none («Dichiaro di non avere condanne», «Ich bestätige, dass keine Einträge…») «yes»; a choice its option of
// «none». A request to attach the extract is a document, never a declaration; the debt-enforcement register is
// another fact, still the candidate's (below).
const CRIMINAL_CONVICTION = /\b(?:condann\w*|verurteil\w*|vorbestraft\w*|convict\w*|condamn\w*|reati|reato|straftat\w*|strafverfahren\w*|strafuntersuchung\w*|strafrechtlich\w* (?:verfolg\w*|verfahren\w*|untersuchung\w*)|procediment\w* penal\w*|carichi pendenti|criminal (?:proceedings?|charges?|offen[cs]es?|investigations?|convictions?|history)|procedures? penales?|poursuites? penales?|antecedents? judiciaires?|incensurat\w*)\b/;
// Criminal-record words that are also words of debt enforcement («poursuites pénales»).
const NOT_DEBT = /\bpoursuites? penales?\b/g;
// The field asks for the document itself.
const ATTACH = /\b(?:allega\w*|alleg[ao]|upload\w*|hochlad\w*|carica\w*|attach\w*|beileg\w*|beifug\w*|joindre|anhang\w*|scan\w*|pdf|file|datei\w*|fichier\w*|kopie|copia|copy|copie)\b/;
// A record with no entry: the words that make a sentence say «there is none».
const CLEAN_RECORD = /\b(?:pulit\w*|incensurat\w*|einwandfrei\w*|unbescholten\w*|leer\w*|blank|clean|vierge|(?:frei von|ohne) (?:jeglich\w* )?(?:vorstraf\w*|eintrag\w*|eintrage\w*|strafregistereintrag\w*)|free (?:of|from) (?:any )?(?:criminal|conviction\w*|record\w*)|without (?:a |any )?(?:criminal|conviction\w*|record\w*)|(?:privo|priva|senza) (?:di )?(?:precedenti|condann\w*|carichi)|sans (?:aucun\w* )?(?:condamnation\w*|antecedent\w*|inscription\w*))\b/;
// A request to hand over the paper (review of #18085): the candidate's, even when it says the paper is clean.
const PROVIDE_DOCUMENT = /\b(?:vorleg\w*|vorweis\w*|einreich\w*|beileg\w*|beibring\w*|bring|provide|submit|present|presentar\w*|furnish|fornir\w*|produrr\w*|obtain|bestell\w*|richied\w*|joindre|fournir|upload\w*|hochlad\w*|carica\w*|allega\w*)\b/;
// Consent to a check of the record is a consent, never a statement about it.
const RECORD_CHECK = /\b(?:consens\w*|acconsent\w*|consent\w*|einwillig\w*|zustimm\w*|einverstanden|autoris\w*|accett\w*|accept\w*|agree\w*|d accord|verific\w*|check\w*|prufung\w*|uberprufung\w*|kontroll\w*|controll\w*|background)\b/;
const NEGATION = /\b(?:kein\w*|nicht|not|non|nessun\w*|aucun\w*|never|nie|niemals|mai|jamais|no (?:criminal|conviction\w*|record\w*|entr\w*|pending))\b/;
const DECLARATION = /\b(?:bestatig\w*|confirm\w*|conferm\w*|dichiar\w*|declar\w*|erklar\w*|attest[oaie]|atteste|certifi(?:co|ca|e|ons)|versicher\w*|garant\w*|assicur\w*|affirm\w*)\b/;
const QUESTION_START = /^(?:hast|haben|hatten|sind|bist|ist|gibt|gab|wurden|wurde|laufen|lauft|besteht|bestehen|liegt|liegen|hai|ha|avete|e|sei|siete|ci sono|esistono|sussistono|have|has|had|are|is|were|was|do|does|did|can|could|avez|as|etes|es|est|existe|y a|puoi|puo|potete|konnen|kannst)\b/;
const NONE_OPTION = /^(?:no|nein|non)\b|\b(?:kein\w*|nessun\w*|aucun\w*|none|nothing|niente|nulla|never|nie|mai|jamais|no (?:criminal|conviction\w*|record\w*|entr\w*|pending))\b/;
const UPLOAD_TYPES = new Set(['file', 'upload', 'attachment', 'document']);

/** How a criminal-record field reads: 'presence' (is there one?), 'absence' (there is none), '' when unclear. */
function asksQuestion(question) {
  const raw = [question?.applicationQuestion, question?.question, question?.label].filter((value) => typeof value === 'string').join(' ');
  return /\?[\s*]*$/.test(raw.trim()) || QUESTION_START.test(label(question));
}

function criminalRecordPolarity(question) {
  const text = label(question);
  const asked = asksQuestion(question);
  if (CLEAN_RECORD.test(text)) return 'absence';
  // «Dichiaro di non avere condanne», «Keine Einträge im Strafregister»: a statement of none. A negated question
  // («Non hai mai avuto condanne?», «Sind Sie nicht vorbestraft?») reads both ways: left to the candidate.
  if (NEGATION.test(text)) return DECLARATION.test(text) || !asked ? 'absence' : '';
  return 'presence';
}

/** Whether the field is a criminal-record question or statement the rule answers. */
function isCriminalRecordField(question) {
  if (UPLOAD_TYPES.has(typeOf(question))) return false;
  const text = label(question);
  if (ATTACH.test(text) || RECORD_CHECK.test(text)) return false;
  const polarity = criminalRecordPolarity(question);
  if (!polarity) return false;
  // «Puoi fornire l'estratto del casellario?» and «Can you provide a clean criminal-record extract?» ask for the
  // paper: the candidate's (review of #18085). «Ist Ihr Strafregisterauszug einwandfrei?» asks about the record.
  if (LEGAL_DOCUMENT_REQUEST.test(text) && (polarity !== 'absence' || PROVIDE_DOCUMENT.test(text))) return false;
  if (isBinary(question) || optionsOf(question).length) return true;
  // A free text field only when it asks («Hai precedenti penali?»): a bare caption («Strafregister») may be the slot
  // of the extract a runner reported as text.
  return polarity === 'presence' && asksQuestion(question) && ['text', 'textarea', ''].includes(typeOf(question));
}

/** 'criminal_record', 'debt_record' or 'criminal_or_debt_record' for a field the platform answers, else null. */
function legalRecordTopic(question) {
  const text = label(question);
  const criminal = CRIMINAL_REGISTER.test(text) || CRIMINAL_CONVICTION.test(text);
  const debt = DEBT_REGISTER.test(text.replace(NOT_DEBT, ' '));
  if (!criminal && !debt) return null;
  if (!debt) return isCriminalRecordField(question) ? 'criminal_record' : null;
  // The debt-enforcement register, alone or beside the criminal record: only the yes/no on a register entry, from
  // the candidate's answers at upload (2026-11-10), «no» when they gave none (2026-11-11).
  // A conviction named beside the debt register («convicted or an entry in the debt-enforcement register») is the
  // same combined yes/no (review of #18085); a pending proceeding, a document or a statement is not.
  if (!isBinary(question)) return null;
  if (LEGAL_PENDING.test(text) || LEGAL_DOCUMENT_REQUEST.test(text) || LEGAL_STATEMENT.test(text)) return null;
  return criminal ? 'criminal_or_debt_record' : 'debt_record';
}

/**
 * Yes when an answer the candidate gave at upload is yes, otherwise no. Owner decision 2026-11-11 («Sempre «no» se
 * manca», SBB ifB89NW2): an order with no upload answer (one made before the question existed) has no entry in
 * either register, as the criminal record has none; the candidate's own «yes» wins.
 */
function legalRecordValue(question, topic, facts, lang) {
  const keys = { debt_record: ['debtRecord'], criminal_or_debt_record: ['criminalRecord', 'debtRecord'] }[topic];
  const answers = keys.map((key) => legalRecordAnswer(facts?.[key]));
  return answers.includes('yes') ? yesValue(question, lang) : noValue(question, lang);
}

const NO_CONVICTION = { it: 'Nessuna condanna', en: 'No convictions', de: 'Keine Vorstrafen', fr: 'Aucune condamnation' };

/**
 * The criminal record (owner decision 2026-11-11): no conviction, no entry, no pending proceeding. The candidate's
 * own «yes» at upload wins: a yes/no on a register entry is then yes, and nothing else is declared for them.
 */
function criminalRecordValue(question, facts, lang) {
  const polarity = criminalRecordPolarity(question);
  const options = optionsOf(question);
  // The candidate's «yes» at upload answers every yes/no on a register entry or a conviction (review of #18085); a
  // pending proceeding is another fact, and nothing else is declared for them.
  if (legalRecordAnswer(facts?.criminalRecord) === 'yes') {
    return polarity === 'presence' && isBinary(question) && !LEGAL_PENDING.test(label(question)) ? yesValue(question, lang) : '';
  }
  if (isBinary(question)) return polarity === 'absence' ? yesValue(question, lang) : noValue(question, lang);
  if (!options.length) return polarity === 'presence' ? NO_CONVICTION[lang] : '';
  // A choice of several: its one option of «none» for a question, its one «yes» for a statement of none.
  const wanted = polarity === 'absence' ? options.filter((option) => YES.test(fold(option)))
    : options.filter((option) => NONE_OPTION.test(fold(option)) && !YES.test(fold(option)));
  return wanted.length === 1 ? wanted[0] : '';
}

function languageValue(question, code, facts) {
  const entry = (facts?.languages || []).find((item) => item.code === code);
  if (!entry) return '';
  const rank = entry.level === 'native' ? 7 : levelRank(entry.level);
  const options = optionsOf(question);
  if (!options.length) {
    if (isBinary(question)) return rank === null || rank >= 3 ? yesValue(question, facts?.locale) : noValue(question, facts?.locale);
    return entry.level === 'native' ? { it: 'Madrelingua', en: 'Native', de: 'Muttersprache', fr: 'Langue maternelle' }[facts?.locale || 'it'] : entry.level;
  }
  if (isBinary(question)) return rank === null || rank >= 3 ? yesValue(question, facts?.locale) : noValue(question, facts?.locale);
  if (rank === null) return '';
  const ranked = options.map((option) => ({ option, rank: levelRank(option) }))
    .filter((item) => item.rank !== null && (rank <= 0 ? true : item.rank > 0));
  if (!ranked.length) return '';
  const atMost = ranked.filter((item) => item.rank <= rank).sort((left, right) => right.rank - left.rank);
  return (atMost[0] || ranked.sort((left, right) => left.rank - right.rank)[0]).option;
}

function salaryValue(question, facts) {
  const salary = facts?.salary;
  if (!salary) return '';
  const text = label(question);
  const monthly = /\b(?:mensil\w*|monthly|monatlich\w*|mensuel\w*|al mese|per month|pro monat|par mois)\b/.test(text);
  const hourly = /\b(?:orari\w*|hourly|stundenlohn|per ora|per hour|pro stunde|par heure|sessione|session)\b/.test(text);
  if (hourly) return '';
  const amount = monthly ? Math.round(salary.annual / 13 / 50) * 50 : salary.annual;
  if (typeOf(question) === 'number') return String(amount);
  const options = optionsOf(question);
  if (options.length) {
    const ranges = options.map((option) => {
      const numbers = (option.replace(/['’ ](?=\d{3})/g, '').match(/\d+(?:[.,]\d+)?\s*k?/gi) || [])
        .map((part) => Number(part.replace(/k$/i, '').replace(',', '.')) * (/k$/i.test(part.trim()) ? 1000 : 1));
      return { option, low: Math.min(...numbers), high: Math.max(...numbers) };
    }).filter((item) => Number.isFinite(item.low));
    const hit = ranges.find((item) => amount >= item.low && amount <= item.high) || ranges.sort((a, b) => b.high - a.high)[0];
    return hit?.option || '';
  }
  const formatted = amount.toLocaleString('de-CH').replace(/[’']/g, "'");
  const period = monthly
    ? { it: 'lordi al mese', en: 'gross per month', de: 'brutto pro Monat', fr: 'brut par mois' }
    : { it: 'lordi annui', en: 'gross per year', de: 'brutto pro Jahr', fr: 'brut par an' };
  return `${salary.currency} ${formatted} ${period[facts?.locale || 'it']}`;
}

/**
 * The platform's answer to a question, as the field can take it, or null.
 * @returns {{value:string, topic:string, source:'policy_default', version:string}|null}
 */
export function platformDefaultAnswer(question, facts = null, { locale } = {}) {
  const topic = platformQuestionTopic(question, { ownedAddressFields: facts?.ownedAddressFields });
  if (!topic) return null;
  const known = facts || basePlatformFacts(Date.now(), locale);
  const lang = languageOf(locale || known.locale);
  const withLocale = { ...known, locale: lang };
  const options = optionsOf(question);
  const address = known.address || {};
  let value = '';
  // A value that rests on the permit the platform deduced (deducedCrossBorderPermit) says so.
  let basis = '';
  switch (topic) {
    case 'residence_postal_code': value = address.postalCode ? choose(question, address.postalCode) : ''; break;
    case 'residence_city': value = address.city ? choose(question, address.city.replace(/\b\p{L}/gu, (letter) => letter.toUpperCase())) : ''; break;
    case 'residence_region': value = address.city ? regionValue(question, address) : ''; break;
    case 'residence_country': value = countryValue(question, withLocale); break;
    case 'address_street': value = address.city ? address.street : ''; break;
    case 'address_street_name': value = address.city ? address.streetName : ''; break;
    case 'address_house_number': value = address.city ? address.houseNumber : ''; break;
    case 'salutation': {
      const gender = /^(?:signora|frau|madame|ms|mrs)$/i.test(known.salutation || '') ? 'f'
        : /^(?:signor|signore|herr|monsieur|mr)$/i.test(known.salutation || '') ? 'm' : '';
      if (!gender) break;
      value = options.length
        ? pickOption(question, (option) => (gender === 'f'
          ? /^(?:signora|sig ra|frau|madame|mme|ms|mrs|donna|female|femmina|weiblich)\b/ : /^(?:signor|signore|sig|herr|monsieur|m|mr|uomo|male|maschio|mannlich)\b/).test(fold(option)))
        : salutationFor(gender, lang);
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
      if (known.permitStatusSource === 'deduced') basis = 'deduced';
      break;
    }
    case 'nationality': {
      const source = known.nationalitySource;
      // The platform's own reading: the CV's declaration ('cv') or the deduction ('deduced').
      const platformCode = ['deduced', 'cv'].includes(source) ? known.nationalityCode || '' : '';
      // A dual nationality the candidate wrote («italiana e svizzera») has its code too (Swiss first).
      const code = nationalityOf(known.nationality)?.code || known.nationalityCode || (known.passport === 'swiss' ? 'CH' : '');
      // A list needs a recognized nationality: an unknown one never picks an option; a free field takes
      // the candidate's own words, or the country's name in the form's language.
      if (options.length) {
        if (!code) break;
        value = pickOption(question, (option) => nationalityOf(option)?.code === code || countryCodeOf(option) === code);
      } else if (source === 'candidate' && !nationalityOf(known.nationality)) value = known.nationality;
      else value = code ? nationalityLabelOf(code, lang) || countryName(code, lang) : known.nationality;
      if (value && platformCode && code === platformCode) basis = source;
      break;
    }
    case 'passport_type': {
      const passport = known.passport;
      // «Do you hold a Swiss work permit or Swiss passport…?»: a held permit answers it first.
      if (known.permitStatus && optionsOf(question).some((option) => /\b(?:permesso|permit|bewilligung|permis)\b/.test(fold(option)))) {
        value = permitOptionFallback(question, known.permitStatus, passport);
        if (value && known.permitStatusSource === 'deduced') basis = 'deduced';
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
    // An unticked box already declines: the platform leaves a marketing checkbox as it is.
    case 'marketing_opt_in': value = ['checkbox'].includes(typeOf(question)) ? '' : noValue(question, lang); break;
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
    case 'recording_consent':
    case 'on_call':
    case 'hybrid':
    case 'business_travel':
    case 'function_suitability':
    case 'other_sites':
    case 'relocation': value = yesValue(question, lang); break;
    // The broadest audience inside the same employer; a yes/no or a box: yes.
    case 'profile_visibility': value = options.length && !isBinary(question) ? profileVisibilityOption(question) : yesValue(question, lang); break;
    case 'salary_expectation': value = salaryValue(question, withLocale); break;
    case 'education_level': value = educationLevelValue(question, known); break;
    case 'held_title': value = heldTitleValue(question, known); break;
    case 'language_row_name': {
      const primary = primaryLanguage(known);
      value = primary ? pickOption(question, (option) => languageCodesIn(option).length === 1 && languageCodesIn(option)[0] === primary.code) : '';
      break;
    }
    case 'language_row_level': {
      const primary = primaryLanguage(known);
      value = primary ? languageValue(question, primary.code, withLocale) : '';
      break;
    }
    case 'first_language': value = firstLanguageValue(question, known); break;
    case 'correspondence_language': value = correspondenceLanguageValue(question, known); break;
    case 'swiss_army_service': value = swissArmyValue(question, known, lang); break;
    case 'criminal_record': value = criminalRecordValue(question, known, lang); break;
    case 'debt_record':
    case 'criminal_or_debt_record': value = legalRecordValue(question, topic, known, lang); break;
    case 'start_date': value = dateValue(question, known.startDate, lang); break;
    default:
      if (topic.startsWith('language:')) value = languageValue(question, topic.slice('language:'.length), withLocale);
  }
  value = String(value ?? '').trim();
  if (!value) return null;
  if (options.length && !options.includes(value) && !['true', 'false'].includes(value)) return null;
  return { value, topic: `platform:${topic}`, source: 'policy_default', ...(basis ? { basis } : {}), version: PLATFORM_DEFAULTS_VERSION };
}
