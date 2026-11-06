/**
 * Cross-view "open the job-alert manager" signal.
 *
 * The job-detail prompt's "Gestisci alert" action lives on the job-DETAIL view,
 * but the `JobAlertForm` (the manager UI that listens for the `openJobAlert`
 * DOM event) is only mounted on the job-board LIST view. Dispatching the event
 * from the detail page therefore hit no listener — "gestisci alert" went
 * nowhere. The caller must first navigate back to the list (`backToList`),
 * which mounts the form fresh; but the form mounts asynchronously (lazy chunk),
 * so a one-shot DOM event can fire before the listener attaches and be lost.
 *
 * This module holds a persistent request that survives the navigation +
 * lazy-mount gap: a caller calls {@link openJobAlertForm} when the form is
 * already mounted, or {@link requestJobAlertOpen} before navigation, and the
 * form consumes the same request once (seeding the keyword and CTA origin).
 * Dependency-free so it can't pull the heavy Firestore/auth graph into either
 * consumer.
 */

import type { PendingJobAlertOrigin } from './pendingJobAlert';

interface JobAlertOpenRequest {
  /** Optional keyword to seed into the form's keyword field. */
  keyword?: string;
  /** CTA surface whose impression should receive the eventual create. */
  origin?: PendingJobAlertOrigin;
}

let pending: JobAlertOpenRequest | null = null;

/** Record a request to open the job-alert manager on the next form mount. */
export function requestJobAlertOpen(keyword?: string, origin?: PendingJobAlertOrigin): void {
  pending = {
    ...(keyword ? { keyword } : {}),
    ...(origin ? { origin } : {}),
  };
}

/**
 * Open the manager from a CTA that may race its lazy mount. The origin is
 * queued first, then broadcast for an already-mounted form; either path feeds
 * the same `ctaOrigin` state and therefore the same `job_alert_created` value.
 */
export function openJobAlertForm(keyword?: string, origin?: PendingJobAlertOrigin): void {
  requestJobAlertOpen(keyword, origin);
  if (typeof window === 'undefined') return;

  const detail: { keyword?: string; origin?: PendingJobAlertOrigin } = {};
  if (keyword) detail.keyword = keyword;
  if (origin) detail.origin = origin;
  window.dispatchEvent(new CustomEvent('openJobAlert', { detail }));
}

/**
 * Consume a pending open request (one-shot). Returns the request if one was
 * queued since the last consume, else `null`. Clears it so it fires only once.
 */
export function consumeJobAlertOpen(): JobAlertOpenRequest | null {
  const req = pending;
  pending = null;
  return req;
}
