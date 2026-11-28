/**
 * Third-party script origins and the "stack entirely third-party" verdict.
 *
 * Shared by the PostHog `before_send` filter (services/posthog-error-filter.ts)
 * and the GA4 `app_error` sink (services/analytics.ts), so one allow-list
 * decides in both pipelines. Dependency-free on purpose: analytics.ts must not
 * pull the PostHog filter (or anything heavy) into its static graph.
 */
import { BROWSER_EXTENSION_ORIGIN_PATTERN } from './benignErrorPatterns';

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
  // Browser extension content scripts (Chrome / Firefox / Safari) — #3673.
  // They run in page context but are entirely third-party; no fix possible.
  // Anchored wrapper around the shared literal in benignErrorPatterns.ts.
  new RegExp(`^${BROWSER_EXTENSION_ORIGIN_PATTERN.source}`, 'i'),
  // Microsoft Clarity session recording — #3760, #19026.
  // The tag bootstrap is served from www.clarity.ms, while the runtime that
  // throws is served from scripts.clarity.ms. Both are Clarity-owned and
  // third-party. Companion to the `standardSelectors` message pattern added
  // to UNIVERSAL_BENIGN_PATTERNS (covers cross-origin, no-frame case).
  /^https:\/\/(?:www|scripts)\.clarity\.ms\//i,
  // Google Publisher Tags (GPT) — third-party stack audit.
  // The library is third-party and can throw errors entirely inside its own
  // securepubads.g.doubleclick.net frames; no first-party fix is possible.
  /^https:\/\/securepubads\.g\.doubleclick\.net\//i,
  // Google Funding Choices CMP — #19705.
  // The reported PostHog sample is a RangeError whose resolved frames are
  // Funding Choices
  // runtime URLs interleaved with `[native code]`; the recursion is inside the
  // vendor CMP, not the page. Keep the origin check narrow and fail open for
  // any first-party frame.
  /^https:\/\/fundingchoicesmessages\.google\.com\//i,
  // Google reCAPTCHA Enterprise — #19025.
  // The live PostHog sample was `reCAPTCHA Timeout (b)` with every resolved
  // frame in Google's gstatic reCAPTCHA release; the timeout is inside the
  // vendor client and cannot be fixed by this application.
  /^https:\/\/www\.gstatic\.com\/recaptcha\//i,
];

/**
 * V8/WebKit can expose native frames alongside the URL-bearing frames of a
 * third-party runtime. They carry no ownership information, so they are
 * neutral in the all-third-party verdict; a stack containing only native
 * frames still fails open.
 */
export const NATIVE_CODE_FRAME_PATTERN = /^\[native code\]$/i;

/**
 * Neutral frames: they carry no ownership information (`[native code]` on
 * WebKit/Firefox, `<anonymous>` on V8). A stack made only of these fails open.
 */
const NEUTRAL_ORIGIN_PATTERN = /^(?:\[native code\]|<anonymous>)$/i;

/**
 * True when there is at least one ownership-bearing origin AND every such
 * origin matches `THIRD_PARTY_STACK_ORIGINS`. Zero ownership-bearing origins
 * (empty / redacted / native-only) fail open: the event stays visible.
 */
export function areAllOriginsThirdParty(origins: readonly string[]): boolean {
  const bearing = origins.filter(
    (origin) => origin && !NATIVE_CODE_FRAME_PATTERN.test(origin) && !NEUTRAL_ORIGIN_PATTERN.test(origin),
  );
  if (bearing.length === 0) return false;
  return bearing.every((origin) => THIRD_PARTY_STACK_ORIGINS.some((pattern) => pattern.test(origin)));
}

/**
 * Extract the script URL of every frame of a raw `error.stack` string.
 * Handles Chrome/V8 (`at fn (url:l:c)`, `at url:l:c`) and Firefox/Safari
 * (`fn@url:l:c`, `@url:l:c`). Header/message lines that are not frames are
 * ignored; frames with no URL (`at :0:1`, redacted `fn@`) yield nothing.
 */
export function extractStackOrigins(stack: string): string[] {
  const origins: string[] = [];
  if (typeof stack !== 'string' || !stack) return origins;
  for (const rawLine of stack.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let location: string | null = null;
    const chrome = /^at\s+(?:.*?\s+\((.*)\)|(.*))$/.exec(line);
    if (chrome) {
      location = chrome[1] ?? chrome[2] ?? '';
    } else {
      const at = line.indexOf('@');
      if (at !== -1 && !/\s/.test(line.slice(0, at))) location = line.slice(at + 1);
    }
    if (location === null) continue;
    const url = location.trim().replace(/(?::\d+){1,2}$/, '');
    if (url) origins.push(url);
  }
  return origins;
}

/**
 * Stack-string counterpart of the PostHog verdict: true only when every
 * ownership-bearing frame is a known third-party origin. Fail open otherwise.
 */
export function isThirdPartyOnlyStack(stack: string | undefined | null, fallbackFilename?: string | null): boolean {
  const origins = extractStackOrigins(stack || '');
  if (origins.length === 0 && fallbackFilename) origins.push(fallbackFilename);
  return areAllOriginsThirdParty(origins);
}
