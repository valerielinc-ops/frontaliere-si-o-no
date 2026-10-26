import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GRANDFATHERED_ABI_HASHES } from '@/build-plugins/shared/abiChunkNaming';
import { PLAIN_NAME_CHUNKS, isPlainNameChunk } from '@/build-plugins/shared/plainNameChunks';

/**
 * The article renderer (packages/articles/engine/ogPagesPlugin.ts) also runs in
 * the publisher repo, outside the Vite build, where the chunk registry is empty
 * and `stableChunkFile(name)` answers `<name>.js`. Every chunk it preloads must
 * therefore either keep that spelling (PLAIN_NAME_CHUNKS, default-only) or be
 * grandfathered on its current interface. This is what stops a new preload from
 * being added to the engine without anyone deciding what its name does when the
 * chunk's exports change.
 */
const engine = fs.readFileSync(path.join(process.cwd(), 'packages/articles/engine/ogPagesPlugin.ts'), 'utf-8');

function chunkNamesResolvedByEngine(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(/stableChunkFile\(\s*'([^']+)'\s*\)/g)) names.add(m[1]);
  for (const m of source.matchAll(/stableChunkFiles\(\s*\[([^\]]*)\]\s*\)/g)) {
    for (const n of m[1].matchAll(/'([^']+)'/g)) names.add(n[1]);
  }
  return [...names].sort();
}

describe('plain-name chunk list', () => {
  it('covers every chunk the article engine preloads by name', () => {
    const used = chunkNamesResolvedByEngine(engine);
    expect(used.length).toBeGreaterThanOrEqual(4);
    const unaccounted = used.filter((name) => !isPlainNameChunk(name) && !(name in GRANDFATHERED_ABI_HASHES));
    expect(unaccounted).toEqual([]);
  });

  it('lists only chunks that exist as plain names today', () => {
    expect([...PLAIN_NAME_CHUNKS]).toEqual(['it-core', 'it-calculator', 'blog-meta-it']);
    expect(isPlainNameChunk('it-core')).toBe(true);
    expect(isPlainNameChunk('blog-meta-it')).toBe(true);
  });

  it('does not pin hubs that other chunks import names from', () => {
    for (const hub of ['App', 'mx', 'shared-services', 'i18n', 'JobBoard', 'vendor-react', 'jobDataNormalization']) {
      expect(isPlainNameChunk(hub), hub).toBe(false);
    }
  });
});
