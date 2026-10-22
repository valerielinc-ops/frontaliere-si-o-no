/**
 * Four-arm subject-line experiment for the daily job-alert digest.
 *
 * The assignment is deterministic for (recipient, alert, UTC week), so a
 * second cron slot or a retry cannot change the subject shown to a recipient.
 * The rollout is deliberately opt-in: an absent/invalid Remote Config value
 * keeps the current subject and does not enter the experiment denominator.
 */
import { createHash } from 'node:crypto';

export const JOB_ALERT_SUBJECT_EXPERIMENT_ID = 'job-alert-subject-v1';
export const DEFAULT_JOB_ALERT_SUBJECT_VARIANT = 'control';
export const DEFAULT_JOB_ALERT_SUBJECT_ROLLOUT = 0;
export const JOB_ALERT_SUBJECT_MAX_LENGTH = 78;

export const JOB_ALERT_SUBJECT_VARIANTS = Object.freeze([
  Object.freeze({ id: 'control', label: 'Current title + company' }),
  Object.freeze({ id: 'match', label: 'Explicit count + criteria + location' }),
  Object.freeze({ id: 'novita', label: 'Freshness / new offers' }),
  Object.freeze({ id: 'scoperta', label: 'Moderate curiosity with context' }),
]);
export const DEFAULT_JOB_ALERT_SUBJECT_ASSIGNMENT = Object.freeze(['control']);
const ALL_JOB_ALERT_SUBJECT_VARIANT_IDS = Object.freeze(JOB_ALERT_SUBJECT_VARIANTS.map(({ id }) => id));

const VARIANT_IDS = new Set(JOB_ALERT_SUBJECT_VARIANTS.map(({ id }) => id));
const HASH_BUCKETS = 0x1_0000_0000;

const SUBJECT_COPY = Object.freeze({
  it: Object.freeze({
    for: 'per',
    in: 'a',
    more: (n) => (n === 1 ? 'altra offerta' : 'altre offerte'),
    offers: (n) => (n === 1 ? 'offerta' : 'offerte'),
    newOffers: (n) => (n === 1 ? 'nuova offerta' : 'nuove offerte'),
    selectedOffers: (n) => (n === 1 ? 'offerta selezionata' : 'offerte selezionate'),
    defaultCriteria: 'le tue offerte',
    question: 'Cosa è uscito per',
  }),
  en: Object.freeze({
    for: 'for',
    in: 'in',
    more: (n) => (n === 1 ? 'more' : 'more'),
    offers: (n) => (n === 1 ? 'job' : 'jobs'),
    newOffers: (n) => (n === 1 ? 'new job' : 'new jobs'),
    selectedOffers: (n) => (n === 1 ? 'selected job' : 'selected jobs'),
    defaultCriteria: 'your alerts',
    question: 'What came up for',
  }),
  de: Object.freeze({
    for: 'für',
    in: 'in',
    more: (n) => (n === 1 ? 'weitere Stelle' : 'weitere Stellen'),
    offers: (n) => (n === 1 ? 'Stelle' : 'Stellen'),
    newOffers: (n) => (n === 1 ? 'neue Stelle' : 'neue Stellen'),
    selectedOffers: (n) => (n === 1 ? 'ausgewählte Stelle' : 'ausgewählte Stellen'),
    defaultCriteria: 'Ihre Alerts',
    question: 'Was ist neu für',
  }),
  fr: Object.freeze({
    for: 'pour',
    in: 'à',
    more: (n) => (n === 1 ? 'autre offre' : 'autres offres'),
    offers: (n) => (n === 1 ? 'offre' : 'offres'),
    newOffers: (n) => (n === 1 ? 'nouvelle offre' : 'nouvelles offres'),
    selectedOffers: (n) => (n === 1 ? 'offre sélectionnée' : 'offres sélectionnées'),
    defaultCriteria: 'vos alertes',
    question: 'Quelles offres pour',
  }),
});

function normalizedLocale(locale) {
  const value = String(locale || '').trim().toLowerCase().split('-')[0];
  return SUBJECT_COPY[value] ? value : 'it';
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function parseRollout(value, fallback = DEFAULT_JOB_ALERT_SUBJECT_ROLLOUT) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : fallback;
}

function parseVariantAssignment(value) {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_JOB_ALERT_SUBJECT_ASSIGNMENT;
  }
  const raw = String(value).trim();
  let candidates;
  try {
    const parsed = JSON.parse(raw);
    candidates = Array.isArray(parsed) ? parsed : raw.split(',');
  } catch {
    candidates = raw.split(',');
  }
  const ids = [...new Set(candidates
    .map((id) => String(id).trim().toLowerCase())
    .filter((id) => VARIANT_IDS.has(id)))];
  return ids.length > 0 ? ids : DEFAULT_JOB_ALERT_SUBJECT_ASSIGNMENT;
}

function configuredVariantIds(config) {
  if (!Array.isArray(config?.variantIds)) return ALL_JOB_ALERT_SUBJECT_VARIANT_IDS;
  const ids = [...new Set(config.variantIds
    .map((id) => String(id).trim().toLowerCase())
    .filter((id) => VARIANT_IDS.has(id)))];
  return ids.length > 0 ? ids : DEFAULT_JOB_ALERT_SUBJECT_ASSIGNMENT;
}

function isFourArmAssignment(ids) {
  return ids.length === ALL_JOB_ALERT_SUBJECT_VARIANT_IDS.length
    && ALL_JOB_ALERT_SUBJECT_VARIANT_IDS.every((id) => ids.includes(id));
}

/**
 * Read the Remote Config-backed experiment controls.
 *
 * All controls are intentionally required for traffic: `enabled=true` with
 * no rollout or without the complete four-arm assignment still means zero
 * experimental traffic. This prevents a partial Remote Config edit from
 * turning on a test unexpectedly.
 */
export function readJobAlertSubjectConfig(env = process.env) {
  return Object.freeze({
    experimentId: JOB_ALERT_SUBJECT_EXPERIMENT_ID,
    seed: JOB_ALERT_SUBJECT_EXPERIMENT_ID,
    enabled: parseBoolean(env.JOB_ALERT_SUBJECT_AB_ENABLED, false),
    rollout: parseRollout(env.JOB_ALERT_SUBJECT_AB_ROLLOUT),
    variantIds: parseVariantAssignment(env.JOB_ALERT_SUBJECT_AB_VARIANTS),
  });
}

/** UTC Monday identifier shared by the two daily job-alert slots. */
export function jobAlertSubjectPeriodId(dateLike = new Date()) {
  const parsed = dateLike instanceof Date ? new Date(dateLike.getTime()) : new Date(dateLike);
  const date = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return `week_${date.toISOString().slice(0, 10)}`;
}

/**
 * Assign one of the four arms, or a non-experiment holdback.
 *
 * `inExperiment` distinguishes the control arm from users held out by a
 * partial rollout. Reports must include only `inExperiment === true` so a
 * rollout below 100% cannot dilute the four-arm comparison with extra control
 * traffic.
 */
export function assignJobAlertSubjectVariant({
  email,
  alertId,
  periodId = jobAlertSubjectPeriodId(),
  config = readJobAlertSubjectConfig(),
} = {}) {
  const safeConfig = config || readJobAlertSubjectConfig();
  const variantIds = configuredVariantIds(safeConfig);
  const key = `${safeConfig.seed}|${normalizeEmail(email)}|${String(alertId || '')}|${String(periodId || '')}`;
  const digest = createHash('sha256').update(key).digest();
  const participationBucket = digest.readUInt32BE(0) / HASH_BUCKETS;
  const armIndex = digest.readUInt32BE(4) % variantIds.length;
  const active = safeConfig.enabled === true
    && safeConfig.rollout > 0
    && isFourArmAssignment(variantIds)
    && participationBucket < safeConfig.rollout;
  const variant = active
    ? variantIds[armIndex]
    : DEFAULT_JOB_ALERT_SUBJECT_VARIANT;
  return {
    experimentId: safeConfig.experimentId || JOB_ALERT_SUBJECT_EXPERIMENT_ID,
    periodId: String(periodId || ''),
    variant,
    inExperiment: active,
    participationBucket,
  };
}

function fitSubject(rawSubject, maxLength = JOB_ALERT_SUBJECT_MAX_LENGTH) {
  const subject = String(rawSubject || '').trim();
  if (subject.length <= maxLength) return subject;
  const slot = subject.slice(0, Math.max(1, maxLength - 1));
  const lastSpace = slot.lastIndexOf(' ');
  const cut = lastSpace > Math.floor(maxLength * 0.5) ? slot.slice(0, lastSpace) : slot;
  return `${cut.replace(/[,:;\-–—|·\s]+$/u, '').trim()}…`;
}

/**
 * Render a treatment subject. `controlSubject` is the existing production
 * subject, supplied by the sender after its language/title safety checks, so
 * the disabled path remains byte-for-byte unchanged.
 */
export function renderJobAlertSubject({
  variant = DEFAULT_JOB_ALERT_SUBJECT_VARIANT,
  locale,
  controlSubject,
  shownCount = 0,
  keyword = '',
  locationLabel = '',
  subjectLabel = '',
  useNewCopy = false,
} = {}) {
  const normalizedVariant = VARIANT_IDS.has(variant) ? variant : DEFAULT_JOB_ALERT_SUBJECT_VARIANT;
  const copy = SUBJECT_COPY[normalizedLocale(locale)];
  const count = Math.max(0, Number(shownCount) || 0);
  const keywordText = String(keyword || '').trim();
  const locationText = String(locationLabel || '').trim();
  const fallback = String(subjectLabel || copy.defaultCriteria).trim() || copy.defaultCriteria;
  const criteria = keywordText && locationText
    ? `${keywordText} ${copy.in} ${locationText}`
    : keywordText || locationText || fallback;
  const queryLabel = keywordText && locationText
    ? `${keywordText} ${copy.in} ${locationText}`
    : keywordText || locationText || fallback;

  if (normalizedVariant === 'control') {
    return {
      subject: String(controlSubject || '').trim(),
      variant: normalizedVariant,
      freshnessQualified: null,
    };
  }

  if (normalizedVariant === 'match') {
    return {
      subject: fitSubject(`🎯 ${count} ${copy.offers(count)} ${copy.for} ${criteria}`),
      variant: normalizedVariant,
      freshnessQualified: null,
    };
  }

  if (normalizedVariant === 'novita') {
    const subject = useNewCopy
      ? `🆕 ${count} ${copy.newOffers(count)} ${copy.for} ${criteria}`
      : `📌 ${count} ${copy.selectedOffers(count)} ${copy.for} ${criteria}`;
    return {
      subject: fitSubject(subject),
      variant: normalizedVariant,
      freshnessQualified: useNewCopy === true,
    };
  }

  return {
    subject: fitSubject(`🔎 ${copy.question} ${queryLabel}? (${count} ${copy.offers(count)})`),
    variant: normalizedVariant,
    freshnessQualified: null,
  };
}

export function listJobAlertSubjectVariantIds() {
  return JOB_ALERT_SUBJECT_VARIANTS.map(({ id }) => id);
}
