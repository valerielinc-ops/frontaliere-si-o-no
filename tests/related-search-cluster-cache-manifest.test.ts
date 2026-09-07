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
});
