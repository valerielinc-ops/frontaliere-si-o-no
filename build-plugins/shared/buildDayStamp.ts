/**
 * Day-granularity build timestamp for JSON-LD `dateModified` on listing/hub/
 * collection pages.
 *
 * WHY day-granularity and not `new Date().toISOString()`: a full-precision
 * build timestamp changes on EVERY build (sub-second), so every prerendered
 * page that embeds it churns on every ~hourly deploy even when its content is
 * unchanged. Measured: with the SPA entry hash now stable (#1615), the residual
 * per-deploy churn (~30% files) is dominated by listing/hub pages whose only
 * (or main) delta is this build-time `dateModified`. Truncating to the UTC day
 * makes it stable across all same-day deploys → those pages stop churning until
 * the calendar day rolls over (and a daily roll is legitimate freshness, still
 * a valid recent `dateModified` for SEO).
 *
 * Returns e.g. `2026-06-09T00:00:00.000Z`. Mirrors the pattern already used by
 * jobMarketSnapshotPlugin (`${todayIso}T00:00:00.000Z`), centralized here so
 * the collection-page generators share one source of truth.
 */
export function buildDayStampIso(): string {
  return `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
}
