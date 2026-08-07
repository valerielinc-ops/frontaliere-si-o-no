/**
 * The article-hub watchdog must ask about the `/tutti/` archives, not only the
 * landings, and its same-origin-asset pattern must actually discriminate.
 *
 * ─── The failure this exists to catch (issue #5270) ──────────────────────
 * `publish-article-fast.mjs` ran the CDN offload BEFORE re-rendering the
 * section archive. The offload is the only pass that rewrites the `/assets/…`
 * strings `articleHubPagesPlugin` emits as plain text (`src="/assets/${entryJs}"`,
 * invisible to Rollup), and nothing on the serving path hosts `/assets` —
 * `https://frontaliereticino.ch/assets/index-entry.js` answered 404 while this
 * was being written. Every archive page therefore shipped 9 dead references:
 * no CSS, no SPA bundle, no AdSense loader, and a 200 status the whole time.
 *
 * ─── Why a source-order test was not enough ──────────────────────────────
 * `tests/fast-publish-cdn-offload-order.test.ts` (#5271) pins the ordering in
 * THIS repo's copy of the script. There are two copies: nanako's
 * `frontaliere-articles` runs its own, and no mirror carries `scripts/`
 * (`mirror-articles-engine.yml` carries `engine/` + `index.ts` +
 * `articleSections.ts`). Both repos push the article shards, so after #5271 the
 * live archive alternated healthy and broken depending on which one had
 * published last — measured on `frontaliere-articolifrontaliere-it`:
 *
 *   07:07:18Z  corpus push  10 same-origin refs,  0 CDN
 *   05:13:17Z  site   push   1 same-origin ref,   9 CDN
 *
 * A source assertion in one repo covers half the publishes. The watchdog asks
 * the served bytes, which covers all of them — but only if it looks at the
 * archive, which until now it explicitly did not ("the /tutti/ archives have
 * their own publisher-side validation in nanako's fast-publish workflow").
 *
 * ─── What is asserted here ───────────────────────────────────────────────
 * The behavioural half — that the pattern flags a real broken page and clears
 * a real healthy one — runs against fixtures copied from production, because a
 * pattern that matched nothing would let the probe report "all healthy" for
 * ever. The structural half pins the archive slug table against the engine's
 * own, since the probe restates it (it runs under bare `node`, no `npm ci`).
 */

import fs from 'node:fs';
import np from 'node:path';

import { describe, it, expect } from 'vitest';

import {
  ARCHIVE_ALL_SLUG,
  SAME_ORIGIN_ASSET_RX,
  countSameOriginAssetRefs,
} from '../scripts/lib/article-archive-assets.mjs';

const ROOT = np.resolve(__dirname, '..');
const PROBE_SRC = fs.readFileSync(
  np.join(ROOT, 'scripts', 'check-article-hub-landings.mjs'),
  'utf-8',
);

/**
 * Verbatim from `https://frontaliereticino.ch/articoli-frontaliere/tutti/`
 * while it was broken — the five distinct refs it carried, in the shapes it
 * carried them.
 */
const BROKEN_ARCHIVE_HTML = [
  '<link rel="stylesheet" href="/assets/critical.css">',
  '<link rel="stylesheet" href="/assets/seo-static.css">',
  '<link rel="stylesheet" href="/assets/index.css" media="print">',
  '<script type="module" src="/assets/index-entry.js"></script>',
  '<script src="/assets/adsense-loader.js" defer></script>',
].join('\n');

/**
 * The same page after a correct offload. Both traps a naive pattern falls
 * into are present on purpose:
 *   - the inline print-stylesheet swap, whose CSS selector contains the
 *     literal `href*="/assets/"`;
 *   - a bare `"/assets/"` with nothing after it.
 * Neither is a resource reference; flagging either would make the watchdog
 * page someone on every healthy run, which is how a gate gets disabled.
 */
const HEALTHY_ARCHIVE_HTML = [
  '<link rel="stylesheet" href="https://cdn.frontaliereticino.ch/assets/critical.css">',
  '<script type="module" src="https://cdn.frontaliereticino.ch/assets/index-entry.js"></script>',
  '<script>setTimeout(function(){var ls=document.querySelectorAll(\'link[media="print"][href*="/assets/"]\');'
    + 'for(var i=0;i<ls.length;i++){ls[i].media="all"}},0)</script>',
  '<meta name="x-asset-root" content="/assets/">',
].join('\n');

describe('same-origin /assets/ detection', () => {
  it('flags every dead reference on the archive as production served it', () => {
    expect(countSameOriginAssetRefs(BROKEN_ARCHIVE_HTML)).toBe(5);
  });

  it('clears a correctly offloaded archive, selector and bare path included', () => {
    expect(countSameOriginAssetRefs(HEALTHY_ARCHIVE_HTML)).toBe(0);
  });

  it('is not a global-regex lastIndex trap across calls', () => {
    // SAME_ORIGIN_ASSET_RX is /g. `String.prototype.match` resets lastIndex,
    // but a future refactor to .test()/.exec() would not — and a probe that
    // silently alternates between finding and not finding is worse than one
    // that never finds.
    expect(SAME_ORIGIN_ASSET_RX.flags).toContain('g');
    expect(countSameOriginAssetRefs(BROKEN_ARCHIVE_HTML)).toBe(5);
    expect(countSameOriginAssetRefs(BROKEN_ARCHIVE_HTML)).toBe(5);
  });
});

describe('the watchdog probe covers the archives', () => {
  it('requests the /tutti/ archive for every route it checks', () => {
    expect(PROBE_SRC).toMatch(/ARCHIVE_ALL_SLUG\[route\.locale\]/);
    // The landing fetch and the archive fetch must BOTH be asserted on, or a
    // reordering that drops one leaves the probe reporting on half the pages.
    expect(PROBE_SRC).toMatch(/countSameOriginAssetRefs\(html\)/);
    expect(PROBE_SRC).toMatch(/countSameOriginAssetRefs\(archiveHtml\)/);
  });

  it('keeps the archive slug table in step with the engine', () => {
    // The engine is the authority; the probe restates the table because it
    // runs under bare `node` with no TypeScript loader available.
    const engine = fs.readFileSync(
      np.join(ROOT, 'packages', 'articles', 'engine', 'articleHubPagesPlugin.ts'),
      'utf-8',
    );
    const block = engine.slice(
      engine.indexOf('const ARCHIVE_ALL_SLUG'),
      engine.indexOf('const ARCHIVE_ALL_SLUG') + 200,
    );
    expect(block, 'ARCHIVE_ALL_SLUG not found in articleHubPagesPlugin.ts').toContain('it:');

    for (const [loc, slug] of Object.entries(ARCHIVE_ALL_SLUG)) {
      expect(
        block,
        `the probe expects /${slug}/ for ${loc}; the engine no longer emits it`,
      ).toMatch(new RegExp(`${loc}:\\s*'${slug}'`));
    }
  });
});
