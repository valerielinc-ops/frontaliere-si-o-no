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
import {
  UNIVERSAL_BENIGN_PATTERNS,
  BROWSER_EXTENSION_ORIGIN_PATTERN,
  isGoogleVignetteInjectedOpaqueError,
  isGoogleIosAppInjectedStackOverflow,
  isFirefoxDeadObjectFromRedactedSource,
  isOriginRedactedThirdPartyStack,
  readErrorDetailsSafely,
  readErrorEventDetailsSafely,
} from './benignErrorPatterns';
// The origin allow-list and the all-third-party verdict live in a dependency-light
// module shared with the GA4 `app_error` pipeline (services/analytics.ts), so the
// two sinks cannot drift.
import {
  THIRD_PARTY_STACK_ORIGINS,
  NATIVE_CODE_FRAME_PATTERN,
  areAllOriginsThirdParty,
} from './thirdPartyStackOrigins';

export { THIRD_PARTY_STACK_ORIGINS, NATIVE_CODE_FRAME_PATTERN };

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
 * The capturing browser's user agent: posthog-js stamps `$raw_user_agent` on
 * every event; fall back to `navigator` when it is absent.
 */
function eventUserAgent(event: PostHogExceptionEvent): string {
  const raw = event.properties?.$raw_user_agent;
  if (typeof raw === 'string' && raw) return raw;
  return typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
}

function eventPageUrl(event: PostHogExceptionEvent): string {
  const raw = event.properties?.$current_url;
  if (typeof raw === 'string' && raw) return raw;
  return typeof window !== 'undefined' ? window.location.href : '';
}

/**
 * True when the exception has at least one ownership-bearing resolved stack
 * frame AND every such frame's origin matches a known third-party script we do
 * not control (see `THIRD_PARTY_STACK_ORIGINS`). Native frames are neutral:
 * browsers can insert them into a vendor stack, but they do not prove
 * first-party ownership. An exception with zero ownership-bearing frames is
 * NOT considered third-party-only (nothing to go on — fail open, keep visible).
 */
function isThirdPartyStackOnly(event: PostHogExceptionEvent): boolean {
  return areAllOriginsThirdParty(extractStackFrameOrigins(event));
}

// ──────────────────────────────────────────────────────────────────────────
// Raw-stack bridge (#4173)
// ──────────────────────────────────────────────────────────────────────────
//
// PostHog's `$exception` autocapture parses `error.stack` with a frame regex
// that REQUIRES a `url:line:col` tail. WebKit redacts exactly that tail for
// every frame of a script the page loaded cross-origin without CORS, so those
// frames are all dropped and the event reaches `before_send` with
// `stacktrace.frames === []` — invisible to `isThirdPartyStackOnly`, which is
// why #4173's `RangeError` kept reopening as a first-party bug for months.
//
// `installRawStackRecorder()` therefore keeps the *unparsed* stack of the last
// few window errors in a small ring buffer, and `before_send` consults it when
// (and only when) PostHog resolved zero frames. It must be installed BEFORE
// `posthog.init()` so the recorder's listener is registered ahead of PostHog's
// own — `initPostHog()` in services/posthog.ts does that synchronously, before
// the dynamic `import('posthog-js')`.

interface RawStackEntry { readonly key: string; readonly stack: string; }

const RAW_STACK_BUFFER_LIMIT = 8;
const rawStackBuffer: RawStackEntry[] = [];
let rawStackRecorderInstalled = false;

/** Normalise a message for buffer lookup: PostHog may reshape the wording. */
function rawStackKey(message: string): string {
  return String(message || '').replace(/^(?:Uncaught\s+)?(?:\w*Error:\s*)?/, '').trim().slice(0, 120);
}

/** @internal — exported for tests and for `installRawStackRecorder`. */
export function recordRawErrorStack(message: string, stack: string): void {
  if (!stack) return;
  rawStackBuffer.push({ key: rawStackKey(message), stack });
  while (rawStackBuffer.length > RAW_STACK_BUFFER_LIMIT) rawStackBuffer.shift();
}

/** @internal — exported for tests. */
export function _resetRawStackBufferForTests(): void {
  rawStackBuffer.length = 0;
  rawStackRecorderInstalled = false;
}

function lookupRawErrorStack(message: string): string {
  const key = rawStackKey(message);
  if (!key) return '';
  for (let i = rawStackBuffer.length - 1; i >= 0; i -= 1) {
    const entry = rawStackBuffer[i];
    if (entry.key && (key.includes(entry.key) || entry.key.includes(key))) return entry.stack;
  }
  return '';
}

/**
 * PostHog may preserve Analytics' source-less synthetic fallback as the raw
 * stack. `at :0:1` carries line/column placeholders but no file or origin, so
 * it must not defeat the already message+Firefox-gated dead-object classifier.
 * Every other non-empty raw stack remains source evidence (fail open).
 */
function rawStackHasIdentifiableSource(rawStack: string): boolean {
  const normalized = rawStack.trim();
  if (!normalized) return false;
  return !/^(?:TypeError:\s*can't access dead object\s*\n)?\s*at\s+:0:1$/i.test(normalized);
}

/**
 * Register the raw-stack recorder. Idempotent, and a no-op outside the browser.
 * Call synchronously from `initPostHog()` before the PostHog SDK is imported.
 */
export function installRawStackRecorder(): void {
  if (rawStackRecorderInstalled || typeof window === 'undefined') return;
  rawStackRecorderInstalled = true;
  window.addEventListener('error', (event) => {
    const details = readErrorEventDetailsSafely(event as ErrorEvent);
    if (details.stack) recordRawErrorStack(details.message || event.message || '', details.stack);
  });
  window.addEventListener('unhandledrejection', (event) => {
    const details = readErrorDetailsSafely((event as PromiseRejectionEvent).reason);
    if (details.stack) recordRawErrorStack(details.message, details.stack);
  });
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
    const origins = extractStackFrameOrigins(event);
    const rawStack = origins.length === 0 ? lookupRawErrorStack(blob) : '';
    if (isFirefoxDeadObjectFromRedactedSource({
      message: blob,
      userAgent: eventUserAgent(event),
      hasSource: origins.length > 0 || rawStackHasIdentifiableSource(rawStack),
    })) return null;
    if (isGoogleIosAppInjectedStackOverflow(
      blob,
      origins.length > 0 ? origins.join('\n') : rawStack,
      eventUserAgent(event),
    )) return null;
    if (isGoogleVignetteInjectedOpaqueError(
      blob,
      origins.length > 0 ? origins.join('\n') : rawStack,
      eventPageUrl(event),
    )) return null;
    // Zero resolved frames → fall back to the raw stack we recorded ahead of
    // PostHog's own handler and classify on its SHAPE (#4173).
    if (origins.length === 0 && isOriginRedactedThirdPartyStack(rawStack)) {
      return null;
    }
    return event;
  };
}
