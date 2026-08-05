/**
 * error-issue-sync.mjs — shared "top-N recurring error → GitHub backlog
 * issue" sync, used by every user-facing error source (GA4 app_error,
 * PostHog $exception, Cloudflare zone-wide 5xx).
 *
 * Extracted per AGENTS.md #6 (no literal duplication of the same construct
 * across sibling scripts) so scripts/app-error-issue-sync.mjs,
 * scripts/posthog-error-issue-sync.mjs and scripts/cf-5xx-issue-sync.mjs
 * share one create/dedupe loop instead of three copy-pasted ones.
 *
 * Relies on scripts/lib/github-issue-creator.mjs for the actual dedup
 * (stable title prefix match against OPEN issues → comment instead of
 * duplicate).
 */

import { createGithubIssue } from './github-issue-creator.mjs';

/**
 * Error messages tracked in telemetry ($exception / app_error) for dashboard
 * observability that are NOT actionable enough to generate a GitHub backlog
 * issue. These are environmental noise or transient failures already handled
 * client-side by an existing recovery path; the raw telemetry capture is
 * intentionally KEPT (chunk-load / error-rate dashboards must stay accurate —
 * see services/posthog-error-filter.ts and PR #3447) but must not flood the
 * backlog with issues no code change can close.
 *
 * Shared by scripts/posthog-error-issue-sync.mjs AND
 * scripts/app-error-issue-sync.mjs (AGENTS.md §Non-Negotiables #6 — the deny
 * decision is feeder-independent: the same self-healed error reaches GA4
 * app_error and PostHog $exception through parallel pipelines).
 *
 * This .mjs runs under plain Node in CI workflows and cannot import the .ts
 * sources of these patterns; the mirrors are pinned byte-for-byte by
 * tests/error-issue-sync.test.ts ("deny-list parity" describe block).
 */
export const ISSUE_DENY_PATTERNS = [
  // Module-script preload failure on flaky networks / stale SW cache (#3762).
  // Handled by SW cache-stale recovery + resilientImport(); kept in PostHog
  // for chunk-load dashboards but not worth a GitHub ticket.
  /Importing a module script failed/i,
  // Link-time ES-module version-skew SyntaxErrors (#3758/#3759/#3761 class):
  // a cached importer chunk links an export the (HTTP-200) dependency chunk
  // no longer provides — deploy-window skew or an ad-filter surrogate, both
  // definitionally transient and already self-healed client-side by the
  // cache-bust + budgeted-reload handlers (index.html bootstrap, early-boot.js
  // on every static page, resilientImport.ts, ChunkLoadErrorBoundary), with
  // the root causes fixed at build time (vite.config minifyInternalExports:false;
  // adFilterSafeChunkName #2971). MUST mirror MODULE_LINK_SKEW_PATTERNS in
  // services/resilientImport.ts — parity-pinned by tests/error-issue-sync.test.ts.
  // A genuinely persistent export breakage still reaches the backlog through
  // OTHER signatures (the downstream TypeErrors it causes are not denied).
  /does not provide an export named/i,
  // GA4 truncates the `error_message` custom event parameter at 100 chars
  // BEFORE it ever reaches this feeder (reports/analytics-latest.json stores
  // the already-truncated GA4 value) — unlike the client-side detection above,
  // which runs on the raw, untruncated `error.message` and is unaffected. A
  // longer `[SilentBoundary:<name>] SyntaxError: The requested module '<path>'
  // does not provide an export named '<binding>'` prefix pushes "an export
  // named" past the 100-char cutoff, so the pattern above never matches and
  // this self-healed class leaks into the backlog anyway (issue #5063: cut off
  // at "...does not provide "). This shorter prefix of the exact same V8/Chrome
  // wording lands well within the truncation budget regardless of boundary/
  // module name length, while staying specific enough to this SyntaxError class
  // to not swallow unrelated errors.
  /does not provide\b/i,
  /import not found/i,
  /indirect export/i,
  /Importing binding name/i,
  // Opaque cross-origin "Script error." (no message, no stack — #3758):
  // confirmed-benign and already dropped at PostHog before_send on BOTH init
  // paths since PR #3447 (services/posthog-error-filter.ts BENIGN_MESSAGES ↔
  // build-plugins/constants.ts POSTHOG_INIT_CONTENT) and never sent by the
  // GA4 app_error pipeline (UNIVERSAL_BENIGN_PATTERNS). This entry only stops
  // the monitor re-filing issues from residual pre-deploy events still inside
  // its trailing query window. Same anchored shape as the benign pattern.
  /^(?:Error: )?Script error\.?$/i,
  // Bare-URL <script>/<link> load failure during the CDN propagation window
  // (#4151 CSS-only fix, generalized to JS by #4592). The inline bootstrap
  // recovery snippet catches error events on ANY /assets/*.js|.css tag
  // regardless of chunk name — the handful of chunks preloaded on nearly
  // every page hit this far more often, since a normal deploy's short
  // post-deploy skew window then shows up at higher absolute volume — stores
  // the failing resource in sessionStorage, busts the HTTP cache, and
  // reloads. Kept in the dashboards for observability but not actionable as
  // a backlog ticket: the reload is the fix and the CDN window closes in
  // seconds. Confirmed self-healing for BOTH extensions and for non-critical
  // lazily-loaded chunks too (data/error-triage-baseline.json ranks 1/2/5
  // logged this exact "already-self-healing" verdict for two CSS chunks and
  // one lazy JS chunk alike during #4304 triage). Anchored to the bare-URL
  // shape so it does NOT match the *different* message shape produced by a
  // dynamic import() rejection ("Stale chunk: Failed to fetch dynamically
  // imported module: …") — that shape stays issue-able to surface
  // persistent CDN outages.
  /^Stale chunk: https?:\/\/\S+\.(?:js|css)(?:\?\S*)?$/i,
  // User-cancelled navigation / fetch abort (#4147 class): "AbortError: The
  // user aborted a request." (WebKit), "AbortError: The operation was aborted."
  // (standard), "AbortError: signal is aborted…", bare "AbortError: AbortError".
  // We never throw AbortError deliberately → every shape is benign cancellation.
  // Mirrors UNIVERSAL_BENIGN_PATTERNS in services/benignErrorPatterns.ts; the
  // client-side GA4 filter already drops most at source, but pre-filter GA4
  // data and edge-case paths still produce events → must not create backlog
  // issues that no code change can close. Parity-pinned by
  // tests/error-issue-sync.test.ts ("deny-list parity" describe block).
  /AbortError: (?:The user aborted a request|The operation was aborted|signal is aborted|AbortError)/i,
  // Bare transport failures — environmental noise (#4150): three browsers emit
  // the same "fetch failed" signal under different wording for a network blip /
  // CORS / cancelled XHR / offline / adblock, none with a usable stack.
  // MUST mirror UNIVERSAL_BENIGN_PATTERNS in services/benignErrorPatterns.ts
  // — parity-pinned by tests/error-issue-sync.test.ts ("deny-list parity").
  // Anchored (`^…$`) so contextualized `[ctx] Failed to fetch` variants and
  // chunk-load fetch failures ("Failed to fetch dynamically imported module:
  // <url>") still reach the backlog (those carry an actionable call-site or
  // CDN-outage signal — see #1810 class).
  //   Safari:  TypeError: Load failed
  //   Chrome:  TypeError: Failed to fetch
  //   Firefox: TypeError: NetworkError when attempting to fetch resource.
  /^(?:TypeError: )?Load failed$/i,
  /^(?:TypeError: )?Failed to fetch$/i,
  /^(?:TypeError: )?NetworkError when attempting to fetch resource\.?$/i,
  // Firebase Auth network-request-failed — transient client connectivity (#4174).
  // MUST mirror UNIVERSAL_BENIGN_PATTERNS in services/benignErrorPatterns.ts
  // — parity-pinned by tests/error-issue-sync.test.ts ("deny-list parity").
  /Firebase:.*auth\/network-request-failed/i,
  // Unsupported-browser parse failure (#4172): a browser too old to parse
  // optional-chaining `?.` / nullish `??` throws "Unexpected token '?'" on a
  // modern chunk. Below our Vite `build.target: 'modules'` baseline → an
  // unsupported-browser environmental failure no code change can close. Matched
  // on the `?` token so "Unexpected token '<'" (HTML-for-JS) / JSON parse bugs
  // still file. MUST mirror UNIVERSAL_BENIGN_PATTERNS in
  // services/benignErrorPatterns.ts — parity-pinned by tests/error-issue-sync.test.ts.
  /Unexpected token ['"]?\?['"]?/i,
  // OS/hardware file-read failure (#4175): DOMException "NotReadableError: The
  // I/O read operation failed." — the OS could not read a user-selected
  // file/blob (flaky disk / ejected media). Environmental, unfixable in code.
  // MUST mirror UNIVERSAL_BENIGN_PATTERNS in services/benignErrorPatterns.ts
  // — parity-pinned by tests/error-issue-sync.test.ts ("deny-list parity").
  /NotReadableError: The I\/O read operation failed/i,
];

/**
 * True when `message` matches the shared deny-list above and therefore must
 * not open/recur a GitHub backlog issue (telemetry capture is unaffected).
 */
export function isIssueDenied(message) {
  return ISSUE_DENY_PATTERNS.some((p) => p.test(message || ''));
}

/**
 * @param {object} opts
 * @param {Array<object>} opts.entries    Already-sorted (desc by relevance) list of error entries.
 * @param {number} [opts.maxIssues]       Cap on how many issues to open/touch per run (avoids backlog flooding).
 * @param {(entry:object)=>string} opts.titleFor   Stable issue title (first ~60 chars must be a unique discriminator).
 * @param {(entry:object)=>string} opts.bodyFor    Issue body markdown.
 * @param {(entry:object)=>number} [opts.priorityFor]  1-4 scale, 3=medium default.
 * @param {string[]} [opts.labels]        Extra labels beyond the priority label.
 * @param {string} [opts.source]          Human label for the "Workflow:" line in the issue body.
 * @returns {Promise<Array<object|null>>}
 */
export async function syncErrorIssues({
  entries,
  maxIssues = 5,
  titleFor,
  bodyFor,
  priorityFor,
  labels = [],
  source,
}) {
  const results = [];
  for (const entry of entries.slice(0, maxIssues)) {
    const title = titleFor(entry);
    if (!title) continue;
    const priority = priorityFor ? priorityFor(entry) : 3;
    // eslint-disable-next-line no-await-in-loop -- sequential to stay under gh API rate limits
    const res = await createGithubIssue({
      title,
      description: bodyFor(entry),
      priority,
      labels,
      workflow: source,
    });
    results.push(res);
  }
  return results;
}
