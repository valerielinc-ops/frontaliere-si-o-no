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
 * lazy-mount gap: the prompt calls {@link requestJobAlertOpen} then navigates,
 * and the freshly-mounted form calls {@link consumeJobAlertOpen} once and opens
 * itself (seeding the keyword if provided). Dependency-free so it can't pull the
 * heavy Firestore/auth graph into either consumer.
 */

interface JobAlertOpenRequest {
  /** Optional keyword to seed into the form's keyword field. */
  keyword?: string;
}

let pending: JobAlertOpenRequest | null = null;

/** Record a request to open the job-alert manager on the next form mount. */
export function requestJobAlertOpen(keyword?: string): void {
  pending = { keyword: keyword || undefined };
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
