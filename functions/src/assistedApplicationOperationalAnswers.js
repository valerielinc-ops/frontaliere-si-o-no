/**
 * Owner-configured form preferences, not facts from the candidate's CV.
 * Keep them out of the confirmed-answer ledger and qualification evidence.
 */
import { isPreferredWorkloadQuestion } from './assistedApplicationCandidateEdits.js';
import { validateAnswer } from './lib/answerRules.js';
import { platformDefaultAnswer } from './assistedApplicationPlatformDefaults.js';
import { cvAnswerFor, isCvAnswerDefault } from './assistedApplicationCvAnswers.js';
import { decisionAnswerFor, isDecisionAnswerDefault } from './assistedApplicationDecisionAnswers.js';
import { hasConsentContradiction, isApplicationDataProcessingConsent, isPrivacyReviewAcknowledgment, minimumDataRetentionOption, privacyReviewAcknowledgmentShape } from './lib/applicationConsent.js';

// v5 (2026-11-09): the platform defaults of assistedApplicationPlatformDefaults.js.
// v6 (2026-11-10): business travel, profile visibility inside the employer and the decision engine
// (assistedApplicationDecisionAnswers.js); a new version lets reconcile-operational-answers.mjs release
// the waits these now answer.
// v7 (2026-11-10): support to other sites or branches, guard and piquet duty (platform-defaults-v7).
// v8 (2026-11-10): the deduced permit G and the declaration of suitability for the position (platform-defaults-v8;
// v7 is the other sites and guard duty of #18004).
// v9 (2026-11-11): the deduced nationality, the criminal record without conviction and the title asked in a text or
// a choice field (platform-defaults-v10): the waits on them are read again.
// v10 (2026-11-11): the nationality the CV declares, and the one the codice fiscale, the phone prefix and the CV's
// language now help deduce (platform-defaults-v11): the waits on a nationality question are read again.
// v11 (2026-11-11): every address block of the candidate's own takes the same address, the one they typed in
// another block first (platform-defaults-v12): the waits on a second address block are read again.
export const OPERATIONAL_DEFAULTS_VERSION = 'operational-preferences-v11';
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
const RETENTION_ACTION = /\b(?:retention|retain\w*|keep\w*|stor\w*|conserv\w*|memoriz\w*|elimin\w*|cancell\w*|delet\w*|aufbewahr\w*|speicher\w*|conservation|stock\w*|effac\w*)\b/;
const RETENTION_DATA = /\b(?:data|dati|donnees|daten|personal information|informazioni personali|informazioni di carattere personale|donnees personnelles|personenbezogen\w*)\b/;
const RETENTION_TIME = /\b(?:how long|for how long|per quanto tempo|per quanto|duration|durata|period|periodo|after|dopo|successiv\w*|future|future offers|offerte di lavoro|nach|apres|combien de temps|wie lange|jahre?|anni?|months?|mesi?|mois|years?|ans?)\b/;
const AFFIRMATIVE_CONSENT = /^(?:(?:i|io|je|ich) )?(?:si|yes|ja|oui|true|1|acconsent\w*|accett\w*|consent\w*|consens\w*|agree\w*|accept\w*|einwillig\w*|zustimm\w*|akzeptier\w*|autoris\w*)(?: .*)?$/;

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
const NOTICE_MONTH_UNIT = /\b(?:months?|mesi|mese|monate?n?|mois)\b/;
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
  const topic = operationalQuestionTopic(question);
  const options = optionsOf(question);
  if (!options.length) return null;
  if (topic === 'application_data_retention' || topic === 'application_data_processing_consent') {
    const normalized = norm(answer);
    const matching = options.filter(option => norm(option.label) === normalized || norm(option.value) === normalized);
    return matching.length === 1 ? matching[0].label : null;
  }
  if (topic !== 'notice_period') return null;
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

/** Compare facts symmetrically: a native range is not an exact duration.
 * Native selection uses the directional operationalAnswerForOption projection. */
export function equivalentOperationalAnswers(question, left, right) {
  if (operationalQuestionTopic(question) !== 'notice_period') return false;
  const a = noticeDuration(left); const b = noticeDuration(right);
  return a && b ? a.unit === b.unit && a.amount === b.amount : literalAnswer(left) === literalAnswer(right);
}

/** Preliminary readiness permits a fresh native read, never a final send. */
export function operationalAnswerReadyForDiscovery(question, answer) {
  const topic = operationalQuestionTopic(question);
  if (!topic || !hasAnswer(answer)) return false;
  const options = optionsOf(question);
  const numericNotice = topic === 'notice_period' && (question?.type === 'number' || question?.inputType === 'number');
  if (options.length) {
    const value = topic === 'notice_period' ? operationalAnswerForOption(question, answer) : String(answer).trim();
    return Boolean(value && validateAnswer(value, { ...question, type: question.type || 'choice', options: options.map(option => option.label) }).ok);
  }
  if (topic === 'notice_period' && !noticeDuration(answer)) {
    const label = norm(question?.applicationQuestion || question?.question || question?.label);
    if (!numericNotice || !NOTICE_MONTH_UNIT.test(label) || !/^(?:0|[1-9]\d?)$/.test(literalAnswer(answer))) return false;
  }
  if (topic === 'preferred_workload' && !/^(?:100|[0-9]{1,2})(?:\s*%)?$/.test(String(answer).trim())) return false;
  if (topic === 'whatsapp_contact' && !/^(?:si|yes|ja|oui|true|1|no|nein|non|false|0)$/.test(literalAnswer(answer))) return false;
  // The old choice descriptor may have lost its catalogue. Only discovery
  // may use this text validation; the live control must supply its real type.
  return validateAnswer(String(answer), { ...question, type: numericNotice ? 'number' : question.type === 'choice' ? 'text' : question.type || 'text', options: [] }).ok;
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
  const privacyRepresentations = [question?.question, question?.label, question?.applicationQuestion]
    .filter(value => typeof value === 'string' && value.trim());
  const supplementalPrivacyLabels = Array.isArray(question?.labels)
    ? question.labels.filter(value => typeof value === 'string' && value.trim()) : [];
  const privacyReviewAck = privacyRepresentations.length > 0
    && privacyRepresentations.every(value => privacyReviewAcknowledgmentShape(value).exact)
    && privacyRepresentations.some(value => isPrivacyReviewAcknowledgment(value, question, ...privacyRepresentations, ...supplementalPrivacyLabels));
  if (privacyReviewAck) return 'privacy_review_ack';
  const consentText = [...privacyRepresentations, ...supplementalPrivacyLabels, question?.context]
    .filter(value => typeof value === 'string' && value.trim()).join(' ');
  if (isApplicationDataProcessingConsent(consentText, question, ...privacyRepresentations, ...supplementalPrivacyLabels)) {
    return 'application_data_processing_consent';
  }
  const retentionText = [question?.question, question?.label, question?.applicationQuestion, question?.context,
    ...optionsOf(question).flatMap(option => [option.label, option.value])]
    .filter(value => typeof value === 'string' && value.trim()).join(' ');
  const retentionFolded = norm(retentionText);
  if (RETENTION_ACTION.test(retentionFolded) && RETENTION_DATA.test(retentionFolded) && RETENTION_TIME.test(retentionFolded)) {
    return 'application_data_retention';
  }
  if (!text || HARD_DECLARATION.test(text) || question?.type === 'date' || question?.inputType === 'date') return null;
  if (NOTICE.test(text) && OTHER_NOTICE_TOPIC.test(text)) return null;
  const workloadPrompt = [
    question?.question, question?.label, question?.applicationQuestion, question?.context,
    ...(Array.isArray(question?.labels) ? question.labels : []),
    ...optionsOf(question).flatMap(option => [option.label, option.value]),
  ].filter(value => typeof value === 'string' && value.trim())
    // A portal's required marker («* (required)») is not a workload requirement.
    .map(value => value.replace(/\*?\s*\((?:required|obligatoire|obbligatorio|pflichtfeld)\)|\*/gi, ' ')).join(' ');
  // A percentage preference fills a percentage field; «available at 80%?» (yes/no) asks a fixed pensum instead.
  if (isPreferredWorkloadQuestion(workloadPrompt)
    && !['yes_no', 'checkbox', 'boolean'].includes(question?.type || question?.kind)) return 'preferred_workload';
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

/**
 * Return a value the actual field can express; never choose another preference.
 * `facts` (platformCandidateFacts) extends the owner preferences with the
 * platform defaults of 2026-11-09; without them only the facts that need no
 * candidate (dates, consents, availabilities) apply.
 */
export function operationalDefaultAnswer(question, { locale, facts } = {}) {
  return ownerPreferenceAnswer(question, { locale, facts }) || platformDefaultAnswer(question, facts || null, { locale })
    // What the CV answers to an open text question (owner decisions 2026-11-10): a proposal like the
    // platform's, verified against the CV (assistedApplicationCvAnswers.js).
    || cvAnswerFor(question, facts)
    // Last, what the decision engine chose by the owner's principles for a question nothing above covers
    // (assistedApplicationDecisionAnswers.js, 2026-11-10): a proposal too, checked again on every read.
    || decisionAnswerFor(question, facts);
}

function ownerPreferenceAnswer(question, { locale, facts = null } = {}) {
  const topic = operationalQuestionTopic(question);
  if (!topic) return null;
  const options = optionsOf(question);
  const text = norm(question?.applicationQuestion || question?.question || question?.label);
  const language = languageOf(text, locale);
  let value;
  if (topic === 'application_data_processing_consent') {
    if (question?.kind === 'checkbox' || question?.type === 'checkbox' || question?.inputType === 'checkbox') value = 'true';
    else if (options.length) {
      const matches = options.filter(option => (AFFIRMATIVE_CONSENT.test(norm(option.label))
        || AFFIRMATIVE_CONSENT.test(norm(option.value)))
        && !hasConsentContradiction(`${option.label} ${option.value}`));
      if (matches.length !== 1) return null;
      value = matches[0].label;
    } else if (['yes_no', 'boolean'].includes(question?.type || question?.kind)) {
      value = { it: 'Sì', en: 'Yes', de: 'Ja', fr: 'Oui' }[language];
    } else return null;
  } else if (topic === 'application_data_retention') {
    value = minimumDataRetentionOption(options, text);
    if (!value) return null;
  } else if (topic === 'privacy_review_ack') {
    if (options.length) {
      const matches = options.filter(option => YES.test(norm(option.label)));
      if (matches.length !== 1) return null;
      value = matches[0].label;
    } else value = question?.kind === 'checkbox' || question?.type === 'checkbox'
      ? 'true' : { it: 'Sì', en: 'Yes', de: 'Ja', fr: 'Oui' }[language];
  } else if (topic === 'notice_period') {
    if (options.length) {
      value = operationalAnswerForOption(question, '3 months');
      if (!value) return null;
    } else if (question?.type === 'number' || question?.inputType === 'number') {
      if (!NOTICE_MONTH_UNIT.test(text)) return null;
      value = '3';
    } else value = { it: '3 mesi', en: '3 months', de: '3 Monate', fr: '3 mois' }[language];
  } else if (topic === 'preferred_workload') {
    // The percentage the candidate stated in their reply wins over the platform's 100 %; part time only with no
    // percentage leaves the field to the candidate (platformCandidateFacts workloadPercent null).
    const percent = facts && Object.hasOwn(facts, 'workloadPercent') ? facts.workloadPercent : 100;
    if (!Number.isInteger(percent)) return null;
    const exact = new RegExp(`^${percent}\\s*%?$`);
    if (options.length) {
      const matches = options.filter(option => exact.test(option.label.trim()) || exact.test(option.value.trim()));
      if (matches.length !== 1) return null;
      value = matches[0].label;
    } else value = question?.type === 'number' || question?.inputType === 'number' ? String(percent) : `${percent}%`;
  } else {
    if (options.length) {
      const matches = options.filter(option => YES.test(norm(option.label)));
      if (matches.length !== 1) return null;
      value = matches[0].label;
    } else value = question?.kind === 'checkbox' || question?.type === 'checkbox'
      ? 'true' : { it: 'Sì', en: 'Yes', de: 'Ja', fr: 'Oui' }[language];
  }
  const validationQuestion = { ...question, type: question.type === 'number' || question.inputType === 'number'
    ? 'number' : question.type || (options.length ? 'choice' : question.inputType || 'text'), options: options.map(option => option.label) };
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

/**
 * Where a proposal mirrored on a draft question comes from (`answerOrigin`, withPlatformSuggestions): a
 * decision of the engine, or a rule of the platform (owner preference or platform default). A CV answer keeps
 * its own `suggestedAnswer` with its evidence (assistedApplicationCvAnswers.js) and no `answerOrigin`.
 */
const PLATFORM_SUGGESTION_ORIGINS = Object.freeze(['platform_decision', 'platform_rule']);
const isPlatformSuggestion = question => PLATFORM_SUGGESTION_ORIGINS.includes(question?.answerOrigin);

const withoutMirror = question => {
  if (!isPlatformSuggestion(question)) return question;
  const { suggestedAnswer: _value, answerOrigin: _origin, ...rest } = question;
  return rest;
};

/** The draft's questions without the mirrored platform proposals: a mirror is recomputed, never an input. */
export function withoutPlatformSuggestions(questions) {
  return (Array.isArray(questions) ? questions : []).map(withoutMirror);
}

/**
 * The platform's answer to every question it answers, mirrored on the draft question in the shape of the
 * field (owner directive 2026-11-10: every answer the platform decides is a proposal the candidate sees):
 * yes or no in the candidate's language, the option, the sentence, the date. A rule (start date three months
 * ahead, workload 100%, the availabilities…) is `answerOrigin: 'platform_rule'`, a decision of the engine
 * `'platform_decision'`. A question the CV answers keeps its own suggestedAnswer and evidence.
 *
 * The mirror is for the readers of the draft (owner tools, the admin view, the census): the review page, the
 * e-mail and the runner keep projecting the answer live (withOperationalQuestionAnswers), so a date stays three
 * months after the actual submission. A rule or a decision that no longer holds takes its mirror with it, and so
 * does a question the candidate answered (`answers`): their word is the answer, not the platform's.
 * `keepExisting` (the reconciliation of written drafts) keeps a mirrored start date as it is: the date moves with
 * the day it is computed on, and a daily run would otherwise rewrite it every day. Every other value is a stable
 * function of the facts, so a second run writes nothing.
 * @param {object[]} questions
 * @param {{facts?: object|null, locale?: string, keepExisting?: boolean, answers?: object}} [options]
 * @returns {object[]}
 */
export function withPlatformSuggestions(questions, { facts = null, locale, keepExisting = false, answers = {} } = {}) {
  return (Array.isArray(questions) ? questions : []).map(question => {
    if (!question?.id) return question;
    const mirrored = isPlatformSuggestion(question);
    if (!mirrored && String(question.suggestedAnswer ?? '').trim()) return question;
    const bare = withoutMirror(question);
    if (hasAnswer(answers?.[question.id])) return bare;
    const answer = operationalDefaultAnswer(bare, { locale, facts });
    const value = String(answer?.value ?? '').trim();
    if (!answer || !value || isCvAnswerDefault(answer)) return bare;
    const origin = isDecisionAnswerDefault(answer) ? 'platform_decision' : 'platform_rule';
    if (keepExisting && mirrored && question.answerOrigin === origin && answer.topic === 'platform:start_date'
      && String(question.suggestedAnswer ?? '').trim()) return question;
    return { ...bare, suggestedAnswer: value, answerOrigin: origin };
  });
}

/**
 * Where a projected default comes from, as the review page labels it: the CV (cited or a plausible
 * description), a decision of the engine, or a rule of the platform.
 * @returns {'cv_evidence'|'cv_plausible'|'platform_decision'|'platform_rule'|null}
 */
export function platformAnswerProvenance(answer) {
  if (!answer) return null;
  if (isCvAnswerDefault(answer)) return answer.origin === 'cv_plausible' ? 'cv_plausible' : 'cv_evidence';
  if (isDecisionAnswerDefault(answer)) return 'platform_decision';
  return 'platform_rule';
}

/** An answer is permitted only by the policy for this exact field. */
export function isOperationalDefaultValue(question, value, options = {}) {
  const expected = operationalDefaultAnswer(question, options);
  if (!expected) return false;
  if (expected.topic === 'notice_period') {
    const equivalent = equivalentOperationalAnswers(question, expected.value, value);
    const options = optionsOf(question);
    const rule = { ...question, type: question.type || (options.length ? 'choice' : question.inputType || 'text'), options: options.map(option => option.label) };
    return Boolean(equivalent && validateAnswer(value, rule).ok);
  }
  return norm(expected.value) === norm(value);
}

/** Required form preferences also leave with an email application. Never edit the CV. */
export function operationalEmailBody(draft, confirmedAnswers = {}, { facts } = {}) {
  const { answers, defaults } = withOperationalQuestionAnswers(draft?.questions, confirmedAnswers, { locale: draft?.language, facts });
  // A CV answer is already in the CV the e-mail carries: no line of its own.
  const lines = (draft?.questions || []).filter(question => question.required && defaults[question.id] && !isCvAnswerDefault(defaults[question.id]))
    .map(question => `${question.applicationQuestion || question.question}: ${answers[question.id]}`);
  const body = draft?.applicationEmail?.body || '';
  return lines.length ? `${body}\n\n${lines.join('\n')}` : body;
}

function explicitProfileValue(profile, keys) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return null;
  for (const key of keys) {
    const value = profile[key];
    if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) continue;
    const text = String(value).trim();
    if (!text || /^(?:unknown|not known|not provided|n\/?a|none|null|sconosciuto|non indicato|keine angabe|inconnu)$/i.test(text)) continue;
    return text;
  }
  return null;
}

function explicitAnswerForField(field, value) {
  const options = optionsOf(field);
  if (options.length) {
    const matches = options.filter(option => norm(option.label) === norm(value) || norm(option.value) === norm(value));
    return matches.length === 1 ? matches[0].value : null;
  }
  if (field.type === 'number' || field.inputType === 'number') {
    const number = Number(value);
    return Number.isFinite(number) && String(value).trim() !== '' ? String(number) : null;
  }
  return value;
}

/**
 * Returns only an explicit value already present in the candidate profile.
 * Employer benchmarks, nationality, option wording and Swiss-market conventions
 * are not evidence of the candidate's own permit, notice, salary or workload.
 *
 * @param {object} field ATS field { label, name, type, options }
 * @param {object} [candidateProfile] Candidate-provided profile facts
 * @param {object} [jobData] Legacy input ignored; an employer benchmark is not a candidate salary expectation
 * @returns {string|null}
 */
export function resolveFrontaliereSmartDefaults(field, candidateProfile = null, jobData = null) {
  void jobData;
  if (!field) return null;
  const text = (field.label || field.name || '').toLowerCase();

  let keys = null;
  if (/(?:permit|bewillig|permesso|permis|autorizzaz|authoriz)/i.test(text)) {
    keys = ['workPermit'];
  } else if (/(?:notice|preavvis|k[uü]ndigung|preavis)/i.test(text)) {
    keys = ['noticePeriod'];
  } else if (/(?:salary|gehalt|lohn|salari|remuneraz|stipend|pretention)/i.test(text)) {
    if (/(?:current|attual|derzeit|actuel|pr[eé]sent|bisher|jetzig)/i.test(text)) {
      keys = ['currentSalaryChf', 'currentSalary'];
    } else {
      keys = ['salaryExpectationChf', 'salaryExpectation'];
    }
  } else if (/(?:workload|pensum|occupaz|grado|taux)/i.test(text)) {
    keys = ['preferredWorkload', 'workloadPercent', 'workload', 'pensum'];
  }
  if (!keys) return null;
  const value = explicitProfileValue(candidateProfile, keys);
  return value === null ? null : explicitAnswerForField(field, value);
}
