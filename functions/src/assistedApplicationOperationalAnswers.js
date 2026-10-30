/**
 * Owner-configured form preferences, not facts from the candidate's CV.
 * Keep them out of the confirmed-answer ledger and qualification evidence.
 */
import { isPreferredWorkloadQuestion } from './assistedApplicationCandidateEdits.js';
import { validateAnswer } from './lib/answerRules.js';

export const OPERATIONAL_DEFAULTS_VERSION = 'operational-preferences-v1';
const norm = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
const hasAnswer = value => typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
  || (Array.isArray(value) ? value.some(item => String(item ?? '').trim()) : String(value ?? '').trim().length > 0);
const YES = /^(?:si|yes|ja|oui|true|1)$/;
const HARD_DECLARATION = /\b(?:experience|esperienz\w*|erfahrung|kenntnis\w*|conosc\w*|qualific\w*|certific\w*|degree|diplom\w*|laurea|law|gesetz|loi|legal|legale|legali|marketing|newsletter|promoz\w*|promot\w*|publicit\w*|werbung|terms|conditions|condizioni|privacy|datenschutz|confidentialite|disabil\w*|criminal\w*|penal\w*|consent\w*|consens\w*|einwillig\w*|zustimm\w*|processing|trattamento|traitement|verarbeitung|salar\w*|gehalt|lohn|retribuz\w*|remuner\w*|start date|starting date|earliest|available from|data di inizio|data d inizio|data di assunzione|fruhest\w*|eintrittsdatum|startdatum|date de debut|date d entree|commencer)\b/;
const NOTICE = /\b(?:notice period|notice time|period of notice|periodo di preavviso|preavviso|kundigungsfrist|delai de preavis|preavis)\b/;
const CONSTRAINED_NOTICE = /\b(?:within|entro|max(?:imum)?|min(?:imum)?|al massimo|almeno|at least|no more|spatestens|mindestens|au moins|au plus|confirm|confermi|bestatigen|confirmez|can you|could you|would you|are you|do you|puoi|potresti|saresti|konnen sie|wurden sie|pouvez vous|pourriez vous|days?|giorni|tage|jours|weeks?|settimane|wochen|semaines)\b/;
const CONTACT = /\b(?:comunicazion\w*|contatt\w*|contact\w*|communication|kommunikation|kontakt\w*|erreich\w*)\b/;
// ATS adapters may expose a yes/no preference as a text input. Only a
// complete, unconditional contact label can imply that binary meaning.
const CONTACT_PREFERENCE_LABEL = /^(?:(?:comunicazione|contatto) (?:via|tramite|su) whatsapp|(?:contact|communication) (?:via|on|through) whatsapp|whatsapp (?:contact|communication)|(?:kommunikation|kontakt) (?:via|per|uber) whatsapp|(?:contact|communication) (?:via|par|sur) whatsapp)$/;
const CONTACT_FACT = /\b(?:do you use|do you have|usi|utilizzi|possiedi|nutzen sie|verwenden sie|utilisez vous|avez vous|number|numero|nummer|telephone|telefono)\b/;
const OTHER_NOTICE_TOPIC = /\b(?:availability|disponibilita|verfugbarkeit|disponibilite|workload|pensum|grado di occupazione|taux d activite|taux d occupation)\b/;

function optionsOf(question) {
  const raw = question?.options?.length ? question.options : question?.applicationOptions || [];
  return raw.map(option => typeof option === 'string' ? { label: option, value: option } : option)
    .filter(option => option && option.placeholder !== true && String(option.label ?? option.value ?? '').trim())
    .map(option => ({ label: String(option.label ?? option.value), value: String(option.value ?? option.label) }));
}

const SMALL_NUMBERS = { zero: 0, uno: 1, one: 1, un: 1, une: 1, ein: 1, eins: 1, eine: 1, einen: 1,
  two: 2, due: 2, zwei: 2, deux: 2, three: 3, tre: 3, drei: 3, trois: 3,
  four: 4, quattro: 4, vier: 4, quatre: 4, five: 5, cinque: 5, funf: 5, fuenf: 5, cinq: 5,
  six: 6, sei: 6, sechs: 6 };
const literalAnswer = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/\s+/g, ' ');
function noticeDuration(value) {
  const match = /^(\d{1,2}|[a-z]+)\s*(months?|mesi|mese|monate?n?|mois|days?|giorni|giorno|tage?n?|jours?)$/.exec(literalAnswer(value));
  if (!match) return null;
  const amount = /^\d+$/.test(match[1]) ? Number(match[1]) : SMALL_NUMBERS[match[1]];
  if (!Number.isInteger(amount)) return null;
  return { amount, unit: /^(?:days?|giorni|giorno|tage?n?|jours?)$/.test(match[2]) ? 'days' : 'months' };
}

/** Project a stated notice duration onto one actual option, without changing its value or provenance. */
export function operationalAnswerForOption(question, answer) {
  if (operationalQuestionTopic(question) !== 'notice_period') return null;
  const options = optionsOf(question);
  if (!options.length) return null;
  const duration = noticeDuration(answer);
  let matching;
  if (duration) {
    matching = options.filter(option => {
      const offered = noticeDuration(option.label);
      return offered && offered.unit === duration.unit && offered.amount === duration.amount;
    });
    if (matching.length > 1) return null;
    // Every calendar month has at least 28 days. Do not approximate 28/30
    // days as a month, nor infer that zero means employment has terminated.
    if (!matching.length && duration.unit === 'days' && duration.amount > 0 && duration.amount < 28) {
      matching = options.filter(option => /^(?:meno di (?:1|un) mese|less than (?:1|one) month|weniger als (?:1|ein|einen|einem) monat|moins (?:de|d) (?:1|un) mois)$/.test(literalAnswer(option.label).replace(/[’']/g, ' ').replace(/\s+/g, ' ')));
    }
  } else matching = options.filter(option => literalAnswer(option.label) === literalAnswer(answer));
  if (matching.length !== 1) return null;
  const value = matching[0].label;
  return validateAnswer(value, { ...question, type: 'choice', options: options.map(option => option.label) }).ok ? value : null;
}

/** Preliminary readiness permits a fresh native read, never a final send. */
export function operationalAnswerReadyForDiscovery(question, answer) {
  const topic = operationalQuestionTopic(question);
  if (!topic || !hasAnswer(answer)) return false;
  const options = optionsOf(question);
  if (options.length) {
    const value = topic === 'notice_period' ? operationalAnswerForOption(question, answer) : String(answer).trim();
    return Boolean(value && validateAnswer(value, { ...question, type: question.type || 'choice', options: options.map(option => option.label) }).ok);
  }
  if (topic === 'notice_period' && !noticeDuration(answer)) return false;
  if (topic === 'preferred_workload' && !/^(?:100|[0-9]{1,2})(?:\s*%)?$/.test(String(answer).trim())) return false;
  if (topic === 'whatsapp_contact' && !/^(?:si|yes|ja|oui|true|1|no|nein|non|false|0)$/.test(literalAnswer(answer))) return false;
  // The old choice descriptor may have lost its catalogue. Only discovery
  // may use this text validation; the live control must supply its real type.
  return validateAnswer(String(answer), { ...question, type: question.type === 'choice' ? 'text' : question.type || 'text', options: [] }).ok;
}

function languageOf(text, locale) {
  if (['it', 'en', 'de', 'fr'].includes(locale)) return locale;
  if (/\b(?:preavviso|comunicazione|contatto|accetti|tramite|tuo|occupazione|desider\w*)\b/.test(text)) return 'it';
  if (/\b(?:kundigungsfrist|kommunikation|kontakt|pensum|beschaftigungsgrad|gewunscht\w*)\b/.test(text)) return 'de';
  if (/\b(?:preavis|delai|votre|vous|souhait\w*|acceptez|taux)\b|\b(?:communication|contact) (?:par|sur) whatsapp\b/.test(text)) return 'fr';
  return 'en';
}

/** Only unconditional operational preferences have an automatic default. */
export function operationalQuestionTopic(question) {
  const label = String(question?.question || question?.label || question?.applicationQuestion || '')
    .replace(/\s*(?:\((?:required|obligatoire|obbligatorio|pflichtfeld)\)|\*)\s*$/i, '');
  const text = norm(label + ' ' + (question?.applicationQuestion || ''));
  if (!text || HARD_DECLARATION.test(text) || question?.type === 'date' || question?.inputType === 'date') return null;
  if (NOTICE.test(text) && OTHER_NOTICE_TOPIC.test(text)) return null;
  if (isPreferredWorkloadQuestion(label)) return 'preferred_workload';
  if (NOTICE.test(text) && !CONSTRAINED_NOTICE.test(text) && !['yes_no', 'checkbox'].includes(question?.type || question?.kind)) return 'notice_period';
  if (/\bwhatsapp\b/.test(text) && CONTACT.test(text) && !CONTACT_FACT.test(text)) {
    // Adjacent form labels are not candidate facts. A promotional/privacy
    // qualifier attached to WhatsApp still makes this a consent, not a preference.
    const context = norm(question?.context);
    if (/(?:whatsapp.{0,80}(?:marketing|newsletter|privacy|promoz|publicit|werbung|consent|consens|einwillig|processing|trattamento|traitement|verarbeitung)|(?:marketing|newsletter|privacy|promoz|publicit|werbung|consent|consens|einwillig|processing|trattamento|traitement|verarbeitung).{0,80}whatsapp)/.test(context)) return null;
    const options = optionsOf(question);
    const binary = ['yes_no', 'checkbox'].includes(question?.type || question?.kind)
      || options.some(option => YES.test(norm(option.label)))
      || CONTACT_PREFERENCE_LABEL.test(norm(label));
    return binary ? 'whatsapp_contact' : null;
  }
  return null;
}

/** Return a value the actual field can express; never choose another preference. */
export function operationalDefaultAnswer(question, { locale } = {}) {
  const topic = operationalQuestionTopic(question);
  if (!topic) return null;
  const options = optionsOf(question);
  const text = norm(question?.applicationQuestion || question?.question || question?.label);
  const language = languageOf(text, locale);
  let value;
  if (topic === 'notice_period') {
    if (options.length) {
      value = operationalAnswerForOption(question, '3 months');
      if (!value) return null;
    } else if (question?.type === 'number' || question?.inputType === 'number') {
      if (!/\b(?:months?|mesi|mese|monate?n?|mois)\b/.test(text)) return null;
      value = '3';
    } else value = { it: '3 mesi', en: '3 months', de: '3 Monate', fr: '3 mois' }[language];
  } else if (topic === 'preferred_workload') {
    if (options.length) {
      const matches = options.filter(option => /^100\s*%?$/.test(option.label.trim()) || /^100\s*%?$/.test(option.value.trim()));
      if (matches.length !== 1) return null;
      value = matches[0].label;
    } else value = question?.type === 'number' || question?.inputType === 'number' ? '100' : '100%';
  } else {
    if (options.length) {
      const matches = options.filter(option => YES.test(norm(option.label)));
      if (matches.length !== 1) return null;
      value = matches[0].label;
    } else value = question?.kind === 'checkbox' || question?.type === 'checkbox'
      ? 'true' : { it: 'Sì', en: 'Yes', de: 'Ja', fr: 'Oui' }[language];
  }
  const validationQuestion = { ...question, type: question.type || (options.length ? 'choice' : question.inputType || 'text'), options: options.map(option => option.label) };
  if (!validateAnswer(value, validationQuestion).ok) return null;
  return { value, topic, source: 'policy_default', version: OPERATIONAL_DEFAULTS_VERSION };
}

/** Project defaults for forms only; supplied/remembered answers always win. */
export function withOperationalQuestionAnswers(questions, confirmedAnswers = {}, options = {}) {
  const answers = { ...confirmedAnswers };
  const defaults = {};
  for (const question of Array.isArray(questions) ? questions : []) {
    if (!question?.id) continue;
    if (hasAnswer(answers[question.id])) {
      const projected = operationalAnswerForOption(question, answers[question.id]);
      if (projected) answers[question.id] = projected;
      continue;
    }
    const answer = operationalDefaultAnswer(question, options);
    if (!answer) continue;
    answers[question.id] = answer.value;
    defaults[question.id] = answer;
  }
  return { answers, defaults };
}

/** An answer is permitted only by the policy for this exact field. */
export function isOperationalDefaultValue(question, value) {
  const expected = operationalDefaultAnswer(question);
  if (!expected) return false;
  if (expected.topic === 'notice_period') {
    const wanted = noticeDuration(expected.value);
    const stated = noticeDuration(value);
    const equivalent = wanted && stated
      ? wanted.amount === stated.amount && wanted.unit === stated.unit
      : literalAnswer(expected.value) === literalAnswer(value);
    const options = optionsOf(question);
    const rule = { ...question, type: question.type || (options.length ? 'choice' : question.inputType || 'text'), options: options.map(option => option.label) };
    return Boolean(equivalent && validateAnswer(value, rule).ok);
  }
  return norm(expected.value) === norm(value);
}

/** Required form preferences also leave with an email application. Never edit the CV. */
export function operationalEmailBody(draft, confirmedAnswers = {}) {
  const { answers, defaults } = withOperationalQuestionAnswers(draft?.questions, confirmedAnswers, { locale: draft?.language });
  const lines = (draft?.questions || []).filter(question => question.required && defaults[question.id])
    .map(question => `${question.applicationQuestion || question.question}: ${answers[question.id]}`);
  const body = draft?.applicationEmail?.body || '';
  return lines.length ? `${body}\n\n${lines.join('\n')}` : body;
}
