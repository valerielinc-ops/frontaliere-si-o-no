/**
 * The post-walk worker's imports must resolve under PLAIN NODE ESM.
 *
 * `postWalkCoordinatorPlugin.ts` runs the post-walk pass inside
 * `worker_threads`, booting `postWalkWorker.mjs` with `execArgv:
 * ['--import','tsx']`. That is a different resolver from the one the rest of
 * the build uses: on the main thread Vite resolves an extensionless specifier
 * happily, but inside the worker `packages/articles` is its own
 * `"type": "module"` package and a deep specifier without a file extension
 * does not resolve at all.
 *
 * Run 15955 died on exactly that — `ERR_MODULE_NOT_FOUND` for
 * `packages/articles/engine/flatHtmlRedirect`, thrown ~70 minutes into a
 * deploy, at post-walk, after every other plugin had already run. Nothing
 * before that point can catch it: the module imports cleanly on the main
 * thread, and `tsc` accepts the extensionless form because
 * `moduleResolution: "bundler"` is what the site builds with.
 *
 * So this test does the only thing that would have caught it — it loads the
 * worker's own imports in a real worker thread, with the same execArgv the
 * coordinator uses. The specifier list is READ OUT of `postWalkWorker.mjs`
 * rather than restated here, so a future import added to the worker is
 * covered automatically instead of silently escaping the gate.
 */

import { describe, it, expect } from 'vitest';
import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER_SRC = path.join(ROOT, 'build-plugins', 'postWalkWorker.mjs');

/** Every `await import('…')` specifier literal in the worker entry point. */
function workerImportSpecifiers(): string[] {
  const src = fs.readFileSync(WORKER_SRC, 'utf-8');
  return [...src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
}

/** Resolve each specifier inside a worker thread; returns one line per import. */
function loadInWorker(specifiers: readonly string[]): Promise<string[]> {
  const base = `${new URL('file://' + path.join(ROOT, 'build-plugins') + '/')}`;
  const body = `
    import { parentPort } from 'node:worker_threads';
    const out = [];
    for (const spec of ${JSON.stringify(specifiers)}) {
      try {
        await import(new URL(spec, ${JSON.stringify(base)}).href);
        out.push('OK ' + spec);
      } catch (e) {
        out.push('FAIL ' + spec + ' :: ' + String(e && e.message).split('\\n')[0]);
      }
    }
    parentPort.postMessage(out);
  `;
  return new Promise((resolve, reject) => {
    const w = new Worker(body, { eval: true, execArgv: ['--import', 'tsx'] });
    w.on('message', (m: string[]) => { void w.terminate(); resolve(m); });
    w.on('error', reject);
  });
}

describe('post-walk worker module resolution', () => {
  it('finds the worker entry point and its dynamic imports', () => {
    expect(fs.existsSync(WORKER_SRC)).toBe(true);
    // A regex that silently matches nothing would make this whole file pass
    // while checking nothing at all.
    expect(workerImportSpecifiers().length).toBeGreaterThanOrEqual(4);
  });

  it('resolves every worker import under plain Node ESM + tsx', async () => {
    const results = await loadInWorker(workerImportSpecifiers());
    const failures = results.filter((r) => r.startsWith('FAIL'));
    expect(failures, failures.join('\n')).toEqual([]);
  }, 180_000);
});
