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
};

const say = (key, locale) => MESSAGES[key][locale] || MESSAGES[key].it;

const rule = (partial) => ({ pattern: '', minLength: 0, maxLength: 200, min: null, max: null, minDate: '', example: '', message: '', ...partial });

const NAME = safePattern("\\p{L}[\\p{L}\\p{M}'’. -]*");
const PHONE = safePattern('\\+?[0-9][0-9 ()./-]{5,24}');
const LINKEDIN = safePattern('(?:https?://)?(?:[a-z]{2,3}\\.)?linkedin\\.com/\\S+');

/**
 * The form fields the candidate may change. `inLetter`: printed in the letter
 * header, so a change rebuilds the PDF. `answerId`: the question that asks the
 * same thing wins (the field is changed there). `perRound`: a text of this
 * round's draft, not a fact about the candidate.
 */
export const EDITABLE_FIELDS = {
  firstName: { rule: rule({ pattern: NAME, minLength: 1, maxLength: 80, example: 'Maria' }), message: 'name', required: true, inLetter: true },
  lastName: { rule: rule({ pattern: NAME, minLength: 1, maxLength: 80, example: 'Rossi' }), message: 'name', required: true, inLetter: true },
  phone: { rule: rule({ pattern: PHONE, maxLength: 30, example: '+41 91 123 45 67' }), message: 'phone', inLetter: true },
  location: { rule: rule({ maxLength: 120 }), inLetter: true },
  linkedin: { rule: rule({ pattern: LINKEDIN, maxLength: 200, example: 'linkedin.com/in/nome-cognome' }), message: 'linkedin' },
  languages: { rule: rule({ maxLength: 200 }) },
  workPermit: { rule: rule({ maxLength: 120 }), answerId: 'work_permit' },
  availability: { rule: rule({ maxLength: 120 }), answerId: 'availability' },
  salary: { rule: rule({ pattern: safePattern('.*\\d.*'), maxLength: 120, example: "CHF 80'000" }), message: 'salary', answerId: 'salary_expectation' },
  motivationShort: { rule: rule({ maxLength: 600 }), perRound: true },
  whyCompany: { rule: rule({ maxLength: 400 }), perRound: true },
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
 * the candidate changed. A question's answer still wins over a field (permit,
 * availability, salary).
 * @returns {{identity:{name:string,email:string,phone:string,firstName:string,lastName:string}, profile:object, answers:object, overrides:object}}
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
  if (has(overrides, 'location')) profile.location = overrides.location;
  if (has(overrides, 'linkedin')) profile.linkedin = overrides.linkedin;
  if (has(overrides, 'languages')) profile.languages = splitLanguages(overrides.languages);
  if (has(overrides, 'workPermit')) profile.workPermit = overrides.workPermit;
  if (has(overrides, 'availability')) profile.availability = overrides.availability;
  const answers = { ...(flow?.answers || {}) };
  if (has(overrides, 'salary') && !String(answers.salary_expectation ?? '').trim()) answers.salary_expectation = overrides.salary;
  return { identity, profile, answers, overrides };
}

/** The form fields with the candidate's changes (review page, handoff kit, owner queue). */
export function formAnswersWithEdits({ order, draft, flow }) {
  if (!draft) return [];
  const { identity, profile, answers } = candidateWithEdits({ order, draft, flow });
  const motivation = Object.fromEntries((draft.formAnswers || []).map((field) => [field.key, field.value]));
  return buildFormAnswers({
    identity,
    profile,
    documents: { motivationShort: motivation.motivationShort, whyCompany: motivation.whyCompany },
    answers,
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
  return {
    key: field.key,
    label: field.label,
    value: field.value,
    editable: !lock,
    locked: lock === 'alias' || lock === 'question' ? lock : null,
    required: Boolean(spec?.required),
    inLetter: Boolean(spec?.inLetter) || field.key === 'email',
    validation: lock ? null : fieldRule(field.key, locale),
  };
}

function checkField(key, text, locale) {
  const spec = EDITABLE_FIELDS[key];
  if (!text) return spec.required ? say('required', locale) : '';
  if (text.length > spec.rule.maxLength) return say('tooLong', locale);
  const question = { type: 'text', required: false, validation: fieldRule(key, locale) };
  const result = validateAnswer(text, question);
  return result.ok ? '' : answerMessage(result, question, locale);
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
export function planCandidateEdits(raw, { order, draft, flow, locale = 'it' }) {
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
    const problem = checkField(key, text, locale);
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
    // A new name or phone also updates the signature we wrote under the e-mail.
    const before = candidateWithEdits({ order, draft, flow }).identity;
    const after = candidateWithEdits({ order, draft, flow: { ...flow, formOverrides: { ...(flow?.formOverrides || {}), ...overrides } } }).identity;
    const oldSignature = signatureOf(before);
    const newSignature = signatureOf(after);
    if (oldSignature !== newSignature && oldSignature && String(email.body || '').endsWith(oldSignature)) {
      email.body = `${email.body.slice(0, -oldSignature.length)}${newSignature}`;
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
