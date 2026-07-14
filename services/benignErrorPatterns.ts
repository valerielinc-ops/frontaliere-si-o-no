/**
 * Shared benign-noise deny-list for client error telemetry.
 *
 * SINGLE SOURCE OF TRUTH for "is this error worth reporting?". Before this
 * module THREE places kept overlapping inline regex lists and drifted:
 *   1. `services/errorReporter.ts` → `reportCaughtError()` (contextualized
 *      catch-block reports, message shaped `[context] <message>`).
 *   2. `services/analytics.ts` → `initGlobalErrorTracking()` global
 *      `window.error` / `unhandledrejection` handlers (bare browser messages,
 *      shaped `<Name>: <message>`).
 *   3. `services/posthog-error-filter.ts` → PostHog SDK `before_send`
 *      ($exception autocapture).
 *
 * The drift meant confirmed-benign environmental noise — bare `Failed to fetch`,
 * user-cancelled `AbortError`, crypto-wallet / Firefox-reader browser-extension
 * globals — leaked into PostHog in the thousands per 3d window (2026-06-22
 * triage, top bucket `unhandled_rejection: TypeError: Failed to fetch` = 1689),
 * drowning real signal (auth chunk-skew, stale imports). Consolidating the
 * shared core makes drift impossible by construction (AGENTS.md §Non-Negotiables
 * #6: "una regex duplicata in ≥2 file → estraila in UN modulo condiviso").
 *
 * Two groups, because the pipelines legitimately differ:
 *   • UNIVERSAL_BENIGN_PATTERNS — benign in BOTH the custom `app_error` pipeline
 *     AND PostHog `$exception` autocapture.
 *   • APP_ERROR_ONLY_PATTERNS — benign only for the `app_error` pipeline. Most
 *     importantly `Importing a module script failed` is KEPT by the $exception
 *     filter (so chunk-load dashboards stay accurate) but dropped here.
 *
 * The $exception filter adds its own autocapture-specific extras (e.g.
 * "Non-Error promise rejection") on top of the universal core.
 *
 * This module has ZERO imports on purpose: both `errorReporter.ts` (which
 * imports `analytics.ts`) and `analytics.ts` consume it without creating an
 * import cycle.
 *
 * The list is intentionally CLOSED — only patterns confirmed not actionable
 * belong here. Real errors (our own TypeErrors, genuine API failures carrying a
 * call-site context) MUST pass through so dashboards stay accurate. Bare,
 * context-less transport failures are anchored with `^…$` so the contextualized
 * `[context] …` variants emitted by `reportCaughtError` still report.
 */

/** Benign in every client error pipeline ($exception autocapture + app_error). */
export const UNIVERSAL_BENIGN_PATTERNS: readonly RegExp[] = [
  // ── Browser-internal layout signal — not a bug ──
  /ResizeObserver loop/i,

  // ── Cross-origin script errors with no stack (browser CORS, opaque) ──
  /^(?:Error: )?Script error\.?$/i,

  // ── Microsoft Office / Outlook in-app browser postMessage bridge noise ──
  // 363 events/30d across 5 Id buckets — pure host-app noise.
  /Object Not Found Matching Id:\d+, MethodName:update, ParamCount:4/i,

  // ── Firebase Installations / Remote Config offline; SDK auto-retries ──
  /Installations:.*Application offline\b/i,
  /Remote Config:.*Original error:.*(Failed to fetch|Load failed|aborted|Database deleted|client is offline)/i,

  // ── Firebase Auth network-request-failed — transient client connectivity ──
  // "Firebase: Error (auth/network-request-failed)." — thrown during sign-in
  // (Google/LinkedIn/email) when the device is offline or the network drops
  // mid-request. Firebase internally records the failure; no code change can
  // prevent a client being offline. 10 occurrences / 9 sessions in 7d (#4174).
  /Firebase:.*auth\/network-request-failed/i,

  // ── IndexedDB lifecycle noise (iOS tab suspension / user clears site data) ──
  // Already auto-recovered by recoverFromIndexedDbLoss(); reporting is dup noise.
  /Connection to Indexed Database server lost/i,
  /Failed to execute 'transaction' on 'IDBDatabase'/i,
  /InvalidStateError.*IDBDatabase/i,
  /UnknownError.*IDBDatabase/i,
  /Database deleted by request of the user/i,

  // ── Bare transport failures with no actionable source ──
  // Three browsers emit the same "the fetch failed" signal under different
  // wording for a network blip / CORS / cancelled XHR / offline / adblock,
  // none with a usable stack. Anchored so contextualized `[ctx] …` variants
  // (which DO carry a call site) still report.
  //   Safari:  TypeError: Load failed
  //   Chrome:  TypeError: Failed to fetch        ← 1689 events/3d, top bucket
  //   Firefox: TypeError: NetworkError when attempting to fetch resource.
  /^(?:TypeError: )?Load failed$/i,
  /^(?:TypeError: )?Failed to fetch$/i,
  /^(?:TypeError: )?NetworkError when attempting to fetch resource\.?$/i,

  // ── User-cancelled requests (navigated away / pressed back mid-fetch) ──
  // 211 events/3d. We never throw AbortError deliberately, so every shape is a
  // benign cancellation. Covers WebKit "The user aborted a request.", the
  // standard "The operation was aborted.", "signal is aborted…", and the bare
  // DOMException "AbortError: AbortError".
  /AbortError: (?:The user aborted a request|The operation was aborted|signal is aborted|AbortError)/i,

  // ── Cross-origin iframe access blocked by SOP — typically an extension ──
  /SecurityError.*Blocked a frame.*cross-origin/i,

  // ── Browser-extension globals — NOT our code ──
  // Crypto-wallet injectors (MetaMask et al.) poke window.ethereum; Firefox
  // Reader mode probes window.__firefox__; Chrome-iOS webview uses __gCrWeb;
  // privacy trackers expose TrackerStorageType. All third-party page context.
  /window\.ethereum|MetaMask/i,
  /__firefox__/,
  /__gCrWeb/,
  /TrackerStorageType/,

  // ── Microsoft Clarity internal selector crash — #3760 ──
  // Clarity (clarity.ms) uses `standardSelectors` internally for its element
  // capture. It can throw when accessing that property on an undefined object
  // (race condition in their code). Cross-origin policy hides the stack frames
  // so `isThirdPartyStackOnly` cannot filter it — matching the message here
  // is the only viable catch. `standardSelectors` is not used anywhere in this
  // codebase, so any error mentioning it is unambiguously Clarity noise.
  /\bstandardSelectors\b/,

  // ── Unsupported-browser parse failure (below our support matrix) — #4172 ──
  // A browser too old to PARSE modern syntax (optional chaining `?.` / nullish
  // coalescing `??`) throws "SyntaxError: Unexpected token '?'" while loading a
  // current module chunk. Vite's default `build.target: 'modules'` baseline
  // (chrome87/safari14/firefox78/edge88) already ships these operators
  // un-transpiled, so ONLY browsers below that baseline hit this — an
  // unsupported-browser environmental failure no code change can close (a real
  // un-transpiled ship would break every modern browser at ~100% volume, not
  // 60 hits across 31 long-tail sessions). Distinct from the link-time
  // version-skew SyntaxErrors (MODULE_LINK_SKEW_PATTERNS, "does not provide an
  // export named …") which are self-healed, not old-browser. Matched on the `?`
  // token specifically so a genuine "Unexpected token '<'" (HTML-for-JS CDN
  // fault) or JSON parse bug still reports.
  /Unexpected token ['"]?\?['"]?/i,

  // ── OS/hardware file-read failure — #4175 ──
  // "NotReadableError: The I/O read operation failed." is a DOMException the
  // browser raises when the OS cannot read a user-selected file/blob (flaky
  // disk, ejected removable media, a file locked or changed mid-read). Purely
  // environmental — the user's storage failed while reading; no code change can
  // prevent it. 9 hits / 1 session (a single user's failing drive).
  /NotReadableError: The I\/O read operation failed/i,
];

/**
 * Benign only for the custom `app_error` pipeline. The $exception autocapture
 * filter intentionally KEEPS these (chunk-load dashboards, etc.).
 */
export const APP_ERROR_ONLY_PATTERNS: readonly RegExp[] = [
  // Adblock / privacy extensions block accounts.google.com/gsi/client. We
  // degrade gracefully (One Tap just doesn't show); reporting is pure noise.
  /Failed to load Google Identity Services/i,
  // Firebase/Firestore offline state during tab suspension on iOS Safari.
  /Failed to get document because the client is offline/i,
  // Module-script preload failure on flaky networks. The SW recovery path
  // (sw_cache_stale) + resilientImport() handle the visible cases; bare
  // rejections without a recovery hook are noise. KEPT by the $exception filter
  // for chunk-load dashboards; filtered from GitHub issue creation in
  // scripts/posthog-error-issue-sync.mjs ISSUE_DENY_PATTERNS (#3762).
  /Importing a module script failed/i,
  // Twelve Data CHF/EUR exchange-rate fetch flake (~140/30d). Caller has a full
  // Firebase RC fallback, so this is recoverable noise.
  /\[exchangeRate\.twelveDataFetch\]/i,
];

/**
 * Full benign deny-list for the `app_error` pipeline (errorReporter + global
 * handlers): the universal core plus the app_error-only extras.
 */
export const BENIGN_ERROR_PATTERNS: readonly RegExp[] = [
  ...UNIVERSAL_BENIGN_PATTERNS,
  ...APP_ERROR_ONLY_PATTERNS,
];

/**
 * Returns `true` when `message` matches a confirmed-benign, non-actionable
 * pattern for the `app_error` pipeline and should NOT be reported.
 */
export function isBenignErrorMessage(message: string): boolean {
  return BENIGN_ERROR_PATTERNS.some((re) => re.test(message));
}
