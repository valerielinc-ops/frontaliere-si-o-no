import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
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

  it('counts a legacy staged accumulator before allowing a destructive conflict merge', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-conflict-legacy-'));
    const legacyRelative = 'data/seo-404-compat-paths.json';
    const legacyFile = path.join(dir, legacyRelative);
    const shardDir = path.join(dir, 'data/seo-404-compat');
    const basePaths = Array.from({ length: 200_000 }, (_, i) => `/family-${i}/path/`);
    const upstreamPaths = [...basePaths, '/upstream/path/'];
    const writeLegacy = (paths: string[]) => {
      fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
      fs.writeFileSync(legacyFile, JSON.stringify({
        source: 'test',
        lastUpdated: '2026-10-21T00:00:00.000Z',
        paths,
      }) + '\n');
    };
    const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });

    try {
      execFileSync('git', ['init', '-q', dir]);
      git('config', 'user.email', 'compat-test@example.test');
      git('config', 'user.name', 'compat test');
      writeLegacy(basePaths);
      git('add', legacyRelative);
      git('commit', '-qm', 'base legacy accumulator');
      const baseCommit = git('rev-parse', 'HEAD').trim();

      git('checkout', '-qb', 'upstream');
      writeLegacy(upstreamPaths);
      git('add', legacyRelative);
      git('commit', '-qm', 'upstream update');

      git('checkout', '-qb', 'local', baseCommit);
      writeLegacy(['/family-0/path/']);
      git('add', legacyRelative);
      git('commit', '-qm', 'local prune');

      const merge = spawnSync('git', [
        '-C', dir,
        '-c', 'merge.conflictStyle=merge',
        'merge', '--no-edit', '--no-commit', '--no-ff', 'upstream',
      ], { encoding: 'utf8' });
      expect(merge.status).not.toBe(0);
      const before = fs.readFileSync(legacyFile, 'utf8');

      const resolved = spawnSync('node', [
        path.join(ROOT, 'scripts/lib/resolve-404-compat-conflict.mjs'),
      ], { cwd: dir, encoding: 'utf8' });
      expect(resolved.status).not.toBe(0);
      expect(`${resolved.stdout}\n${resolved.stderr}`).toMatch(/automatic pruning|floor 150000|200000/i);
      expect(fs.existsSync(shardDir)).toBe(false);
      expect(fs.readFileSync(legacyFile, 'utf8')).toBe(before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
