/**
 * jobAlertCtaState — synchronous "does this visitor have an active job alert"
 * signal, mirroring services/newsletterCtaState.ts's exact style.
 *
 * Currently consumed by AdBlockGate (#3655 targeting refinement): a visitor
 * with a job alert already set up is hard-excluded from the 30/70 AdBlock A/B
 * gate, the same way a newsletter subscriber is — they are a retained,
 * engaged user we never want to interrupt with the full-screen blocker.
 *
 * Deliberately dependency-free (no firebase, no analytics) so importing it
 * eagerly does not bloat whichever chunk pulls it in.
 */

export const JOB_ALERT_SUBSCRIBED_KEY = 'job_alert_subscribed';

/**
 * Surfaces accepted by the alert-funnel conversion goal. Each one has a
 * corresponding `job_alert_cta_shown` event; an authentication/replay path is
 * deliberately not a CTA surface.
 */
export const JOB_ALERT_CTA_SURFACES = [
  'inline_card',
  'job_detail_button',
  'job_detail_prompt',
  'job_board_filters',
  'job_match_pill',
  'sticky_banner',
  'end_card',
] as const;

export type JobAlertCtaSurface = (typeof JOB_ALERT_CTA_SURFACES)[number];

export type JobAlertCreationPath = 'direct' | 'post_auth_auto';

export function isJobAlertCtaSurface(value: unknown): value is JobAlertCtaSurface {
  return typeof value === 'string' && JOB_ALERT_CTA_SURFACES.includes(value as JobAlertCtaSurface);
}

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
