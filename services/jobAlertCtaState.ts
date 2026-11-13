/**
 * jobAlertCtaState — synchronous "does this visitor have an active job alert"
 * signal, mirroring services/newsletterCtaState.ts's exact style.
 *
 * Currently consumed by AdBlockGate (#3655 targeting refinement): a visitor
 * with a job alert already set up is excluded from the native application
 * offer, the same way a newsletter subscriber is — they are a retained,
 * engaged user we never want to interrupt with a full-screen promotion.
 *
 * Deliberately dependency-free (no firebase, no analytics) so importing it
 * eagerly does not bloat whichever chunk pulls it in.
 */

export const JOB_ALERT_SUBSCRIBED_KEY = 'job_alert_subscribed';

/**
 * True when this visitor has successfully created at least one job alert
 * (set by components/community/JobAlertForm.tsx on every successful
 * `persistAlert` call, manual or post-auth-replay).
 */
export function isJobAlertSubscribed(): boolean {
  try {
    return localStorage.getItem(JOB_ALERT_SUBSCRIBED_KEY) === 'true';
  } catch {
    // localStorage unavailable (privacy mode / SSR) — fail closed (not subscribed).
    return false;
  }
}
