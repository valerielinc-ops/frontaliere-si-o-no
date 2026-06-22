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
 * sessionStorage (not in-memory) so it survives a redirect-based sign-in; a
 * short TTL so a config abandoned mid-auth never fires a surprise alert later.
 */

import type { JobAlertConfig } from '@/services/jobAlertService';

const KEY = 'pending_job_alert';
// Long enough for a Google popup or newsletter-autologin token exchange, short
// enough that an abandoned attempt never resurfaces in a later session/visit.
const TTL_MS = 15 * 60 * 1000;

interface StoredPendingAlert {
  config: JobAlertConfig;
  savedAt: number;
}

export function savePendingJobAlert(config: JobAlertConfig): void {
  if (typeof window === 'undefined') return;
  try {
    const payload: StoredPendingAlert = { config, savedAt: Date.now() };
    window.sessionStorage.setItem(KEY, JSON.stringify(payload));
  } catch {
    /* sessionStorage unavailable (private mode) — degrade to no replay */
  }
}

/**
 * Return the pending alert config and clear it, but only if it was saved within
 * the TTL. Returns null when absent, expired, or malformed.
 */
export function consumePendingJobAlert(): JobAlertConfig | null {
  if (typeof window === 'undefined') return null;
  let raw: string | null = null;
  try {
    raw = window.sessionStorage.getItem(KEY);
    if (raw) window.sessionStorage.removeItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredPendingAlert;
    if (!parsed || typeof parsed.savedAt !== 'number' || !parsed.config) return null;
    if (Date.now() - parsed.savedAt > TTL_MS) return null;
    return parsed.config;
  } catch {
    return null;
  }
}

export function clearPendingJobAlert(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
