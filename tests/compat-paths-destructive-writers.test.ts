import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');

// These scripts all read the accumulator and then write it back. A forgiving
// read can silently omit a corrupt shard, so each must fail closed before its
// next write. Runtime-only readers intentionally remain on readCompatPaths().
const DESTRUCTIVE_WRITERS = [
  'scripts/discover-404s-via-cloudflare.mjs',
  'scripts/discover-404s-via-inspection.mjs',
  'scripts/ingest-gsc-coverage-404s.ts',
  'scripts/sync-gsc-orphans.mjs',
  'scripts/build-search-cluster-301-map.mjs',
  'scripts/mine-all-job-slugs.mjs',
  'scripts/prune-404-compat-paths.ts',
  'scripts/lib/resolve-404-compat-conflict.mjs',
];

function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('destructive compatibility writers', () => {
  it('use the strict accumulator reader for every read-before-write path', () => {
    for (const relativePath of DESTRUCTIVE_WRITERS) {
      const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
      const code = withoutComments(source);
      expect(code, relativePath).toContain('readCompatPathsStrict');
      expect(code, relativePath).not.toMatch(/\breadCompatPaths\s*\(/);
    }
  });

  it('preflights all conflict stages before the resolver writes any shard', () => {
    const source = fs.readFileSync(
      path.join(ROOT, 'scripts/lib/resolve-404-compat-conflict.mjs'),
      'utf8',
    );
    expect(source).toContain('throw new Error(`[resolve-404-compat] ${label} is invalid:');
    expect(source).toContain('const mergedFiles = mergeFiles.map((file) => ({ file, ...mergeCompatFile(file) }));');
    expect(source).toContain('const shardEntries = expectedMergedShardEntries(mergedFiles, shardConflicts);');
    expect(source).toContain('clean shard ${file} differs from its merged index entry');
    expect(source).toContain('despite indexed compatibility shards; refusing a sparse/incomplete merge');
    expect(source).toContain('const previousTotal = previousStoreTotal();');
    expect(source).toContain('assertCompatFloor(previousTotal, finalTotal');
    expect(source).toContain('assertCompatPruneSafety(previousTotal, finalTotal');
    expect(source).toContain('assertCompatPruneFamilySafety(familyTotals, familyRemoved');
    expect(source).toContain('writeCompatPaths({ ...manifestMeta, paths: candidatePaths });');
    expect(source).toContain('readCompatPathsStrictAfterMerge');
    expect(source).toContain('err?.status === 128');
    expect(source).toContain('function appendPaths(target, paths)');
    expect(source).not.toMatch(/\.push\(\.\.\./);
    expect(source).toContain('const baseline = new Set();');

    const guardOffset = source.indexOf('assertCompatPruneFamilySafety(familyTotals, familyRemoved');
    const writeOffset = source.indexOf('writeCompatPaths({ ...manifestMeta, paths: candidatePaths });');
    expect(guardOffset).toBeGreaterThanOrEqual(0);
    expect(writeOffset).toBeGreaterThan(guardOffset);
  });
});
