/**
 * sitemap-auto-index — verifies `sitemapAliasPlugin` correctly discovers
 * every `sitemap-*.xml` in `dist/`, deduplicates them, excludes
 * `sitemap.xml` and the legacy `sitemap_news.xml`, and emits a well-formed
 * sitemap-index XML.
 *
 * Strategy: seed a tmpdir with fixture files, call `discoverSitemapFiles`
 * and `buildSitemapIndexXml` directly (pure functions), and assert on the
 * output. No Vite build, no real dist/ mutation — the plugin wiring itself
 * is covered by the end-to-end `npm run build:ci` in CI.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildSitemapIndexXml,
  discoverSitemapFiles,
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

  it('derives lastmod (YYYY-MM-DD) from each file\'s mtime', async () => {
    const fixedMtime = new Date('2026-04-15T10:00:00Z');
    seedSitemap(distDir, 'sitemap-pages.xml', fixedMtime);

    const discovered = await discoverSitemapFiles(distDir);
    expect(discovered[0].lastmod).toBe('2026-04-15');
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
      'sitemap-job-market.xml',
      'sitemap-jobs-expired.xml',
      'sitemap-jobs.xml',
      'sitemap-news.xml',
      'sitemap-orphan-landings.xml',
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

    // <loc> count matches expected list length.
    expect((xml.match(/<loc>/g) ?? []).length).toBe(expected.length);
  });
});
