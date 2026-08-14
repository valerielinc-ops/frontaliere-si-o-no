/**
 * Forced garbage collection that actually SHRINKS RSS — ONE definition (#5899).
 *
 * ── The defect this replaces ──────────────────────────────────────────────
 *
 * Six sites across the build plugins forced a GC and documented, in prose, that
 * the point was to give pages back to the operating system:
 *
 *   profilePlugin.ts              "this WILL return pages to the OS, shrinking RSS"
 *   jobsSeoPagesPlugin.ts         "returned to the OS immediately"
 *   employerProfilePagesPlugin.ts "make V8 hand the pages back to the OS"
 *   staticPagesPlugin.ts          "trims the peak RSS this plugin contributes"
 *   borderMunicipalityPagesPlugin.ts, shared/buildMemLog.ts   — same intent
 *
 * All six called bare `gc()`. Bare `gc()` runs a full major collection, so the
 * LIVE HEAP does drop — which is why the [profile-mem] `heapUsed_mb` column
 * always looked healthy and the intent read as satisfied. It does not run V8's
 * memory-reduction pass, so the freed pages stay mapped and RSS does not move.
 *
 * Measured on Node 22.20.0 — the version deploy.yml pins — with 2.4 GB of small
 * objects allocated and dropped:
 *
 *   after alloc                       rss=2267 MB   heapUsed=2442 MB
 *   gc()                              rss=2162 MB   heapUsed=4 MB     <- heap freed, RSS pinned
 *   gc()  (a second time)             rss=2162 MB   heapUsed=4 MB     <- and it never moves
 *   gc({flavor:'last-resort'})        rss=  59 MB   heapUsed=4 MB     <- 2.1 GB handed back
 *
 * The build's memory guard samples RSS, not heap, so the difference is the whole
 * ballgame. Run 31822249277 leg `en` tripped it at peakRss=13303 MB against a
 * 12907 MB ceiling — an overshoot of 396 MB — while sitting at 10971 MB RSS
 * against 4715 MB of live heap immediately after a forced `gc()`. Six gigabytes
 * of that RSS was collected-but-unreturned pages.
 *
 * ── Why the flavor, and what it costs ─────────────────────────────────────
 *
 * `flavor: 'last-resort'` is what triggers the memory-reduction pass; `type:
 * 'major'` and `execution: 'sync'` are the defaults, stated explicitly so the
 * call says what it does. Measured cost on the same runner-equivalent: ~100 ms
 * versus ~11 ms for bare `gc()`. Across the ~62 profiled plugins that is ~5.6 s
 * added to a build that runs 30-38 minutes — inside the "~50-200 ms per call ×
 * ~30 plugins = ~3-6 s total; cheap insurance" budget profilePlugin.ts had
 * already written down and accepted for the weaker call.
 *
 * ── Why it degrades instead of throwing ───────────────────────────────────
 *
 * The options-object form needs a V8 new enough to parse it. Node 22 has it
 * (measured above), and deploy.yml pins Node 22, but a contributor on an older
 * local toolchain must not get a build that dies inside an instrumentation
 * helper. On a TypeError we fall back to bare `gc()` — the exact behaviour every
 * one of these six sites had before — and remember the outcome so the failed
 * probe happens once per process, not once per plugin.
 *
 * `gcReturnsPagesToOs()` exposes which path is live so a caller can assert on it
 * rather than trusting this comment; that is the whole lesson of the defect.
 */

type GcOptions = { execution?: 'sync' | 'async'; flavor?: 'regular' | 'last-resort'; type?: 'major' | 'minor' };
type GcFn = (options?: GcOptions) => void;

/**
 * `undefined` until the first forceGc() call has probed the runtime:
 * `true`  → the options-object form parsed, RSS-shrinking pass is in use
 * `false` → fell back to bare gc(), or --expose-gc was never passed
 */
let _optionsFormSupported: boolean | undefined;

/** Options-object probe result, for tests and for callers that want to log it. */
export function gcReturnsPagesToOs(): boolean | undefined {
  return _optionsFormSupported;
}

/** Reset the memoized probe. Tests only. */
export function resetGcProbe(): void {
  _optionsFormSupported = undefined;
}

/**
 * Run a full major GC that hands freed pages back to the OS.
 *
 * No-ops when the process was started without `--expose-gc` (local `npm run
 * build` does not pass it; `build:ci` does), so every call site stays safe to
 * invoke unconditionally.
 *
 * @returns `true` when a collection ran, `false` when `--expose-gc` is absent.
 */
export function forceGc(): boolean {
  const gc = (globalThis as { gc?: GcFn }).gc;
  if (typeof gc !== 'function') {
    _optionsFormSupported = false;
    return false;
  }
  if (_optionsFormSupported !== false) {
    try {
      gc({ execution: 'sync', flavor: 'last-resort', type: 'major' });
      _optionsFormSupported = true;
      return true;
    } catch {
      // V8 too old to parse the options object — fall through to the bare form
      // and stop probing for the rest of the process.
      _optionsFormSupported = false;
    }
  }
  gc();
  return true;
}
