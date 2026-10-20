/**
 * Validation rules for the answers a candidate gives on the review page of the
 * automated assisted application (owner decision 2026-09-30: the questions are
 * dynamic, one set per posting, and the page must check an answer at once).
 *
 * Codex writes a rule for each question when it writes the question (the
 * draft, before the review page opens); `sanitizeValidation` keeps only what
 * is safe and consistent, and the same `validateAnswer` runs in the browser
 * (components/community/AssistedApplicationReview.tsx, on every change) and
 * on the server (functions/src/assistedApplicationReview.js, on save). No
 * model runs while the candidate waits.
 *
 * Pure JavaScript, no Node or browser API: imported by both sides.
 */

const OBJ = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

/** The rule Codex writes with a question (strict schema). */
export const ANSWER_VALIDATION_SCHEMA = OBJ({
  pattern: { type: 'string', description: 'JavaScript regular expression (no slashes, no flags) the WHOLE answer must match, e.g. ^\\d{1,3}\\s?(%|mesi|months)?$ ; "" when the type already says enough' },
  minLength: { type: 'integer', description: 'Minimum characters, 0 when none' },
  maxLength: { type: 'integer', description: 'Maximum characters, 0 when none' },
  min: { type: ['number', 'null'], description: 'Smallest value for a number, null when none' },
  max: { type: ['number', 'null'], description: 'Largest value for a number, null when none' },
  minDate: { type: 'string', enum: ['', 'today'], description: '"today" when the date cannot be in the past (a start date), else ""' },
  example: { type: 'string', description: 'One valid answer in the expected format' },
  message: { type: 'string', description: 'One short sentence in the candidate\'s language on what a valid answer looks like' },
});

const MAX_PATTERN = 200;
const MAX_ANSWER = 500;
const clean = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const int = (value, max) => (Number.isInteger(value) && value > 0 ? Math.min(value, max) : 0);
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/**
 * A pattern is kept only when it compiles, is short, has no backreference and
 * no nested quantifier (the shapes that can make a regex run for minutes).
 */
export function safePattern(pattern) {
  const source = String(pattern || '').trim();
  if (!source || source.length > MAX_PATTERN) return '';
  if (/\\[1-9]|\\k</.test(source)) return '';
  if (/\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/.test(source)) return '';
  const anchored = `^(?:${source.replace(/^\^/, '').replace(/\$$/, '')})$`;
  try {
    new RegExp(anchored, 'u');
  } catch {
    return '';
  }
  return anchored;
}

/**
 * The rule kept for a question: Codex's rule cleaned, the regex dropped when it
 * rejects its own example (a rule that refuses a valid answer is worse than none).
 */
export function sanitizeValidation(raw, { type = 'text' } = {}) {
  const rule = {
    pattern: type === 'text' || type === 'number' ? safePattern(raw?.pattern) : '',
    minLength: int(raw?.minLength, MAX_ANSWER),
    maxLength: int(raw?.maxLength, MAX_ANSWER) || MAX_ANSWER,
    min: type === 'number' ? num(raw?.min) : null,
    max: type === 'number' ? num(raw?.max) : null,
    minDate: type === 'date' && raw?.minDate === 'today' ? 'today' : '',
    example: clean(raw?.example, 100),
    message: clean(raw?.message, 200),
  };
  if (rule.minLength > rule.maxLength) rule.minLength = 0;
  if (rule.min !== null && rule.max !== null && rule.min > rule.max) rule.max = null;
  if (rule.pattern && rule.example && !new RegExp(rule.pattern, 'u').test(rule.example)) rule.pattern = '';
  return rule;
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function realDate(text, todayIso) {
  const match = ISO_DATE_RE.exec(text);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return false;
  const thisYear = Number(String(todayIso || '').slice(0, 4)) || new Date().getUTCFullYear();
  return year >= 1900 && year <= thisYear + 10;
}

/** "80'000", "80 000", "80.000,50" → 80000 / 80000.5; NaN when not a number. */
export function parseNumberAnswer(text) {
  const compact = String(text || '').replace(/[\s'’]/g, '');
  if (!/^-?\d[\d.,]*$/.test(compact)) return Number.NaN;
  const lastSeparator = Math.max(compact.lastIndexOf('.'), compact.lastIndexOf(','));
  const decimals = lastSeparator >= 0 ? compact.length - lastSeparator - 1 : 0;
  // A separator followed by exactly three digits groups thousands.
  const normalized = lastSeparator >= 0 && decimals !== 3
    ? `${compact.slice(0, lastSeparator).replace(/[.,]/g, '')}.${compact.slice(lastSeparator + 1)}`
    : compact.replace(/[.,]/g, '');
  return Number(normalized);
}

// What the candidate reads when the rule carries no message of its own.
const DEFAULT_MESSAGES = {
  required: { it: 'Questa risposta è obbligatoria.', de: 'Diese Antwort ist obligatorisch.', fr: 'Cette réponse est obligatoire.', en: 'This answer is required.' },
  too_long: { it: 'La risposta è troppo lunga.', de: 'Die Antwort ist zu lang.', fr: 'La réponse est trop longue.', en: 'The answer is too long.' },
  too_short: { it: 'La risposta è troppo corta.', de: 'Die Antwort ist zu kurz.', fr: 'La réponse est trop courte.', en: 'The answer is too short.' },
  not_a_date: { it: 'Inserisci una data valida.', de: 'Gib ein gültiges Datum ein.', fr: 'Saisissez une date valide.', en: 'Enter a valid date.' },
  date_too_early: { it: 'La data non può essere nel passato.', de: 'Das Datum darf nicht in der Vergangenheit liegen.', fr: 'La date ne peut pas être dans le passé.', en: 'The date cannot be in the past.' },
  not_a_number: { it: 'Inserisci un numero.', de: 'Gib eine Zahl ein.', fr: 'Saisissez un nombre.', en: 'Enter a number.' },
  too_small: { it: 'Il valore è troppo basso.', de: 'Der Wert ist zu niedrig.', fr: 'La valeur est trop basse.', en: 'The value is too low.' },
  too_large: { it: 'Il valore è troppo alto.', de: 'Der Wert ist zu hoch.', fr: 'La valeur est trop élevée.', en: 'The value is too high.' },
  not_an_option: { it: 'Scegli una delle opzioni.', de: 'Wähl eine der Optionen.', fr: 'Choisissez une des options.', en: 'Choose one of the options.' },
  pattern: { it: 'Controlla il formato della risposta.', de: 'Prüf das Format der Antwort.', fr: 'Vérifiez le format de la réponse.', en: 'Check the format of the answer.' },
};

/** The message for a failed check: the rule's own, else the default for the reason. */
export function answerMessage(result, question, locale = 'it') {
  if (result.ok) return '';
  // A date or an option has one obvious fix: the default says it best.
  const own = result.reason === 'pattern' || result.reason === 'too_small' || result.reason === 'too_large' ? result.message : '';
  const example = question?.validation?.example ? ` (${question.validation.example})` : '';
  const fallback = (DEFAULT_MESSAGES[result.reason] || DEFAULT_MESSAGES.pattern)[locale] || DEFAULT_MESSAGES.pattern.it;
  return own || (result.reason === 'pattern' ? `${fallback}${example}` : fallback);
}

/**
 * @param {string} value the answer
 * @param {{type?:string, options?:string[], required?:boolean, minDate?:string|null, validation?:object}} question
 *   `minDate` is the concrete earliest date (YYYY-MM-DD) the server resolved.
 * @param {{todayIso?:string}} [context]
 * @returns {{ok:true} | {ok:false, reason:string, message:string}}
 */
export function validateAnswer(value, question, { todayIso = '' } = {}) {
  const text = clean(value, MAX_ANSWER + 1);
  const rule = question?.validation || {};
  const fail = (reason) => ({ ok: false, reason, message: rule.message || '' });
  if (!text) return question?.required ? fail('required') : { ok: true };
  if (text.length > (rule.maxLength || MAX_ANSWER)) return fail('too_long');
  if (rule.minLength && text.length < rule.minLength) return fail('too_short');
  switch (question?.type) {
    case 'date': {
      if (!realDate(text, todayIso)) return fail('not_a_date');
      const earliest = question.minDate || (rule.minDate === 'today' ? todayIso : '');
      if (earliest && text < earliest) return fail('date_too_early');
      return { ok: true };
    }
    case 'number': {
      const number = parseNumberAnswer(text);
      if (Number.isNaN(number)) return fail('not_a_number');
      if (rule.min !== null && rule.min !== undefined && number < rule.min) return fail('too_small');
      if (rule.max !== null && rule.max !== undefined && number > rule.max) return fail('too_large');
      break;
    }
    case 'choice':
      if (question.options?.length && !question.options.includes(text)) return fail('not_an_option');
      return { ok: true };
    case 'yes_no':
      return { ok: true };
    default:
      break;
  }
  if (rule.pattern) {
    try {
      if (!new RegExp(rule.pattern, 'u').test(text)) return fail('pattern');
    } catch {
      // An unusable rule never blocks the candidate.
    }
  }
  return { ok: true };
}
