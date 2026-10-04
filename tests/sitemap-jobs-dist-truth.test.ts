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
 * — critically — that healthy job URLs are never touched. The reconciler edits
 * sitemap XML only: it must never delete the historical HTML that remains the
 * source of SEO traffic even when that page is noindex or non-canonical.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  reconcileSitemapJobsWithDist,
  extractSitemapLocs,
} from '../build-plugins/relatedSearchClustersPlugin';
import { reconcileFinalSitemapsWithDist } from '../build-plugins/sitemapAliasPlugin';

const BASE = 'https://frontaliereticino.ch';

const HEALTHY = `${BASE}/cerca-lavoro-ticino/sviluppatore-acme-lugano/`;
const HEALTHY_2 = `${BASE}/cerca-lavoro-zurigo/infermiere-beta-zurigo/`;
// Reproduced verbatim from run 30376520728.
const MISSING = `${BASE}/cerca-lavoro-ticino/ricerca-groupe-mutuel-emploi/`;
const NOINDEX = `${BASE}/cerca-lavoro-ticino/ricerca-pittore-imbianchino-ticino/`;
const FOREIGN_CANONICAL = `${BASE}/cerca-lavoro-ticino/ricerca-allianz-job/`;
const KNOWN_MIRROR = `${BASE}/cerca-lavoro-ticino/ricerca-projektleiter-m-w-d/`;
const SHARD_NOINDEX = `${BASE}/de/jobs-im-aargau/bridge-noindex/`;
const SHARD_HEALTHY = `${BASE}/de/jobs-im-aargau/bridge-healthy/`;
const META_REFRESH = `${BASE}/de/jobs-im-tessin/legacy-refresh/`;
const MISSING_CANONICAL = `${BASE}/de/jobs-im-tessin/missing-canonical/`;
const UNQUOTED_CANONICAL = `${BASE}/de/jobs-im-tessin/unquoted-canonical/`;

const selfCanonical = (loc: string) =>
  `<!doctype html><html><head><link rel="canonical" href="${loc}"></head><body>ok</body></html>`;
const noindexBridge = (canonical: string) =>
  `<!doctype html><html><head><meta name="robots" content="noindex,follow">` +
  `<link rel="canonical" href="${canonical}"></head><body>bridge</body></html>`;
const metaRefreshBridge = (canonical: string) =>
  `<!doctype html><html><head><meta http-equiv="refresh" content="0;url=${canonical}">` +
  `<link rel="canonical" href="${canonical}"></head><body>bridge</body></html>`;
const unquotedCanonical = (canonical: string) =>
  `<!doctype html><html><head><link href=${canonical} rel=canonical></head><body>bridge</body></html>`;
const missingCanonical = () =>
  '<!doctype html><html><head><meta name="description" content="page"></head><body>bridge</body></html>';

const urlBlock = (loc: string) =>
  `  <url>\n    <loc>${loc}</loc>\n    <lastmod>2026-07-28</lastmod>\n  </url>`;
const jobUrlBlock = (loc: string) =>
  `  <url>\n    <loc>${loc}</loc>\n    <priority>0.6</priority>\n  </url>`;
const wrap = (locs: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${locs
    .map(urlBlock)
    .join('\n')}\n</urlset>\n`;
const wrapJobUrls = (locs: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${locs
    .map(jobUrlBlock)
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

function pageFile(loc: string): string {
  const rel = new URL(loc).pathname.replace(/^\/+|\/+$/g, '');
  return path.join(dist, rel, 'index.html');
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
    expect(fs.existsSync(pageFile(NOINDEX))).toBe(true);
  });

  it('drops a <loc> whose canonical points at another page', async () => {
    await reconcileSitemapJobsWithDist(dist, []);
    expect(readSitemap()).not.toContain('ricerca-allianz-job');
  });

  it('drops a meta-refresh redirect even when its canonical is temporarily self-canonical', async () => {
    fs.writeFileSync(path.join(dist, 'sitemap-jobs.xml'), wrap([META_REFRESH]), 'utf-8');
    writePage(META_REFRESH, metaRefreshBridge(META_REFRESH));
    await reconcileSitemapJobsWithDist(dist, []);
    expect(readSitemap()).not.toContain('legacy-refresh');
    expect(fs.existsSync(pageFile(META_REFRESH))).toBe(true);
  });

  it('drops a sitemap URL whose final HTML has no canonical tag', async () => {
    fs.writeFileSync(path.join(dist, 'sitemap-jobs.xml'), wrap([MISSING_CANONICAL]), 'utf-8');
    writePage(MISSING_CANONICAL, missingCanonical());
    await reconcileSitemapJobsWithDist(dist, []);
    expect(readSitemap()).not.toContain('missing-canonical');
  });

  it('parses quote-free canonical attributes before applying the self-canonical check', async () => {
    fs.writeFileSync(path.join(dist, 'sitemap-jobs.xml'), wrap([UNQUOTED_CANONICAL]), 'utf-8');
    writePage(UNQUOTED_CANONICAL, unquotedCanonical(`${BASE}/cerca-lavoro-svizzera/`));
    await reconcileSitemapJobsWithDist(dist, []);
    expect(readSitemap()).not.toContain('unquoted-canonical');
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

  it('keeps a priority-0.6 shard URL when the exact source sitemap is absent', async () => {
    const current = `${BASE}/cerca-lavoro-ticino/shard-only-detail/`;
    const shardPath = path.join(dist, 'sitemap-jobs-ti.xml');
    fs.rmSync(path.join(dist, 'sitemap-jobs.xml'));
    fs.writeFileSync(shardPath, wrapJobUrls([current]), 'utf-8');
    writePage(current, selfCanonical(current));

    await reconcileSitemapJobsWithDist(dist, []);

    expect(fs.existsSync(shardPath)).toBe(true);
    expect(extractSitemapLocs(fs.readFileSync(shardPath, 'utf-8'))).toEqual([current]);
  });

  it('removes exactly the offending run-30376520728 cohort and nothing else', async () => {
    await reconcileSitemapJobsWithDist(dist, []);
    expect(extractSitemapLocs(readSitemap())).toEqual([HEALTHY, HEALTHY_2, KNOWN_MIRROR]);
  });

  it('also reconciles canton shards and drops a present foreign-locale bridge', async () => {
    const shardPath = path.join(dist, 'sitemap-jobs-argovia.xml');
    fs.writeFileSync(shardPath, wrap([SHARD_NOINDEX, SHARD_HEALTHY]), 'utf-8');
    writePage(SHARD_NOINDEX, noindexBridge(`${BASE}/de/jobs-im-aargau/`));
    writePage(SHARD_HEALTHY, selfCanonical(SHARD_HEALTHY));

    await reconcileSitemapJobsWithDist(dist, []);

    const shardXml = fs.readFileSync(shardPath, 'utf-8');
    expect(shardXml).not.toContain('bridge-noindex');
    expect(shardXml).toContain('bridge-healthy');
  });

  it('removes a shard file after its last URL is filtered out', async () => {
    const shardPath = path.join(dist, 'sitemap-jobs-stale.xml');
    fs.writeFileSync(shardPath, wrap([MISSING]), 'utf-8');
    await reconcileSitemapJobsWithDist(dist, []);
    expect(fs.existsSync(shardPath)).toBe(false);
  });

  it('drops source-stale detail URLs from a shard even when foreign HTML is absent', async () => {
    const stale = `${BASE}/de/jobs-im-tessin/old-legacy-detail/`;
    const current = `${BASE}/de/jobs-im-tessin/current-detail/`;
    const shardPath = path.join(dist, 'sitemap-jobs-ticino.xml');
    fs.writeFileSync(shardPath, wrapJobUrls([stale, current]), 'utf-8');

    const previousBuildLocale = process.env.BUILD_LOCALE;
    process.env.BUILD_LOCALE = 'it';
    try {
      vi.resetModules();
      const shard = await import('../build-plugins/relatedSearchClustersPlugin');
      const out = await import('../build-plugins/shared/buildSignals');
      out.setActiveJobSitemapLocs(new Set([current]));
      await shard.reconcileSitemapJobsWithDist(dist, []);
      expect(shard.extractSitemapLocs(fs.readFileSync(shardPath, 'utf-8'))).toEqual([current]);
    } finally {
      if (previousBuildLocale === undefined) delete process.env.BUILD_LOCALE;
      else process.env.BUILD_LOCALE = previousBuildLocale;
      const out = await import('../build-plugins/shared/buildSignals');
      out.setActiveJobSitemapLocs(null);
    }
  });

  it('rebuilds the active allowlist on a cache-hit path before dropping stale foreign details', async () => {
    const stale = `${BASE}/de/jobs-im-tessin/old-cache-detail/`;
    const current = `${BASE}/de/jobs-im-tessin/current-cache-detail/`;
    const currentIt = `${BASE}/cerca-lavoro-ticino/current-cache-detail/`;
    const shardPath = path.join(dist, 'sitemap-jobs-ticino.xml');
    fs.writeFileSync(shardPath, wrapJobUrls([stale, current]), 'utf-8');
    fs.writeFileSync(
      path.join(dist, 'sitemap-jobs.xml'),
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n` +
        `  <url><loc>${currentIt}</loc><xhtml:link rel="alternate" hreflang="de" href="${current}" /><priority>0.6</priority></url>\n` +
        `</urlset>\n`,
      'utf-8',
    );

    const previousBuildLocale = process.env.BUILD_LOCALE;
    process.env.BUILD_LOCALE = 'it';
    try {
      vi.resetModules();
      const shard = await import('../build-plugins/relatedSearchClustersPlugin');
      const signals = await import('../build-plugins/shared/buildSignals');
      signals.setActiveJobSitemapLocs(null);
      await shard.reconcileSitemapJobsWithDist(dist, []);
      expect(shard.extractSitemapLocs(fs.readFileSync(shardPath, 'utf-8'))).toEqual([current]);
    } finally {
      if (previousBuildLocale === undefined) delete process.env.BUILD_LOCALE;
      else process.env.BUILD_LOCALE = previousBuildLocale;
      const signals = await import('../build-plugins/shared/buildSignals');
      signals.setActiveJobSitemapLocs(null);
    }
  });

  it('runs the final dist-truth gate for both dynamic sitemap families', async () => {
    const cluster = `${BASE}/fr/trouver-emploi-suisse/recherche-stale/`;
    const clusterPath = path.join(dist, 'sitemap-search-clusters-001.xml');
    fs.writeFileSync(clusterPath, wrap([cluster]), 'utf-8');
    writePage(cluster, noindexBridge(cluster));

    await reconcileFinalSitemapsWithDist(dist, [KNOWN_MIRROR]);

    expect(readSitemap()).not.toContain('ricerca-groupe-mutuel-emploi');
    expect(readSitemap()).not.toContain('ricerca-projektleiter-m-w-d');
    expect(fs.readFileSync(clusterPath, 'utf-8')).not.toContain('recherche-stale');
    expect(readSitemap()).toContain('sviluppatore-acme-lugano');
    expect(fs.existsSync(pageFile(NOINDEX))).toBe(true);
    expect(fs.existsSync(pageFile(cluster))).toBe(true);
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

  it('checks a foreign-locale file when the job shard has one on disk', async () => {
    fs.writeFileSync(
      path.join(dist, 'sitemap-jobs-argovia.xml'),
      wrap([SHARD_NOINDEX, SHARD_HEALTHY]),
      'utf-8',
    );
    writePage(SHARD_NOINDEX, noindexBridge(`${BASE}/de/jobs-im-aargau/`));
    writePage(SHARD_HEALTHY, selfCanonical(SHARD_HEALTHY));

    vi.resetModules();
    const prev = process.env.BUILD_LOCALE;
    process.env.BUILD_LOCALE = 'it';
    try {
      const shard = await import('../build-plugins/relatedSearchClustersPlugin');
      await shard.reconcileSitemapJobsWithDist(dist, []);
      const out = fs.readFileSync(path.join(dist, 'sitemap-jobs-argovia.xml'), 'utf-8');
      expect(out).not.toContain('bridge-noindex');
      expect(out).toContain('bridge-healthy');
    } finally {
      if (prev === undefined) delete process.env.BUILD_LOCALE;
      else process.env.BUILD_LOCALE = prev;
    }
  });
});
