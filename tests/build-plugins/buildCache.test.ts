// @vitest-environment node
/**
 * Unit tests for the build-plugin cache utility (`build-plugins/shared/buildCache.ts`).
 *
 * The cache lets expensive plugins (salary-hub, health-premiums) skip their
 * heavy work when none of their inputs have changed since the last run. The
 * key invariant under test: **automatic invalidation** — modifying ANY
 * source file in the plugin's import graph or any runtime data file MUST
 * cause the cache key to change, which forces a fresh rebuild.
 *
 * No manual CACHE_VERSION bump exists. Invalidation is driven entirely by
 * file content hashes (esbuild bundle hash for code, plain SHA256 for data).
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { computeCacheKey, runCached } from '../../build-plugins/shared/buildCache';

let tmpRoot: string;
let cacheDir: string;
let distDir: string;
let entryFile: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'buildcache-test-'));
  cacheDir = path.join(tmpRoot, '.cache', 'build-plugins');
  distDir = path.join(tmpRoot, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  entryFile = path.join(tmpRoot, 'plugin.ts');
  fs.writeFileSync(
    entryFile,
    `export const greeting = 'hello';\nexport function pageHtml() { return '<html>' + greeting + '</html>'; }\n`,
    'utf-8',
  );
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('computeCacheKey', () => {
  it('returns a stable hex SHA256 string', async () => {
    const key = await computeCacheKey({ rootDir: tmpRoot, bundleEntry: entryFile });
    expect(key).toMatch(/^[a-f0-9]{64}$/);
  });

  it('produces the same key for unchanged inputs across calls', async () => {
    const k1 = await computeCacheKey({ rootDir: tmpRoot, bundleEntry: entryFile });
    const k2 = await computeCacheKey({ rootDir: tmpRoot, bundleEntry: entryFile });
    expect(k1).toBe(k2);
  });

  it('changes when the entry file content changes', async () => {
    const key1 = await computeCacheKey({ rootDir: tmpRoot, bundleEntry: entryFile });
    fs.writeFileSync(entryFile, `export const greeting = 'changed';\n`, 'utf-8');
    const key2 = await computeCacheKey({ rootDir: tmpRoot, bundleEntry: entryFile });
    expect(key1).not.toBe(key2);
  });

  it('automatically invalidates when a transitive import changes (no manual list)', async () => {
    const helperFile = path.join(tmpRoot, 'helper.ts');
    fs.writeFileSync(helperFile, `export const VERSION = 1;\n`, 'utf-8');
    fs.writeFileSync(
      entryFile,
      `import { VERSION } from './helper';\nexport const greeting = 'hello' + VERSION;\n`,
      'utf-8',
    );
    const key1 = await computeCacheKey({ rootDir: tmpRoot, bundleEntry: entryFile });

    // Modify ONLY the transitive helper — the entry file is unchanged.
    fs.writeFileSync(helperFile, `export const VERSION = 2;\n`, 'utf-8');
    const key2 = await computeCacheKey({ rootDir: tmpRoot, bundleEntry: entryFile });

    expect(key1).not.toBe(key2);
  });

  it('changes when a runtime data file changes', async () => {
    const dataFile = path.join(tmpRoot, 'data.json');
    fs.writeFileSync(dataFile, '{"version":1}', 'utf-8');
    const key1 = await computeCacheKey({
      rootDir: tmpRoot,
      bundleEntry: entryFile,
      runtimeFiles: () => [dataFile],
    });
    fs.writeFileSync(dataFile, '{"version":2}', 'utf-8');
    const key2 = await computeCacheKey({
      rootDir: tmpRoot,
      bundleEntry: entryFile,
      runtimeFiles: () => [dataFile],
    });
    expect(key1).not.toBe(key2);
  });

  it('changes when a new runtime data file is added to the list', async () => {
    const dataA = path.join(tmpRoot, 'a.json');
    const dataB = path.join(tmpRoot, 'b.json');
    fs.writeFileSync(dataA, '{"a":1}', 'utf-8');
    fs.writeFileSync(dataB, '{"b":2}', 'utf-8');
    const k1 = await computeCacheKey({
      rootDir: tmpRoot,
      bundleEntry: entryFile,
      runtimeFiles: () => [dataA],
    });
    const k2 = await computeCacheKey({
      rootDir: tmpRoot,
      bundleEntry: entryFile,
      runtimeFiles: () => [dataA, dataB],
    });
    expect(k1).not.toBe(k2);
  });

  it('changes when extraKey changes (e.g. current year crossing boundary)', async () => {
    const k1 = await computeCacheKey({ rootDir: tmpRoot, bundleEntry: entryFile, extraKey: '2026' });
    const k2 = await computeCacheKey({ rootDir: tmpRoot, bundleEntry: entryFile, extraKey: '2027' });
    expect(k1).not.toBe(k2);
  });

  it('is independent of file mtime — only content matters', async () => {
    const k1 = await computeCacheKey({ rootDir: tmpRoot, bundleEntry: entryFile });
    // Touch the file to bump mtime without changing content.
    const now = new Date();
    const future = new Date(now.getTime() + 60_000);
    fs.utimesSync(entryFile, future, future);
    const k2 = await computeCacheKey({ rootDir: tmpRoot, bundleEntry: entryFile });
    expect(k1).toBe(k2);
  });
});

describe('runCached', () => {
  it('cache miss on first run: executes work and snapshots files', async () => {
    let workCalls = 0;
    const result = await runCached({
      pluginName: 'test-plugin',
      rootDir: tmpRoot,
      distDir,
      bundleEntry: entryFile,
      cacheDir,
      work: async ({ recordWrite }) => {
        workCalls++;
        const outFile = path.join(distDir, 'page.html');
        fs.writeFileSync(outFile, '<html>hi</html>', 'utf-8');
        recordWrite(outFile);
      },
    });
    expect(result.hit).toBe(false);
    expect(workCalls).toBe(1);
    expect(fs.readFileSync(path.join(distDir, 'page.html'), 'utf-8')).toBe('<html>hi</html>');
    expect(fs.existsSync(path.join(cacheDir, 'test-plugin', result.key))).toBe(true);
  });

  it('cache hit on second run: skips work, restores files byte-identical', async () => {
    const opts = (workTracker: { calls: number }) => ({
      pluginName: 'test-plugin',
      rootDir: tmpRoot,
      distDir,
      bundleEntry: entryFile,
      cacheDir,
      work: async ({ recordWrite }: { recordWrite: (p: string) => void }) => {
        workTracker.calls++;
        const outFile = path.join(distDir, 'page.html');
        fs.writeFileSync(outFile, '<html>hi</html>', 'utf-8');
        recordWrite(outFile);
      },
    });

    const tracker = { calls: 0 };
    await runCached(opts(tracker));
    expect(tracker.calls).toBe(1);

    // Wipe dist to prove the restore actually replays files.
    fs.rmSync(distDir, { recursive: true, force: true });
    fs.mkdirSync(distDir, { recursive: true });

    const r2 = await runCached(opts(tracker));
    expect(r2.hit).toBe(true);
    expect(tracker.calls).toBe(1); // work was NOT called again
    expect(fs.readFileSync(path.join(distDir, 'page.html'), 'utf-8')).toBe('<html>hi</html>');
  });

  it('cache miss when entry file changes: re-runs work', async () => {
    const tracker = { calls: 0 };
    const buildOpts = () => ({
      pluginName: 'test-plugin',
      rootDir: tmpRoot,
      distDir,
      bundleEntry: entryFile,
      cacheDir,
      work: async ({ recordWrite }: { recordWrite: (p: string) => void }) => {
        tracker.calls++;
        const out = path.join(distDir, 'page.html');
        fs.writeFileSync(out, `<html>v${tracker.calls}</html>`, 'utf-8');
        recordWrite(out);
      },
    });

    await runCached(buildOpts());
    expect(tracker.calls).toBe(1);

    fs.writeFileSync(entryFile, `export const greeting = 'changed';\n`, 'utf-8');

    const r = await runCached(buildOpts());
    expect(r.hit).toBe(false);
    expect(tracker.calls).toBe(2);
  });

  it('cache miss when a transitive import changes', async () => {
    const helper = path.join(tmpRoot, 'helper.ts');
    fs.writeFileSync(helper, 'export const X = 1;\n', 'utf-8');
    fs.writeFileSync(entryFile, `import { X } from './helper';\nexport const out = X;\n`, 'utf-8');

    const tracker = { calls: 0 };
    const buildOpts = () => ({
      pluginName: 'test-plugin',
      rootDir: tmpRoot,
      distDir,
      bundleEntry: entryFile,
      cacheDir,
      work: async ({ recordWrite }: { recordWrite: (p: string) => void }) => {
        tracker.calls++;
        const out = path.join(distDir, 'page.html');
        fs.writeFileSync(out, `<html>v${tracker.calls}</html>`, 'utf-8');
        recordWrite(out);
      },
    });

    await runCached(buildOpts());
    expect(tracker.calls).toBe(1);

    // Modify only the helper — entry file untouched.
    fs.writeFileSync(helper, 'export const X = 2;\n', 'utf-8');

    const r = await runCached(buildOpts());
    expect(r.hit).toBe(false);
    expect(tracker.calls).toBe(2);
  });

  it('cache miss when a runtime data file changes', async () => {
    const dataFile = path.join(tmpRoot, 'data.json');
    fs.writeFileSync(dataFile, '{"v":1}', 'utf-8');

    const tracker = { calls: 0 };
    const buildOpts = () => ({
      pluginName: 'test-plugin',
      rootDir: tmpRoot,
      distDir,
      bundleEntry: entryFile,
      cacheDir,
      runtimeFiles: () => [dataFile],
      work: async ({ recordWrite }: { recordWrite: (p: string) => void }) => {
        tracker.calls++;
        const out = path.join(distDir, 'page.html');
        fs.writeFileSync(out, '<html>x</html>', 'utf-8');
        recordWrite(out);
      },
    });

    await runCached(buildOpts());
    expect(tracker.calls).toBe(1);

    fs.writeFileSync(dataFile, '{"v":2}', 'utf-8');

    const r = await runCached(buildOpts());
    expect(r.hit).toBe(false);
    expect(tracker.calls).toBe(2);
  });

  it('handles many recorded files in nested directories', async () => {
    await runCached({
      pluginName: 'test-plugin',
      rootDir: tmpRoot,
      distDir,
      bundleEntry: entryFile,
      cacheDir,
      work: async ({ recordWrite }) => {
        for (let i = 0; i < 5; i++) {
          const out = path.join(distDir, 'subdir', `page-${i}.html`);
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.writeFileSync(out, `page ${i}`, 'utf-8');
          recordWrite(out);
        }
      },
    });

    fs.rmSync(distDir, { recursive: true, force: true });
    fs.mkdirSync(distDir, { recursive: true });

    const tracker = { calls: 0 };
    const r = await runCached({
      pluginName: 'test-plugin',
      rootDir: tmpRoot,
      distDir,
      bundleEntry: entryFile,
      cacheDir,
      work: async () => {
        tracker.calls++;
      },
    });
    expect(r.hit).toBe(true);
    expect(tracker.calls).toBe(0);
    for (let i = 0; i < 5; i++) {
      expect(fs.readFileSync(path.join(distDir, 'subdir', `page-${i}.html`), 'utf-8')).toBe(
        `page ${i}`,
      );
    }
  });

  it('byte-identical restore: hit replays exact original bytes', async () => {
    let firstContent = '';
    await runCached({
      pluginName: 'test-plugin',
      rootDir: tmpRoot,
      distDir,
      bundleEntry: entryFile,
      cacheDir,
      work: async ({ recordWrite }) => {
        const outFile = path.join(distDir, 'page.html');
        // Use deterministic content within a single test run.
        firstContent = '<html>byte-identical-test</html>';
        fs.writeFileSync(outFile, firstContent, 'utf-8');
        recordWrite(outFile);
      },
    });
    fs.rmSync(distDir, { recursive: true, force: true });
    fs.mkdirSync(distDir, { recursive: true });

    let workCalled = false;
    await runCached({
      pluginName: 'test-plugin',
      rootDir: tmpRoot,
      distDir,
      bundleEntry: entryFile,
      cacheDir,
      work: async () => {
        workCalled = true;
      },
    });
    expect(workCalled).toBe(false);
    expect(fs.readFileSync(path.join(distDir, 'page.html'), 'utf-8')).toBe(firstContent);
  });

  it('integrates with WriteCollector pathRecorder so the collector path goes through the cache', async () => {
    // Use the real WriteCollector to prove the pathRecorder option fires for
    // queued writes. This guards the contract between batchWrite and
    // buildCache — if pathRecorder is ever silently dropped, the cache would
    // snapshot zero files even on cache miss.
    const { WriteCollector } = await import('../../build-plugins/batchWrite');

    let capturedPaths: string[] = [];
    const r1 = await runCached({
      pluginName: 'test-plugin',
      rootDir: tmpRoot,
      distDir,
      bundleEntry: entryFile,
      cacheDir,
      work: async ({ recordWrite }) => {
        capturedPaths = [];
        const collector = new WriteCollector({
          distDir,
          pluginName: 'test-plugin',
          pathRecorder: (p) => {
            capturedPaths.push(p);
            recordWrite(p);
          },
        });
        for (let i = 0; i < 3; i++) {
          collector.add(path.join(distDir, `via-collector-${i}.html`), `via ${i}`);
        }
        await collector.flush();
      },
    });

    expect(r1.hit).toBe(false);
    expect(capturedPaths).toHaveLength(3);
    expect(r1.fileCount).toBe(3);

    fs.rmSync(distDir, { recursive: true, force: true });
    fs.mkdirSync(distDir, { recursive: true });

    const r2 = await runCached({
      pluginName: 'test-plugin',
      rootDir: tmpRoot,
      distDir,
      bundleEntry: entryFile,
      cacheDir,
      work: async () => {
        throw new Error('work should not run on cache hit');
      },
    });
    expect(r2.hit).toBe(true);
    expect(r2.fileCount).toBe(3);
    for (let i = 0; i < 3; i++) {
      expect(fs.readFileSync(path.join(distDir, `via-collector-${i}.html`), 'utf-8')).toBe(
        `via ${i}`,
      );
    }
  });

  it('logs a human-readable miss reason mentioning the changed file (smoke check)', async () => {
    // First run primes the cache.
    await runCached({
      pluginName: 'test-plugin',
      rootDir: tmpRoot,
      distDir,
      bundleEntry: entryFile,
      cacheDir,
      work: async ({ recordWrite }) => {
        const out = path.join(distDir, 'page.html');
        fs.writeFileSync(out, '<html>1</html>', 'utf-8');
        recordWrite(out);
      },
    });
    // Modify entry → next run is a miss.
    fs.writeFileSync(entryFile, `export const greeting = 'changed';\n`, 'utf-8');

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };
    try {
      await runCached({
        pluginName: 'test-plugin',
        rootDir: tmpRoot,
        distDir,
        bundleEntry: entryFile,
        cacheDir,
        work: async ({ recordWrite }) => {
          const out = path.join(distDir, 'page.html');
          fs.writeFileSync(out, '<html>2</html>', 'utf-8');
          recordWrite(out);
        },
      });
    } finally {
      console.log = origLog;
    }

    const joined = logs.join('\n');
    expect(joined).toMatch(/\[cache\]/i);
    expect(joined.toLowerCase()).toContain('test-plugin');
    expect(joined.toLowerCase()).toContain('miss');
  });
});
