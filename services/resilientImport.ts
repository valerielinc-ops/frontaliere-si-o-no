/**
 * Resilient dynamic import for lazily-loaded service chunks.
 *
 * Chunk filenames are STABLE (non-hashed) on this site (see vite.config rollup
 * output). After a deploy, two distinct stale-deploy failure modes can hit a
 * client still running the previous build:
 *
 *  1. import() REJECTS with "Failed to fetch dynamically imported module" —
 *     the chunk URL 404s because the CDN replaced/purged the old file.
 *
 *  2. import() RESOLVES but the returned module's named exports are undefined —
 *     the CDN/Cloudflare SPA fallback served index.html (HTTP 200) for the
 *     missing .js, so import() parses an HTML document as an (empty) module.
 *     Downstream code then throws on a MINIFIED name, e.g.
 *     "n.getApp is not a function", "n is not a function",
 *     "Ze is not a constructor", "[clarity.init] e is not a function".
 *
 * Both are the same root cause (stale build vs. current CDN assets). This helper
 * clears caches, retries once, and finally reloads the page to fetch fresh HTML
 * that references the current chunk URLs. A single sessionStorage key guards
 * against reload loops across every caller.
 */

/**
 * SINGLE SOURCE OF TRUTH for the fetch-time stale-chunk substring signatures.
 * Consumed here by isChunkLoadError, by lazyRetry.ts and seoService.ts's
 * retry wrappers (via direct import — this module has no dependencies of its
 * own so no import cycle), and by build-plugins/constants.ts at BUILD TIME to
 * generate the equivalent regex embedded in SELF_HEAL_SCRIPT_CONTENT (the
 * emitted early-boot.js cannot `import` this module — it runs before any
 * module JS loads — so constants.ts inlines `.join('|')` of these strings
 * into the raw script text instead). Before this consolidation these four
 * call sites drifted independently (AGENTS.md §Non-Negotiables #6): the
 * early-boot.js copy was missing 'Importing a module script failed' (WebKit's
 * generic module-load-failure wording), so a Safari user hitting that signature
 * on a static SEO page had no self-heal listener for it (issue #3216 item 1).
 *
 * 'Loading chunk' / 'Loading CSS chunk' are legacy webpack wordings kept for
 * back-compat with very old cached client JS; Vite never throws them but
 * matching is a pure widening (safe — guarded by the same reload budget).
 */
export const CHUNK_LOAD_ERROR_SUBSTRINGS = [
  'Importing a module script failed',
  'Failed to fetch dynamically imported module',
  'error loading dynamically imported module',
  'Loading chunk',
  'Loading CSS chunk',
] as const;

export function isChunkLoadError(err: unknown): boolean {
  const msg = (err as Error)?.message || '';
  return (
    CHUNK_LOAD_ERROR_SUBSTRINGS.some((s) => msg.includes(s)) || (err as Error)?.name === 'ChunkLoadError'
  );
}

function escapeRegExpLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Regex-source (escaped, `|`-joined) form of CHUNK_LOAD_ERROR_SUBSTRINGS, for
 * consumers that need a `RegExp.test()` rather than the `.includes()` chain
 * above — `ChunkLoadErrorBoundary.tsx` (combines it with its own `/i` flag +
 * a bare 'ChunkLoadError' alternative) and `build-plugins/constants.ts`
 * (interpolates it into the raw SELF_HEAL_SCRIPT_CONTENT string at build
 * time, since the emitted early-boot.js cannot import this module).
 */
export const CHUNK_LOAD_ERROR_PATTERN_SOURCE = CHUNK_LOAD_ERROR_SUBSTRINGS.map(escapeRegExpLiteral).join('|');

/**
 * SINGLE SOURCE OF TRUTH for the "this resource-load failure is a content/ad
 * blocker, not a genuine bug" classifier used by the two pre-module bootstrap
 * handlers in index.html (script/link load errors, dynamic-import rejections)
 * and their mirrored copy in build-plugins/constants.ts (SELF_HEAL_SCRIPT_CONTENT,
 * via `.map(r => r.source).join('|')` at BUILD TIME — same technique as
 * CHUNK_LOAD_ERROR_PATTERN_SOURCE above). index.html's two copies are hand-synced
 * (cannot `import` this module — see the comment on CHUNK_LOAD_ERROR_SUBSTRINGS).
 *
 * Confirmed via a live PostHog HogQL query (issue #4304, 2026-07-16): of 6,986
 * `resource_load_error` events/30d, ~1,420 (~20%) were failed loads of
 * THIRD-PARTY resources routinely blocked by ad/privacy blockers — Microsoft
 * Clarity, Google Funding Choices (consent CMP), the Cloudflare Web Analytics
 * beacon, and this site's own PostHog reverse-proxy subdomain (mirrors
 * `POSTHOG_HOST` in services/posthog.ts and build-plugins/constants.ts) — but
 * the pre-existing pattern list only covered generic tracking/ads keywords,
 * missing all four, so those failures were misclassified `ad_blocker: false`
 * (counted as genuine app errors), inflating the reported error rate. Each new
 * entry is domain-anchored (not a bare keyword) so it cannot accidentally match
 * a first-party chunk filename (e.g. services/clarity.ts's own lazy-loaded
 * chunk has no `.ms` TLD in its name).
 */
export const AD_BLOCKER_TRIGGER_PATTERNS: readonly RegExp[] = [
  /analytics/,
  /tracking/,
  /adsense/,
  /adsbygoogle/,
  /googletag/,
  /firebase/,
  /gtag/,
  /recaptcha/,
  /clarity\.ms/,
  /fundingchoices/,
  /cloudflareinsights/,
  /t\.frontaliereticino\.ch/,
];

/**
 * Regex-source (`|`-joined) form of AD_BLOCKER_TRIGGER_PATTERNS, for consumers
 * that interpolate it into a raw script string (build-plugins/constants.ts) or
 * build their own case-insensitive RegExp from it.
 */
export const AD_BLOCKER_TRIGGER_PATTERN_SOURCE = AD_BLOCKER_TRIGGER_PATTERNS.map((re) => re.source).join('|');

/** True when `url` (a failed resource src, or an import()-rejection message
 * carrying the failing URL) matches a known ad/privacy-blocker trigger. */
export function isAdBlockerTriggerUrl(url: string): boolean {
  return new RegExp(AD_BLOCKER_TRIGGER_PATTERN_SOURCE, 'i').test(url);
}

/**
 * A LINK-TIME ES-module mismatch SyntaxError — the cross-browser wordings the
 * browser throws when an importer chunk requests an export the (already loaded,
 * HTTP 200) dependency chunk does not provide. Used by isVersionSkewError below
 * and mirrored as an inline regex in index.html's runtime-error / rejection
 * handlers (which cannot import this module — keep the two in sync).
 *
 * Wordings observed across engines (the binding name in quotes is app-specific):
 *   - V8 / Chrome / Edge: "...does not provide an export named 'House'"
 *   - Firefox:            "import not found: House" / "ambiguous indirect export: House"
 *   - WebKit / Safari:    "Importing binding name 'House' is not found."
 */
/**
 * SINGLE SOURCE OF TRUTH for the link-time module-export-mismatch wordings.
 * Consumed here by isModuleLinkSkewMessage AND by build-plugins/constants.ts
 * at BUILD TIME (via `.map(r => r.source).join('|')`) to generate the
 * equivalent inline regex in SELF_HEAL_SCRIPT_CONTENT — see the
 * CHUNK_LOAD_ERROR_SUBSTRINGS comment above for why constants.ts cannot
 * simply `import` this module's functions into the emitted script.
 */
export const MODULE_LINK_SKEW_PATTERNS: readonly RegExp[] = [
  /does not provide an export named/,
  /import not found/,
  /indirect export/,
  /Importing binding name/,
];

export function isModuleLinkSkewMessage(msg: string): boolean {
  return MODULE_LINK_SKEW_PATTERNS.some((re) => re.test(msg));
}

/**
 * Detect a CROSS-CHUNK VERSION-SKEW error — a stale-deploy failure mode the
 * fetch-based detectors above do not cover. Two distinct shapes, ONE root cause
 * (stable filenames + per-asset cache lifetimes → a client ends up with a
 * MISMATCHED set of stable-named chunks), ONE recovery (clear caches + reload).
 *
 * (a) CALL-TIME (TypeError): Rollup minifies internal cross-chunk export names
 *     to single letters (`export { lt as m }`) that are REASSIGNED every build
 *     from pure minifier ordering. A client holding a previously-cached importer
 *     chunk binds the OLD letter (`import { m as ls }`) to whatever the FRESH
 *     dependency chunk now exports under `m`. Both chunks load fine (HTTP 200) —
 *     the mismatch only surfaces at CALL time as a TypeError: the bound symbol
 *     is the wrong kind of value. (`minifyInternalExports:false` in vite.config
 *     attacks the cause; this is the runtime safety net.)
 *       - "ls(...).then is not a function" / "n is not a function"
 *       - "Ze is not a constructor" / "e is not iterable"
 *
 * (b) LINK-TIME (SyntaxError, issue #3097): the dependency chunk's EXPORT SET
 *     changes between deploys (e.g. lucide-react tree-shaking adds/removes icons
 *     in `vendor-icons.js`), so a cached importer (`BlogArticles.js` importing
 *     `House`) links against a stale/old `vendor-icons.js` that does not export
 *     that name. The ES module linker throws a SyntaxError at instantiation
 *     ("...does not provide an export named 'House'"), surfaced through
 *     React.lazy → ErrorBoundary. Same skew, same clear-caches + one-reload fix.
 *
 * Neither is throwable at import() time as a chunk-load error: (a) fires deep in
 * render/effects, (b) rejects the lazy import() with a SyntaxError that the
 * fetch-failure predicates (isChunkLoadError) do not match. Both reach the React
 * ErrorBoundary (in-render) or the global window handlers (outside React), which
 * route here → recoverFromStaleChunk().
 *
 * The predicate is signature-based. A genuine app bug producing the same message
 * costs at most MAX_RELOADS extra reloads before the per-session guard blocks
 * further reloads and the error UI is shown — identical to the existing
 * chunk-recovery tradeoff, and far better than a permanent white screen on a
 * real skew.
 */
/**
 * SINGLE SOURCE OF TRUTH for the call-time version-skew TypeError wordings.
 * Mirrored (via `.map(r => r.source).join('|')`) into SELF_HEAL_SCRIPT_CONTENT
 * at BUILD TIME by build-plugins/constants.ts — see the
 * CHUNK_LOAD_ERROR_SUBSTRINGS comment above.
 */
export const CALL_TIME_SKEW_PATTERNS: readonly RegExp[] = [
  /\bis not a function\b/,
  /\bis not a constructor\b/,
  /\bis not iterable\b/,
];

export function isVersionSkewError(err: unknown): boolean {
  const e = err as { name?: string; message?: string } | null | undefined;
  if (!e) return false;
  const msg = e.message || '';
  if (e.name === 'TypeError') {
    return CALL_TIME_SKEW_PATTERNS.some((re) => re.test(msg));
  }
  if (e.name === 'SyntaxError') {
    return isModuleLinkSkewMessage(msg);
  }
  return false;
}

// Session-wide reload BUDGET shared across every recovery surface: resilientImport's
// chunk-load path (below), recoverFromStaleChunk (called by ErrorBoundary + the
// global window-error handler), lazyRetry.ts, index.html's bootstrap handlers, and
// their mirrored copy in build-plugins/constants.ts (SELF_HEAL_SCRIPT_CONTENT,
// injected into every static SEO page). Keep all in sync — none of the non-module
// copies can import this file.
//
// Stored as a JSON map `{ [signature]: attempts }` under BOOTSTRAP_RELOAD_KEY,
// keyed on WHAT went stale (the failing chunk URL or error message) rather than a
// single flat counter. A flat counter (previous design, raised 1→2 in #3184)
// conflates "this exact bug keeps looping" with "the session hit a genuinely NEW,
// independently-stale chunk" — a client that recovers from vendor-icons.js on page
// A and i18n.js on page B has legitimately spent both slots and is then PERMANENTLY
// stranded if a THIRD, unrelated chunk goes stale on page C, even though recovery
// would have worked again given the chance (#3097 recurrence, jul02). Per-signature
// tracking gives each distinct stale chunk its own MAX_RELOADS attempts, while a
// bug that keeps throwing the IDENTICAL message is still capped — and
// MAX_TOTAL_RELOADS backstops the (unlikely) case of many distinct signatures
// reload-storming the user.
const BOOTSTRAP_RELOAD_KEY = '_swReloadCount';
export const MAX_RELOADS = 2;
export const MAX_TOTAL_RELOADS = 6;

function readReloadBudget(): Record<string, number> {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(BOOTSTRAP_RELOAD_KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Attempt to spend one reload against the shared per-signature budget. Returns
 * true (and records the attempt) if `signature` has not yet exhausted its own
 * MAX_RELOADS allowance and the session-wide MAX_TOTAL_RELOADS ceiling has not
 * been reached; false if the caller should give up and show the error UI.
 */
export function consumeReloadBudget(signature: string): boolean {
  const budget = readReloadBudget();
  const key = (signature || 'unknown').slice(0, 150);
  const total = Object.values(budget).reduce((a, b) => a + b, 0);
  const count = budget[key] || 0;
  if (count >= MAX_RELOADS || total >= MAX_TOTAL_RELOADS) return false;
  budget[key] = count + 1;
  try {
    sessionStorage.setItem(BOOTSTRAP_RELOAD_KEY, JSON.stringify(budget));
  } catch {
    /* private mode — proceed without persisting the guard */
  }
  return true;
}

// Upper bound on how long the HTTP-cache bust may run before we reload anyway.
// Asset chunks are small and refetched in parallel; this is only a backstop so a
// hung/blocked refetch can never strand the user on the error page.
const BUST_TIMEOUT_MS = 4000;

// Resource Timing's default buffer is spec-floored at 250 entries and this is a
// long-lived SPA session (client-side routing, no full navigation between
// in-app pages) with AdSense Auto Ads/GTM/Firebase/Clarity generating many
// resource loads over a session — realistic enough to overflow the default
// buffer and silently EVICT the oldest entries, including a version-skewed
// `/assets/*` chunk's own timing entry (issue #3149). Raising the cap can only
// prevent FUTURE eviction, not restore entries already dropped, so this alone
// is set here as a defensive backstop; the real mitigation is raising it
// EARLY, before the buffer fills — the pre-module bootstrap scripts do the
// same raise at page start (index.html inline script and
// `SELF_HEAL_SCRIPT_CONTENT` in build-plugins/constants.ts — keep the value in
// sync across all three, none of the non-module copies can import this file).
const RESOURCE_TIMING_BUFFER_SIZE = 1000;

/**
 * Overwrite the STALE entries the skewed chunks occupy in the browser's HTTP
 * disk cache, so the subsequent reload loads a consistent, current chunk set.
 *
 * Why this is necessary on top of `caches.delete()` (issue #3097, recurrence of
 * the #3071/#3131 self-heal): the version-skewed chunks are cross-origin module
 * scripts served from `cdn.frontaliereticino.ch/assets/*` with
 * `Cache-Control: max-age=600, must-revalidate`. CacheStorage (`caches.*`) is
 * EMPTY on this site — no service worker caches `/assets` — so `caches.delete()`
 * is a no-op, and a plain `location.reload()` re-serves the SAME stale bytes from
 * the HTTP cache within the 600 s window. The one allowed reload is then wasted
 * and the error page persists (works in incognito only because there is no
 * persistent HTTP cache). `fetch(url, { cache: 'reload' })` bypasses the HTTP
 * cache AND replaces the stored entry with current bytes, breaking the skew.
 *
 * Best-effort and time-boxed: every refetch swallows its own error and the whole
 * batch races a {@link BUST_TIMEOUT_MS} timer, so recovery never hangs. Resolves
 * once the cache has been refreshed (or the timer fires); the caller then reloads.
 */
export async function bustAssetHttpCache(): Promise<void> {
  if (typeof window === 'undefined' || typeof fetch !== 'function') return;

  try {
    if (typeof performance !== 'undefined' && typeof performance.setResourceTimingBufferSize === 'function') {
      performance.setResourceTimingBufferSize(RESOURCE_TIMING_BUFFER_SIZE);
    }
  } catch {
    /* unsupported — proceed with whatever entries the buffer already holds. */
  }

  let urls: string[] = [];
  try {
    const entries =
      typeof performance !== 'undefined' && typeof performance.getEntriesByType === 'function'
        ? performance.getEntriesByType('resource')
        : [];
    urls = entries
      .map((e) => (e as PerformanceResourceTiming).name)
      .filter((u) => /\/assets\/.+\.(?:js|css)(?:\?|$)/.test(u));
  } catch {
    /* Resource Timing unavailable — the DOM scan below still runs. */
  }
  // Second, INDEPENDENT enumeration path — always unioned with Resource Timing
  // (not just when it comes back empty), so a partial eviction that dropped
  // only SOME entries still recovers the ones still present as DOM nodes. Note
  // this cannot cover chunks loaded via dynamic import(): a native ES module
  // dynamic import never leaves a <script>/<link> element in the DOM, so an
  // evicted Resource Timing entry for one is unrecoverable by this path — the
  // buffer-size raise above is the actual mitigation for that case.
  if (typeof document !== 'undefined') {
    try {
      document
        .querySelectorAll<HTMLScriptElement | HTMLLinkElement>(
          'script[src*="/assets/"], link[href*="/assets/"]',
        )
        .forEach((el) => {
          const u = (el as HTMLScriptElement).src || (el as HTMLLinkElement).href;
          if (u) urls.push(u);
        });
    } catch {
      /* DOM unavailable */
    }
  }

  const unique = Array.from(new Set(urls));
  if (unique.length === 0) return;

  // `cache: 'reload'` forces a network refetch that overwrites the cache entry.
  // `mode: 'cors'` matches how module fetches are always CORS-enabled requests
  // (HTML spec, independent of any `crossorigin` attribute). `credentials:
  // 'same-origin'` matches the credentials mode module scripts use when their
  // top-level <script type="module"> carries no `crossorigin` attribute (the
  // spec default) — NOT 'omit'. On the CDN deploy (cdn.frontaliereticino.ch,
  // cross-origin from frontaliereticino.ch) 'same-origin' already omits
  // credentials for that foreign origin, identical to the old hardcoded
  // 'omit'. But when ASSET_CDN is unset (vite.config.ts renderBuiltUrl) chunks
  // are same-origin, where the module loader's default DOES send credentials —
  // a hardcoded 'omit' would then diverge from what the browser actually
  // fetches, risking a distinct cache entry for a differently-credentialed
  // response. 'same-origin' reproduces the real module-fetch behaviour in both
  // deploy shapes with one value instead of branching on ASSET_CDN.
  const refetch = Promise.all(
    unique.map((u) =>
      fetch(u, { cache: 'reload', mode: 'cors', credentials: 'same-origin' }).catch(() => {
        /* one failed refetch must not block the others or the reload */
      }),
    ),
  );
  await Promise.race([
    refetch,
    new Promise<void>((resolve) => setTimeout(resolve, BUST_TIMEOUT_MS)),
  ]);
}

/**
 * Clear all CacheStorage entries and reload the page so the browser refetches a
 * CONSISTENT set of stable-named chunks (post-propagation, the skew is gone).
 * Called by the ErrorBoundary version-skew recovery; shares the `_swReloadCount`
 * per-signature budget (see consumeReloadBudget) with the index.html bootstrap
 * recovery so every skew surface (React-caught + global window error) draws from
 * one pool, capped at MAX_RELOADS attempts per distinct stale chunk/message and
 * MAX_TOTAL_RELOADS overall. No-op outside the browser. Returns true if a reload
 * was scheduled, false if the guard blocked it.
 */
export async function recoverFromStaleChunk(reason: string): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  // Dev (Vite HMR) produces transient skew that resolves itself — never reload.
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return false;
  }
  if (!consumeReloadBudget(reason)) return false;
  // Best-effort breadcrumb for Analytics.initGlobalErrorTracking() post-reload.
  try {
    sessionStorage.setItem(
      '_forceReloadInfo',
      JSON.stringify({
        source: 'resilient_import',
        reason,
        pagePath: window.location.pathname + window.location.search,
        timestamp: new Date().toISOString(),
      }),
    );
  } catch {
    /* storage unavailable */
  }
  if ('caches' in window) {
    try {
      const names = await caches.keys();
      await Promise.all(names.map((n) => caches.delete(n)));
    } catch {
      /* cache eviction is best-effort */
    }
  }
  // The skew lives in the HTTP cache, which `caches.delete()` does not touch —
  // bust it so the reload loads current bytes rather than the same stale set.
  await bustAssetHttpCache();
  window.location.reload();
  return true;
}

/**
 * Load a dynamically-imported module, recovering from stale-deploy failures.
 *
 * @param factory  the `() => import(...)` thunk.
 * @param validate optional guard run against the resolved module. Return
 *                 `false` when an expected export is missing (mode 2 above):
 *                 the module is then treated as a stale chunk and retried with
 *                 the same cache-clear → reload path as an outright fetch error.
 */
export async function resilientImport<T>(
  factory: () => Promise<T>,
  validate?: (mod: T) => boolean,
): Promise<T> {
  const attempt = async (): Promise<T> => {
    const mod = await factory();
    if (validate && !validate(mod)) {
      // Resolved, but missing expected exports — SPA-fallback HTML served for a
      // purged chunk. Surface it as a chunk-load error so the recovery path runs.
      const stale = new Error(
        'Failed to fetch dynamically imported module (stale chunk: expected exports missing)',
      );
      stale.name = 'ChunkLoadError';
      throw stale;
    }
    return mod;
  };

  try {
    return await attempt();
  } catch (err) {
    if (!isChunkLoadError(err)) throw err;
    // Clear all caches so the browser refetches fresh chunks.
    if (typeof window !== 'undefined' && 'caches' in window) {
      try {
        const names = await caches.keys();
        await Promise.all(names.map((n) => caches.delete(n)));
      } catch {
        /* cache eviction is best-effort */
      }
    }
    // Retry once after cache clear.
    try {
      return await attempt();
    } catch (err2) {
      // Chunk truly gone — reload to get fresh HTML with current chunk URLs.
      if (typeof window !== 'undefined') {
        const signature = (err2 as Error)?.message || 'chunk_load';
        const shouldReload = consumeReloadBudget(signature);
        if (shouldReload) {
          // Bust the HTTP cache before reloading: a stale-but-200 chunk (HTML
          // served for a purged name, or a skewed dependency) would otherwise be
          // re-served from the disk cache and the reload wasted.
          await bustAssetHttpCache();
          window.location.reload();
        }
      }
      throw err2;
    }
  }
}
