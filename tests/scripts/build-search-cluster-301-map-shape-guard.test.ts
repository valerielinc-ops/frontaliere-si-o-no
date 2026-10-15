import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Shape-validation guard for `data/indexed-cluster-urls.json` parsing in
 * scripts/build-search-cluster-301-map.mjs (issue #2918, item 2).
 *
 * `legacyClusterUrls` tolerates several input shapes (bare array /
 * `{ urls: [...] }` / any object with an array-valued property — the real
 * on-disk shape is `{ ..., indexedPaths: [...] }`). Before this guard, an
 * UNEXPECTED shape silently resolved to `[]`, so the script wrote an EMPTY
 * `data/search-cluster-301-map.json` with no error — zeroing the entire
 * 301 recovery (≈14k hits/day) with no signal distinguishing it from a
 * normal run. It must now fail loud (non-zero exit) instead.
 *
 * Importing the module must NOT trigger `main()` (network fetch + file
 * write) — see the `invokedDirectly` CLI-entry guard at the bottom of the
 * script.
 */
const { legacyClusterUrls, resolveLegacyUrlsArray } = (await import(
  '../../scripts/build-search-cluster-301-map.mjs'
)) as unknown as {
  legacyClusterUrls: (indexedPath: string) => Map<string, string>;
  resolveLegacyUrlsArray: (raw: unknown) => unknown;
};

function writeTmpJson(content: string): string {
  const file = path.join(
    os.tmpdir(),
    `indexed-cluster-urls-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  fs.writeFileSync(file, content);
  return file;
}

function mockExit() {
  return vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${code}`);
  }) as never);
}

describe('resolveLegacyUrlsArray — tolerated shapes', () => {
  it('accepts a bare array', () => {
    expect(resolveLegacyUrlsArray(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('accepts { urls: [...] }', () => {
    expect(resolveLegacyUrlsArray({ urls: ['a'] })).toEqual(['a']);
  });

  it('accepts an object with an array-valued property (real on-disk { indexedPaths } shape)', () => {
    expect(resolveLegacyUrlsArray({ refreshedAt: 'x', indexedPaths: ['a'] })).toEqual(['a']);
  });

  it('returns undefined for a shape with no array anywhere', () => {
    expect(resolveLegacyUrlsArray({ foo: 'bar', count: 3 })).toBeUndefined();
    expect(resolveLegacyUrlsArray('a string')).toBeUndefined();
    expect(resolveLegacyUrlsArray(null)).toBeUndefined();
    expect(resolveLegacyUrlsArray(42)).toBeUndefined();
  });
});

describe('legacyClusterUrls — fail-loud shape guard (issue #2918 item 2)', () => {
  const files: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const f of files.splice(0)) {
      fs.rmSync(f, { force: true });
    }
  });

  it('throws (exit 1) on an unexpected top-level shape instead of writing an empty map', () => {
    const exitSpy = mockExit();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const file = writeTmpJson(JSON.stringify({ unexpected: 'garbage', count: 5 }));
    files.push(file);

    expect(() => legacyClusterUrls(file)).toThrow('process.exit:1');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('unexpected shape'));
  });

  it('throws (exit 1) on a valid-but-empty shape when the source file is non-empty', () => {
    const exitSpy = mockExit();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const file = writeTmpJson(JSON.stringify({ urls: [] }));
    files.push(file);

    expect(() => legacyClusterUrls(file)).toThrow('process.exit:1');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('parsed 0 legacy URL candidates'));
  });

  it('parses through normally on a valid, non-empty bare-array shape', () => {
    const file = writeTmpJson(
      JSON.stringify([
        '/cerca-lavoro-ticino/ricerca-infermiere-svizzera/',
        '/en/find-jobs-ticino/search-nurse-switzerland/',
      ]),
    );
    files.push(file);

    const out = legacyClusterUrls(file);
    expect(out.size).toBe(2);
    expect(out.get('/cerca-lavoro-ticino/ricerca-infermiere-svizzera/')).toBe('it');
    expect(out.get('/en/find-jobs-ticino/search-nurse-switzerland/')).toBe('en');
  });

  it('parses through normally on the real on-disk { indexedPaths: [...] } shape', () => {
    const file = writeTmpJson(
      JSON.stringify({
        refreshedAt: '2026-07-02T00:00:00.000Z',
        indexedCount: 1,
        indexedPaths: ['/de/jobs-im-tessin/suche-maler-schweiz/'],
      }),
    );
    files.push(file);

    const out = legacyClusterUrls(file);
    expect(out.size).toBe(1);
    expect(out.get('/de/jobs-im-tessin/suche-maler-schweiz/')).toBe('de');
  });
});
