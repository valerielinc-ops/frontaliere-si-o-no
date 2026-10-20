/**
 * What the candidate may change on the review page before approving (owner
 * decision 2026-09-30): the cover letter, the e-mail to the employer (only
 * when the application leaves by e-mail) and the form fields we propose. The
 * address stays the order's alias: the employer's replies must reach the flow
 * (forwarding, follow-ups, interview prep).
 *
 * Where each edit lives:
 * - the letter, the e-mail and the two motivation texts belong to the round's
 *   draft (a new round writes new ones);
 * - the candidate's own data (name, phone, place, permit, salary...) is kept
 *   in the flow as `formOverrides` and holds across rounds, like the answers.
 *
 * Everything that builds the application — the review page, the submission
 * (e-mail and portal), the handoff kit, the owner queue, the next draft —
 * reads the candidate through `candidateWithEdits`.
 *
 * Pure JavaScript: imported by the functions and by the runner scripts.
 */

import {
  buildFormAnswers,
  candidateIdentity,
  clean,
  cleanBlock,
  letterText,
  parseLetterText,
  SALARY_RULE_MESSAGES,
  splitName,
} from './assistedApplicationAiDraftCore.js';
import { answerMessage, safePattern, validateAnswer } from './lib/answerRules.js';
import { isoDateOf } from './lib/cvPeriod.js';
import { permitOptions, permitStatusOf } from './lib/permitStatus.js';
import { civilStatusCode, civilStatusOptions, cvPersonalFacts, isSalutation, personalFieldLabel, salutationFor, salutationGenderFromName, salutationOptions } from './lib/personalFacts.js';
import { hasExplicitLanguageSection, isLanguageAbilityQuestion, languageCodesIn, languageExplicitlyAbsent } from './lib/languageFacts.js';

const LEGACY_LANGUAGE_LIST_LIMIT = 12;
const LANGUAGE_LEVEL_RE = /\b(?:level|proficiency|fluency|fluent|niveau|livello|grado|kenntnis|kenntnisse|maitrise|maîtrise)\b/i;
const LANGUAGE_MODALITY_RE = /\b(?:written|schriftlich|ecrit|écrit|scritto|scritta)\b/i;
const LANGUAGE_ORAL_RE = /\b(?:oral|spoken|muendlich|mündlich|parlato|parlata|parle|parlé)\b/i;

function normalizeQuestionValue(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[’‘`]/g, "'").replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function questionHash(value) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function optionValues(question) {
  return (Array.isArray(question?.options) ? question.options : [])
    .flatMap((option) => typeof option === 'string' ? [option] : [option?.label, option?.value])
    .map(normalizeQuestionValue).filter(Boolean);
}

function hasQuestionAnswer(value) {
  return typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
    || (Array.isArray(value) && value.some((item) => String(item ?? '').trim()))
    || String(value ?? '').trim().length > 0;
}

function answerValueKey(value) {
  return Array.isArray(value) ? value.map(normalizeQuestionValue).sort().join('|') : normalizeQuestionValue(value);
}

function answerFitsQuestion(value, question) {
  const options = optionValues(question);
  return !options.length || options.includes(normalizeQuestionValue(value));
}

/** Stable fact key for an answer, independent of a model or ATS field id. */
export function candidateQuestionAnswerKey(question) {
  const text = String(question?.question ?? '').trim();
  if (!text) return '';
  const languageCodes = languageCodesIn(text);
  if (languageCodes.length === 1 && isLanguageAbilityQuestion(text)) {
    const normalized = normalizeQuestionValue(text);
    const threshold = /\b(?:at least|minimum|min(?:imum)? level|required level|mindestens|au moins|almeno|minimum|minimo)\s*(?:level\s*)?([abc][12])\b/i.exec(normalized)?.[1] || '';
    const modality = LANGUAGE_MODALITY_RE.test(normalized) ? 'written' : LANGUAGE_ORAL_RE.test(normalized) ? 'oral' : 'any';
    const kind = threshold ? `threshold_${threshold}` : LANGUAGE_LEVEL_RE.test(normalized) ? 'proficiency' : 'ability';
    return `language_${languageCodes[0]}_${modality}_${kind}`;
  }
  const normalized = normalizeQuestionValue(text);
  if (!normalized) return '';
  const context = normalizeQuestionValue(question?.context);
  const type = normalizeQuestionValue(question?.type) || 'unknown';
  const options = [...new Set(optionValues(question))].sort().join('|');
  return `question_${questionHash(`${type}\u0000${context}\u0000${normalized}\u0000${options}`)}`;
}

/** Reuse answers across changed ids only when their topic is unambiguous and the answer fits. */
export function candidateAnswersForQuestions(questions, answers = {}, memory = {}) {
  const result = { ...(answers && typeof answers === 'object' ? answers : {}) };
  const currentValues = new Map();
  const conflicts = new Set();
  for (const question of Array.isArray(questions) ? questions : []) {
    const key = candidateQuestionAnswerKey(question);
    const value = result[question?.id];
    if (!key || !hasQuestionAnswer(value)) continue;
    const previous = currentValues.get(key);
    if (!previous) currentValues.set(key, { value, comparable: answerValueKey(value) });
    else if (previous.comparable !== answerValueKey(value)) conflicts.add(key);
  }
  for (const question of Array.isArray(questions) ? questions : []) {
    if (!question?.id || hasQuestionAnswer(result[question.id])) continue;
    const key = candidateQuestionAnswerKey(question);
    if (!key || conflicts.has(key)) continue;
    const remembered = Object.hasOwn(memory || {}, key) ? memory[key] : undefined;
    if (Object.hasOwn(memory || {}, key) && !hasQuestionAnswer(remembered)) continue;
    const source = currentValues.get(key)?.value ?? remembered;
    if (hasQuestionAnswer(source) && answerFitsQuestion(source, question)) result[question.id] = source;
  }
  return result;
}

/** Persist a compact, order-scoped answer ledger so a later draft can survive new question ids. */
export function rememberCandidateQuestionAnswers({ questions, answers = {}, previous = {}, changed = {} } = {}) {
  const memory = { ...(previous && typeof previous === 'object' ? previous : {}) };
  const groups = new Map();
  for (const question of Array.isArray(questions) ? questions : []) {
    const key = candidateQuestionAnswerKey(question);
    if (!key || !question?.id) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(question);
  }
  for (const [key, group] of groups) {
    const changedQuestions = group.filter((question) => Object.hasOwn(changed || {}, question.id));
    const changedValues = changedQuestions.map((question) => answers[question.id]).filter(hasQuestionAnswer);
    const currentValues = group.map((question) => answers[question.id]).filter(hasQuestionAnswer);
    const unique = new Map(currentValues.map((value) => [answerValueKey(value), value]));
    const changedUnique = new Map(changedValues.map((value) => [answerValueKey(value), value]));
    const explicitClear = changedQuestions.some((question) => !hasQuestionAnswer(changed[question.id]));
    if (changedUnique.size === 1) memory[key] = [...changedUnique.values()][0];
    else if (changedUnique.size > 1 || explicitClear) memory[key] = '';
    else if (unique.size === 1 && !Object.hasOwn(memory, key)) memory[key] = [...unique.values()][0];
    else if (unique.size > 1) memory[key] = '';
  }
  return Object.fromEntries(Object.entries(memory).slice(-80));
}

/** Whether a language ability question still needs an answer after facts from the CV are applied. */
export function questionNeedsCandidateAnswer(question, profile) {
  return !languageExplicitlyAbsent(profile, question?.question);
}

/** Remove questions established by the CV and duplicate semantic requests, retaining required status. */
export function questionsForCandidate(questions, profile, answers = {}, memory = {}) {
  const projectedAnswers = candidateAnswersForQuestions(questions, answers, memory);
  const candidates = (Array.isArray(questions) ? questions : []).filter((question) => questionNeedsCandidateAnswer(question, profile));
  const answerValues = new Map();
  const conflictingKeys = new Set();
  const questionsByKey = new Map();
  for (const question of candidates) {
    const key = candidateQuestionAnswerKey(question);
    if (key) {
      if (!questionsByKey.has(key)) questionsByKey.set(key, []);
      questionsByKey.get(key).push(question);
    }
    const answer = projectedAnswers[question?.id];
    if (!key || !hasQuestionAnswer(answer)) continue;
    if (!answerValues.has(key)) answerValues.set(key, new Set());
    answerValues.get(key).add(answerValueKey(answer));
    if (answerValues.get(key).size > 1) conflictingKeys.add(key);
  }
  const incompatibleKeys = new Set();
  for (const [key, group] of questionsByKey) {
    for (const question of group) {
      const answer = projectedAnswers[question?.id];
      if (hasQuestionAnswer(answer) && group.some((other) => !answerFitsQuestion(answer, other))) incompatibleKeys.add(key);
    }
  }
  const result = [];
  const seen = new Map();
  for (const question of candidates) {
    const key = candidateQuestionAnswerKey(question);
    if (!key) {
      result.push(question);
      continue;
    }
    if (conflictingKeys.has(key) || incompatibleKeys.has(key)) {
      result.push(question);
      continue;
    }
    const priorIndex = seen.get(key);
    if (priorIndex === undefined) {
      seen.set(key, result.length);
      result.push(question);
      continue;
    }
    const previous = result[priorIndex];
    const previousAnswered = hasQuestionAnswer(projectedAnswers[previous.id]);
    const currentAnswered = hasQuestionAnswer(projectedAnswers[question.id]);
    const preferred = currentAnswered && !previousAnswered
      || Boolean(question.required && !previous.required)
      ? question
      : previous;
    result[priorIndex] = { ...preferred, required: Boolean(previous.required || question.required) };
  }
  return result;
}

const MESSAGES = {
  name: {
    it: 'Scrivi il nome con le lettere, come nei tuoi documenti.',
    de: 'Schreib den Namen mit Buchstaben, wie in deinen Dokumenten.',
    fr: 'Écrivez le nom en lettres, comme sur vos documents.',
    en: 'Write the name in letters, as in your documents.',
  },
  phone: {
    it: 'Un numero di telefono, per esempio +41 91 123 45 67.',
    de: 'Eine Telefonnummer, zum Beispiel +41 91 123 45 67.',
    fr: 'Un numéro de téléphone, par exemple +41 91 123 45 67.',
    en: 'A phone number, for example +41 91 123 45 67.',
  },
  linkedin: {
    it: 'Il link al tuo profilo LinkedIn, per esempio linkedin.com/in/nome-cognome.',
    de: 'Der Link zu deinem LinkedIn-Profil, zum Beispiel linkedin.com/in/vorname-nachname.',
    fr: 'Le lien vers votre profil LinkedIn, par exemple linkedin.com/in/prenom-nom.',
    en: 'The link to your LinkedIn profile, for example linkedin.com/in/first-last.',
  },
  salary: SALARY_RULE_MESSAGES,
  required: {
    it: 'Questo campo è obbligatorio.',
    de: 'Dieses Feld ist obligatorisch.',
    fr: 'Ce champ est obligatoire.',
    en: 'This field is required.',
  },
  tooShort: {
    it: 'Il testo è troppo corto.',
    de: 'Der Text ist zu kurz.',
    fr: 'Le texte est trop court.',
    en: 'The text is too short.',
  },
  tooLong: {
    it: 'Il testo è troppo lungo.',
    de: 'Der Text ist zu lang.',
    fr: 'Le texte est trop long.',
    en: 'The text is too long.',
  },
  alias: {
    it: 'L’indirizzo della candidatura non si cambia: le risposte del datore arrivano lì e te le inoltriamo.',
    de: 'Die Adresse der Bewerbung bleibt: Antworten des Arbeitgebers kommen dort an und wir leiten sie dir weiter.',
    fr: 'L’adresse de la candidature ne change pas : les réponses de l’employeur y arrivent et nous vous les transmettons.',
    en: 'The application address stays: the employer’s replies arrive there and we forward them to you.',
  },
  question: {
    it: 'Si cambia nella domanda qui sopra.',
    de: 'Das änderst du in der Frage oben.',
    fr: 'Cela se modifie dans la question ci-dessus.',
    en: 'Change it in the question above.',
  },
  birthDate: {
    it: 'Una data di nascita valida, per esempio 12.03.1998.',
    de: 'Ein gültiges Geburtsdatum, zum Beispiel 12.03.1998.',
    fr: 'Une date de naissance valide, par exemple 12.03.1998.',
    en: 'A valid date of birth, for example 12.03.1998.',
  },
};

const say = (key, locale) => MESSAGES[key][locale] || MESSAGES[key].it;

const rule = (partial) => ({ pattern: '', minLength: 0, maxLength: 200, min: null, max: null, minDate: '', example: '', message: '', ...partial });

const NAME = safePattern("\\p{L}[\\p{L}\\p{M}'’. -]*");
const PHONE = safePattern('\\+?[0-9][0-9 ()./-]{5,24}');
const LINKEDIN = safePattern('(?:https?://)?(?:[a-z]{2,3}\\.)?linkedin\\.com/\\S+');
// Day first, as the CV prints it, or ISO; that it is a real date in the past is checked on save.
const BIRTH_DATE = safePattern('\\d{1,2}[./]\\d{1,2}[./]\\d{4}|\\d{4}-\\d{2}-\\d{2}');

/**
 * The form fields the candidate may change. `inLetter`: printed in the letter
 * header, so a change rebuilds the PDF. `inCv`: printed in the tailored CV, so
 * the page shows it for e-mail applications too. `answerId`: the question that
 * asks the same thing wins (the field is changed there). `perRound`: a text of
 * this round's draft, not a fact about the candidate. `choice: 'permit'`: one
 * of the permit statuses (lib/permitStatus.js). `birthDate`: a real date in
 * the past.
 */
export const EDITABLE_FIELDS = {
  firstName: { rule: rule({ pattern: NAME, minLength: 1, maxLength: 80, example: 'Maria' }), message: 'name', required: true, inLetter: true, inCv: true },
  lastName: { rule: rule({ pattern: NAME, minLength: 1, maxLength: 80, example: 'Rossi' }), message: 'name', required: true, inLetter: true, inCv: true },
  phone: { rule: rule({ pattern: PHONE, maxLength: 30, example: '+41 91 123 45 67' }), message: 'phone', inLetter: true, inCv: true },
  location: { rule: rule({ maxLength: 120 }), inLetter: true, inCv: true },
  linkedin: { rule: rule({ pattern: LINKEDIN, maxLength: 200, example: 'linkedin.com/in/nome-cognome' }), message: 'linkedin', inCv: true },
  languages: { rule: rule({ maxLength: 200 }), inCv: true },
  // Optional corrections, never asked by a required question (decision 5): no question locks them.
  dateOfBirth: { rule: rule({ pattern: BIRTH_DATE, maxLength: 40, example: '12.03.1998' }), message: 'birthDate', inCv: true, birthDate: true },
  nationality: { rule: rule({ maxLength: 120 }), inCv: true },
  workPermit: { rule: rule({ maxLength: 120 }), answerId: 'work_permit', inCv: true, choice: 'permit' },
  availability: { rule: rule({ maxLength: 120 }), answerId: 'availability', inCv: true },
  salary: { rule: rule({ pattern: safePattern('.*\\d.*'), maxLength: 120, example: "CHF 80'000" }), message: 'salary', answerId: 'salary_expectation' },
  motivationShort: { rule: rule({ maxLength: 600 }), perRound: true },
  whyCompany: { rule: rule({ maxLength: 400 }), perRound: true },
  // What the candidate said of themselves, by an answer or in their CV's own words (lib/personalFacts.js):
  // shown only when known, so that they can correct it. Neither is asked once the CV says it.
  salutation: { rule: rule({ maxLength: 40 }), answerId: 'salutation', choice: 'salutation' },
  civilStatus: { rule: rule({ maxLength: 60 }), choice: 'civilStatus' },
};

// The closed lists a field is chosen from, in the candidate's language, and whether a text is one of a list
// (in any of the four languages: a value kept from another locale stays valid).
const CHOICES = {
  permit: { options: permitOptions, valid: (text) => Boolean(permitStatusOf(text)) },
  salutation: { options: salutationOptions, valid: isSalutation },
  civilStatus: { options: civilStatusOptions, valid: (text) => Boolean(civilStatusCode(text)) },
};

/** Letter and e-mail lengths (the draft writes within them). */
export const TEXT_LIMITS = {
  coverLetterText: { min: 200, max: 8000 },
  emailSubject: { min: 3, max: 250 },
  emailBody: { min: 20, max: 4000 },
};

const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

/** The stored overrides, only known keys and bounded values. */
function storedOverrides(raw) {
  const out = {};
  for (const [key, value] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    const spec = EDITABLE_FIELDS[key];
    if (spec && !spec.perRound && typeof value === 'string') out[key] = clean(value, spec.rule.maxLength);
  }
  return out;
}

function splitLanguages(text) {
  return String(text || '').split(/[,;\n]/).map((part) => clean(part, 80)).filter(Boolean).map((language) => ({ language, level: '' }));
}

/**
 * The candidate as the application uses them: the order and the CV, then what
 * the candidate changed. A corrected permit, availability or salary replaces
 * an older answer; only a question the current draft asks again wins over it.
 * `profile.permitStatus` is derived here at every read, never stored as a
 * source: the code of the status the candidate chose (lib/permitStatus.js),
 * '' when none.
 * `personal`: the form of address and the civil status, derived here at every
 * read too: what the candidate answered or corrected, else what the CV states
 * explicitly or an unambiguous first name supports (lib/personalFacts.js). A form of address known from either source also stands as `answers.salutation`, so the
 * question is not asked and the portal's field is filled as if answered. The
 * civil status stays out of `profile` and `answers`: the letter and the CV
 * are written from those, and neither says whom the candidate married.
 * @returns {{identity:{name:string,email:string,phone:string,firstName:string,lastName:string}, profile:object & {permitStatus:string}, answers:object, overrides:object, personal:{salutation:string, civilStatus:string}}}
 */
export function candidateWithEdits({ order, draft, flow }) {
  const overrides = storedOverrides(flow?.formOverrides);
  const base = candidateIdentity(order, draft?.profile);
  const names = splitName(base.name);
  const firstName = has(overrides, 'firstName') ? overrides.firstName : names.firstName;
  const lastName = has(overrides, 'lastName') ? overrides.lastName : names.lastName;
  const identity = {
    ...base,
    name: [firstName, lastName].filter(Boolean).join(' ') || base.name,
    firstName,
    lastName,
    phone: has(overrides, 'phone') ? overrides.phone : base.phone,
  };
  const profile = { ...(draft?.profile || {}) };
  // Older profiles capped language lists at 12 without a completeness marker.
  // A shorter list can still be complete when its CV has a dedicated language
  // section; keep an at-cap legacy list conservative because it may be cut off.
  if (profile.languagesListTruncated === undefined) {
    profile.languagesListTruncated = Array.isArray(profile.languages)
      && profile.languages.length >= LEGACY_LANGUAGE_LIST_LIMIT;
    profile.languagesExplicitList = profile.languagesExplicitList === true && !profile.languagesListTruncated;
  }
  if (has(overrides, 'location')) profile.location = overrides.location;
  if (has(overrides, 'linkedin')) profile.linkedin = overrides.linkedin;
  if (has(overrides, 'languages')) {
    profile.languages = splitLanguages(overrides.languages);
    profile.languagesListTruncated = false;
    profile.languagesExplicitList = Boolean(overrides.languages.trim());
  }
  if (!has(overrides, 'languages') && profile.languagesListTruncated !== true && hasExplicitLanguageSection(draft?.factSources?.text)) profile.languagesExplicitList = true;
  if (has(overrides, 'workPermit')) profile.workPermit = overrides.workPermit;
  if (has(overrides, 'availability')) profile.availability = overrides.availability;
  if (has(overrides, 'dateOfBirth')) profile.dateOfBirth = overrides.dateOfBirth;
  if (has(overrides, 'nationality')) profile.nationality = overrides.nationality;
  const answers = candidateAnswersForQuestions(draft?.questions, flow?.answers || {}, flow?.questionAnswers || {});
  const asked = new Set((draft?.questions || []).map((question) => question.id));
  for (const [key, spec] of Object.entries(EDITABLE_FIELDS)) {
    if (spec.answerId && has(overrides, key) && !asked.has(spec.answerId)) answers[spec.answerId] = overrides[key];
  }
  // The status is what the candidate chose (the question, else the field, else an older answer), never the CV's
  // words (decision 2). An availability they gave is the one the CV prints.
  profile.permitStatus = permitStatusOf(clean(answers.work_permit, 200) || (has(overrides, 'workPermit') ? overrides.workPermit : ''));
  const availability = clean(answers.availability, 200);
  if (availability) profile.availability = availability;
  const cv = cvPersonalFacts(draft?.factSources?.text);
  const locale = order?.locale || 'it';
  const salutation = salutationNow({ answers, overrides, cvGender: cv.gender || salutationGenderFromName(identity.firstName, locale), locale });
  answers.salutation = salutation;
  if (!salutation) delete answers.salutation;
  const personal = { salutation, civilStatus: has(overrides, 'civilStatus') ? overrides.civilStatus : cv.civilStatusText };
  return { identity, profile, answers, overrides, personal };
}

/**
 * The candidate's form of address as of now. What the CV says is a default, never a rule; the candidate's
 * own word comes first, in this order:
 *  1. the field they corrected on the review page, even emptied (`has`, not truthiness), whatever an older
 *     answer says: `answers.salutation` «Monsieur» with `formOverrides.salutation` «» gives «». It holds
 *     across rounds, and a draft written afterwards does not ask the question again (lib/draft.mjs): the
 *     older answer would otherwise come back with the question (review of #12348);
 *  2. their answer to the question;
 *  3. only where they touched neither, the gender the CV explicitly states in its own words or the locale-aware
 *     default for an unambiguous first name. Unknown and ambiguous names leave the field blank.
 */
function salutationNow({ answers, overrides, cvGender, locale }) {
  if (has(overrides, 'salutation')) return overrides.salutation;
  return clean(answers.salutation, 40) || salutationFor(cvGender, locale);
}

/**
 * The fact sources a gate run reads, with the candidate's permit status of now
 * (decision 8). A draft written before the status existed has no
 * `permitStatus` in its sources and is judged as it was.
 */
export function factSourcesNow({ order, draft, flow }, sources = draft?.factSources || {}) {
  if (typeof sources?.permitStatus !== 'string') return sources;
  return { ...sources, permitStatus: candidateWithEdits({ order, draft, flow }).profile.permitStatus };
}

/** The form fields with the candidate's changes (review page, handoff kit, owner queue). */
export function formAnswersWithEdits({ order, draft, flow }) {
  if (!draft) return [];
  const { identity, profile, answers, personal } = candidateWithEdits({ order, draft, flow });
  const motivation = Object.fromEntries((draft.formAnswers || []).map((field) => [field.key, field.value]));
  return buildFormAnswers({
    identity,
    profile,
    documents: { motivationShort: motivation.motivationShort, whyCompany: motivation.whyCompany },
    answers,
    locale: order?.locale || 'it',
    personal,
  });
}

/** Why a field cannot be changed here: the alias, or a question that asks it. */
function lockReason(key, draft) {
  if (key === 'email') return 'alias';
  const answerId = EDITABLE_FIELDS[key]?.answerId;
  if (answerId && (draft?.questions || []).some((question) => question.id === answerId)) return 'question';
  return EDITABLE_FIELDS[key] ? null : 'fixed';
}

/** The field's rule with its message in the candidate's language. */
export function fieldRule(key, locale = 'it') {
  const spec = EDITABLE_FIELDS[key];
  if (!spec) return null;
  return { ...spec.rule, message: spec.message ? say(spec.message, locale) : '' };
}

/** How the page shows a field: editable or not (and why), with the rule. */
export function fieldView(field, { draft, locale = 'it' }) {
  const lock = lockReason(field.key, draft);
  const spec = EDITABLE_FIELDS[field.key];
  const view = {
    key: field.key,
    // The form of address and the civil status are named here, in the candidate's language, as their lists are.
    label: personalFieldLabel(field.key, locale) || field.label,
    value: field.value,
    editable: !lock,
    locked: lock === 'alias' || lock === 'question' ? lock : null,
    required: Boolean(spec?.required),
    inLetter: Boolean(spec?.inLetter) || field.key === 'email',
    inCv: Boolean(spec?.inCv),
    validation: lock ? null : fieldRule(field.key, locale),
  };
  // The permit status is chosen, never typed (decision 2): the six options in the candidate's language. A value
  // that is none of them (the CV's own words, an older text) stays shown and selected; no status is pre-selected.
  // So are the form of address and the civil status.
  if (!lock && CHOICES[spec?.choice]) {
    const options = CHOICES[spec.choice].options(locale);
    const value = String(field.value || '').trim();
    view.options = value && !options.includes(value) ? [value, ...options] : options;
  }
  return view;
}

function checkField(key, text, locale, todayIso) {
  const spec = EDITABLE_FIELDS[key];
  if (!text) return spec.required ? say('required', locale) : '';
  if (text.length > spec.rule.maxLength) return say('tooLong', locale);
  const question = { type: 'text', required: false, validation: fieldRule(key, locale) };
  const result = validateAnswer(text, question);
  if (!result.ok) return answerMessage(result, question, locale);
  // Only a text that is there is held to its list: an emptied field is accepted (above), never «not an option».
  const list = CHOICES[spec.choice];
  if (list && text && !list.valid(text)) return answerMessage({ ok: false, reason: 'not_an_option', message: '' }, {}, locale);
  if (spec.birthDate) {
    const iso = isoDateOf(text);
    if (!iso || iso > todayIso) return say('birthDate', locale);
  }
  return '';
}

function checkText(key, text, locale) {
  const { min, max } = TEXT_LIMITS[key];
  if (text.length < min) return say('tooShort', locale);
  if (text.length > max) return say('tooLong', locale);
  return '';
}

const signatureOf = (identity) => [identity.name, identity.email, identity.phone].filter(Boolean).join('\n');

/**
 * What an edit request changes, checked the same way as on the page. Only
 * what differs from what the candidate saw is kept.
 * @param {{coverLetterText?:string, emailSubject?:string, emailBody?:string, fields?:Record<string,string>}} raw
 * @returns {{errors:Record<string,string>, changed:string[], overrides:object, draftPatch:object, identityChanged:boolean, candidateText:string}}
 */
export function planCandidateEdits(raw, { order, draft, flow, locale = 'it', nowMs = Date.now() }) {
  const todayIso = new Date(nowMs).toISOString().slice(0, 10);
  const errors = {};
  const changed = [];
  const draftPatch = {};
  const overrides = {};
  const written = [];
  const input = raw && typeof raw === 'object' ? raw : {};

  const shown = new Map(formAnswersWithEdits({ order, draft, flow }).map((field) => [field.key, field.value]));
  const roundTexts = {};
  for (const [key, value] of Object.entries(input.fields && typeof input.fields === 'object' ? input.fields : {})) {
    if (!shown.has(key) || typeof value !== 'string') continue;
    const text = clean(value, 2000);
    if (text === clean(shown.get(key), 2000)) continue;
    const lock = lockReason(key, draft);
    if (lock) {
      errors[key] = say(lock === 'question' ? 'question' : 'alias', locale);
      continue;
    }
    const problem = checkField(key, text, locale, todayIso);
    if (problem) {
      errors[key] = problem;
      continue;
    }
    if (EDITABLE_FIELDS[key].perRound) roundTexts[key] = text;
    else overrides[key] = text;
    written.push(text);
  }
  if (Object.keys(overrides).length) changed.push('fields');
  if (Object.keys(roundTexts).length) {
    const present = new Set((draft.formAnswers || []).map((field) => field.key));
    draftPatch.formAnswers = [
      ...(draft.formAnswers || []).map((field) => (has(roundTexts, field.key) ? { ...field, value: roundTexts[field.key] } : field)),
      ...Object.entries(roundTexts).filter(([key]) => !present.has(key)).map(([key, value]) => ({ key, label: key, value, needsConfirmation: false, note: '' })),
    ];
    changed.push('texts');
  }

  if (typeof input.coverLetterText === 'string') {
    const letter = parseLetterText(cleanBlock(input.coverLetterText, TEXT_LIMITS.coverLetterText.max + 1));
    const text = letterText(letter);
    if (text !== letterText(parseLetterText(draft.coverLetter?.text || ''))) {
      const problem = checkText('coverLetterText', text, locale);
      if (problem) errors.coverLetterText = problem;
      else {
        draftPatch.coverLetter = { ...(draft.coverLetter || {}), ...letter, text };
        changed.push('coverLetter');
        written.push(text);
      }
    }
  }

  // The e-mail exists only when the application leaves by e-mail.
  const email = draft.channel?.type === 'email' ? { ...(draft.applicationEmail || {}) } : null;
  if (email) {
    let emailChanged = false;
    if (typeof input.emailSubject === 'string') {
      const subject = clean(input.emailSubject, TEXT_LIMITS.emailSubject.max + 1);
      if (subject !== clean(email.subject, TEXT_LIMITS.emailSubject.max + 1)) {
        const problem = checkText('emailSubject', subject, locale);
        if (problem) errors.emailSubject = problem;
        else { email.subject = subject; emailChanged = true; written.push(subject); }
      }
    }
    if (typeof input.emailBody === 'string') {
      const body = cleanBlock(input.emailBody, TEXT_LIMITS.emailBody.max + 1);
      if (body !== cleanBlock(email.body, TEXT_LIMITS.emailBody.max + 1)) {
        const problem = checkText('emailBody', body, locale);
        if (problem) errors.emailBody = problem;
        else { email.body = body; emailChanged = true; written.push(body); }
      }
    }
    // A new name or phone also updates the signature we wrote under the
    // e-mail: found in the e-mail as drafted, written under the e-mail as
    // saved, so a rewritten body never leaves without the contact details.
    const before = candidateWithEdits({ order, draft, flow }).identity;
    const after = candidateWithEdits({ order, draft, flow: { ...flow, formOverrides: { ...(flow?.formOverrides || {}), ...overrides } } }).identity;
    const oldSignature = signatureOf(before);
    const newSignature = signatureOf(after);
    if (oldSignature !== newSignature && oldSignature && String(draft.applicationEmail?.body || '').endsWith(oldSignature)) {
      const body = String(email.body || '');
      if (body.endsWith(oldSignature)) email.body = `${body.slice(0, -oldSignature.length)}${newSignature}`;
      else if (!body.endsWith(newSignature)) email.body = `${body.replace(/\s+$/, '')}\n\n${newSignature}`;
      emailChanged = true;
    }
    if (emailChanged) {
      draftPatch.applicationEmail = email;
      changed.push('email');
    }
  }

  const identityChanged = ['firstName', 'lastName', 'phone', 'location'].some((key) => has(overrides, key));
  return {
    errors,
    changed: Object.keys(errors).length ? [] : changed,
    overrides,
    draftPatch,
    identityChanged,
    candidateText: written.join('\n'),
  };
}
