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

const staticPagesSignal = makeSignal();
const professionLandingsSignal = makeSignal();
const salaryHubSignal = makeSignal();
const jobsSeoPagesSignal = makeSignal();

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
