/**
 * Keep the sitemaps from advertising URLs the edge already answers 301/410.
 *
 * THE DEFECT THIS CLOSES (issue #7670)
 * ────────────────────────────────────
 * Nothing tied `EDGE_RETIRED_PATHS` to `public/sitemap-*.xml`. A retirement is
 * declared in one commit — `legacyRedirectsPlugin.ts` plus the edge table — and
 * from that moment the Worker answers those URLs 301 (or 410). The sitemap kept
 * listing them until the NEXT run of `sync-articles-sitemaps.yml`, which is on
 * `cron: '23 5,17 * * *'`: a window of up to ~12h in which the site's own index
 * invites Google to crawl pages the site refuses to serve. Every one of those
 * `<loc>`s is a crawl-budget request that resolves to a redirect, and a sitemap
 * full of redirects is a quality signal against the whole document.
 *
 * The window is not the occurrence — on 2026-09-06 the intersection measured 0
 * of 81, because the 05:23 sync had already run. What was missing is the layer
 * that makes it structurally impossible to reopen at the NEXT retirement, and
 * that is two things: this pruner, applied on ingest so the publisher can never
 * reintroduce a dead URL, and tests/sitemap-retired-paths-absent.test.ts, which
 * turns the intersection into a red gate so the pruning lands in the SAME commit
 * that switches the 301 on.
 *
 * WHY IT MATCHES ON `<loc>` AND NOT ON THE hreflang ALTERNATES
 * ───────────────────────────────────────────────────────────
 * A `<url>` block is the crawl request; the `<xhtml:link>` alternates inside it
 * describe the same document in the other locales. Dropping a block because one
 * ALTERNATE is retired would de-list a page that is still live — the opposite
 * defect — and rewriting the alternate out of an otherwise live block breaks the
 * reciprocity that tests/sitemap-hreflang-reciprocity.test.ts pins. It is also
 * unnecessary: `tests/edge-retired-paths.test.ts` already refuses a retirement
 * declared in some locales and not the others ("bridges all four locale URLs of
 * a retirement"), so an alternate cannot be retired while its own `<loc>` is
 * live. Match the `<loc>`, drop the whole block, leave hreflang alone.
 */

// eslint-disable-next-line import/no-relative-parent-imports
import { lookupRetired } from '../../infra/cloudflare-worker/locale-router.js';

/** Pathname of a sitemap `<loc>`, or null when it is not a parseable URL. */
function locPathname(loc) {
  try {
    return new URL(loc).pathname;
  } catch {
    return loc.startsWith('/') ? loc : null;
  }
}

/**
 * True when the edge would NOT hand this `<loc>` to the origin — i.e. the URL is
 * declared retired. Uses the Worker's own lookup, so the slash-less and
 * `/index.html` forms are judged exactly as they are at request time.
 *
 * @param {string} loc absolute or root-relative URL from a `<loc>`
 * @returns {boolean}
 */
export function isRetiredLoc(loc) {
  const pathname = locPathname(loc);
  return pathname !== null && lookupRetired(pathname) !== undefined;
}

/**
 * Every `<loc>` in a sitemap document that the edge answers 301/410.
 *
 * This is the measurement the gate reports, so it scans ALL `<loc>` elements —
 * including a sitemap INDEX, whose `<loc>`s name sub-sitemap files rather than
 * pages. Those are never retired paths, so the index simply yields [].
 *
 * @param {string} xml
 * @returns {string[]}
 */
export function retiredLocsIn(xml) {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map((m) => m[1].trim())
    .filter(isRetiredLoc);
}

/**
 * Removes every `<url>…</url>` block whose `<loc>` is a retired path.
 *
 * The whole block goes, not just the `<loc>` — same reasoning as
 * dropShadowedSitemapUrlBlocks() in scripts/lib/article-canonical-overrides.mjs,
 * whose regex idiom this deliberately mirrors: the block carries the page's
 * hreflang alternates, and leaving them orphaned would advertise the retired
 * article's other locales while the entry point is gone.
 *
 * Idempotent, and a no-op on a document with nothing retired in it — including a
 * sitemap index, which has no `<url>` blocks at all.
 *
 * @param {string} xml
 * @returns {{ xml: string, dropped: string[] }}
 */
export function dropRetiredSitemapUrlBlocks(xml) {
  const dropped = [];
  const out = xml.replace(/[ \t]*<url>[\s\S]*?<\/url>\n?/g, (block) => {
    const loc = block.match(/<loc>([^<]+)<\/loc>/)?.[1]?.trim();
    if (!loc || !isRetiredLoc(loc)) return block;
    dropped.push(loc);
    return '';
  });
  return { xml: out, dropped };
}
