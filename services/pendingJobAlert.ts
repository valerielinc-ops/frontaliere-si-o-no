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

/**
 * The CTA surface a guest submitted from. Carried through the auth round-trip
 * so the replayed `job_alert_created` is attributed to the surface that emitted
 * the `job_alert_cta_shown` impression (issue 9576), instead of a synthetic
 * `post_auth_auto` that the alert_funnel_conversion allowlist
 * (`ALERT_CTA_SURFACES` in scripts/campaign-goal-check.mjs) excludes. Every
 * value here MUST be an impression-bearing surface of that allowlist — pinned
 * by tests/campaign-goal-check.test.ts.
 */
export const PENDING_JOB_ALERT_ORIGINS = Object.freeze(['inline_card'] as const);
export type PendingJobAlertOrigin = (typeof PENDING_JOB_ALERT_ORIGINS)[number];

export interface PendingJobAlert {
  config: JobAlertConfig;
  /** null = stored by a build that did not record the origin (legacy shape). */
  origin: PendingJobAlertOrigin | null;
}

/**
 * Typed outcome of the stash (issue 9575). `storage_unavailable` means the
 * intent is NOT readable after the auth round-trip (private mode, quota, a
 * storage shim that drops writes): the caller must not send the visitor
 * through sign-in on the promise of an automatic replay.
 */
export type SavePendingJobAlertResult =
  | { ok: true }
  | { ok: false; reason: 'storage_unavailable' };

interface StoredPendingJobAlert {
  config: JobAlertConfig;
  origin: PendingJobAlertOrigin;
}

export function savePendingJobAlert(
  config: JobAlertConfig,
  origin: PendingJobAlertOrigin,
): SavePendingJobAlertResult {
  const stored: StoredPendingJobAlert = { config, origin };
  return saveIntent(KEY, stored) ? { ok: true } : { ok: false, reason: 'storage_unavailable' };
}

function isOrigin(value: unknown): value is PendingJobAlertOrigin {
  return typeof value === 'string' && (PENDING_JOB_ALERT_ORIGINS as readonly string[]).includes(value);
}

function isConfig(value: unknown): value is JobAlertConfig {
  return Boolean(value) && typeof value === 'object' && Array.isArray((value as JobAlertConfig).keywords);
}

/**
 * Return the pending alert (config + CTA origin) and clear it, but only if it
 * was saved within the TTL. Returns null when absent, expired, or malformed.
 * A bare config written before the origin was recorded is still replayed, with
 * `origin: null` — the caller then reports it under its diagnostic surface.
 */
export function consumePendingJobAlert(): PendingJobAlert | null {
  const raw = consumeIntent<unknown>(KEY);
  if (!raw || typeof raw !== 'object') return null;
  const wrapped = raw as Partial<StoredPendingJobAlert>;
  if (isConfig(wrapped.config)) {
    return { config: wrapped.config, origin: isOrigin(wrapped.origin) ? wrapped.origin : null };
  }
  if (isConfig(raw)) return { config: raw, origin: null };
  return null;
}

export function clearPendingJobAlert(): void {
  clearIntent(KEY);
}
