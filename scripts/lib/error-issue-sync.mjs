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
import { DEFAULT_LIVE_CHECK_USER_AGENT } from './live-link-check.mjs';

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
 * Extract every resolved stack-frame filename/URL out of a PostHog
 * `$exception_list` value (the parsed shape of `properties.$exception_list`).
 * Mirrors `extractStackFrameOrigins` in services/posthog-error-filter.ts —
 * kept as a separate copy because that file is `.ts` with DOM-adjacent client
 * deps and this one runs under plain Node in CI, same reason
 * ISSUE_DENY_PATTERNS above mirrors instead of importing (#5999: a mangled
 * 2-char message like "Ba" can't be pattern-matched safely, so the feeder
 * needs to surface resolved stack origins in the issue body instead).
 *
 * HogQL's `any(properties.$exception_list)` (and every other row/aggregate
 * read of a JSON-typed column) comes back as a JSON-encoded STRING, not a
 * parsed array — confirmed live against the PostHog API for #5999 itself.
 * `services/posthog-error-filter.ts`'s copy runs in-browser on the SDK's
 * already-parsed `event.properties.$exception_list`, so it never needs this;
 * only this HogQL-facing copy does.
 */
export function extractStackFrameOrigins(rawList) {
  const origins = [];
  if (typeof rawList === 'string') {
    try {
      rawList = JSON.parse(rawList);
    } catch {
      return origins;
    }
  }
  if (!Array.isArray(rawList)) return origins;
  for (const exc of rawList) {
    if (!exc || typeof exc !== 'object') continue;
    const frames = exc.stacktrace?.frames;
    if (!Array.isArray(frames)) continue;
    for (const frame of frames) {
      if (!frame || typeof frame !== 'object') continue;
      const filename = typeof frame.filename === 'string' ? frame.filename : frame.junk_drawer?.raw_frame?.filename;
      if (typeof filename === 'string' && filename) origins.push(filename);
    }
  }
  return origins;
}

// ── Stale page_404 telemetry (issues #5064 / #5065) ────────────────────────
//
// `page_404` is the one app_error class whose truth can be re-checked against
// production, and the GA4 report window is a TRAILING 30 DAYS. So a 404 that
// was fixed on day 3 keeps being reported for another 27 days, and each report
// opens (or recurs) a `priority:high` + `needs-human` backlog issue for a URL
// that has been serving 200 for weeks. Observed on both #5064 and #5065:
// verified live, the two job URLs return HTTP 200 with a complete JobPosting
// page, and the redirect-vs-telemetry race that produced the events was fixed
// by PR #4840 on 2026-07-28 — inside the window.
//
// Re-checking the URL before filing is not "suppressing a signal": a URL that
// answers 200 is not a 404. It is the same call the deny-list above already
// makes for self-healed transients, just answered by production instead of by
// a regex. Every skipped false positive is also a Claude invocation the issue
// automation does not spend (AGENTS.md → frugalità quota: cut the NUMBER of
// invocations by architecture).
//
// Fails OPEN: any network/timeout/parse problem keeps the issue, so a real
// outage can never be silently swallowed.

const PROD_ORIGIN = 'https://frontaliereticino.ch';
const PAGE_404_PROBE_TIMEOUT_MS = 10_000;

/** Extracts the site-relative path a page_404 entry refers to, or ''. */
export function page404Path(entry) {
  const type = String(entry?.errorType ?? '').trim();
  const message = String(entry?.errorMessage ?? '').trim();
  const isPage404 = type === 'page_404' || /^Page not found:/i.test(message);
  if (!isPage404) return '';
  const raw =
    String(entry?.pagePath ?? '').trim() ||
    (message.match(/^Page not found:\s*(\S+)/i)?.[1] ?? '');
  if (!raw.startsWith('/')) return '';
  // Drop the query string: the 404 is a routing fact about the path.
  return raw.split(/[?#]/)[0];
}

/**
 * True when the entry is a `page_404` whose URL currently resolves on
 * production — i.e. stale telemetry inside the trailing report window, not a
 * live defect. Non-page_404 entries always return false.
 *
 * @param {object} entry
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetchImpl] Injected for tests.
 * @param {string} [opts.origin]
 */
export async function isSelfHealedPage404(entry, { fetchImpl = fetch, origin = PROD_ORIGIN } = {}) {
  const path = page404Path(entry);
  if (!path) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAGE_404_PROBE_TIMEOUT_MS);
  try {
    // `redirect: 'manual'` on purpose: a 301 to a live page is also a resolved
    // URL (the canton-drift recovery in public/404.html does exactly that), and
    // not following it keeps the probe to a single request.
    //
    // User-Agent required (issue #5532): a plain Node fetch sends none, which
    // Cloudflare's "unidentified-scripted-traffic-challenge" rule treats as
    // empty and `managed_challenge`s with HTTP 403 — same root cause already
    // fixed in scripts/lib/live-link-check.mjs for every OTHER same-origin
    // liveness probe in this repo (see its doc comment). This probe never got
    // that fix, so it always saw 403 → always < 400 was false → always
    // reopened the issue regardless of the page's real status.
    const res = await fetchImpl(`${origin}${path}`, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'User-Agent': DEFAULT_LIVE_CHECK_USER_AGENT },
    });
    const status = Number(res?.status ?? 0);
    if (status <= 0) return false;
    if (status < 300) return true;
    if (status >= 400) return false;
    // 3xx: only a redirect to a SPECIFIC resolved page counts as self-healed
    // (canton-drift → the job's real canonical URL, a company-hub fix, or the
    // national board for a legacy search cluster). The Worker's LAST-RESORT
    // recovery for a genuinely expired job-detail slug
    // (recoverExpiredJobToCantonRoot, infra/cloudflare-worker/locale-router.js)
    // instead 301s to the generic canton SECTION ROOT (the path with its last
    // segment dropped) as a graceful fallback — that is not a fix for the
    // reported URL, so a redirect landing exactly there must still count as a
    // live defect. Declared choice (issue #5532), not a side effect of adding
    // the header above: without it, fixing the 403 would flip this guard from
    // "always reopens" to "silently swallows every expired en/de/fr job 404".
    const location = res.headers?.get?.('location') || '';
    if (!location) return true;
    let targetPath;
    try {
      targetPath = new URL(location, `${origin}${path}`).pathname;
    } catch {
      return true;
    }
    const sectionRoot = `${path.replace(/\/+$/, '').split('/').slice(0, -1).join('/')}/`;
    return targetPath !== sectionRoot;
  } catch {
    // Fail open — an unreachable prod must not hide a genuine 404.
    return false;
  } finally {
    clearTimeout(timer);
  }
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
