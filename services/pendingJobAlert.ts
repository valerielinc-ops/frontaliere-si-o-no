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
import {
  isJobAlertCtaSurface,
  type JobAlertCtaSurface,
} from '@/services/jobAlertCtaState';
import { saveIntent, consumeIntent, clearIntent } from '@/services/pendingIntentStore';

const KEY = 'pending_job_alert';

export interface PendingJobAlert {
  config: JobAlertConfig;
  ctaSurface: JobAlertCtaSurface;
}

export function savePendingJobAlert(
  config: JobAlertConfig,
  ctaSurface: JobAlertCtaSurface = 'inline_card',
): void {
  saveIntent<PendingJobAlert>(KEY, { config, ctaSurface });
}

/**
 * Return the pending alert config and clear it, but only if it was saved within
 * the TTL. Returns null when absent, expired, or malformed.
 */
export function consumePendingJobAlert(): PendingJobAlert | null {
  const pending = consumeIntent<PendingJobAlert | JobAlertConfig>(KEY);
  if (!pending) return null;

  // Intent records written before the attribution field was introduced stored
  // the config directly. Replay those safely as the form's inline surface.
  if (typeof pending === 'object' && pending !== null && 'config' in pending) {
    return {
      config: pending.config,
      ctaSurface: isJobAlertCtaSurface(pending.ctaSurface)
        ? pending.ctaSurface
        : 'inline_card',
    };
  }

  return { config: pending, ctaSurface: 'inline_card' };
}

export function clearPendingJobAlert(): void {
  clearIntent(KEY);
}
