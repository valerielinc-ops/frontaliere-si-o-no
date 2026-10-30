/** Positive, typed question contracts. This module never infers a fact from a CV or an opaque answer key. */
import { PERMIT_STATUSES, permitOptionCode, permitOptions } from './permitStatus.js';

export const CANDIDATE_FACTS_VERSION = 'candidate-facts-v1';
const fold = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/ß/g, 'ss').replace(/[^a-z0-9+#./]+/g, ' ').replace(/[?.]+$/g, '').trim();
const words = value => fold(value).replace(/\s+/g, ' ').trim();
const full = (value, patterns) => patterns.map(pattern => pattern.exec(value)).find(Boolean);
const BIRTH_DATE = /^(?:what is your date of birth|when were you born|qual e la tua data di nascita|quando sei nato|quando sei nata|was ist ihr geburtsdatum|wann sind sie geboren|quelle est votre date de naissance|quand etes vous ne|quand etes vous nee)$/;
const PERMIT_STATUS = /^(?:what is your current swiss work permit status|quale permesso svizzero possiedi attualmente|welche schweizer bewilligung besitzen sie aktuell|quel permis suisse possedez vous actuellement)$/;
const DURATION = [
  /^how many (years|months) of experience do you have (?:with|in) (.+)$/,
  /^quanti (anni|mesi) di esperienza hai (?:con|in) (.+)$/,
  /^wie viele (jahre|monate) erfahrung haben sie (?:mit|in) (.+)$/,
  /^combien d (annees|mois) d experience avez vous (?:avec|en) (.+)$/,
];
const YEARS = new Set(['years', 'anni', 'jahre', 'annees']);
const CREDENTIAL = [
  /^do you hold (?:the |a |an )?(.+) certification$/,
  /^possiedi (?:la |una )?certificazione (.+)$/,
  /^besitzen sie (?:die |eine )?zertifizierung (.+)$/,
  /^possedez vous (?:la |une )?certification (.+)$/,
];
// The catalogue is positive and exact. An unrecognised subject stays job-bound;
// a nearby role, credential family or future goal is never promoted by substring.
const SUBJECTS = {
  experience: new Set(['python', 'java', 'javascript', 'typescript', 'c++', 'c#', 'sql', 'sap', 'sap s/4hana',
    'azure', 'aws', 'it project management', 'project management', 'business analysis', 'software development', 'customer service']),
  credential: new Set(['pmp', 'prince2 foundation', 'prince2 practitioner', 'itil foundation', 'itil 4 foundation',
    'itil v3 foundation', 'cissp', 'cism', 'aws certified solutions architect associate',
    'aws certified solutions architect professional', 'microsoft certified azure administrator associate']),
};
function namedSubject(value, type) {
  const subject = fold(value);
  return SUBJECTS[type]?.has(subject) ? subject : '';
}
function unqualified(question) {
  const label = words(question.question);
  return !question.context && !question.section && !question.autocomplete && !Object.hasOwn(question, 'addressContext') && question.source !== 'policy_default'
    && (!question.applicationQuestion || words(question.applicationQuestion) === label);
}

/** A recognized question describes a type; a separate value check is still required before portability. */
export function candidateQuestionFact(question = {}) {
  if (!question || typeof question !== 'object' || Array.isArray(question)) return null;
  const label = words(question.question);
  if (!unqualified(question)) return null;
  if (question.type === 'date' && BIRTH_DATE.test(label)) return {
    type: 'birth_date', subject: 'candidate', category: 'personal', unit: 'calendar_date', relation: 'date_of_birth',
  };
  if (question.type === 'number') {
    const match = full(label, DURATION); const subject = match && namedSubject(match[2], 'experience');
    if (subject) return { type: 'experience_duration', subject, category: 'experience', unit: YEARS.has(match[1]) ? 'years' : 'months', relation: 'reported_duration' };
  }
  if (['yes_no', 'checkbox'].includes(question.type)) {
    const match = full(label, CREDENTIAL); const subject = match && namedSubject(match[1], 'credential');
    if (subject) return { type: 'credential_held', subject, category: 'qualification', unit: 'boolean', relation: 'held_not_document_verified' };
  }
  if (question.type === 'choice' && PERMIT_STATUS.test(label)) return {
    type: 'permit_status', subject: 'candidate', category: 'work_authorization', unit: 'held_status', relation: 'reported_possession_not_work_right', jurisdiction: 'CH',
  };
  return null;
}

const OFFICIAL_PERMIT_LABELS = new Map(['it', 'en', 'de', 'fr'].flatMap(locale => permitOptions(locale).map((label, index) => [fold(label), PERMIT_STATUSES[index]])));
function positivePermitStatus(value) {
  return OFFICIAL_PERMIT_LABELS.get(fold(value)) || permitOptionCode(value);
}

/** No conversion or qualification inference. The original answer remains authoritative. */
export function candidateAnswerFact(question, answer, { nowMs = Date.now() } = {}) {
  const fact = candidateQuestionFact(question);
  if (!fact) return null;
  if (fact.type === 'birth_date') {
    if (!Number.isFinite(nowMs) || typeof answer !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(answer)) return null;
    const date = new Date(`${answer}T00:00:00.000Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== answer || date.getTime() > nowMs) return null;
  } else if (fact.type === 'experience_duration') {
    if (typeof answer !== 'number' && (typeof answer !== 'string' || !/^\d+(?:[.,]\d+)?$/.test(answer.trim()))) return null;
    const value = Number(String(answer).replace(',', '.'));
    if (!Number.isFinite(value) || value < 0) return null;
  } else if (fact.type === 'credential_held') {
    if (!(typeof answer === 'boolean' || /^(?:yes|no|si|ja|nein|oui|non|true|false)$/.test(fold(answer)))) return null;
  } else if (fact.type === 'permit_status') {
    const status = positivePermitStatus(answer);
    if (!status) return null;
    return { ...fact, status, scope: status === 'permit_g' ? 'job' : 'candidate' };
  }
  return { ...fact, scope: 'candidate' };
}

/** A stable typed identity; it does not attest a value or its source. */
export function candidateFactIdentity(fact) {
  if (!fact) return '';
  return [CANDIDATE_FACTS_VERSION, fact.type, fact.subject, fact.unit, fact.relation, fact.jurisdiction || ''].join('|');
}

/** Render the same explicit fact in an unambiguous target option; never change its meaning or unit. */
export function candidateFactAnswerForQuestion(question, answer) {
  const fact = candidateAnswerFact(question, answer);
  if (!fact) return null;
  const options = Array.isArray(question.options) ? question.options.filter(option => typeof option === 'string') : [];
  if (!options.length || options.includes(answer)) return answer;
  let matches;
  if (fact.type === 'permit_status') matches = options.filter(option => positivePermitStatus(option) === fact.status);
  else if (fact.type === 'credential_held') {
    const truth = value => /^(?:yes|si|ja|oui|true)$/.test(fold(value)) ? true
      : /^(?:no|nein|non|false)$/.test(fold(value)) ? false : null;
    const source = truth(answer);
    matches = options.filter(option => truth(option) === source);
  } else return null;
  return matches.length === 1 ? matches[0] : null;
}
