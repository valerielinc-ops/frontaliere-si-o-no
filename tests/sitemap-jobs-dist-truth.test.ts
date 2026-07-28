/**
 * sitemap-jobs.xml must list only URLs dist/ actually serves as self-canonical,
 * indexable pages.
 *
 * The file is written by jobsSeoPagesPlugin, which advertises keyword/search
 * landings it does not itself emit. relatedSearchClustersPlugin used to patch
 * it by dropping one enumerated set (its own cross-section mirrors, #911),
 * which left every other advertised-vs-emitted divergence in the published
 * sitemap. Post-deploy validate-dist run 30376520728 shipped 7 `<loc>`s with
 * no HTML in dist/ plus 1 pointing at a noindex bridge canonicalised to
 * /cerca-lavoro-svizzera/ — all 8 dead at the edge — and took out
 * validate:sitemap-links, validate:sitemap-pages, audit:sitemap-canonicals and
 * validate:canonical together.
 *
 * `reconcileSitemapJobsWithDist` asserts the invariant against dist/ instead of
 * enumerating the ways it can be violated. These tests pin each drop reason and
 * — critically — that healthy job URLs are never touched.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  reconcileSitemapJobsWithDist,
  extractSitemapLocs,
} from '../build-plugins/relatedSearchClustersPlugin';

const BASE = 'https://frontaliereticino.ch';

const HEALTHY = `${BASE}/cerca-lavoro-ticino/sviluppatore-acme-lugano/`;
const HEALTHY_2 = `${BASE}/cerca-lavoro-zurigo/infermiere-beta-zurigo/`;
// Reproduced verbatim from run 30376520728.
const MISSING = `${BASE}/cerca-lavoro-ticino/ricerca-groupe-mutuel-emploi/`;
const NOINDEX = `${BASE}/cerca-lavoro-ticino/ricerca-pittore-imbianchino-ticino/`;
const FOREIGN_CANONICAL = `${BASE}/cerca-lavoro-ticino/ricerca-allianz-job/`;
const KNOWN_MIRROR = `${BASE}/cerca-lavoro-ticino/ricerca-projektleiter-m-w-d/`;

const selfCanonical = (loc: string) =>
  `<!doctype html><html><head><link rel="canonical" href="${loc}"></head><body>ok</body></html>`;
const noindexBridge = (canonical: string) =>
  `<!doctype html><html><head><meta name="robots" content="noindex,follow">` +
  `<link rel="canonical" href="${canonical}"></head><body>bridge</body></html>`;

const urlBlock = (loc: string) =>
  `  <url>\n    <loc>${loc}</loc>\n    <lastmod>2026-07-28</lastmod>\n  </url>`;
const wrap = (locs: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${locs
    .map(urlBlock)
    .join('\n')}\n</urlset>\n`;

let dist: string;

function writePage(loc: string, html: string): void {
  const rel = new URL(loc).pathname.replace(/^\/+|\/+$/g, '');
  const dir = path.join(dist, rel);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), html, 'utf-8');
}

function readSitemap(): string {
  return fs.readFileSync(path.join(dist, 'sitemap-jobs.xml'), 'utf-8');
}

beforeEach(() => {
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'sitemap-jobs-dist-truth-'));
  // Everything advertised…
  fs.writeFileSync(
    path.join(dist, 'sitemap-jobs.xml'),
    wrap([HEALTHY, MISSING, NOINDEX, FOREIGN_CANONICAL, HEALTHY_2, KNOWN_MIRROR]),
    'utf-8',
  );
  // …but only these actually shipped, and two of them are not indexable.
  writePage(HEALTHY, selfCanonical(HEALTHY));
  writePage(HEALTHY_2, selfCanonical(HEALTHY_2));
  writePage(NOINDEX, noindexBridge(`${BASE}/cerca-lavoro-svizzera/`));
  writePage(FOREIGN_CANONICAL, selfCanonical(`${BASE}/cerca-lavoro-svizzera/`));
  writePage(KNOWN_MIRROR, selfCanonical(KNOWN_MIRROR));
  // MISSING is deliberately never written.
});

afterEach(() => {
  fs.rmSync(dist, { recursive: true, force: true });
});

describe('extractSitemapLocs', () => {
  it('returns every <loc> in document order', () => {
    expect(extractSitemapLocs(wrap([HEALTHY, MISSING]))).toEqual([HEALTHY, MISSING]);
  });

  it('returns an empty list for a sitemap with no urls', () => {
    expect(extractSitemapLocs('<urlset></urlset>')).toEqual([]);
  });
});

describe('reconcileSitemapJobsWithDist — dist truth, not enumeration', () => {
  it('drops a <loc> with no HTML in dist/', async () => {
    await reconcileSitemapJobsWithDist(dist, []);
    expect(readSitemap()).not.toContain('ricerca-groupe-mutuel-emploi');
  });

  it('drops a <loc> whose page is noindex', async () => {
    await reconcileSitemapJobsWithDist(dist, []);
    expect(readSitemap()).not.toContain('ricerca-pittore-imbianchino-ticino');
  });

  it('drops a <loc> whose canonical points at another page', async () => {
    await reconcileSitemapJobsWithDist(dist, []);
    expect(readSitemap()).not.toContain('ricerca-allianz-job');
  });

  it('still drops a known cross-section mirror passed in explicitly (#911)', async () => {
    await reconcileSitemapJobsWithDist(dist, [KNOWN_MIRROR]);
    expect(readSitemap()).not.toContain('ricerca-projektleiter-m-w-d');
  });

  it('never drops a healthy self-canonical job URL', async () => {
    await reconcileSitemapJobsWithDist(dist, []);
    const out = readSitemap();
    expect(out).toContain('sviluppatore-acme-lugano');
    expect(out).toContain('infermiere-beta-zurigo');
    // A mirror not declared this run is self-canonical on disk, so it stays.
    expect(out).toContain('ricerca-projektleiter-m-w-d');
  });

  it('leaves the sitemap byte-identical when every <loc> is served', async () => {
    fs.writeFileSync(path.join(dist, 'sitemap-jobs.xml'), wrap([HEALTHY, HEALTHY_2]), 'utf-8');
    const before = readSitemap();
    await reconcileSitemapJobsWithDist(dist, []);
    expect(readSitemap()).toBe(before);
  });

  it('is a no-op when sitemap-jobs.xml was not emitted this build', async () => {
    fs.rmSync(path.join(dist, 'sitemap-jobs.xml'));
    await expect(reconcileSitemapJobsWithDist(dist, [KNOWN_MIRROR])).resolves.toBeUndefined();
    expect(fs.existsSync(path.join(dist, 'sitemap-jobs.xml'))).toBe(false);
  });

  it('removes exactly the offending run-30376520728 cohort and nothing else', async () => {
    await reconcileSitemapJobsWithDist(dist, []);
    expect(extractSitemapLocs(readSitemap())).toEqual([HEALTHY, HEALTHY_2, KNOWN_MIRROR]);
  });
});

/**
 * The safety property that matters most here: on a BUILD_LOCALE shard, most of
 * sitemap-jobs.xml's URLs belong to locales this shard deliberately does not
 * emit. Their HTML is absent by design and lives on another shard, so a naive
 * "file missing → drop" pass would delete three quarters of the sitemap.
 * dropOverwrittenLocs' cross-shard rule is what prevents that; this pins it
 * through the sitemap-jobs entry point.
 */
describe('reconcileSitemapJobsWithDist on a locale shard', () => {
  const EN = `${BASE}/en/find-jobs-ticino/sviluppatore-acme-lugano/`;
  const DE = `${BASE}/de/jobs-im-tessin/sviluppatore-acme-lugano/`;
  const FR = `${BASE}/fr/trouver-emploi-tessin/sviluppatore-acme-lugano/`;

  it('keeps en/de/fr locs whose HTML lives on another shard', async () => {
    fs.writeFileSync(path.join(dist, 'sitemap-jobs.xml'), wrap([HEALTHY, EN, DE, FR]), 'utf-8');
    // Only the IT page is on disk — exactly what an it-shard build produces.
    vi.resetModules();
    const prev = process.env.BUILD_LOCALE;
    process.env.BUILD_LOCALE = 'it';
    try {
      const shard = await import('../build-plugins/relatedSearchClustersPlugin');
      await shard.reconcileSitemapJobsWithDist(dist, []);
      expect(shard.extractSitemapLocs(readSitemap())).toEqual([HEALTHY, EN, DE, FR]);
    } finally {
      if (prev === undefined) delete process.env.BUILD_LOCALE;
      else process.env.BUILD_LOCALE = prev;
    }
  });
});
