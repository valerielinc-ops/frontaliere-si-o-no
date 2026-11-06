/**
 * URL prefixes this build still WRITES INTO but can no longer SHIP.
 *
 * THE DEFECT
 * ──────────
 * The two article sections run with `<SECTION>_BUILD_EMIT_SKIP=true`, and
 * deploy.yml then excludes them from the full-replace shard push ("excluded
 * from full-replace push (served by fast-publish only)"). The Worker
 * (infra/cloudflare-worker/locale-router.js — matchSection + the section
 * dispatch) sends the ENTIRE prefix to `SECTION_ORIGIN[section][locale]` with
 * NO apex fallback. So a file this build writes under one of those prefixes is
 * a file no user can ever fetch: `scripts/lib/rehydrate-trunk-guard.sh` deletes
 * it from dist/ before the post-deploy audits even see it, and the shard — the
 * only thing on the serving path — never receives it.
 *
 * Two emitters wrote there unconditionally, which made their output a statement
 * of intent rather than a description of production. Both now gate on this
 * module; #5290 had already made the same call for topicClusterHubsPlugin.
 *
 * MEASURED LIVE, 2026-08-08, on the BARE apex URLs (a `?cb=1` probe measures a
 * different origin on some apex paths — see wrangler.toml's route comments):
 *
 * legacyRedirectsPlugin — 38 static entries fall under these prefixes:
 *   22/38 → 200, the "Pagina spostata" bridge, noindex + meta-refresh. Stale
 *           shard files: pushed by the last full-replace push before the flag
 *           went on, never replaced since. They work by an accident of history,
 *           not because this build ships them.
 *   16/38 → 200 serving the ORIGINAL RETIRED ARTICLE, `index, follow`,
 *           self-canonical — the bridge entirely inert. These are exactly the
 *           16 URLs added on 2026-08-06 (4 retired articles x 4 locales, pinned
 *           by tests/retired-runaway-articles-redirects.test.ts): every entry
 *           added AFTER the cutover, and only those.
 *    0/38 → 404.
 *
 * legacyAliasPlugin — 21 of its 24 `data/legacy-aliases.json` entries fall
 * under these prefixes, and it emits `robots: 'index,follow'` by explicit
 * never-noindex policy. That is the class rehydrate-trunk-guard.sh calls FATAL
 * ("indexable page(s) were built under a prefix this build does not ship").
 * Sampled live: /articoli-frontaliere/addiofrontalierelongo/,
 * /articoli-frontaliere/tassa-salute-frontalieri/,
 * /de/grenzgaenger-artikel/rega-helikopter-locarno/ and
 * /en/cross-border-articles/bossi-wanted-good-for-ticino/ all answer 200 with
 * the shard's "Pagina non disponibile — esplora alternative" soft-landing and
 * NO robots meta at all — never the alias page this build writes.
 *
 * Note what that means and what this gate does NOT do: it stops the build
 * claiming fixes it cannot deliver. It does not repair the URLs.
 *
 * WHERE THE REPAIR LIVES — READ THIS BEFORE ADDING A REDIRECT HERE
 * ───────────────────────────────────────────────────────────────
 * It is `EDGE_RETIRED_PATHS` in `infra/cloudflare-worker/locale-router.js`
 * (issue #5369 §4, 2026-08-14). The Worker is the only layer in FRONT of the
 * shard for all eight prefixes, so it answers a retired path — 301 to a real
 * substitute, or 410 Gone — before `serveShard` ever runs, whatever the
 * append-only shard still holds. `tests/edge-retired-paths.test.ts` re-derives
 * that table from THIS build's own declarations (this plugin family's tables,
 * `data/article-redirects.json`, `data/legacy-aliases.json`) minus the corpus
 * slug registries, and fails in both directions.
 *
 * So a redirect declared under one of these prefixes still has to be declared
 * where it is declared today — that stays the source of truth for the target —
 * but it is not LIVE until the edge table carries it too. That test is what
 * makes forgetting the second half impossible rather than invisible.
 *
 * WHY GATE HERE AND REROUTE THERE, RATHER THAN SHIP
 * ────────────────────────────────────────────────
 * Shipping means putting the sections back into deploy.yml's push loop — a
 * full-replace force-push of this build's near-empty subtree over a shard the
 * corpus owns, which is the wipe BUILD_EMIT_SKIP exists to prevent. Not
 * emitting what cannot be delivered is the one call this build can make alone;
 * delivering it is the Worker's, and both halves are now covered.
 *
 * Two objections this comment used to raise against rerouting, both since
 * measured false: the source of truth is NOT forked across two repos (the
 * Worker lives in this one, and the test derives its table from these very
 * files), and it does NOT require a manual Worker deploy —
 * `.github/workflows/deploy-worker.yml` deploys on every push to main touching
 * `infra/cloudflare-worker/**`.
 */

import { EXTERNALLY_SERVED_SECTIONS } from '../../scripts/lib/externally-served-paths.mjs';
import { SECTION_ROUTES } from '../../infra/cloudflare-worker/locale-router.js';

/**
 * The URL prefixes routed to a section shard this build does not push.
 *
 * Derived from the Worker's own `SECTION_ROUTES`, for the same reason
 * scripts/lib/externally-served-paths.mjs derives it there: restating the eight
 * prefixes would let this gate drift away from what the edge actually routes to
 * a shard, and a drifted gate is worse than no gate.
 *
 * Returns [] when neither flag is 'true' — flipping a section's flag back to
 * 'false' puts it back in the push loop, and its pages must be emitted again.
 * Strict `=== 'true'`, so the literal string "false" cannot switch it on (the
 * footgun tests/build-emit-skip-gate.test.ts pins for the other three gates).
 */
export function unshippableSectionPrefixes(): string[] {
  const buildEmitSkip: Record<string, boolean> = {
    articolifrontaliere: process.env.ARTICOLIFRONTALIERE_BUILD_EMIT_SKIP === 'true',
    articolisvizzera: process.env.ARTICOLISVIZZERA_BUILD_EMIT_SKIP === 'true',
  };
  return (SECTION_ROUTES as ReadonlyArray<{ section: string; prefix: string; locale: string }>)
    .filter((route) => EXTERNALLY_SERVED_SECTIONS.has(route.section) && buildEmitSkip[route.section] === true)
    .map((route) => route.prefix);
}

/**
 * True when `pathname` sits under one of `prefixes`, matched at a SEGMENT
 * boundary — the same rule as isExternallyServedPath().
 *
 * The boundary is load-bearing here, not defensive tidiness: `/fr/articles-frontalier`
 * IS a section prefix and `/fr/articles-frontaliers/` is NOT — the `-s` spelling has
 * no SECTION_ROUTES entry, so the Worker leaves it on the FR locale shard, which this
 * build does ship. Google indexed both spellings and legacyRedirectsPlugin's table
 * carries entries for both, so a plain `startsWith(prefix)` test would swallow the
 * `-s` variant and silently stop emitting four bridges that work today.
 */
export function isUnshippablePath(pathname: string, prefixes: readonly string[]): boolean {
  if (typeof pathname !== 'string' || pathname.length === 0 || prefixes.length === 0) return false;
  const p = pathname.startsWith('/') ? pathname : `/${pathname}`;
  // `${prefix}.html` is the FLAT root of the section, and `matchSection`
  // (infra/cloudflare-worker/locale-router.js) matches it explicitly:
  // `pathname === `${route.prefix}.html``. Without it here, a bridge landing
  // exactly on `/articoli-frontaliere.html` reads as shippable, gets emitted
  // indexable, and the Worker still routes it to the shard that never receives
  // it — reproducing the very class this gate closes.
  //
  // It is the same blind spot that produced `dist/<locale>.html`: a prefix test
  // that sees the directory and misses its flat twin. Mirrored from
  // `matchSection` deliberately, so the two cannot disagree about what belongs
  // to a section.
  return prefixes.some((prefix) =>
    p === prefix
    || p === `${prefix}/`
    || p === `${prefix}.html`
    || p.startsWith(`${prefix}/`));
}
