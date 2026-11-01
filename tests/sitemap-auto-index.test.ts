/**
 * sitemap-auto-index — verifies `sitemapAliasPlugin` correctly discovers
 * every `sitemap-*.xml` in `dist/`, deduplicates them, excludes
 * `sitemap.xml`, the legacy `sitemap_news.xml` and the nested
 * `sitemap-index.xml` (#3506), and emits a well-formed sitemap-index XML.
 *
 * Strategy: seed a tmpdir with fixture files, call `discoverSitemapFiles`
 * and `buildSitemapIndexXml` directly (pure functions), and assert on the
 * output. No Vite build, no real dist/ mutation — the plugin wiring itself
 * is covered by the end-to-end `npm run build:ci` in CI.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildSitemapIndexXml,
  discoverSitemapFiles,
  reconcileFinalSitemapsWithDist,
  reconcileRemainingSitemapsWithDist,
  reconcileSitemapFuelWithDist,
  type DiscoveredSitemap,
} from '@/build-plugins/sitemapAliasPlugin';

const BASE_URL = 'https://frontaliereticino.ch';

/** Create a fresh tmpdir that emulates a Vite `dist/` layout. */
function makeTmpDist(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sitemap-auto-index-'));
}

/** Touch a sitemap file with minimal but valid XML content. */
function seedSitemap(distDir: string, filename: string, mtime?: Date): void {
  const filepath = path.join(distDir, filename);
  fs.writeFileSync(
    filepath,
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>\n',
    'utf-8',
  );
  if (mtime) {
    fs.utimesSync(filepath, mtime, mtime);
  }
}

function seedSitemapWithLocs(distDir: string, filename: string, locs: string[]): void {
  const urlEntries = locs
    .map((loc) => `  <url>\n    <loc>${loc}</loc>\n  </url>`)
    .join('\n');
  fs.writeFileSync(
    path.join(distDir, filename),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urlEntries}\n</urlset>\n`,
    'utf-8',
  );
}

function seedHtmlPage(
  distDir: string,
  urlPath: string,
  options: { canonical?: string; noindex?: boolean } = {},
): void {
  const pageDir = path.join(distDir, urlPath.replace(/^\/+/, ''));
  fs.mkdirSync(pageDir, { recursive: true });
  const canonical = options.canonical ?? `${BASE_URL}${urlPath}`;
  const robots = options.noindex ? '<meta name="robots" content="noindex,follow">' : '';
  fs.writeFileSync(
    path.join(pageDir, 'index.html'),
    `<!doctype html><html><head>${robots}<link rel="canonical" href="${canonical}"></head><body>Fuel station</body></html>`,
    'utf-8',
  );
}

describe('sitemapAliasPlugin — auto-discovery', () => {
  let distDir: string;

  beforeEach(() => {
    distDir = makeTmpDist();
  });

  afterEach(() => {
    if (distDir && fs.existsSync(distDir)) {
      fs.rmSync(distDir, { recursive: true, force: true });
    }
  });

  it('discovers every sitemap-*.xml file in the dist directory', async () => {
    seedSitemap(distDir, 'sitemap-pages.xml');
    seedSitemap(distDir, 'sitemap-blog.xml');
    seedSitemap(distDir, 'sitemap-jobs.xml');
    seedSitemap(distDir, 'sitemap-fuel-daily.xml');
    seedSitemap(distDir, 'sitemap-weekly-employers.xml');
    seedSitemap(distDir, 'sitemap-health-premiums.xml');

    const discovered = await discoverSitemapFiles(distDir);
    const names = discovered.map((s) => s.file);

    expect(names).toContain('sitemap-pages.xml');
    expect(names).toContain('sitemap-blog.xml');
    expect(names).toContain('sitemap-jobs.xml');
    expect(names).toContain('sitemap-fuel-daily.xml');
    expect(names).toContain('sitemap-weekly-employers.xml');
    expect(names).toContain('sitemap-health-premiums.xml');
    expect(names).toHaveLength(6);
  });

  it('excludes sitemap.xml (the index itself) from its own listing', async () => {
    seedSitemap(distDir, 'sitemap.xml');
    seedSitemap(distDir, 'sitemap-pages.xml');

    const discovered = await discoverSitemapFiles(distDir);
    const names = discovered.map((s) => s.file);

    expect(names).not.toContain('sitemap.xml');
    expect(names).toEqual(['sitemap-pages.xml']);
  });

  it('excludes the legacy sitemap_news.xml alias to avoid duplicate entries', async () => {
    seedSitemap(distDir, 'sitemap-news.xml');
    seedSitemap(distDir, 'sitemap_news.xml');
    seedSitemap(distDir, 'sitemap-pages.xml');

    const discovered = await discoverSitemapFiles(distDir);
    const names = discovered.map((s) => s.file);

    expect(names).toContain('sitemap-news.xml');
    expect(names).not.toContain('sitemap_news.xml');
    expect(names).toHaveLength(2);
  });

  it('excludes sitemap-index.xml (nested index is forbidden by the sitemap protocol)', async () => {
    // sitemap-index.xml is itself a <sitemapindex> (cathedral per-canton
    // job-shard index) — listing it inside sitemap.xml is an index-in-index
    // protocol violation that Google reports as an error (#3506).
    seedSitemap(distDir, 'sitemap-index.xml');
    seedSitemap(distDir, 'sitemap-jobs-ticino.xml');
    seedSitemap(distDir, 'sitemap-pages.xml');

    const discovered = await discoverSitemapFiles(distDir);
    const names = discovered.map((s) => s.file);

    expect(names).not.toContain('sitemap-index.xml');
    expect(names).toEqual(['sitemap-jobs-ticino.xml', 'sitemap-pages.xml']);
  });

  it('does not pick up non-sitemap files or files with the wrong prefix', async () => {
    seedSitemap(distDir, 'sitemap-pages.xml');
    // Noise — must all be ignored
    fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html>', 'utf-8');
    fs.writeFileSync(path.join(distDir, 'robots.txt'), 'User-agent: *', 'utf-8');
    fs.writeFileSync(path.join(distDir, 'my-sitemap.xml'), '<urlset/>', 'utf-8');
    fs.writeFileSync(path.join(distDir, 'sitemap.txt'), '', 'utf-8');

    const discovered = await discoverSitemapFiles(distDir);
    const names = discovered.map((s) => s.file);

    expect(names).toEqual(['sitemap-pages.xml']);
  });

  it('returns results sorted alphabetically for deterministic output', async () => {
    seedSitemap(distDir, 'sitemap-weekly-employers.xml');
    seedSitemap(distDir, 'sitemap-pages.xml');
    seedSitemap(distDir, 'sitemap-fuel-daily.xml');
    seedSitemap(distDir, 'sitemap-blog.xml');

    const discovered = await discoverSitemapFiles(distDir);
    const names = discovered.map((s) => s.file);

    expect(names).toEqual([
      'sitemap-blog.xml',
      'sitemap-fuel-daily.xml',
      'sitemap-pages.xml',
      'sitemap-weekly-employers.xml',
    ]);
  });

  it('derives lastmod from the newest entry of each file, not from its mtime', async () => {
    fs.writeFileSync(path.join(distDir, 'sitemap-pages.xml'), '<urlset><url><lastmod>2026-04-15</lastmod></url></urlset>');
    fs.utimesSync(path.join(distDir, 'sitemap-pages.xml'), new Date('2026-10-30T10:00:00Z'), new Date('2026-10-30T10:00:00Z'));
    seedSitemap(distDir, 'sitemap-eventi.xml', new Date('2026-10-30T10:00:00Z'));

    const discovered = await discoverSitemapFiles(distDir);

    expect(discovered).toEqual([
      { file: 'sitemap-eventi.xml', lastmod: undefined },
      { file: 'sitemap-pages.xml', lastmod: '2026-04-15' },
    ]);
    const xml = buildSitemapIndexXml(discovered, BASE_URL);
    expect(xml).toContain(`<loc>${BASE_URL}/sitemap-eventi.xml</loc>\n  </sitemap>`);
    expect(xml).toContain('<lastmod>2026-04-15</lastmod>');
    expect(xml.match(/<lastmod>/g)).toHaveLength(1);
  });

  it('keeps every emitted recovery family in the sitemap index', async () => {
    const restored = [
      'sitemap-orphan-landings.xml',
      'sitemap-profession-cantons.xml',
      'sitemap-profession-cities.xml',
      'sitemap-fuel-italian-stations.xml',
      'sitemap-job-market.xml',
      'sitemap-topics-frontaliere.xml',
      'sitemap-topics-svizzera.xml',
    ];
    for (const file of [...restored, 'sitemap-moduli.xml']) seedSitemap(distDir, file);

    const names = (await discoverSitemapFiles(distDir)).map((s) => s.file);

    expect(names).toEqual([...restored, 'sitemap-moduli.xml'].sort());
    const index = buildSitemapIndexXml(await discoverSitemapFiles(distDir), BASE_URL);
    for (const file of restored) expect(index).toContain(`<loc>${BASE_URL}/${file}</loc>`);
  });

  it('does not include duplicate entries when called twice on the same dist', async () => {
    seedSitemap(distDir, 'sitemap-pages.xml');
    seedSitemap(distDir, 'sitemap-blog.xml');

    const first = await discoverSitemapFiles(distDir);
    const second = await discoverSitemapFiles(distDir);

    expect(first.map((s) => s.file)).toEqual(second.map((s) => s.file));
    expect(first).toHaveLength(2);
  });

  it('returns an empty list if the dist directory is missing', async () => {
    const missing = path.join(distDir, 'does-not-exist');
    const discovered = await discoverSitemapFiles(missing);
    expect(discovered).toEqual([]);
  });

  it('returns an empty list if dist exists but has no sitemaps', async () => {
    fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html>', 'utf-8');
    const discovered = await discoverSitemapFiles(distDir);
    expect(discovered).toEqual([]);
  });
});

describe('sitemapAliasPlugin — index XML builder', () => {
  it('emits a valid sitemap-index XML with every discovered entry', () => {
    const entries: DiscoveredSitemap[] = [
      { file: 'sitemap-blog.xml', lastmod: '2026-04-15' },
      { file: 'sitemap-fuel-daily.xml', lastmod: '2026-04-20' },
      { file: 'sitemap-weekly-employers.xml', lastmod: '2026-04-20' },
    ];
    const xml = buildSitemapIndexXml(entries, BASE_URL);

    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain('</sitemapindex>');
    expect(xml).toContain(`<loc>${BASE_URL}/sitemap-blog.xml</loc>`);
    expect(xml).toContain(`<loc>${BASE_URL}/sitemap-fuel-daily.xml</loc>`);
    expect(xml).toContain(`<loc>${BASE_URL}/sitemap-weekly-employers.xml</loc>`);
    expect(xml).toContain('<lastmod>2026-04-15</lastmod>');
    expect(xml).toContain('<lastmod>2026-04-20</lastmod>');
  });

  it('omits <lastmod> for a sub-sitemap with no dated entry', () => {
    const xml = buildSitemapIndexXml([{ file: 'sitemap-eventi.xml' }], BASE_URL);
    expect(xml).toContain(`<loc>${BASE_URL}/sitemap-eventi.xml</loc>`);
    expect(xml).not.toContain('<lastmod>');
    expect(xml).not.toContain('undefined');
  });

  it('emits exactly one <loc> entry per input file (no duplicates)', () => {
    const entries: DiscoveredSitemap[] = [
      { file: 'sitemap-pages.xml', lastmod: '2026-04-20' },
      { file: 'sitemap-blog.xml', lastmod: '2026-04-20' },
    ];
    const xml = buildSitemapIndexXml(entries, BASE_URL);
    const locCount = (xml.match(/<loc>/g) ?? []).length;
    expect(locCount).toBe(entries.length);
  });

  it('produces a valid (if empty) index when no sitemaps are found', () => {
    const xml = buildSitemapIndexXml([], BASE_URL);
    expect(xml).toContain('<sitemapindex');
    expect(xml).toContain('</sitemapindex>');
    expect(xml.match(/<sitemap>/g)).toBeNull();
  });

  it('respects the base URL passed in (no www, canonical origin)', () => {
    const entries: DiscoveredSitemap[] = [
      { file: 'sitemap-pages.xml', lastmod: '2026-04-20' },
    ];
    const xml = buildSitemapIndexXml(entries, BASE_URL);
    expect(xml).toContain('https://frontaliereticino.ch/sitemap-pages.xml');
    expect(xml).not.toContain('www.frontaliereticino.ch');
  });
});

describe('sitemapAliasPlugin — recovered-family URL eligibility', () => {
  let distDir: string;

  beforeEach(() => {
    distDir = makeTmpDist();
  });

  afterEach(() => {
    if (distDir && fs.existsSync(distDir)) fs.rmSync(distDir, { recursive: true, force: true });
  });

  it('uses strict all-locale URL checks after CI rehydrates the final dist', () => {
    const source = fs.readFileSync(
      new URL('../scripts/ci/reconcile-rehydrated-sitemaps.ts', import.meta.url),
      'utf8',
    );
    expect(source).toMatch(/reconcileFinalSitemapsWithDist\(distDir, \[\], \{\s*keepMissing: false,\s*ignoreShardOwnership: true,\s*\}\)/);
  });

  it('keeps healthy recovered URLs and removes noindex, noncanonical, and final-dist 404 URLs', async () => {
    const healthy = `${BASE_URL}/it/professioni/ticino/infermiere/`;
    const noindex = `${BASE_URL}/it/professioni/ticino/placeholder/`;
    const noncanonical = `${BASE_URL}/it/professioni/ticino/legacy-slug/`;
    const missing = `${BASE_URL}/it/professioni/ticino/missing-page/`;
    const file = 'sitemap-profession-cantons.xml';
    seedSitemapWithLocs(distDir, file, [healthy, noindex, noncanonical, missing]);
    seedHtmlPage(distDir, '/it/professioni/ticino/infermiere/');
    seedHtmlPage(distDir, '/it/professioni/ticino/placeholder/', { noindex: true });
    seedHtmlPage(distDir, '/it/professioni/ticino/legacy-slug/', {
      canonical: `${BASE_URL}/contact/`,
    });

    await reconcileRemainingSitemapsWithDist(distDir);
    const shardBuildLocs = [...fs.readFileSync(path.join(distDir, file), 'utf8').matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)]
      .map((match) => match[1]!);
    expect(shardBuildLocs).toEqual([healthy, missing]);

    await reconcileFinalSitemapsWithDist(distDir, [], {
      keepMissing: false,
      ignoreShardOwnership: true,
    });
    const finalLocs = [...fs.readFileSync(path.join(distDir, file), 'utf8').matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)]
      .map((match) => match[1]!);
    expect(finalLocs).toEqual([healthy]);
  });

  it('checks absent foreign-locale URLs in the complete dist even under a shard environment', async () => {
    const previousBuildLocale = process.env.BUILD_LOCALE;
    process.env.BUILD_LOCALE = 'it';
    vi.resetModules();
    try {
      const sitemapAlias = await import('../build-plugins/sitemapAliasPlugin');
      const foreign = `${BASE_URL}/en/professioni/ticino/infermiere/`;
      const file = 'sitemap-profession-cantons.xml';
      seedSitemapWithLocs(distDir, file, [foreign]);

      await sitemapAlias.reconcileFinalSitemapsWithDist(distDir, [], {
        keepMissing: false,
        ignoreShardOwnership: true,
      });

      expect(fs.existsSync(path.join(distDir, file))).toBe(false);
    } finally {
      if (previousBuildLocale === undefined) delete process.env.BUILD_LOCALE;
      else process.env.BUILD_LOCALE = previousBuildLocale;
      vi.resetModules();
    }
  });
});

describe('sitemapAliasPlugin — integration: discover + build', () => {
  let distDir: string;

  beforeEach(() => {
    distDir = makeTmpDist();
  });

  afterEach(() => {
    if (distDir && fs.existsSync(distDir)) {
      fs.rmSync(distDir, { recursive: true, force: true });
    }
  });

  it('round-trips: seed → discover → build → every sitemap appears once', async () => {
    const expected = [
      'sitemap-blog.xml',
      'sitemap-fuel-daily.xml',
      'sitemap-glossario.xml',
      'sitemap-guides.xml',
      'sitemap-health-premiums.xml',
      'sitemap-jobs-expired.xml',
      'sitemap-jobs.xml',
      'sitemap-news.xml',
      'sitemap-pages.xml',
      'sitemap-recency.xml',
      'sitemap-salary-hub.xml',
      'sitemap-sector.xml',
      'sitemap-weekly-employers.xml',
    ];
    for (const f of expected) seedSitemap(distDir, f);
    // Poison the dist with files that must be ignored.
    seedSitemap(distDir, 'sitemap.xml'); // index — excluded
    seedSitemap(distDir, 'sitemap_news.xml'); // legacy alias — excluded
    seedSitemap(distDir, 'sitemap-index.xml'); // nested index — excluded (#3506)
    fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html>', 'utf-8');

    const discovered = await discoverSitemapFiles(distDir);
    const xml = buildSitemapIndexXml(discovered, BASE_URL);

    // Every expected file appears exactly once.
    for (const f of expected) {
      const matches = xml.match(new RegExp(`<loc>${BASE_URL}/${f.replace(/\./g, '\\.')}</loc>`, 'g'));
      expect(matches, `expected exactly one entry for ${f}`).not.toBeNull();
      expect(matches!.length, `duplicate entry for ${f}`).toBe(1);
    }
    // None of the excluded files leak in.
    expect(xml).not.toContain('<loc>https://frontaliereticino.ch/sitemap.xml</loc>');
    expect(xml).not.toContain('<loc>https://frontaliereticino.ch/sitemap_news.xml</loc>');
    expect(xml).not.toContain('<loc>https://frontaliereticino.ch/sitemap-index.xml</loc>');

    // <loc> count matches expected list length.
    expect((xml.match(/<loc>/g) ?? []).length).toBe(expected.length);
  });
});

describe('sitemapAliasPlugin — final fuel dist reconciliation', () => {
  let distDir: string;

  beforeEach(() => {
    distDir = makeTmpDist();
  });

  afterEach(() => {
    if (distDir && fs.existsSync(distDir)) {
      fs.rmSync(distDir, { recursive: true, force: true });
    }
  });

  it('removes stale fuel shard entries whose final pages are missing, noindex, or non-self-canonical', async () => {
    const livePath = '/prezzi-benzina/chiasso/oggi/';
    const noindexPath = '/prezzi-benzina/mendrisio/oggi/';
    const driftPath = '/prezzi-benzina/lugano/oggi/';
    const missingPath = '/prezzi-benzina/locarno/oggi/';
    const staleShardPath = '/prezzi-benzina/bellinzona/oggi/';
    const loc = (urlPath: string) => `${BASE_URL}${urlPath}`;

    seedSitemapWithLocs(distDir, 'sitemap-fuel-stations.xml', [
      loc(livePath),
      loc(noindexPath),
      loc(driftPath),
      loc(missingPath),
    ]);
    seedSitemapWithLocs(distDir, 'sitemap-fuel-stations-1.xml', [loc(staleShardPath)]);
    seedHtmlPage(distDir, livePath);
    seedHtmlPage(distDir, noindexPath, { noindex: true });
    seedHtmlPage(distDir, driftPath, { canonical: `${BASE_URL}/prezzi-benzina/oggi/` });
    seedHtmlPage(distDir, staleShardPath);

    await expect(reconcileSitemapFuelWithDist(distDir)).resolves.toBe(3);

    expect(fs.existsSync(path.join(distDir, 'sitemap-fuel-stations-1.xml'))).toBe(false);
    const remaining = fs.readFileSync(
      path.join(distDir, 'sitemap-fuel-stations.xml'),
      'utf-8',
    );
    expect(remaining).toContain(`<loc>${loc(livePath)}</loc>`);
    expect(remaining).not.toContain(`<loc>${loc(noindexPath)}</loc>`);
    expect(remaining).not.toContain(`<loc>${loc(driftPath)}</loc>`);
    expect(remaining).not.toContain(`<loc>${loc(missingPath)}</loc>`);
  });
});
