import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
});
