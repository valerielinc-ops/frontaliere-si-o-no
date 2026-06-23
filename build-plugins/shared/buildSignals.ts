/**
 * Build-phase synchronisation signals shared across Vite plugins.
 *
 * Vite/Rollup runs `closeBundle` hooks IN PARALLEL via `hookParallel`, so even
 * with `enforce: 'post'` two plugins that both write to the same file paths
 * race against each other. The `WriteCollector.add()` API is synchronous but
 * auto-flushes in the background once the pending queue crosses 5 000 writes,
 * which means a target file can be written by a background batch BEFORE the
 * plugin's own `closeBundle` reaches its final `await collector.flush()`.
 *
 * Post-injection plugins (e.g. `professionLandingsLinksPlugin`) need a
 * deterministic way to wait until every write to their target files has
 * landed on disk. This module exposes one explicit signal per source plugin
 * so consumers can `await` instead of polling for `mtime` stability.
 *
 * Usage:
 *
 *   // Producer plugin (e.g. staticPagesPlugin):
 *   await collector.flush();
 *   resolveStaticPagesFlushed();
 *
 *   // Consumer plugin (e.g. professionLandingsLinksPlugin):
 *   await staticPagesFlushed;
 *   // …safe to read/patch the files staticPagesPlugin wrote.
 *
 * Signals are intentionally NEVER rejected — a plugin failure should surface
 * via the producer's own thrown error, not via a downstream consumer awaiting
 * forever. If a producer fails before resolving, every other process is
 * already terminating because Vite propagates the original error.
 *
 * Idempotency: each `resolve*()` is a no-op when called twice (Vite may run
 * `closeBundle` once per build, but tests / dev-mode can re-invoke). The
 * underlying Promise resolves to the first value passed.
 */

function makeSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolveFn: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    resolveFn = resolve;
  });
  let resolved = false;
  return {
    promise,
    resolve: () => {
      if (resolved) return;
      resolved = true;
      resolveFn();
    },
  };
}

/** Like {@link makeSignal} but carries a value to the awaiting consumer. */
function makeValueSignal<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolveFn: (v: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    resolveFn = resolve;
  });
  let resolved = false;
  return {
    promise,
    resolve: (v: T) => {
      if (resolved) return;
      resolved = true;
      resolveFn(v);
    },
  };
}

const staticPagesSignal = makeSignal();
const professionLandingsSignal = makeSignal();
const salaryHubSignal = makeSignal();
const jobsSeoPagesSignal = makeSignal();
const sectorPagesSignal = makeSignal();
const professionCantonsSignal = makeValueSignal<readonly string[]>();

/** Resolves when {@link staticPagesPlugin} has flushed all its queued writes. */
export const staticPagesFlushed: Promise<void> = staticPagesSignal.promise;
export function resolveStaticPagesFlushed(): void {
  staticPagesSignal.resolve();
}

/** Resolves when {@link professionLandingsPlugin} has finished writing the 40 landings. */
export const professionLandingsFlushed: Promise<void> = professionLandingsSignal.promise;
export function resolveProfessionLandingsFlushed(): void {
  professionLandingsSignal.resolve();
}

/**
 * Resolves when {@link salaryHubPlugin} has flushed every salary scenario,
 * evergreen article AND the new browseable scenario index pages
 * (`/calcola-stipendio/scenari/` + 3 locale twins).
 *
 * Consumed by {@link salaryHubIndexLinkPlugin} which patches the calculator
 * hub HTML produced by {@link staticPagesPlugin} so BFS from `/` can reach
 * the scenario index (and through it, all 1 732 scenario pages — closing
 * the `sitemap-salary-hub.xml` orphan gap flagged by Semrush).
 */
export const salaryHubFlushed: Promise<void> = salaryHubSignal.promise;
export function resolveSalaryHubFlushed(): void {
  salaryHubSignal.resolve();
}

/**
 * Resolves when {@link jobsSeoPagesPlugin} has flushed all queued writes,
 * including previousSlugs bridge HTML. Consumed by
 * {@link relatedSearchClustersPlugin} so its sitemap canonical-mismatch
 * filter reads the final on-disk content. Without this barrier, parallel
 * `closeBundle` lets the cluster sitemap be written while bridge HTML is
 * still buffered, and bridge URLs (canonical → active slug) leak into
 * sitemap-search-clusters.xml — `audit:sitemap-canonicals` then fails.
 */
export const jobsSeoPagesFlushed: Promise<void> = jobsSeoPagesSignal.promise;
export function resolveJobsSeoPagesFlushed(): void {
  jobsSeoPagesSignal.resolve();
}

/**
 * Resolves when {@link jobSectorPagesPlugin} has written every sector-hub
 * landing (49 sectors × 4 locales). Consumed by {@link sectorHubLinksPlugin},
 * which patches the 4 job-board hub pages with an `<aside>` listing the
 * highest-demand sector hubs so BFS from `/` reaches them (today the root hub
 * links the sector INDEX once but none of the 49 sector-hub canonicals → ~37
 * are orphaned with ~0 internal links). Awaiting this barrier guarantees the
 * link targets exist on disk before we inject anchors to them, mirroring the
 * salaryHubFlushed → salaryHubIndexLinkPlugin contract.
 */
export const sectorPagesFlushed: Promise<void> = sectorPagesSignal.promise;
export function resolveSectorPagesFlushed(): void {
  sectorPagesSignal.resolve();
}

/**
 * Resolves with the list of canonical paths {@link professionCantonLandings}
 * actually wrote this build (job-floor gated → a data-dependent subset of the
 * enumerated routes). Consumed by {@link professionCantonLandingsLinksPlugin},
 * which injects a "same role, other cantons" link block into the per-locale
 * HTML sitemap pages so BFS-from-`/` reaches every emitted page at depth ≤ 3
 * (closing the `sitemap-profession-cantons.xml` orphan tier flagged by
 * `audit:max-bfs-depth`).
 */
export const professionCantonsFlushed: Promise<readonly string[]> =
  professionCantonsSignal.promise;
export function resolveProfessionCantonsFlushed(paths: readonly string[]): void {
  professionCantonsSignal.resolve(paths);
}
