/**
 * Pure helpers behind scripts/ci/check-hydrated-article-parity.mjs.
 *
 * They live here so the gate can be VERIFIED rather than trusted. The CLI is
 * top-level code against live production, so its only check was to aim it at a
 * real defect — which worked once (it named the six articles a browser was
 * dropping) and then stopped working, because production healed and the
 * mutation had nothing left to find. A gate whose correctness cannot be
 * re-established on demand decays into decoration.
 */

/**
 * Slugs the SSG wrote into a hub's article grid.
 *
 * Anchored on the grid's own card class rather than "everything after the
 * grid marker": the page also links articles from the nav, the footer and the
 * related rails, and counting those would make the gate red for reasons that
 * are not the defect. Attribute order is not assumed — only that the anchor
 * carries the class.
 */
export function renderedSlugs(html, hubPath) {
  if (!html || !html.includes('ssg-article-grid')) return [];
  const prefix = String(hubPath || '').replace(/\/$/, '');
  const href = new RegExp(`href="${prefix}/([a-z0-9][a-z0-9-]{4,})/"`);
  const out = new Set();
  for (const [tag] of html.matchAll(/<a\b[^>]*>/g)) {
    if (!tag.includes('ssg-art-card')) continue;
    const m = tag.match(href);
    if (m) out.add(m[1]);
  }
  return [...out];
}

/**
 * Article ids a client data surface carries.
 *
 * The registry chunk is minified JS, so the ids are read as literals rather
 * than by parsing: `id:"…"`. That is deliberately the same shape the bundler
 * emits for every entry.
 */
export function idsInRegistryChunk(source) {
  const out = new Set();
  for (const m of String(source || '').matchAll(/\bid:"([a-z0-9][a-z0-9-]*)"/g)) out.add(m[1]);
  return out;
}

/**
 * Which rendered articles the client cannot render.
 *
 * ON IDS, NEVER ON SLUGS. The registry is keyed by `id` while the URL carries
 * a per-locale `slug`, and the two differ on most evergreen articles and on
 * EVERY non-Italian URL. Comparing the two directly is what once produced
 * "zero matches" against a perfectly healthy corpus and sent an investigation
 * after the wrong root cause.
 *
 * A slug the reverse map does not know resolves to itself: an id-shaped URL is
 * exactly what the client falls back to, so treating it as its own id keeps
 * this from inventing a failure.
 */
export function missingFromClient(slugs, reverseSlugToId, clientIds) {
  const missing = [];
  for (const slug of slugs) {
    const id = reverseSlugToId?.[slug] ?? slug;
    if (!clientIds.has(id)) missing.push(id === slug ? slug : `${slug} (id: ${id})`);
  }
  return missing;
}

/**
 * Surfaces the edge answers differently depending on whether `Origin` is sent.
 *
 * This is the cache defect caught directly instead of through its
 * consequences: a `Vary: Origin` beside a constant
 * `Access-Control-Allow-Origin: *` splits the edge into two variants, and a
 * purge only ever clears the one no browser asks for. Every header check then
 * reads current while visitors are served a copy up to a day old.
 */
export function divergentSurfaces(readings) {
  const out = [];
  for (const [url, r] of Object.entries(readings || {})) {
    const a = r?.withOrigin;
    const b = r?.withoutOrigin;
    if (a && b && a !== b) out.push({ url, withOrigin: a, withoutOrigin: b });
  }
  return out;
}

/**
 * Is an edge-variant divergence a failure, or a warning?
 *
 * Divergence is the MECHANISM, not the outcome. The outcome this gate exists
 * to judge is whether the client holds every article the server rendered —
 * and the runtime overlay is designed to close exactly the gap a stale
 * registry chunk opens (`services/articlesOverlay.ts`; it is fetched under a
 * five-minute rotating key, so it is never the stale variant). When the
 * overlay does its job the visitor sees the whole hub, and the divergence has
 * cost nobody anything yet.
 *
 * Measured 2026-08-07 on production: the browser's copy of
 * `blog-articles-data.js` was 18h old and lacked 9 of the 100 rendered
 * articles — and the overlay supplied all 9. Net missing: 0, on all eight
 * section/locale landings.
 *
 * Treating that as a hard failure had a cost the failure itself did not. The
 * caller retries a red verdict eight times at 45s (the workflow's ladder,
 * built for an article that has not propagated YET), so a global and
 * non-transient condition — an unpurged edge variant lives to its `max-age`,
 * up to 24h — burned 5m28s per landing across eight landings: ~44 minutes
 * against a 15-minute job. The job was cancelled at landing 3 of 8 on every
 * run for seven hours, so the gate could never reach the step that reports.
 * It was loudest exactly where it was silenced (#5279, #5280).
 *
 * So: fatal when the client really lost an article (divergence is then the
 * explanation, and worth failing on), a warning when the overlay absorbed it,
 * and fatal on demand via `strict` for a caller that wants to assert the zone
 * property directly — as a single cheap probe, never behind a retry ladder.
 */
export function divergenceVerdict({ divergent, missing, strict } = {}) {
  if (!divergent?.length) return 'none';
  if (strict || missing?.length) return 'fatal';
  return 'warn';
}
