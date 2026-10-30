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
const CONTACT_FACT = /\b(?:do you use|do you have|usi|utilizzi|possiedi|nutzen sie|verwenden sie|utilisez vous|avez vous|number|numero|nummer|telephone|telefono)\b/;
const OTHER_NOTICE_TOPIC = /\b(?:availability|disponibilita|verfugbarkeit|disponibilite|workload|pensum|grado di occupazione|taux d activite|taux d occupation)\b/;
const THREE_MONTHS = /\b(?:3|three|tre|drei|trois)\s*(?:months?|mesi|mese|monate?n?|mois)\b/;

function optionsOf(question) {
  const raw = question?.options?.length ? question.options : question?.applicationOptions || [];
  return raw.map(option => typeof option === 'string' ? { label: option, value: option } : option)
    .filter(option => option && String(option.label ?? option.value ?? '').trim())
    .map(option => ({ label: String(option.label ?? option.value), value: String(option.value ?? option.label) }));
}

function languageOf(text, locale) {
  if (['it', 'en', 'de', 'fr'].includes(locale)) return locale;
  if (/\b(?:preavviso|comunicazione|accetti|tramite|tuo|occupazione|desider\w*)\b/.test(text)) return 'it';
  if (/\b(?:kundigungsfrist|kommunikation|kontakt|pensum|beschaftigungsgrad|gewunscht\w*)\b/.test(text)) return 'de';
  if (/\b(?:preavis|delai|votre|vous|souhait\w*|acceptez|taux)\b/.test(text)) return 'fr';
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
      || options.some(option => YES.test(norm(option.label)));
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
      const matches = options.filter(option => THREE_MONTHS.test(norm(option.label)) || THREE_MONTHS.test(norm(option.value)));
      if (matches.length !== 1) return null;
      value = matches[0].label;
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
    if (!question?.id || hasAnswer(answers[question.id])) continue;
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
  return Boolean(expected && norm(expected.value) === norm(value));
}

/** Required form preferences also leave with an email application. Never edit the CV. */
export function operationalEmailBody(draft, confirmedAnswers = {}) {
  const { answers, defaults } = withOperationalQuestionAnswers(draft?.questions, confirmedAnswers, { locale: draft?.language });
  const lines = (draft?.questions || []).filter(question => question.required && defaults[question.id])
    .map(question => `${question.applicationQuestion || question.question}: ${answers[question.id]}`);
  const body = draft?.applicationEmail?.body || '';
  return lines.length ? `${body}\n\n${lines.join('\n')}` : body;
}
