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
 * localStorage (not sessionStorage) so it survives EVERY sign-in surface — not
 * just a same-tab redirect, but also the newsletter-autologin flow where the
 * email link can open a *new* tab (sessionStorage is per-tab and would be lost
 * there, silently degrading the 93%-drop funnel back to the old behaviour). The
 * explicit TTL below is what keeps localStorage's longer lifetime safe: a config
 * abandoned mid-auth never fires a surprise alert in a later session/visit.
 */

import type { JobAlertConfig } from '@/services/jobAlertService';

const KEY = 'pending_job_alert';
// Long enough for a Google popup or newsletter-autologin token exchange, short
// enough that an abandoned attempt never resurfaces in a later session/visit.
// This TTL is load-bearing now that we use localStorage (cross-tab, persistent)
// rather than sessionStorage (per-tab, tab-lifetime).
const TTL_MS = 15 * 60 * 1000;

interface StoredPendingAlert {
  config: JobAlertConfig;
  savedAt: number;
}

export function savePendingJobAlert(config: JobAlertConfig): void {
  if (typeof window === 'undefined') return;
  try {
    const payload: StoredPendingAlert = { config, savedAt: Date.now() };
    window.localStorage.setItem(KEY, JSON.stringify(payload));
  } catch {
    /* localStorage unavailable (private mode / quota) — degrade to no replay */
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
    raw = window.localStorage.getItem(KEY);
    if (raw) window.localStorage.removeItem(KEY);
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
    window.localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
