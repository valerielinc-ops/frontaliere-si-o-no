import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WriteCollector } from '../build-plugins/batchWrite';
import { reset as resetRegistry, setModeForTest } from '../build-plugins/sharedWriteRegistry';

/**
 * Due `add()` sullo stesso path con contenuti diversi finiscono in batch di
 * auto-flush diversi: prima i batch partivano in parallelo e l'ultimo a
 * completare vinceva, quindi il file finale dipendeva dallo scheduler (le due
 * pagine di un job con lo stesso slug in due cantoni cambiavano da run a run).
 * Il contratto e' «l'ultimo add() vince», sempre.
 */

let dir: string;
beforeEach(() => {
  resetRegistry();
  setModeForTest('report');
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-lastwins-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
  setModeForTest(null);
});

describe('WriteCollector — last add() wins across auto-flush batches', () => {
  it('keeps the LAST content for a path re-added after earlier batches left', async () => {
    const mismatches: number[] = [];
    for (let round = 0; round < 150; round++) {
      resetRegistry();
      const root = path.join(dir, `r${round}`);
      const collector = new WriteCollector({
        distDir: root,
        pluginName: 'testPlugin',
        autoFlushThreshold: 3,
        concurrency: 2,
      });
      const target = path.join(root, 'job', 'index.html');
      collector.add(target, `v1-${round}`);
      for (let k = 0; k < 4; k++) collector.add(path.join(root, 'f1', `${k}.html`), `f1-${k}`);
      await collector.awaitDrainSlot(8);
      collector.add(target, `v2-${round}`);
      for (let k = 0; k < 4; k++) collector.add(path.join(root, 'f2', `${k}.html`), `f2-${k}`);
      collector.add(target, `v3-${round}`);
      for (let k = 0; k < 4; k++) collector.add(path.join(root, 'f3', `${k}.html`), `f3-${k}`);
      await collector.flush();
      if (fs.readFileSync(target, 'utf8') !== `v3-${round}`) mismatches.push(round);
    }
    expect(mismatches).toEqual([]);
  });

  it('does not reorder unrelated paths (all files land with their own content)', async () => {
    const collector = new WriteCollector({ distDir: dir, pluginName: 'testPlugin2', autoFlushThreshold: 5, concurrency: 3 });
    const files: Array<[string, string]> = [];
    for (let i = 0; i < 60; i++) files.push([path.join(dir, 'u', `${i}`, 'index.html'), `c-${i}`]);
    for (const [p, c] of files) collector.add(p, c);
    await collector.flush();
    for (const [p, c] of files) expect(fs.readFileSync(p, 'utf8')).toBe(c);
  });

  it('keeps independent auto-flush batches concurrent', async () => {
    const firstPath = path.join(dir, 'first.html');
    const secondPath = path.join(dir, 'second.html');
    const started: string[] = [];
    let releaseFirst!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    vi.spyOn(fs.promises, 'writeFile').mockImplementation((filePath) => {
      const normalizedPath = String(filePath);
      started.push(normalizedPath);
      if (normalizedPath === firstPath) return firstWrite;
      return Promise.resolve();
    });

    const collector = new WriteCollector({
      distDir: dir,
      pluginName: 'concurrency-test',
      autoFlushThreshold: 1,
      concurrency: 1,
    });
    collector.add(firstPath, 'first');
    for (let i = 0; i < 20 && !started.includes(firstPath); i++) await Promise.resolve();
    expect(started).toContain(firstPath);

    collector.add(secondPath, 'second');
    for (let i = 0; i < 20 && !started.includes(secondPath); i++) await Promise.resolve();
    expect(started).toContain(secondPath);

    releaseFirst();
    await collector.flush();
  });

  it.skipIf(process.env.RUN_WRITE_COLLECTOR_BENCH !== '1')('redflag benchmark — same corpus for ordered and parallel paths', async () => {
    const fileCount = 20_000;
    const collector = new WriteCollector({
      distDir: dir,
      pluginName: 'benchmark',
      autoFlushThreshold: 500,
      concurrency: 64,
    });
    let peakRss = process.memoryUsage().rss;
    let peakAnon = process.memoryUsage().heapUsed;
    const sampler = setInterval(() => {
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
      peakAnon = Math.max(peakAnon, process.memoryUsage().heapUsed);
    }, 5);
    const startedAt = process.hrtime.bigint();
    for (let i = 0; i < fileCount; i++) {
      collector.add(path.join(dir, 'benchmark', `${i}.html`), `benchmark-${i}`);
    }
    await collector.flush();
    clearInterval(sampler);
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    peakAnon = Math.max(peakAnon, process.memoryUsage().heapUsed);
    const wallMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    console.log(JSON.stringify({
      benchmark: 'write-collector',
      chain: process.env.WRITE_COLLECTOR_CHAIN !== '0',
      fileCount,
      wallMs: Math.round(wallMs),
      peakRssMb: Math.round(peakRss / 1024 / 1024),
      peakAnonMb: Math.round(peakAnon / 1024 / 1024),
    }));
  });
});
