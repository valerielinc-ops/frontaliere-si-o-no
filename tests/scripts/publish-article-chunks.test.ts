/**
 * publish-article-chunks.mjs gate (issue #4881 Fase 3-bis).
 *
 * The fast-publish path rebuilds `data/blog-articles-data.ts` and
 * `data/swiss-articles-data.ts` with esbuild, standalone, outside Rollup —
 * a future refactor of either module (e.g. a new runtime import, or a
 * default export instead of a named one) could silently break that isolated
 * rebuild while the normal Vite build stays fine. This test pins the
 * isolated-rebuild output against the source-of-truth registry (imported
 * normally, via vitest's own transform) by article-id-set parity, so any such
 * drift fails loudly here instead of surfacing only in production as a
 * missing/stale CDN chunk.
 *
 * Pure-ESM script. The CLI block is gated on
 * `import.meta.url === file://${process.argv[1]}`, so importing it is
 * side-effect-free (no upload, no purge).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, afterEach } from 'vitest';

import {
  buildRegistryChunk,
  validateRegistryChunk,
  REGISTRIES,
  ROOT_DIR,
} from '../../scripts/publish-article-chunks.mjs';
import { computeTickerArticles } from '../../build-plugins/newsTickerDataPlugin';
import { ARTICLES } from '../../data/blog-articles-data';
import { SWISS_ARTICLES } from '../../data/swiss-articles-data';

const SOURCE_OF_TRUTH: Record<string, Array<{ id: string }>> = {
  ARTICLES,
  SWISS_ARTICLES,
};

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-article-chunks-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('publish-article-chunks isolated esbuild rebuild', () => {
  for (const registry of REGISTRIES) {
    it(
      `${registry.source} rebuilds standalone and its "${registry.exportName}" id set matches the source registry exactly`,
      async () => {
        const outFile = path.join(makeTmpDir(), path.basename(registry.cdnKey));
        await buildRegistryChunk(ROOT_DIR, registry.source, outFile);
        expect(fs.existsSync(outFile)).toBe(true);

        const rebuilt = await validateRegistryChunk(outFile, registry.exportName);
        const truth = SOURCE_OF_TRUTH[registry.exportName];
        expect(truth).toBeDefined();

        const rebuiltIds = new Set(rebuilt.map((a: { id: string }) => a.id));
        const truthIds = new Set(truth.map((a) => a.id));
        expect(rebuiltIds.size).toBe(truthIds.size);
        for (const id of truthIds) {
          expect(rebuiltIds.has(id)).toBe(true);
        }
      },
      30_000,
    );
  }

  it('rejects a rebuilt module whose export is missing, empty, or not an array', async () => {
    const dir = makeTmpDir();
    const badFile = path.join(dir, 'bad.js');
    fs.writeFileSync(badFile, 'export const ARTICLES = [];\n');
    await expect(validateRegistryChunk(badFile, 'ARTICLES')).rejects.toThrow(/not a non-empty array/);

    const wrongShapeFile = path.join(dir, 'wrong.js');
    fs.writeFileSync(wrongShapeFile, 'export const ARTICLES = { not: "an array" };\n');
    await expect(validateRegistryChunk(wrongShapeFile, 'ARTICLES')).rejects.toThrow(/not a non-empty array/);
  });
});

describe('computeTickerArticles articlesOverride (issue #4881)', () => {
  it('uses the override instead of the module-level ARTICLES import when given', () => {
    const np = path;
    const fresh = [
      { id: 'zzz-brand-new-article', category: 'novita' as const, date: '2099-01-01', image: 'x', hasCalculator: false },
      ...ARTICLES.slice(0, 2),
    ];
    const withOverride = computeTickerArticles(fs, np, ROOT_DIR, fresh);
    expect(withOverride[0].id).toBe('zzz-brand-new-article');

    const withoutOverride = computeTickerArticles(fs, np, ROOT_DIR);
    expect(withoutOverride[0].id).not.toBe('zzz-brand-new-article');
  });
});
