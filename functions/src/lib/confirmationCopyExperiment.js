/**
 * Stable assignment and measurement labels for the confirmation-copy
 * experiment (#6317).
 *
 * The experiment is deliberately inactive in code: rollout 0 means the current
 * contextual copy is sent to every eligible subscriber and no experiment
 * campaign id is emitted. Remote Config can activate a rollout after deploy.
 * The bucket is derived from a dedicated seed and a one-way subscriber id;
 * neither the clear email nor the pseudonymous id is logged or placed in tags.
 */

import { createHash } from 'node:crypto';
import { normalizeLocale } from '../emailI18n.js';

export const CONFIRMATION_COPY_ROLLOUT_RC_KEY = 'NEWSLETTER_CONFIRMATION_COPY_ROLLOUT';
export const CONFIRMATION_COPY_ASSIGNMENT_SEED = 'newsletter-confirmation-copy-2026-10';

export const CONFIRMATION_COPY_VARIANTS = Object.freeze({
  GENERIC: 'generic',
  CONTEXTUAL: 'contextual',
});

export const CONFIRMATION_COPY_ELIGIBLE_SOURCE_CTAS = Object.freeze([
  'job_board_email_unlock',
  'job_gate_email_unlock',
  'job_board_social_unlock',
  'job_expired_email_unlock',
]);

export const CONFIRMATION_COPY_DEFAULTS = Object.freeze({ rollout: 0 });
export const CONFIRMATION_COPY_CAMPAIGN_PREFIX = 'confirmation_copy_ab';

const ELIGIBLE_SOURCE_CTAS = new Set(CONFIRMATION_COPY_ELIGIBLE_SOURCE_CTAS);
const VALID_VARIANTS = new Set(Object.values(CONFIRMATION_COPY_VARIANTS));

function normalizeSubscriberEmail(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized.includes('@') ? normalized : '';
}

function boundedNumber(value, fallback, min = 0, max = 1) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * Parse the single RC value independently from its transport (env or Admin
 * SDK result). Invalid or absent values are fail-safe and mean "off".
 */
export function readConfirmationCopyConfig(env = process.env) {
  return Object.freeze({
    rollout: boundedNumber(
      env?.[CONFIRMATION_COPY_ROLLOUT_RC_KEY],
      CONFIRMATION_COPY_DEFAULTS.rollout,
    ),
  });
}

export function isConfirmationCopyVariant(value) {
  return VALID_VARIANTS.has(String(value || ''));
}

export function isConfirmationCopyEligibleSourceCta(value) {
  return ELIGIBLE_SOURCE_CTAS.has(String(value || '').trim());
}

export function isConfirmationCopyExperimentActive(config = CONFIRMATION_COPY_DEFAULTS) {
  return boundedNumber(config?.rollout, CONFIRMATION_COPY_DEFAULTS.rollout) > 0;
}

/** Stable pseudonymous subscriber id. It is never emitted by the sender. */
export function pseudonymousConfirmationSubscriberId(email) {
  const normalized = normalizeSubscriberEmail(email);
  if (!normalized) return null;
  return createHash('sha256').update(normalized).digest('hex').slice(0, 32);
}

/** Stable bucket in [0, 1), with a seed reserved for this experiment. */
export function confirmationCopyBucket(email) {
  const subscriberId = pseudonymousConfirmationSubscriberId(email);
  if (!subscriberId) return null;
  const digest = createHash('sha256')
    .update(`${CONFIRMATION_COPY_ASSIGNMENT_SEED}:${subscriberId}`)
    .digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000;
}

/**
 * Assign one eligible subscriber. `null` means outside the experiment; an
 * eligible subscriber with rollout 0 still receives the contextual copy, but
 * is not stamped as an experiment exposure.
 */
export function assignConfirmationCopyVariant({ email, eligible = false, config = CONFIRMATION_COPY_DEFAULTS } = {}) {
  if (!eligible) return null;
  const rollout = boundedNumber(config?.rollout, CONFIRMATION_COPY_DEFAULTS.rollout);
  const bucket = confirmationCopyBucket(email);
  if (bucket === null) return CONFIRMATION_COPY_VARIANTS.CONTEXTUAL;
  if (!(rollout > 0)) return CONFIRMATION_COPY_VARIANTS.CONTEXTUAL;
  return bucket < rollout
    ? CONFIRMATION_COPY_VARIANTS.GENERIC
    : CONFIRMATION_COPY_VARIANTS.CONTEXTUAL;
}

/**
 * Campaign id carried through every provider. It contains only allowlisted
 * experiment dimensions, so the weekly monitor can classify it as
 * `confirmation` without exposing a recipient identifier.
 */
export function buildConfirmationCopyCampaignId({ variant, sourceCta, locale } = {}) {
  const normalizedCta = String(sourceCta || '').trim();
  if (!isConfirmationCopyVariant(variant) || !isConfirmationCopyEligibleSourceCta(normalizedCta)) return null;
  const language = normalizeLocale(locale);
  return `${CONFIRMATION_COPY_CAMPAIGN_PREFIX}_${variant}_${normalizedCta}_${language}`;
}

/** Parse an experiment campaign id, or null for every non-experiment campaign. */
export function parseConfirmationCopyCampaignId(campaignId) {
  const match = new RegExp(
    `^${CONFIRMATION_COPY_CAMPAIGN_PREFIX}_(generic|contextual)_(.+)_(it|en|de|fr)$`,
  ).exec(String(campaignId || ''));
  if (!match || !isConfirmationCopyEligibleSourceCta(match[2])) return null;
  return { variant: match[1], source_cta: match[2], locale: match[3] };
}
