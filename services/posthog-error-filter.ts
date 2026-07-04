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
 * The benign core (cross-origin script errors, IDB lifecycle, bare transport
 * failures, AbortError, browser-extension globals, Office bridge, RC offline)
 * is shared with the custom `app_error` pipeline via
 * `services/benignErrorPatterns.ts` so the two cannot drift (AGENTS.md
 * §Non-Negotiables #6). This filter adds two $exception-autocapture-specific
 * extras on top of the universal core.
 *
 * The list is intentionally CLOSED — only patterns that are confirmed
 * not actionable belong here. Real errors (ChunkLoadError, TypeError from
 * our own code) MUST pass through so dashboards stay accurate — note that
 * "Importing a module script failed" is deliberately NOT in the universal core,
 * so chunk-load $exceptions still reach the dashboards.
 *
 * GitHub issue #3407 ("Error: oa", 19 occurrences/7d): live HogQL query
 * against PostHog (2026-07-04) showed every sampled occurrence's resolved
 * stacktrace lives ENTIRELY inside `https://accounts.google.com/gsi/client`
 * (Google Identity Services, third-party, cross-origin). The message is an
 * unrecoverable Closure-Compiler-mangled token ("oa") because Google's own
 * sourcemap fetch 403s — this is not a message we can safely pattern-match
 * (too short/generic to distinguish from a real first-party error), so
 * instead `isThirdPartyStackOnly` below inspects the RESOLVED STACK FRAMES:
 * only drops the event when every frame's origin is a known third-party
 * script we do not control. This is narrower and safer than a message regex.
 */
import { UNIVERSAL_BENIGN_PATTERNS } from './benignErrorPatterns';

/** Patterns that match benign / unactionable exception messages. */
export const BENIGN_MESSAGES: readonly RegExp[] = [
  ...UNIVERSAL_BENIGN_PATTERNS,
  // ── $exception-autocapture-specific extras ──
  // PostHog wraps thrown non-Error values into a synthetic "Non-Error promise
  // rejection captured with value: …" $exception; the inner value is already
  // covered (or noise) — the wrapper itself carries no actionable stack.
  /Non-Error promise rejection/i,
];

/**
 * Script origins that are known third-party, cross-origin, and outside our
 * control. When an exception's ENTIRE resolved stack lives inside one of
 * these origins, it cannot be a bug in our own code — see #3407 above.
 * Keep this list as narrow/closed as BENIGN_MESSAGES: only add an origin
 * once confirmed via a live stack-trace sample, never speculatively.
 */
export const THIRD_PARTY_STACK_ORIGINS: readonly RegExp[] = [
  // Google Identity Services (One Tap / Sign in with Google) — #3407.
  /^https:\/\/accounts\.google\.com\/gsi\//i,
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
 * Pull every resolved stack-frame filename/URL out of a PostHog `$exception`
 * event's `$exception_list`. PostHog's error-tracking pipeline nests frames
 * under `stacktrace.frames[]`, each carrying `filename` (resolved) and/or
 * `junk_drawer.raw_frame.filename` (pre-resolution fallback).
 */
function extractStackFrameOrigins(event: PostHogExceptionEvent): string[] {
  const props = event.properties || {};
  const rawList = props.$exception_list;
  const origins: string[] = [];
  if (!Array.isArray(rawList)) return origins;
  for (const exc of rawList) {
    if (!exc || typeof exc !== 'object') continue;
    const frames = (exc as { stacktrace?: { frames?: unknown } }).stacktrace?.frames;
    if (!Array.isArray(frames)) continue;
    for (const frame of frames) {
      if (!frame || typeof frame !== 'object') continue;
      const f = frame as { filename?: unknown; junk_drawer?: { raw_frame?: { filename?: unknown } } };
      const filename = typeof f.filename === 'string' ? f.filename : f.junk_drawer?.raw_frame?.filename;
      if (typeof filename === 'string' && filename) origins.push(filename);
    }
  }
  return origins;
}

/**
 * True when the exception has at least one resolved stack frame AND every
 * frame's origin matches a known third-party script we do not control
 * (see `THIRD_PARTY_STACK_ORIGINS`). An exception with zero frames is NOT
 * considered third-party-only (nothing to go on — fail open, keep visible).
 */
function isThirdPartyStackOnly(event: PostHogExceptionEvent): boolean {
  const origins = extractStackFrameOrigins(event);
  if (origins.length === 0) return false;
  return origins.every((origin) => THIRD_PARTY_STACK_ORIGINS.some((pattern) => pattern.test(origin)));
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
    if (blob) {
      for (const pattern of BENIGN_MESSAGES) {
        if (pattern.test(blob)) return null;
      }
    }
    if (isThirdPartyStackOnly(event)) return null;
    return event;
  };
}
