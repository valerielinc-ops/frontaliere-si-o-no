/**
 * Issue #7755 — the cluster cache manifest may only advertise files it holds.
 *
 * `saveToCache` used to mark a rel as "seen" BEFORE checking that the emitted
 * file existed in dist/, and built `manifest.files` from that set: the manifest
 * listed entries whose blob was never copied. On the next cache HIT
 * `tryRestoreFromCache` swallowed the resulting ENOENT, so the build shipped a
 * dist/ with missing cluster pages while `restoredKeywordLandingPaths`
 * registered them as planned landings — a silent hole with no signal.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveToCache, tryRestoreFromCache } from '../build-plugins/relatedSearchClustersPlugin';

const KEY = 'testkey0000000';
let root: string;

function write(dir: string, rel: string, body: string): void {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, 'utf-8');
}

function readManifest(): { files: string[]; retiredFiles?: string[]; emittedCount: number } {
  return JSON.parse(
    fs.readFileSync(path.join(root, '.cache', 'related-search-clusters', KEY, 'manifest.json'), 'utf-8'),
  );
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-cache-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('cluster cache manifest honesty', () => {
  it('excludes emitted files that are absent from dist/', () => {
    const dist = path.join(root, 'dist');
    write(dist, 'cerca-lavoro-ticino/ricerca-a/index.html', '<html>a</html>');
    write(dist, 'cerca-lavoro-ticino/ricerca-b/index.html', '<html>b</html>');

    const emitted = [
      'cerca-lavoro-ticino/ricerca-a/index.html',
      'cerca-lavoro-ticino/ricerca-missing/index.html',
      'cerca-lavoro-ticino/ricerca-b/index.html',
    ];
    const copied = saveToCache(root, dist, KEY, emitted, [], [], [], [], [
      'cerca-lavoro-ticino/ricerca-missing/index.html',
    ]);

    const manifest = readManifest();
    expect(manifest.files).not.toContain('cerca-lavoro-ticino/ricerca-missing/index.html');
    expect(manifest.files.sort()).toEqual([
      'cerca-lavoro-ticino/ricerca-a/index.html',
      'cerca-lavoro-ticino/ricerca-b/index.html',
    ]);
    // A retirement whose source was missing is not advertised either.
    expect(manifest.retiredFiles ?? []).toEqual([]);
    expect(copied).toBe(2);
    expect(manifest.emittedCount).toBe(2);

    // Every manifest entry has a blob on disk.
    for (const rel of manifest.files) {
      expect(fs.existsSync(path.join(root, '.cache', 'related-search-clusters', KEY, 'files', rel))).toBe(true);
    }
  });

  it('round-trips: every manifest entry lands in dist/ on restore', async () => {
    const dist = path.join(root, 'dist');
    write(dist, 'cerca-lavoro-ticino/ricerca-a/index.html', '<html>a</html>');
    write(dist, 'de/stellensuche-tessin/suche-b/index.html', '<html>b</html>');

    saveToCache(root, dist, KEY, [
      'cerca-lavoro-ticino/ricerca-a/index.html',
      'de/stellensuche-tessin/suche-b/index.html',
      'cerca-lavoro-ticino/ricerca-missing/index.html',
    ], [], [], [], []);

    const dist2 = path.join(root, 'dist2');
    fs.mkdirSync(dist2, { recursive: true });
    const restored = await tryRestoreFromCache(root, dist2, KEY);

    expect(restored).not.toBeNull();
    for (const rel of restored!.files) {
      expect(fs.existsSync(path.join(dist2, rel))).toBe(true);
    }
    expect(restored!.emittedCount).toBe(restored!.files.length);
  });

  it('invalidates the restore (and says so) when a manifest entry has no blob', async () => {
    const dist = path.join(root, 'dist');
    write(dist, 'cerca-lavoro-ticino/ricerca-a/index.html', '<html>a</html>');
    write(dist, 'cerca-lavoro-ticino/ricerca-b/index.html', '<html>b</html>');
    saveToCache(root, dist, KEY, [
      'cerca-lavoro-ticino/ricerca-a/index.html',
      'cerca-lavoro-ticino/ricerca-b/index.html',
    ], [], [], [], []);

    // Simulate a truncated/corrupt cache directory.
    fs.rmSync(
      path.join(root, '.cache', 'related-search-clusters', KEY, 'files', 'cerca-lavoro-ticino/ricerca-b/index.html'),
    );

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dist2 = path.join(root, 'dist2');
    fs.mkdirSync(dist2, { recursive: true });
    const restored = await tryRestoreFromCache(root, dist2, KEY);

    expect(restored).toBeNull();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('cache INVALID'))).toBe(true);
  });

  it('invalidates the restore when a copy fails for a reason other than ENOENT', async () => {
    const dist = path.join(root, 'dist');
    write(dist, 'cerca-lavoro-ticino/ricerca-a/index.html', '<html>a</html>');
    write(dist, 'de/stellensuche-tessin/suche-b/index.html', '<html>b</html>');
    saveToCache(root, dist, KEY, [
      'cerca-lavoro-ticino/ricerca-a/index.html',
      'de/stellensuche-tessin/suche-b/index.html',
    ], [], [], [], []);

    // Every blob is present: the copy itself fails. A regular file where the
    // restore needs a directory makes mkdirSync/copyFile throw ENOTDIR — the
    // same shape as the EMFILE/EACCES/ENOSPC/EIO the runner can throw at
    // concurrency 64, none of which is ENOENT.
    const dist2 = path.join(root, 'dist2');
    fs.mkdirSync(dist2, { recursive: true });
    fs.writeFileSync(path.join(dist2, 'cerca-lavoro-ticino'), 'not a directory', 'utf-8');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const restored = await tryRestoreFromCache(root, dist2, KEY);

    expect(restored).toBeNull();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('restore failed for'))).toBe(true);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('cache INVALID'))).toBe(true);
  });
});


describe('cached sitemap freshness', () => {
  it('restores unchanged pages on different days without manufacturing URL dates', async () => {
    const initial = Date.now();
    const oldDay = new Date(initial - 7 * 86_400_000).toISOString().slice(0, 10);
    const dist = path.join(root, 'dist');
    const shard = 'sitemap-search-clusters-001.xml';
    const html = '<html><body>Unchanged substantive content</body></html>';
    const page = 'cerca-lavoro-ticino/ricerca-a/index.html';
    const sitemap = '<urlset><url><loc>https://frontaliereticino.ch/a/</loc><priority>0.6</priority></url></urlset>';
    const sourceDatedSitemap = `<urlset><url><loc>https://frontaliereticino.ch/blog/</loc><lastmod>${oldDay}</lastmod></url></urlset>`;
    write(dist, page, html);
    write(dist, shard, sitemap);
    // A different sitemap and an index have independent, valid date provenance.
    write(dist, 'sitemap-blog.xml', sourceDatedSitemap);
    write(dist, 'sitemap.xml', `<sitemapindex><sitemap><loc>https://frontaliereticino.ch/${shard}</loc><lastmod>${oldDay}</lastmod></sitemap></sitemapindex>`);
    saveToCache(root, dist, KEY, [page, shard, 'sitemap-blog.xml', 'sitemap.xml'], [], [], [], []);
    // A valid cache hit is disk-to-disk only. No post-copy migration may
    // invalidate it because a second write is unavailable.
    const writeAfterRestore = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw Object.assign(new Error('post-copy writes unavailable'), { code: 'EACCES' });
    });
    const results: string[] = [];
    vi.useFakeTimers({ toFake: ['Date'] });
    for (const offset of [0, 2]) {
      vi.setSystemTime(initial + offset * 86_400_000);
      const restoredDir = path.join(root, `restored-${offset}`);
      fs.mkdirSync(restoredDir);
      expect(await tryRestoreFromCache(root, restoredDir, KEY)).not.toBeNull();
      expect(fs.readFileSync(path.join(restoredDir, page), 'utf-8')).toBe(html);
      expect(fs.readFileSync(path.join(restoredDir, 'sitemap-blog.xml'), 'utf-8')).toBe(sourceDatedSitemap);
      expect(fs.readFileSync(path.join(restoredDir, 'sitemap.xml'), 'utf-8')).toContain(`<lastmod>${oldDay}</lastmod>`);
      const restored = fs.readFileSync(path.join(restoredDir, shard), 'utf-8');
      expect(restored).not.toContain('<lastmod>');
      expect(restored).toContain('<loc>https://frontaliereticino.ch/a/</loc>');
      results.push(restored);
    }
    expect(results[0]).toBe(results[1]);
    expect(writeAfterRestore).not.toHaveBeenCalled();
  });

  it('rejects a legacy build-date manifest before copying any output', async () => {
    const dist = path.join(root, 'legacy-dist');
    const shard = 'sitemap-search-clusters-001.xml';
    write(dist, shard, '<urlset><url><loc>https://frontaliereticino.ch/a/</loc><lastmod>2026-01-01</lastmod></url></urlset>');
    saveToCache(root, dist, KEY, [shard], [], [], [], []);
    const manifestPath = path.join(root, '.cache', 'related-search-clusters', KEY, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    manifest.version = 'v12';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const copy = vi.spyOn(fs.promises, 'copyFile');
    const restoredDir = path.join(root, 'restored-legacy');
    expect(await tryRestoreFromCache(root, restoredDir, KEY)).toBeNull();
    expect(copy).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(restoredDir, shard))).toBe(false);
  });

});
