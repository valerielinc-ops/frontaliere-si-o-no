import { createHash } from 'node:crypto';
import { getRemoteConfigValueWithinMaxStaleAge } from './remoteConfigSecrets.js';

export const APPLICATION_CONCIERGE_RENEWAL_ENABLED_RC_KEY = 'APPLICATION_CONCIERGE_RENEWAL_ENABLED';
export const APPLICATION_CONCIERGE_RENEWAL_ROLLOUT_PERCENT_RC_KEY = 'APPLICATION_CONCIERGE_RENEWAL_ROLLOUT_PERCENT';
export const APPLICATION_CONCIERGE_RENEWAL_ASSIGNMENT_SEED = 'application-concierge-renewal-2026-11';

let remoteConfigWarningLogged = false;

function enabledValue(value) {
  return ['1', 'true', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

function parseRolloutPercent(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 100 ? parsed : 0;
}

/** Stable per-account assignment so the candidate stays in the same rollout cohort. */
export function isApplicationConciergeRenewalAssigned(userId, { enabled = false, rolloutPercent: percent = 0 } = {}) {
  const subject = String(userId || '').trim();
  if (!subject || !enabled) return false;
  const percentage = parseRolloutPercent(percent);
  if (percentage <= 0) return false;
  if (percentage >= 100) return true;

  const digest = createHash('sha256')
    .update(`${APPLICATION_CONCIERGE_RENEWAL_ASSIGNMENT_SEED}:${subject}`)
    .digest();
  const bucket = digest.readUInt32BE(0) / 0x1_0000_0000;
  return bucket < percentage / 100;
}

/** Missing, invalid, or unreadable Remote Config values keep renewal disabled. */
export async function isApplicationConciergeRenewalEnabledFor(userId, read = getRemoteConfigValueWithinMaxStaleAge) {
  const subject = String(userId || '').trim();
  if (!subject) return false;

  try {
    const [enabled, percent] = await Promise.all([
      read(APPLICATION_CONCIERGE_RENEWAL_ENABLED_RC_KEY),
      read(APPLICATION_CONCIERGE_RENEWAL_ROLLOUT_PERCENT_RC_KEY),
    ]);
    return isApplicationConciergeRenewalAssigned(subject, {
      enabled: enabledValue(enabled),
      rolloutPercent: percent,
    });
  } catch {
    if (!remoteConfigWarningLogged) {
      remoteConfigWarningLogged = true;
      console.warn('[applicationConciergeRenewalRollout] Remote Config read failed; renewal disabled');
    }
    return false;
  }
}
