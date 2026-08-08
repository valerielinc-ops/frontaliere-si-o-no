/**
 * Same-origin `/data/**` references emitted into STATIC HTML, made safe on
 * every locale shard.
 *
 * The problem this exists to solve
 * -------------------------------
 * `scripts/offload-generated-images-cdn.mjs` (Phase 2) pushes `dist/data/*` to
 * the CDN repo, rewrites `/data/<file>` refs it finds in dist HTML to
 * `${CDN_BASE}/data/<file>`, and then DELETES the now-CDN-served files from
 * `dist/`. So after a deploy the apex serves NO `/data/**` at all — a surviving
 * same-origin `/data/x.json` in shipped HTML is a guaranteed 404.
 *
 * That rewrite is only as good as its authority, and its authority is
 * per-shard:
 *
 *     const dataRepl = (m, file) =>
 *       distDataRel.has('/data/' + file) ? `${cdnBase}/data/${file}` : m;
 *
 * `distDataRel` is "what is in THIS shard's dist/data". The served site is the
 * UNION of ~27 section × 4 locale shards. A shard that emits a page referencing
 * `/data/x.json` but does not itself carry `dist/data/x.json` gets no rewrite,
 * ships the bare same-origin path, and the reference 404s in production —
 * silently, because these hydration scripts all `.catch(function(){})`.
 *
 * Measured live (2026-08-08), same page family, two shards:
 *
 *     /meteo-frontalieri/      → fetch('https://cdn.frontaliereticino.ch/data/weather-snapshot.json')  ✅
 *     /fr/meteo-frontaliers/   → fetch('/data/weather-snapshot.json')                                  ❌ 404
 *
 * Same class as the hreflang defect in #4921: a per-shard view of "what the
 * build emits" used to decide something about the whole site.
 *
 * The fix
 * -------
 * Stop depending on the rewrite for correctness. Resolve at RUNTIME against the
 * base the offload injects into every page
 * (`<script>window.__CDN_DATA_BASE__="…"</script>`), which is shard-independent
 * because it is injected after the shards are merged.
 *
 * Deliberately correct in all three states, which is why the emitted code tests
 * the first character instead of blindly prefixing:
 *
 *   - rewrite DID happen  → value is already an absolute CDN URL → used as-is
 *     (blindly prefixing would produce `${base}https://cdn…` and break the
 *     shards that currently work);
 *   - rewrite did NOT happen → value is `/data/…` → prefixed with the injected
 *     base → resolves to the CDN;
 *   - no base at all (dev, or the non-fatal offload was skipped) → prefix is ''
 *     → stays same-origin and is served from `dist/`, exactly as before.
 *
 * This is `services/cdnDataBase.ts` → `cdnDataUrl()` expressed inline, for the
 * static pages that ship before any bundle loads. Keep the two in step.
 */

/**
 * Emit a JS expression (for inlining in a `<script>`) that resolves `path` to
 * the CDN when the page carries an injected base, and leaves an
 * already-rewritten absolute URL untouched.
 *
 * @param path Site-absolute generated-data path, e.g. `/data/weather-snapshot.json`.
 *             Left as a bare literal ON PURPOSE so the offload's HTML rewrite can
 *             still upgrade it to an absolute CDN URL on shards that carry the file.
 */
export function cdnDataHydrationUrlExpr(path: string): string {
  const literal = JSON.stringify(path);
  return `(function(u){return u.charAt(0)==='/'?(window.__CDN_DATA_BASE__||'')+u:u})(${literal})`;
}
