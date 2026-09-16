/**
 * Pending job-alert intent — survives the auth round-trip.
 *
 * A logged-out user who fills the job-alert form and clicks "create" is sent
 * through the sign-in flow (Google popup or newsletter-autologin redirect) and,
 * on the old behaviour, landed back with an empty form and had to re-enter +
 * re-submit. Almost nobody did (PostHog: 536 CTA clicks → 39 alerts created,
 * a 93% drop at exactly this step).
 *
 * We stash the intended alert config here BEFORE triggering auth and replay it
 * once the user is authenticated, auto-creating the alert they asked for.
 * Storage/TTL mechanics live in services/pendingIntentStore.ts, shared with
 * services/pendingSaveJob.ts (same auth-round-trip problem, different payload).
 */

import type { JobAlertConfig } from '@/services/jobAlertService';
import { saveIntent, consumeIntent, clearIntent } from '@/services/pendingIntentStore';

const KEY = 'pending_job_alert';

/** The impression-bearing surface that owns the shared alert form. */
export type PendingJobAlertSurface = 'inline_card';

export interface PendingJobAlertIntent {
  config: JobAlertConfig;
  surface: PendingJobAlertSurface;
}

/**
 * Save the config together with the surface that emitted its impression.
 *
 * Older versions stored the bare config. `normalizePendingJobAlertIntent`
 * below deliberately accepts that shape so a user already in an auth
 * round-trip is not forced to start over after this deploy.
 */
export function savePendingJobAlert(
  config: JobAlertConfig,
  surface: PendingJobAlertSurface = 'inline_card',
): void {
  saveIntent(KEY, { config, surface });
}

function normalizePendingJobAlertIntent(
  value: PendingJobAlertIntent | JobAlertConfig | null,
): PendingJobAlertIntent | null {
  if (!value || typeof value !== 'object') return null;
  if ('config' in value) {
    return {
      config: value.config,
      // Only an impression-bearing surface is valid for the conversion goal.
      // Unknown future/legacy values fail closed onto the owning form surface
      // instead of producing a created event the goal cannot count.
      surface: value.surface === 'inline_card' ? value.surface : 'inline_card',
    };
  }
  // Backward compatibility for entries written before surface metadata.
  return { config: value, surface: 'inline_card' };
}

/** Return and clear the pending intent, including its funnel surface. */
export function consumePendingJobAlertIntent(): PendingJobAlertIntent | null {
  return normalizePendingJobAlertIntent(
    consumeIntent<PendingJobAlertIntent | JobAlertConfig>(KEY),
  );
}

/**
 * Return the pending alert config and clear it, but only if it was saved within
 * the TTL. Returns null when absent, expired, or malformed.
 */
export function consumePendingJobAlert(): JobAlertConfig | null {
  return consumePendingJobAlertIntent()?.config ?? null;
}

export function clearPendingJobAlert(): void {
  clearIntent(KEY);
}
