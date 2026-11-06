/**
 * Cross-plugin registry for canton hub noindex decisions.
 *
 * `jobsSeoPagesPlugin` decides which `/cerca-lavoro-{canton}/` landings ship
 * with `<meta robots="noindex,follow">` based on a DEDUPED job count (groups
 * jobs by `id` or `title|company`). Audit `audit-bfs-depth.mjs` treats a
 * noindex page as a BFS dead-end (line 276: `if (htmlHasNoindex(html)) continue`),
 * so any sub-hub linked only from that landing (`/tutti/`, `/settori/`,
 * `/aziende/`) becomes unreachable and trips the BFS gate.
 *
 * `seoHubsPlugin` emits those sub-hubs and uses its own dedup heuristic
 * (snapshot-history `tc|role|employerKey`) that does not match the
 * id-aware key jobsSeoPagesPlugin uses. When the two disagree, sub-hubs are
 * emitted under a noindex parent → orphan in BFS.
 *
 * This module bridges the two plugins: jobsSeoPagesPlugin writes the
 * authoritative noindex canton set, seoHubsPlugin reads it and skips emit
 * for those cantons. Both plugins run sequentially in the same Node
 * process during the build (`closeBundle`), so module-scoped state is
 * sufficient — no filesystem sidecar needed.
 *
 * Audit context: 2026-05-21 PR — `sitemap-seo-hubs.xml` BFS regression
 * (appenzello/sciaffusa/uri × {tutti,settori,aziende} = 9 orphans).
 */

const noindexCantons = new Set<string>();

/** Called by jobsSeoPagesPlugin after computing per-canton dedup-grouped counts. */
export function markCantonNoindex(cantonKey: string): void {
  noindexCantons.add(cantonKey);
}

/** Called by seoHubsPlugin's emitThinCantonHubs before emitting per-canton sub-hubs. */
export function isCantonNoindex(cantonKey: string): boolean {
  return noindexCantons.has(cantonKey);
}

/** Test/diagnostic helper — never mutate from production code. */
export function _resetCantonNoindexRegistry(): void {
  noindexCantons.clear();
}

/** Test/diagnostic helper — never mutate from production code. */
export function _getCantonNoindexSnapshot(): readonly string[] {
  return [...noindexCantons];
}
