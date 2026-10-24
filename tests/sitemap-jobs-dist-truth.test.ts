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
  createForeignDirectoryIndex,
  reconcileSitemapJobsWithDist,
  extractSitemapLocs,
} from '../build-plugins/relatedSearchClustersPlugin';
import { reconcileFinalSitemapsWithDist } from '../build-plugins/sitemapAliasPlugin';
import { scanMarkupStartTags } from '../scripts/lib/html-attr.mjs';

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
const FOREIGN_PDF = `${BASE}/de/jobs-im-aargau/document.pdf`;

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

async function legacyForeignDirectoryInventory(root: string): Promise<number> {
  const regularFiles = new Set<string>();
  const entries = await fs.promises.readdir(root, { recursive: true, withFileTypes: true });

  for (const entry of entries) {
    const parentPath = 'parentPath' in entry
      ? String(entry.parentPath)
      : String((entry as fs.Dirent & { path: string }).path);
    const filePath = path.resolve(parentPath, entry.name);
    if (entry.isFile()) regularFiles.add(filePath);
  }

  return regularFiles.size;
}

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

describe('scanMarkupStartTags', () => {
  it('keeps live metadata after a script string containing an unterminated comment marker', () => {
    const html = `<script>const marker = '<!--';</script><meta name=robots content=noindex>`;

    expect(scanMarkupStartTags(html, 'meta')).toHaveLength(1);
  });
});

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

  it('keeps the final cross-canton detail and drops T5/T6 noindex or redirect aliases', async () => {
    const canonical = `${BASE}/cerca-lavoro-zurigo/offerta-canonica/`;
    const noindexAlias = `${BASE}/cerca-lavoro-ticino/offerta-canonica/`;
    const redirectAlias = `${BASE}/cerca-lavoro-ticino/offerta-redirect/`;
    fs.writeFileSync(
      path.join(dist, 'sitemap-jobs.xml'),
      wrap([canonical, noindexAlias, redirectAlias]),
      'utf-8',
    );
    writePage(canonical, selfCanonical(canonical));
    writePage(noindexAlias, noindexBridge(canonical));
    writePage(redirectAlias, metaRefreshBridge(canonical));

    await reconcileSitemapJobsWithDist(dist, []);

    const out = readSitemap();
    expect(out).toContain(canonical);
    expect(out).not.toContain(noindexAlias);
    expect(out).not.toContain(redirectAlias);
    expect(fs.existsSync(pageFile(noindexAlias))).toBe(true);
    expect(fs.existsSync(pageFile(redirectAlias))).toBe(true);
  });

  it('drops a sitemap URL whose final HTML has no canonical tag', async () => {
    fs.writeFileSync(path.join(dist, 'sitemap-jobs.xml'), wrap([MISSING_CANONICAL]), 'utf-8');
    writePage(MISSING_CANONICAL, missingCanonical());
    await reconcileSitemapJobsWithDist(dist, []);
    expect(readSitemap()).not.toContain('missing-canonical');
  });

  it('keeps an explicitly classified canonical bridge', async () => {
    const bridge = `${BASE}/cerca-lavoro-ticino/previous-job-slug/`;
    fs.writeFileSync(path.join(dist, 'sitemap-jobs.xml'), wrap([bridge]), 'utf-8');
    writePage(
      bridge,
      `<html><head><link rel="canonical" href="${HEALTHY}"></head>` +
        '<body>__BRIDGE_TARGET_SLUG__</body></html>',
    );

    await reconcileSitemapJobsWithDist(dist, []);

    expect(readSitemap()).toContain(bridge);
  });

  it('parses quote-free canonical attributes before applying the self-canonical check', async () => {
    fs.writeFileSync(path.join(dist, 'sitemap-jobs.xml'), wrap([UNQUOTED_CANONICAL]), 'utf-8');
    writePage(UNQUOTED_CANONICAL, unquotedCanonical(`${BASE}/cerca-lavoro-svizzera/`));
    await reconcileSitemapJobsWithDist(dist, []);
    expect(readSitemap()).not.toContain('unquoted-canonical');
  });

  it('does not treat comment or script text as live noindex metadata', async () => {
    fs.writeFileSync(path.join(dist, 'sitemap-jobs.xml'), wrap([HEALTHY]), 'utf-8');
    writePage(
      HEALTHY,
      '<!doctype html><html><head>' +
        '<!-- <meta name=robots content=noindex> -->' +
        '<script>const fake = "<meta name=robots content=noindex>";</script>' +
        `<link href="${HEALTHY}" rel="canonical"></head><body>ok</body></html>`,
    );

    await reconcileSitemapJobsWithDist(dist, []);

    expect(readSitemap()).toContain(HEALTHY);
  });

  it('still drops a known cross-section mirror passed in explicitly (#911)', async () => {
    await reconcileSitemapJobsWithDist(dist, [KNOWN_MIRROR]);
    expect(readSitemap()).not.toContain('ricerca-projektleiter-m-w-d');
  });

  it('leaves the full dist-truth decision to the final pass when doing the early mirror patch', async () => {
    fs.writeFileSync(path.join(dist, 'sitemap-jobs.xml'), wrap([MISSING, KNOWN_MIRROR, HEALTHY]), 'utf-8');
    writePage(KNOWN_MIRROR, selfCanonical(KNOWN_MIRROR));

    await reconcileSitemapJobsWithDist(dist, [KNOWN_MIRROR], { checkDistTruth: false });

    expect(readSitemap()).not.toContain('ricerca-projektleiter-m-w-d');
    expect(readSitemap()).toContain('ricerca-groupe-mutuel-emploi');

    await reconcileFinalSitemapsWithDist(dist, []);

    expect(readSitemap()).not.toContain('ricerca-groupe-mutuel-emploi');
    expect(readSitemap()).toContain('sviluppatore-acme-lugano');
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

  it('removes shard copies of sitemap-jobs.xml entries on a cache-hit path, keeping the legacy file and the allowlist intact', async () => {
    // Reproduces the cache-hit reconciliation with a shard restored from a
    // pre-dedupe artifact: the IT detail is listed BOTH in sitemap-jobs.xml and
    // in the canton shard (22,384 such URLs live on 2026-10-24). The shard copy
    // goes; the legacy entry and the locale variant it annotates stay.
    const itDetail = `${BASE}/cerca-lavoro-zurigo/cache-hit-detail/`;
    const deDetail = `${BASE}/de/jobs-in-zurich/cache-hit-detail/`;
    const cantonRoot = `${BASE}/cerca-lavoro-zurigo/`;
    const legacyPath = path.join(dist, 'sitemap-jobs.xml');
    const shardPath = path.join(dist, 'sitemap-jobs-zurigo.xml');
    fs.writeFileSync(
      legacyPath,
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n` +
        `  <url><loc>${itDetail}</loc><xhtml:link rel="alternate" hreflang="de" href="${deDetail}" /><lastmod>2026-10-20</lastmod><priority>0.6</priority></url>\n` +
        `</urlset>\n`,
      'utf-8',
    );
    fs.writeFileSync(
      shardPath,
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
        `${jobUrlBlock(itDetail)}\n${jobUrlBlock(deDetail)}\n  <url>\n    <loc>${cantonRoot}</loc>\n    <priority>0.7</priority>\n  </url>\n</urlset>\n`,
      'utf-8',
    );
    for (const loc of [itDetail, deDetail, cantonRoot]) writePage(loc, selfCanonical(loc));

    const previousBuildLocale = process.env.BUILD_LOCALE;
    process.env.BUILD_LOCALE = 'it';
    try {
      vi.resetModules();
      const shard = await import('../build-plugins/relatedSearchClustersPlugin');
      const signals = await import('../build-plugins/shared/buildSignals');
      signals.setActiveJobSitemapLocs(null); // cache hit: producer skipped
      await shard.reconcileSitemapJobsWithDist(dist, []);
      expect(shard.extractSitemapLocs(fs.readFileSync(legacyPath, 'utf-8'))).toEqual([itDetail]);
      expect(fs.readFileSync(legacyPath, 'utf-8')).toContain('<lastmod>2026-10-20</lastmod>');
      expect(shard.extractSitemapLocs(fs.readFileSync(shardPath, 'utf-8'))).toEqual([deDetail, cantonRoot]);
      // The recovered allowlist still knows the job, so the de variant is not
      // mistaken for a stale detail on the next pass either.
      await shard.reconcileSitemapJobsWithDist(dist, []);
      expect(shard.extractSitemapLocs(fs.readFileSync(shardPath, 'utf-8'))).toEqual([deDetail, cantonRoot]);
    } finally {
      if (previousBuildLocale === undefined) delete process.env.BUILD_LOCALE;
      else process.env.BUILD_LOCALE = previousBuildLocale;
      const signals = await import('../build-plugins/shared/buildSignals');
      signals.setActiveJobSitemapLocs(null);
    }
  });

  it('keeps EN/DE/FR variants that the IT-only link registry does not know (BUILD_LOCALE=it)', async () => {
    const itDetail = `${BASE}/cerca-lavoro-zurigo/variant-detail/`;
    const deDetail = `${BASE}/de/jobs-in-zurich/variant-detail/`;
    const shardPath = path.join(dist, 'sitemap-jobs-zurigo-de.xml');
    fs.writeFileSync(shardPath, wrapJobUrls([deDetail]), 'utf-8');

    const previousBuildLocale = process.env.BUILD_LOCALE;
    process.env.BUILD_LOCALE = 'it';
    try {
      vi.resetModules();
      const shard = await import('../build-plugins/relatedSearchClustersPlugin');
      const signals = await import('../build-plugins/shared/buildSignals');
      // What jobsSeoPagesPlugin publishes on the IT leg since #14380: links
      // limited to IT, sitemap allowlist for every locale.
      signals.setActiveJobSitemapLocs(new Set([itDetail]));
      signals.setJobSitemapAllowlist(new Set([itDetail, deDetail]));
      await shard.reconcileSitemapJobsWithDist(dist, []);
      expect(shard.extractSitemapLocs(fs.readFileSync(shardPath, 'utf-8'))).toEqual([deDetail]);
    } finally {
      if (previousBuildLocale === undefined) delete process.env.BUILD_LOCALE;
      else process.env.BUILD_LOCALE = previousBuildLocale;
      const signals = await import('../build-plugins/shared/buildSignals');
      signals.setActiveJobSitemapLocs(null);
      signals.setJobSitemapAllowlist(null);
    }
  });

  it('removes a shard that only repeated sitemap-jobs.xml entries', async () => {
    const shardPath = path.join(dist, 'sitemap-jobs-ticino.xml');
    fs.writeFileSync(shardPath, wrapJobUrls([HEALTHY]), 'utf-8');
    await reconcileSitemapJobsWithDist(dist, []);
    expect(fs.existsSync(shardPath)).toBe(false);
    expect(readSitemap()).toContain(HEALTHY);
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

  it('uses sitemap-scoped candidates instead of walking the whole shard dist', async () => {
    const foreign = `${BASE}/de/jobs-im-aargau/final-alias-bridge/`;
    fs.writeFileSync(path.join(dist, 'sitemap-pages.xml'), wrap([foreign]), 'utf8');
    writePage(foreign, noindexBridge(`${BASE}/de/jobs-im-aargau/`));
    const unrelated = path.join(dist, 'unrelated', 'nested', 'asset.html');
    fs.mkdirSync(path.dirname(unrelated), { recursive: true });
    fs.writeFileSync(unrelated, '<html>not a sitemap candidate</html>', 'utf8');

    const previousBuildLocale = process.env.BUILD_LOCALE;
    const opendirSpy = vi.spyOn(fs.promises, 'opendir');
    const lstatSpy = vi.spyOn(fs.promises, 'lstat');
    const statSpy = vi.spyOn(fs.promises, 'stat');
    process.env.BUILD_LOCALE = 'it';
    try {
      vi.resetModules();
      const { reconcileFinalSitemapsWithDist: reconcileFinal } =
        await import('../build-plugins/sitemapAliasPlugin');
      await reconcileFinal(dist, []);

      expect(opendirSpy).not.toHaveBeenCalled();
      const routePath = path.join(dist, 'de/jobs-im-aargau/final-alias-bridge');
      const expectedProbePaths = new Set([
        routePath,
        path.join(routePath, 'index.html'),
        `${routePath}.html`,
      ].map((filePath) => path.resolve(filePath)));
      expect(new Set(lstatSpy.mock.calls.map(([filePath]) => path.resolve(String(filePath)))))
        .toEqual(expectedProbePaths);
      expect(fs.existsSync(path.join(dist, 'sitemap-pages.xml'))).toBe(false);
    } finally {
      lstatSpy.mockRestore();
      opendirSpy.mockRestore();
      if (previousBuildLocale === undefined) delete process.env.BUILD_LOCALE;
      else process.env.BUILD_LOCALE = previousBuildLocale;
      vi.resetModules();
    }
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

  it('classifies a foreign regular file through its flat HTML sibling', async () => {
    fs.writeFileSync(path.join(dist, 'sitemap-jobs-argovia.xml'), wrap([FOREIGN_PDF]), 'utf-8');
    const pdfPath = path.join(dist, new URL(FOREIGN_PDF).pathname.replace(/^\/+/, ''));
    fs.mkdirSync(path.dirname(pdfPath), { recursive: true });
    fs.writeFileSync(pdfPath, '%PDF-1.7', 'utf8');
    fs.writeFileSync(`${pdfPath}.html`, noindexBridge(`${BASE}/de/jobs-im-aargau/`), 'utf8');

    vi.resetModules();
    const previousBuildLocale = process.env.BUILD_LOCALE;
    process.env.BUILD_LOCALE = 'it';
    try {
      const shard = await import('../build-plugins/relatedSearchClustersPlugin');
      await shard.reconcileSitemapJobsWithDist(dist, []);
      expect(fs.existsSync(path.join(dist, 'sitemap-jobs-argovia.xml'))).toBe(false);
    } finally {
      if (previousBuildLocale === undefined) delete process.env.BUILD_LOCALE;
      else process.env.BUILD_LOCALE = previousBuildLocale;
    }
  });

  it('uses a candidate-scoped inventory for foreign-locale probes', async () => {
    fs.writeFileSync(path.join(dist, 'sitemap-jobs.xml'), wrap([EN, DE, FR]), 'utf-8');

    const previousBuildLocale = process.env.BUILD_LOCALE;
    const opendirSpy = vi.spyOn(fs.promises, 'opendir');
    const lstatSpy = vi.spyOn(fs.promises, 'lstat');
    const statSpy = vi.spyOn(fs.promises, 'stat');
    process.env.BUILD_LOCALE = 'it';
    try {
      vi.resetModules();
      const shard = await import('../build-plugins/relatedSearchClustersPlugin');
      await shard.reconcileSitemapJobsWithDist(dist, []);

      const inventoryRootCalls = opendirSpy.mock.calls.filter(([directory]) =>
        path.resolve(String(directory)) === path.resolve(dist),
      );
      expect(inventoryRootCalls).toHaveLength(0);

      const expectedProbePaths = new Set(
        [EN, DE, FR].flatMap((loc) => {
          const routePath = path.join(dist, new URL(loc).pathname.replace(/\/+$/, ''));
          return [routePath, `${routePath}.html`];
        }).map((filePath) => path.resolve(filePath)),
      );
      const actualProbePaths = new Set(
        lstatSpy.mock.calls.map(([filePath]) => path.resolve(String(filePath))),
      );
      expect(actualProbePaths).toEqual(expectedProbePaths);
      expect(statSpy).not.toHaveBeenCalled();
      expect(shard.extractSitemapLocs(readSitemap())).toEqual([EN, DE, FR]);
    } finally {
      statSpy.mockRestore();
      lstatSpy.mockRestore();
      opendirSpy.mockRestore();
      if (previousBuildLocale === undefined) delete process.env.BUILD_LOCALE;
      else process.env.BUILD_LOCALE = previousBuildLocale;
    }
  });

  it('keeps entries discovered before a nested directory disappears', async () => {
    const raceRoot = path.join(dist, 'race-dist');
    const vanished = path.join(raceRoot, 'vanished');
    fs.mkdirSync(vanished, { recursive: true });
    const stable = path.join(raceRoot, 'stable.html');
    fs.writeFileSync(stable, '<html></html>', 'utf8');

    const realOpendir = fs.promises.opendir;
    const opendirSpy = vi.spyOn(fs.promises, 'opendir').mockImplementation((directory, options) => {
      if (path.resolve(String(directory)) === path.resolve(vanished)) {
        const error = Object.assign(new Error('directory disappeared'), { code: 'ENOENT' });
        return Promise.reject(error);
      }
      return realOpendir.call(fs.promises, directory, options);
    });
    try {
      const index = createForeignDirectoryIndex(raceRoot);
      expect(await index.hasFile(stable)).toBe(true);
      expect(await index.hasFile(path.join(vanished, 'gone.html'))).toBe(false);
    } finally {
      opendirSpy.mockRestore();
    }
  });

  it('retains only requested HTML and symlink candidates in the inventory', async () => {
    const candidateRoot = path.join(dist, 'candidate-dist');
    const retained = path.join(candidateRoot, 'retained.html');
    const ignored = path.join(candidateRoot, 'ignored.html');
    fs.mkdirSync(candidateRoot, { recursive: true });
    fs.writeFileSync(retained, '<html></html>', 'utf8');
    fs.writeFileSync(ignored, '<html></html>', 'utf8');

    const index = createForeignDirectoryIndex(candidateRoot, new Set([retained]));
    expect(await index.hasFile(retained)).toBe(true);
    expect(await index.hasFile(ignored)).toBe(false);
  });

  it('benchmarks streaming inventory against the pre-change recursive walk', async () => {
    const benchmarkRoot = path.join(dist, 'benchmark-dist');
    const directoryCount = 128;
    const filesPerDirectory = 32;

    for (let directoryIndex = 0; directoryIndex < directoryCount; directoryIndex += 1) {
      const directory = path.join(benchmarkRoot, `locale-${directoryIndex}`);
      fs.mkdirSync(directory, { recursive: true });
      for (let fileIndex = 0; fileIndex < filesPerDirectory; fileIndex += 1) {
        fs.writeFileSync(path.join(directory, `page-${fileIndex}.html`), '<html></html>', 'utf8');
      }
    }

    const measure = async (run: () => Promise<number>): Promise<{ files: number; ms: number; maxRssKb: number }> => {
      const startedAt = process.hrtime.bigint();
      const files = await run();
      const ms = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      return { files, ms, maxRssKb: process.resourceUsage().maxRSS };
    };

    const baseline = await measure(() => legacyForeignDirectoryInventory(benchmarkRoot));
    const streaming = await measure(async () => {
      const candidatePaths = new Set<string>();
      for (let directoryIndex = 0; directoryIndex < directoryCount; directoryIndex += 1) {
        for (let fileIndex = 0; fileIndex < filesPerDirectory; fileIndex += 1) {
          candidatePaths.add(path.join(benchmarkRoot, `locale-${directoryIndex}`, `page-${fileIndex}`));
        }
      }
      const index = createForeignDirectoryIndex(benchmarkRoot, candidatePaths);
      const firstFile = path.join(benchmarkRoot, 'locale-0', 'page-0.html');
      expect(await index.hasFile(firstFile)).toBe(true);
      expect(await index.hasRegularFile(firstFile)).toBe(true);
      const knownFiles = [
        path.join(benchmarkRoot, 'locale-0', 'page-0.html'),
        path.join(benchmarkRoot, `locale-${directoryCount - 1}`, `page-${filesPerDirectory - 1}.html`),
      ];
      for (const filePath of knownFiles) expect(await index.hasRegularFile(filePath)).toBe(true);
      expect(await index.hasRegularFile(path.join(benchmarkRoot, 'missing.html'))).toBe(false);
      return directoryCount * filesPerDirectory;
    });

    expect(streaming.files).toEqual(baseline.files);
    console.info(
      `[foreign-directory-benchmark] files=${baseline.files} ` +
      `baseline_ms=${baseline.ms.toFixed(2)} streaming_ms=${streaming.ms.toFixed(2)} ` +
      `baseline_max_rss_kb=${baseline.maxRssKb} streaming_max_rss_kb=${streaming.maxRssKb}`,
    );
  });
});
