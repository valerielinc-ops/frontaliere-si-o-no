/**
 * No sitemap may list a URL the edge answers 301 or 410.
 *
 * THE DEFECT THIS GUARDS (issue #7670)
 * ────────────────────────────────────
 * `EDGE_RETIRED_PATHS` (81 keys) and `public/sitemap-*.xml` were joined by
 * nothing. A retirement lands in ONE commit — a bridge in
 * `build-plugins/legacyRedirectsPlugin.ts` plus the edge table — and the Worker
 * starts answering 301/410 the moment that commit deploys. The only thing that
 * ever removed the URL from the sitemap was the next run of
 * `sync-articles-sitemaps.yml`, on `cron: '23 5,17 * * *'`. Between the two:
 * up to ~12h in which the site's own index tells Google to crawl pages the site
 * refuses to serve.
 *
 * Measured on 2026-09-06 the intersection was 0 of 81 — the 05:23 sync had
 * already closed the window on the Courmayeur/Tovo retirements by itself. That
 * is exactly why this file exists: the defect is the ABSENCE of the observer,
 * not the occurrence. Green today, and red at the next retirement that forgets
 * to prune, which is the only moment it can pay.
 *
 * WHY IT IS NOT VACUOUS
 * ─────────────────────
 * A test asserting "0 == 0" over an empty table, or over a `public/` that a
 * sparse checkout did not materialise, would be green forever and guard
 * nothing. So the floors below pin both inputs: the retired table must still
 * carry its measured size, and the sitemaps must still be found and still
 * parse to real `<loc>`s. Break either and this file goes red rather than
 * quietly stopping to check.
 *
 * WHEN IT GOES RED
 * ────────────────
 * Run `npm run sitemap:prune-retired` and commit the result — in the SAME
 * commit that declares the retirement. That is the whole point: it moves the
 * de-listing from "up to half a day later, if the cron fires" to "atomically
 * with the 301".
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — plain JS Worker module, no type declarations.
import { EDGE_RETIRED_PATHS } from '../infra/cloudflare-worker/locale-router.js';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — plain .mjs module, no type declarations.
import {
  dropRetiredSitemapUrlBlocks,
  isRetiredLoc,
  retiredLocsIn,
} from '../scripts/lib/sitemap-retired-urls.mjs';

const REPO = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(REPO, 'public');
const APEX = 'https://frontaliereticino.ch';

const RETIRED_TABLE = EDGE_RETIRED_PATHS as Record<string, string | null>;

const sitemapFiles = fs
  .readdirSync(PUBLIC_DIR)
  .filter((f) => f.startsWith('sitemap') && f.endsWith('.xml'))
  .sort();

const documents = sitemapFiles.map((name) => ({
  name,
  xml: fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf-8'),
}));

describe('the gate can actually see both sides of the intersection', () => {
  it('finds the committed sitemaps', () => {
    // 11 on 2026-09-06. A lower bound, not equality: new sub-sitemaps get added
    // and must be covered automatically, but a checkout that materialised none
    // of them must not read as "nothing retired is listed".
    expect(sitemapFiles.length, `no sitemap-*.xml under public/`).toBeGreaterThanOrEqual(11);
  });

  it('reads real <loc>s out of every one of them', () => {
    const empty = documents.filter(({ xml }) => !/<loc>[^<]+<\/loc>/.test(xml));
    expect(empty.map((d) => d.name), 'sitemap with no parseable <loc>').toEqual([]);
  });

  it('has a retired table to intersect against', () => {
    // 81 on 2026-09-06, pinned exactly by tests/edge-retired-paths.test.ts. Here
    // only the floor matters: an empty (or unparsed) table would make every
    // assertion below trivially true.
    expect(Object.keys(RETIRED_TABLE).length).toBeGreaterThanOrEqual(81);
  });

  it('recognises a retired URL in all three forms a <loc> could take', () => {
    const sample = Object.keys(RETIRED_TABLE).find((p) => p.endsWith('/'));
    expect(sample, 'no directory-form key in the retired table').toBeTruthy();
    const dir = sample as string;
    for (const loc of [
      `${APEX}${dir}`,
      `${APEX}${dir.replace(/\/$/, '')}`,
      `${APEX}${dir}index.html`,
      dir,
    ]) {
      expect(isRetiredLoc(loc), `${loc} must be seen as retired`).toBe(true);
    }
    expect(isRetiredLoc(`${APEX}/cerca-lavoro-ticino/`), 'a live URL must not match').toBe(false);
    expect(isRetiredLoc('not a url'), 'garbage must not match').toBe(false);
  });
});

describe('EDGE_RETIRED_PATHS ∩ public/sitemap-*.xml is empty', () => {
  for (const { name, xml } of documents) {
    it(`${name} lists no URL the edge answers 301/410`, () => {
      const listed = retiredLocsIn(xml);
      expect(
        listed,
        `${name} asks Google to crawl ${listed.length} URL(s) that EDGE_RETIRED_PATHS `
          + `already answers 301/410 — every one is a wasted crawl request and a `
          + `redirect-only entry in the site's own index:\n`
          + listed.map((loc) => `  ${loc}`).join('\n')
          + `\n\nFix: run \`npm run sitemap:prune-retired\` and commit the result, in the `
          + `same commit that declares the retirement.`,
      ).toEqual([]);
    });
  }
});

describe('the pruner that keeps it that way', () => {
  it('is a no-op on the committed sitemaps, so the gate above is self-consistent', () => {
    for (const { name, xml } of documents) {
      const { xml: pruned, dropped } = dropRetiredSitemapUrlBlocks(xml);
      expect(dropped, `${name}: pruner disagrees with the gate`).toEqual([]);
      expect(pruned, `${name}: pruner rewrote a clean document`).toBe(xml);
    }
  });

  it('removes the whole <url> block, hreflang alternates included', () => {
    // Leaving the alternates behind would keep advertising the retired
    // article's other locales after its entry point is gone.
    const retired = Object.keys(RETIRED_TABLE).find((p) => p.endsWith('/')) as string;
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      '  <url>',
      `    <loc>${APEX}${retired}</loc>`,
      `    <xhtml:link rel="alternate" hreflang="en" href="${APEX}/en/whatever/" />`,
      '  </url>',
      '  <url>',
      `    <loc>${APEX}/cerca-lavoro-ticino/</loc>`,
      '  </url>',
      '</urlset>',
      '',
    ].join('\n');

    const { xml: pruned, dropped } = dropRetiredSitemapUrlBlocks(xml);
    expect(dropped).toEqual([`${APEX}${retired}`]);
    expect(pruned).not.toContain(retired);
    expect(pruned).not.toContain('hreflang="en"');
    expect(pruned).toContain(`${APEX}/cerca-lavoro-ticino/`);
    // Idempotent: a second pass must not keep eating the document.
    expect(dropRetiredSitemapUrlBlocks(pruned).xml).toBe(pruned);
  });

  it('leaves a sitemap index alone — its <loc>s name files, not pages', () => {
    const idx = fs.readFileSync(path.join(PUBLIC_DIR, 'sitemap.xml'), 'utf-8');
    expect(retiredLocsIn(idx)).toEqual([]);
    expect(dropRetiredSitemapUrlBlocks(idx).xml).toBe(idx);
  });
});
