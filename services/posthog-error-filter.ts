/**
 * PostHog `before_send` filter for $exception events.
 *
 * Drops well-known benign noise so real errors stay visible. Based on
 * Phase 1 of the 2026-05-18 traffic recovery audit:
 * `data/recovery-2026-05-18/app-errors.md` ranked 1,231 exceptions across
 * 686 sessions (30 d). ~95 % were noise from cross-origin scripts (AdSense,
 * Clarity, GSI), Safari IndexedDB lifecycle events (Firebase Remote Config
 * storage), and benign ResizeObserver loops.
 *
 * The list is intentionally CLOSED — only patterns that are confirmed
 * not actionable belong here. Real errors (ChunkLoadError, TypeError from
 * our own code) MUST pass through so dashboards stay accurate.
 */

/** Patterns that match benign / unactionable exception messages. */
export const BENIGN_MESSAGES: readonly RegExp[] = [
  /ResizeObserver loop/i,
  /Script error\.?$/i,
  /Non-Error promise rejection/i,
  /UnknownError.*IDBDatabase/i,
  /Connection to Indexed Database server lost/i,
  /InvalidStateError.*IDBDatabase/i,
  /Failed to execute 'transaction' on 'IDBDatabase'/i,
  /AbortError.*signal is aborted/i,
  // Safari emits a generic `TypeError: Load failed` for every fetch/resource
  // failure (network blip, CORS, image 404, cancelled XHR) without ever
  // populating `$exception_source` — no actionable signal in the payload.
  // The chunk-load slice that DOES matter is caught upstream by
  // `components/ChunkLoadErrorBoundary.tsx` via explicit "Failed to fetch
  // dynamically imported module" / "Importing a module script failed" patterns.
  // 30d ad-hoc audit (2026-05-18 follow-up): 49 events / 13 sessions, all
  // with empty source, scattered across 15 distinct URLs — pure transport noise.
  /^TypeError: Load failed$/i,
];

/**
 * Minimal PostHog event shape we depend on. Avoids importing posthog-js
 * type defs into this pure helper module (it must stay tree-shakable and
 * unit-testable without the SDK in scope).
 */
export interface PostHogExceptionEvent {
  event?: string;
  properties?: {
    $exception_values?: unknown;
    $exception_list?: unknown;
    [key: string]: unknown;
  } | null;
}

/**
 * Pull the human-readable exception text from a PostHog `$exception` event.
 * PostHog emits exception values as either a list of strings OR a list of
 * `{ value: string, type: string }` objects depending on capture path.
 */
function extractExceptionMessages(event: PostHogExceptionEvent): string {
  const props = event.properties || {};
  const msgs: string[] = [];
  const rawValues = props.$exception_values ?? props.$exception_list;
  if (Array.isArray(rawValues)) {
    for (const v of rawValues) {
      if (typeof v === 'string') {
        msgs.push(v);
      } else if (v && typeof v === 'object' && 'value' in v) {
        const value = (v as { value: unknown }).value;
        if (typeof value === 'string') msgs.push(value);
      }
    }
  }
  return msgs.join(' | ');
}

/**
 * Create the `before_send` hook for `posthog.init()`. Returns the event
 * unchanged for non-exception events and real errors; returns `null` to
 * drop confirmed-benign exceptions.
 */
export function createExceptionFilter() {
  return function beforeSend(event: PostHogExceptionEvent | null | undefined): PostHogExceptionEvent | null {
    if (!event || event.event !== '$exception') return event ?? null;
    const blob = extractExceptionMessages(event).trim();
    if (!blob) return event;
    for (const pattern of BENIGN_MESSAGES) {
      if (pattern.test(blob)) return null;
    }
    return event;
  };
}
