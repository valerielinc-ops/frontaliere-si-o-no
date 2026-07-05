/**
 * Regression test for the sibling class of defect found alongside issue
 * #3499 (build-plugins/seoHubsPlugin.ts): six other build plugins pushed a
 * sitemap `<url>` entry ONLY for the `it` locale even though EN/DE/FR HTML
 * for the same page is genuinely built and live. That made the EN/DE/FR
 * members of the `xhtml:link` alternate group one-sided (referenced but
 * never listed as their own `<loc>`) — exactly the class of defect
 * `sanitizeSitemapHreflangReciprocity` (build-plugins/sitemapAliasPlugin.ts,
 * issue #3474) strips from dist/.
 *
 * Two of the six (`jobRecencyPagesPlugin`, `jobSectorPagesPlugin`) also
 * computed `x-default` from the current loop iteration's own locale —
 * correct only by coincidence when gated to IT-only. This file also
 * regression-tests that `x-default` stays anchored to the IT alternate for
 * every locale block, across all six plugins.
 *
 * None of these six plugins' dedicated sitemap files carry paginated
 * (page-N, IT-only, self-referencing) entries, so — unlike
 * sitemap-seo-hubs.xml — the whole file is expected to survive the
 * sanitizer completely unchanged.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Plugin } from 'vite';
import { costOfLivingLandingsPlugin } from '../../build-plugins/costOfLivingLandingsPlugin';
import { faqHubPlugin } from '../../build-plugins/faqHubPlugin';
import { jobRecencyPagesPlugin } from '../../build-plugins/jobRecencyPagesPlugin';
import { jobSectorPagesPlugin } from '../../build-plugins/jobSectorPagesPlugin';
import { nursingLandingsPlugin } from '../../build-plugins/nursingLandingsPlugin';
import { professionLandingsPlugin } from '../../build-plugins/professionLandingsPlugin';
import { sanitizeSitemapHreflangReciprocity } from '../../build-plugins/sitemapAliasPlugin';

// Vite's writeBundle happens to have already flushed `dist/index.html` by the
// time these plugins' closeBundle hooks run in a real build. jobRecencyPagesPlugin
// and jobSectorPagesPlugin poll for it (build-plugins/spaBundleResolver.ts) to
// extract the hashed entry filenames, so the isolated temp dist/ needs a stub.
const STUB_INDEX_HTML =
  '<html><head><link rel="stylesheet" href="/assets/index.css"></head>' +
  '<body><script type="module" src="/assets/index-entry.js"></script></body></html>';

const tempRoots: string[] = [];

function makeTempRoot(withStubIndexHtml: boolean): string {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sibling-hub-test-'));
  fs.mkdirSync(path.join(tempRoot, 'dist'));
  fs.mkdirSync(path.join(tempRoot, 'data'));
  if (withStubIndexHtml) {
    fs.writeFileSync(path.join(tempRoot, 'dist', 'index.html'), STUB_INDEX_HTML);
  }
  tempRoots.push(tempRoot);
  return tempRoot;
}

async function runCloseBundle(plugin: Plugin): Promise<void> {
  // None of these four plugins reference Rollup's `this` plugin-context
  // inside closeBundle, so calling the hook directly (no fake context) is
  // safe. The cast is only to route around closeBundle's optional/object-hook
  // typing in Vite's Plugin interface.
  await (plugin as unknown as { closeBundle: () => Promise<void> }).closeBundle();
}

afterEach(() => {
  while (tempRoots.length) {
    const dir = tempRoots.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function parseUrlBlocks(xml: string): string[] {
  return xml.match(/<url>[\s\S]*?<\/url>/g) ?? [];
}

function locOf(block: string): string {
  return /<loc>([^<]+)<\/loc>/.exec(block)?.[1] ?? '';
}

function altHrefOf(block: string, hreflang: string): string | undefined {
  const rx = new RegExp(`<xhtml:link rel="alternate" hreflang="${hreflang}" href="([^"]+)"`);
  return rx.exec(block)?.[1];
}

/**
 * Shared assertions for a sibling sitemap file that (post-fix) contains only
 * fully-reciprocal 4-locale groups and no pagination noise:
 *  - block count is a non-zero multiple of 4 (would-be IT-only regression
 *    breaks this for every one of these plugins' actual group counts)
 *  - the whole file survives sanitizeSitemapHreflangReciprocity unchanged
 *  - every block's x-default alternate matches its group's own `it` alternate
 *    (never the block's own locale when that locale isn't `it`)
 */
function assertFullyReciprocalFourLocaleSitemap(fileName: string, xml: string): void {
  const blocks = parseUrlBlocks(xml);
  expect(blocks.length, fileName).toBeGreaterThan(0);
  expect(blocks.length % 4, `${fileName} block count (${blocks.length}) not a multiple of 4`).toBe(0);

  const out = sanitizeSitemapHreflangReciprocity([{ file: fileName, xml }]);
  const sanitized = out.has(fileName) ? out.get(fileName)! : xml;
  expect(parseUrlBlocks(sanitized).length, fileName).toBe(blocks.length);

  for (const block of blocks) {
    const itAlt = altHrefOf(block, 'it');
    const xDefault = altHrefOf(block, 'x-default');
    expect(itAlt, `${fileName} block missing it alternate: ${locOf(block)}`).toBeTruthy();
    expect(xDefault, `${fileName} x-default anchored to it (${locOf(block)})`).toBe(itAlt);
  }
}

describe('sibling build-plugins — EN/DE/FR sitemap entries reciprocal, x-default anchored to IT', () => {
  it('costOfLivingLandingsPlugin: sitemap-cost-of-living.xml', async () => {
    const tempRoot = makeTempRoot(false);
    await runCloseBundle(costOfLivingLandingsPlugin(tempRoot));
    const xml = fs.readFileSync(path.join(tempRoot, 'dist', 'sitemap-cost-of-living.xml'), 'utf-8');
    assertFullyReciprocalFourLocaleSitemap('sitemap-cost-of-living.xml', xml);
  });

  it('faqHubPlugin: sitemap-faq-hub.xml', async () => {
    const tempRoot = makeTempRoot(false);
    await runCloseBundle(faqHubPlugin(tempRoot));
    const xml = fs.readFileSync(path.join(tempRoot, 'dist', 'sitemap-faq-hub.xml'), 'utf-8');
    assertFullyReciprocalFourLocaleSitemap('sitemap-faq-hub.xml', xml);
  });

  it('jobRecencyPagesPlugin: sitemap-recency.xml (no data/jobs.json — empty-state pages)', async () => {
    const tempRoot = makeTempRoot(true);
    await runCloseBundle(jobRecencyPagesPlugin(tempRoot));
    const xml = fs.readFileSync(path.join(tempRoot, 'dist', 'sitemap-recency.xml'), 'utf-8');
    assertFullyReciprocalFourLocaleSitemap('sitemap-recency.xml', xml);
  });

  it('jobSectorPagesPlugin: sitemap-sector.xml (no data/jobs.json — empty-state pages)', async () => {
    const tempRoot = makeTempRoot(true);
    await runCloseBundle(jobSectorPagesPlugin(tempRoot));
    const xml = fs.readFileSync(path.join(tempRoot, 'dist', 'sitemap-sector.xml'), 'utf-8');
    assertFullyReciprocalFourLocaleSitemap('sitemap-sector.xml', xml);
  });

  it('nursingLandingsPlugin: sitemap-nursing.xml (no data/jobs.json — empty-state pages)', async () => {
    const tempRoot = makeTempRoot(false);
    await runCloseBundle(nursingLandingsPlugin(tempRoot));
    const xml = fs.readFileSync(path.join(tempRoot, 'dist', 'sitemap-nursing.xml'), 'utf-8');
    assertFullyReciprocalFourLocaleSitemap('sitemap-nursing.xml', xml);
  });

  it('professionLandingsPlugin: sitemap-professions.xml (no data/jobs.json — empty-state pages)', async () => {
    const tempRoot = makeTempRoot(false);
    await runCloseBundle(professionLandingsPlugin(tempRoot));
    const xml = fs.readFileSync(path.join(tempRoot, 'dist', 'sitemap-professions.xml'), 'utf-8');
    assertFullyReciprocalFourLocaleSitemap('sitemap-professions.xml', xml);
  });
});
