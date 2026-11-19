// @vitest-environment node
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  COMPAT_SHARD_COUNT,
  compatManifestFile,
  compatShardFile,
  compatShardIndex,
  readCompatPathsStrict,
  readCompatPathsStrictAfterMerge,
  readCompatPathsStrictWithManifestRepair,
  repairCompatManifest,
  writeCompatPaths,
} from '../scripts/lib/compat-paths-store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPAIR_CLI = path.join(ROOT, 'scripts/ci/repair-compat-manifest.mjs');
const PUSH_HELPER = path.join(ROOT, 'scripts/lib/git-push-with-retry.sh');
const MERGE_DRIVER = path.join(ROOT, 'scripts/ci/merge-compat-shard.mjs');
const ERROR_PREFIX = '[compat-paths-store] ';

let rootDir: string;

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-lag-'));
});

afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
});

function manifestOf(dir: string) {
  return JSON.parse(fs.readFileSync(compatManifestFile(dir), 'utf8'));
}

function setManifestTotal(dir: string, totalPaths: number) {
  const manifest = manifestOf(dir);
  manifest.totalPaths = totalPaths;
  fs.writeFileSync(compatManifestFile(dir), JSON.stringify(manifest, null, 2) + '\n');
}

function seedStore(dir: string, count: number, extra: Record<string, unknown> = {}) {
  const paths = Array.from({ length: count }, (_, i) => `/lag/p${String(i).padStart(4, '0')}/`);
  writeCompatPaths({
    source: 'test-source',
    lastUpdated: '2026-11-15',
    ...extra,
    paths,
  }, dir);
  return paths;
}

function thrownMessage(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('Expected operation to throw');
}

function expectStrictAndRepairReadersToReject(dir: string, pattern: RegExp) {
  expect(() => readCompatPathsStrict(dir)).toThrow(pattern);
  expect(() => repairCompatManifest(dir)).toThrow(pattern);
  expect(() => readCompatPathsStrictWithManifestRepair(dir)).toThrow(pattern);
}

function shardHashes(dir: string): string[] {
  return Array.from({ length: COMPAT_SHARD_COUNT }, (_, i) => {
    const bytes = fs.readFileSync(compatShardFile(i, dir));
    return createHash('sha256').update(bytes).digest('hex');
  });
}

describe('readCompatPathsStrict — manifest total versus validated shards', () => {
  it('rejects a lagging manifest by default with the run 43728895227 error', () => {
    seedStore(rootDir, 12);
    setManifestTotal(rootDir, 2);

    expect(thrownMessage(() => readCompatPathsStrict(rootDir))).toBe(
      ERROR_PREFIX
        + 'manifest declares 2 paths, but complete shards contain 12; refusing destructive rewrite',
    );
  });

  it('repairs a leading manifest total from validated shards instead of rejecting after repair', () => {
    seedStore(rootDir, 5);
    setManifestTotal(rootDir, 9);

    expect(thrownMessage(() => readCompatPathsStrict(rootDir))).toBe(
      ERROR_PREFIX
        + 'manifest declares 9 paths, but complete shards contain 5; refusing destructive rewrite',
    );
    expect(repairCompatManifest(rootDir)).toEqual({
      changed: true,
      totalPaths: 5,
      previousTotalPaths: 9,
    });
    expect(readCompatPathsStrict(rootDir).paths).toHaveLength(5);
  });

  it('rejects a missing shard in the strict reader and both repair APIs', () => {
    seedStore(rootDir, 12);
    fs.rmSync(compatShardFile(7, rootDir));
    const manifestBefore = fs.readFileSync(compatManifestFile(rootDir), 'utf8');

    expectStrictAndRepairReadersToReject(rootDir, /incomplete shard set/);
    expect(fs.readFileSync(compatManifestFile(rootDir), 'utf8')).toBe(manifestBefore);
  });

  it('rejects corrupt shard JSON in the strict reader and both repair APIs', () => {
    seedStore(rootDir, 12);
    fs.writeFileSync(compatShardFile(0, rootDir), '{');
    const manifestBefore = fs.readFileSync(compatManifestFile(rootDir), 'utf8');

    expectStrictAndRepairReadersToReject(rootDir, /cannot read part-00\.json/);
    expect(fs.readFileSync(compatManifestFile(rootDir), 'utf8')).toBe(manifestBefore);
  });

  it('rejects corrupt manifest JSON in the strict reader and both repair APIs', () => {
    seedStore(rootDir, 12);
    fs.writeFileSync(compatManifestFile(rootDir), '{');
    const manifestBefore = fs.readFileSync(compatManifestFile(rootDir), 'utf8');

    expectStrictAndRepairReadersToReject(rootDir, /cannot read shard manifest/);
    expect(fs.readFileSync(compatManifestFile(rootDir), 'utf8')).toBe(manifestBefore);
  });

  it('keeps strict reads fail-closed while repair readers heal an exact canonical duplicate', () => {
    const paths = seedStore(rootDir, 12);
    const [duplicate] = paths;
    const targetIndex = (compatShardIndex(duplicate) + 1) % COMPAT_SHARD_COUNT;
    const targetPath = compatShardFile(targetIndex, rootDir);
    const target = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
    target.paths.push(duplicate);
    fs.writeFileSync(targetPath, JSON.stringify(target));

    expect(() => readCompatPathsStrict(rootDir)).toThrow(/duplicate path/);
    expect(repairCompatManifest(rootDir)).toMatchObject({
      changed: false,
      totalPaths: paths.length,
    });
    expect(readCompatPathsStrict(rootDir).paths).toHaveLength(paths.length);

    const repairedTarget = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
    repairedTarget.paths.push(duplicate);
    fs.writeFileSync(targetPath, JSON.stringify(repairedTarget));
    setManifestTotal(rootDir, 2);

    const prepared = readCompatPathsStrictWithManifestRepair(rootDir);
    expect(prepared).toMatchObject({
      changed: true,
      previousTotalPaths: 2,
      totalPaths: paths.length,
    });
    expect(JSON.parse(fs.readFileSync(targetPath, 'utf8')).paths).not.toContain(duplicate);
    expect(readCompatPathsStrict(rootDir).paths).toHaveLength(paths.length);
  });

  it('rejects a path in the wrong shard in the strict reader and both repair APIs', () => {
    const [wrongPath] = seedStore(rootDir, 12);
    const sourceIndex = compatShardIndex(wrongPath);
    const targetIndex = (sourceIndex + 1) % COMPAT_SHARD_COUNT;
    const sourcePath = compatShardFile(sourceIndex, rootDir);
    const targetPath = compatShardFile(targetIndex, rootDir);
    const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
    const target = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
    source.paths = source.paths.filter((value: string) => value !== wrongPath);
    target.paths.push(wrongPath);
    fs.writeFileSync(sourcePath, JSON.stringify(source));
    fs.writeFileSync(targetPath, JSON.stringify(target));
    const manifestBefore = fs.readFileSync(compatManifestFile(rootDir), 'utf8');

    expectStrictAndRepairReadersToReject(rootDir, /assigned to shard/);
    expect(fs.readFileSync(compatManifestFile(rootDir), 'utf8')).toBe(manifestBefore);
  });

  it('rejects an invalid manifest shape in the strict reader and both repair APIs', () => {
    seedStore(rootDir, 12);
    fs.writeFileSync(
      compatManifestFile(rootDir),
      JSON.stringify({ shardCount: COMPAT_SHARD_COUNT, totalPaths: 'twelve' }),
    );
    const manifestBefore = fs.readFileSync(compatManifestFile(rootDir), 'utf8');

    expectStrictAndRepairReadersToReject(rootDir, /invalid shard manifest/);
    expect(fs.readFileSync(compatManifestFile(rootDir), 'utf8')).toBe(manifestBefore);
  });
});

describe('repairCompatManifest and readCompatPathsStrictWithManifestRepair', () => {
  it('realigns bytes like writeCompatPaths and leaves every shard hash unchanged', () => {
    const paths = seedStore(rootDir, 12);
    const expectedManifest = JSON.stringify({
      source: 'test-source',
      lastUpdated: '2026-11-15',
      shardCount: COMPAT_SHARD_COUNT,
      totalPaths: paths.length,
    }, null, 2) + '\n';
    const hashesBefore = shardHashes(rootDir);
    setManifestTotal(rootDir, 2);

    expect(repairCompatManifest(rootDir)).toEqual({
      changed: true,
      totalPaths: 12,
      previousTotalPaths: 2,
    });
    expect(fs.readFileSync(compatManifestFile(rootDir), 'utf8')).toBe(expectedManifest);
    expect(Object.keys(manifestOf(rootDir))).toEqual([
      'source',
      'lastUpdated',
      'shardCount',
      'totalPaths',
    ]);
    expect(shardHashes(rootDir)).toEqual(hashesBefore);
    expect(readCompatPathsStrict(rootDir).paths.slice().sort()).toEqual(paths.slice().sort());
  });

  it('is a no-op on a coherent store', () => {
    seedStore(rootDir, 5);
    const manifestBefore = fs.readFileSync(compatManifestFile(rootDir), 'utf8');

    expect(repairCompatManifest(rootDir)).toMatchObject({
      changed: false,
      totalPaths: 5,
      previousTotalPaths: 5,
    });
    expect(fs.readFileSync(compatManifestFile(rootDir), 'utf8')).toBe(manifestBefore);
  });

  it('returns totalPaths null when repairing a legacy checkout without shards', () => {
    const legacyPath = path.join(rootDir, 'data/seo-404-compat-paths.json');
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, JSON.stringify({ source: 'legacy', paths: ['/legacy/a/', '/legacy/b/'] }));

    expect(repairCompatManifest(rootDir)).toMatchObject({
      changed: false,
      totalPaths: null,
      previousTotalPaths: null,
    });
  });

  it('returns the complete validated path set while repairing the manifest in one pass', () => {
    const paths = seedStore(rootDir, 12);
    setManifestTotal(rootDir, 2);

    const result = readCompatPathsStrictWithManifestRepair(rootDir);

    expect(result).toMatchObject({
      changed: true,
      previousTotalPaths: 2,
      totalPaths: 12,
    });
    expect(result.data.paths.slice().sort()).toEqual(paths.slice().sort());
    expect(readCompatPathsStrict(rootDir).paths).toHaveLength(12);
  });
});

describe('repair-compat-manifest CLI', () => {
  it('prints repair and coherent-store results, succeeds on both, and fails on broken shards', () => {
    seedStore(rootDir, 12);

    const coherent = spawnSync(process.execPath, [REPAIR_CLI, rootDir], { encoding: 'utf8' });
    expect(coherent.status).toBe(0);
    expect(coherent.stdout).toContain('manifest already matches 12 validated shard paths');

    setManifestTotal(rootDir, 2);
    const repaired = spawnSync(process.execPath, [REPAIR_CLI, rootDir], { encoding: 'utf8' });
    expect(repaired.status).toBe(0);
    expect(repaired.stdout).toContain('repaired stale manifest count 2 → 12 from validated shards');

    fs.writeFileSync(compatShardFile(0, rootDir), '{');
    const broken = spawnSync(process.execPath, [REPAIR_CLI, rootDir], { encoding: 'utf8' });
    expect(broken.status).not.toBe(0);
  });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function initRepo(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'compat-test@example.test');
  git(dir, 'config', 'user.name', 'compat test');

  // Keep the real driver and its imports available to the push helper, which
  // registers the production-relative driver path inside its working clone.
  fs.mkdirSync(path.join(dir, 'scripts/ci'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'scripts/lib'), { recursive: true });
  fs.copyFileSync(MERGE_DRIVER, path.join(dir, 'scripts/ci/merge-compat-shard.mjs'));
  for (const filename of ['compat-path-safety.mjs', 'mid-plugins-flag.mjs']) {
    fs.copyFileSync(
      path.join(ROOT, 'scripts/lib', filename),
      path.join(dir, 'scripts/lib', filename),
    );
  }
  fs.writeFileSync(
    path.join(dir, '.gitattributes'),
    'data/seo-404-compat/part-*.json merge=compat-shard\n',
  );
  git(
    dir,
    'config',
    'merge.compat-shard.driver',
    'node "' + MERGE_DRIVER + '" %O %A %B',
  );
}

function commitAll(dir: string, message: string) {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
}

const BASE = Array.from({ length: 40 }, (_, i) => `/base/b${String(i).padStart(3, '0')}/`);
const range = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => `/${prefix}/${String(i).padStart(3, '0')}/`);

describe('real git merge reproduces a stale compat manifest', () => {
  it('both branches change totalPaths: manifest conflict resolved by hand leaves 49 for 52 shard paths', () => {
    initRepo(rootDir);
    writeCompatPaths({ source: 's', lastUpdated: '2026-11-14', paths: BASE }, rootDir);
    commitAll(rootDir, 'base');

    git(rootDir, 'checkout', '-q', '-b', 'inspection');
    writeCompatPaths({
      source: 's',
      lastUpdated: '2026-11-15',
      paths: [...BASE, ...range('insp', 6)],
    }, rootDir);
    commitAll(rootDir, 'inspection');

    git(rootDir, 'checkout', '-q', 'main');
    git(rootDir, 'checkout', '-q', '-b', 'cloudflare');
    writeCompatPaths({
      source: 's',
      lastUpdated: '2026-11-15',
      paths: [...BASE, ...range('cf', 6), ...range('insp', 3)],
    }, rootDir);
    commitAll(rootDir, 'cloudflare');

    const merge = spawnSync('git', ['merge', '--no-edit', 'inspection'], {
      cwd: rootDir,
      encoding: 'utf8',
    });
    expect(merge.status).not.toBe(0);
    expect(git(rootDir, 'diff', '--name-only', '--diff-filter=U').trim())
      .toBe('data/seo-404-compat/manifest.json');

    git(rootDir, 'checkout', '--ours', 'data/seo-404-compat/manifest.json');
    git(rootDir, 'add', 'data/seo-404-compat/manifest.json');
    git(rootDir, 'commit', '-q', '--no-edit');

    expect(manifestOf(rootDir).totalPaths).toBe(49);
    expect(thrownMessage(() => readCompatPathsStrict(rootDir))).toBe(
      ERROR_PREFIX
        + 'manifest declares 49 paths, but complete shards contain 52; refusing destructive rewrite',
    );
    expect(repairCompatManifest(rootDir)).toEqual({
      changed: true,
      totalPaths: 52,
      previousTotalPaths: 49,
    });
    expect(readCompatPathsStrict(rootDir).paths).toHaveLength(52);
  });

  it('one branch changes totalPaths: clean silent merge leaves 36 for 40 shard paths', () => {
    initRepo(rootDir);
    writeCompatPaths({ source: 's', lastUpdated: '2026-11-14', paths: BASE }, rootDir);
    commitAll(rootDir, 'base');

    git(rootDir, 'checkout', '-q', '-b', 'producer-a');
    writeCompatPaths({
      source: 's',
      lastUpdated: '2026-11-14',
      paths: BASE.slice(4),
    }, rootDir);
    commitAll(rootDir, 'producer a minus four');

    git(rootDir, 'checkout', '-q', 'main');
    git(rootDir, 'checkout', '-q', '-b', 'producer-b');
    writeCompatPaths({
      source: 's',
      lastUpdated: '2026-11-14',
      paths: [...BASE.slice(4), ...range('b', 4)],
    }, rootDir);
    commitAll(rootDir, 'producer b minus four plus four');
    expect(git(rootDir, 'diff', '--name-only', 'main', 'HEAD')).not.toContain('manifest.json');

    git(rootDir, 'merge', '--no-edit', 'producer-a');

    expect(manifestOf(rootDir).totalPaths).toBe(36);
    expect(thrownMessage(() => readCompatPathsStrict(rootDir))).toBe(
      ERROR_PREFIX
        + 'manifest declares 36 paths, but complete shards contain 40; refusing destructive rewrite',
    );
    expect(repairCompatManifest(rootDir)).toEqual({
      changed: true,
      totalPaths: 40,
      previousTotalPaths: 36,
    });
    expect(readCompatPathsStrict(rootDir).paths).toHaveLength(40);
  });
});

describe('git-push-with-retry.sh repairs the rebased manifest before pushing', () => {
  it('amends the validated shard count into HEAD after the real rebase and before the push', () => {
    const remoteDir = path.join(rootDir, 'remote.git');
    const seedDir = path.join(rootDir, 'seed');
    const localDir = path.join(rootDir, 'local');
    const writerDir = path.join(rootDir, 'writer');
    const wrapDir = path.join(rootDir, 'git-wrapper');
    fs.mkdirSync(remoteDir, { recursive: true });
    git(remoteDir, 'init', '-q', '--bare', '-b', 'main');

    initRepo(seedDir);
    writeCompatPaths({ source: 's', lastUpdated: '2026-11-14', paths: BASE }, seedDir);
    commitAll(seedDir, 'seed');
    git(seedDir, 'remote', 'add', 'origin', remoteDir);
    git(seedDir, 'push', '-q', 'origin', 'HEAD:main');

    for (const dir of [localDir, writerDir]) {
      fs.mkdirSync(dir, { recursive: true });
      git(dir, 'clone', '-q', '--branch', 'main', remoteDir, '.');
      git(dir, 'config', 'user.email', 'compat-test@example.test');
      git(dir, 'config', 'user.name', 'compat test');
    }

    writeCompatPaths({
      source: 's',
      lastUpdated: '2026-11-15',
      paths: BASE.slice(4),
    }, writerDir);
    commitAll(writerDir, 'producer a');
    git(writerDir, 'push', '-q', 'origin', 'HEAD:main');

    writeCompatPaths({
      source: 's',
      lastUpdated: '2026-11-14',
      paths: [...BASE.slice(4), ...range('b', 4)],
    }, localDir);
    commitAll(localDir, 'producer b');

    fs.mkdirSync(wrapDir, { recursive: true });
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const sentinel = path.join(wrapDir, 'first-push-rejected');
    const wrapper = path.join(wrapDir, 'git');
    fs.writeFileSync(wrapper, [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'has_push=false',
      'for arg in "$@"; do',
      '  if [ "$arg" = "push" ]; then has_push=true; fi',
      'done',
      'if [ "$has_push" = true ] && [ ! -f "${COMPAT_PUSH_SENTINEL}" ]; then',
      '  : > "${COMPAT_PUSH_SENTINEL}"',
      '  echo "simulated first push rejection" >&2',
      '  exit 1',
      'fi',
      'exec "${COMPAT_PUSH_REAL_GIT}" "$@"',
      '',
    ].join('\n'));
    fs.chmodSync(wrapper, 0o755);

    const output = execFileSync('bash', [PUSH_HELPER, '--max-attempts', '3'], {
      cwd: localDir,
      env: {
        ...process.env,
        PATH: wrapDir + ':' + (process.env.PATH || ''),
        COMPAT_PUSH_REAL_GIT: realGit,
        COMPAT_PUSH_SENTINEL: sentinel,
      },
      encoding: 'utf8',
    });

    expect(fs.existsSync(sentinel)).toBe(true);
    expect(output).toContain('repaired stale manifest count 36 → 40 from validated shards');
    expect(git(remoteDir, 'log', '--format=%s', 'main').trim().split('\n'))
      .toEqual(['producer b', 'producer a', 'seed']);
    const headManifest = JSON.parse(git(localDir, 'show', 'HEAD:data/seo-404-compat/manifest.json'));
    const pushedManifest = JSON.parse(git(remoteDir, 'show', 'main:data/seo-404-compat/manifest.json'));
    expect(headManifest.totalPaths).toBe(40);
    expect(pushedManifest.totalPaths).toBe(40);
    expect(pushedManifest.source).toBe('s');
    expect(git(localDir, 'status', '--porcelain', '--untracked-files=no')).toBe('');
    expect(readCompatPathsStrict(localDir).paths).toHaveLength(40);
  }, 120_000);

  it('runs manifest repair only behind compat-store guards in both commit and push helpers', () => {
    const pushSource = fs.readFileSync(PUSH_HELPER, 'utf8');
    const pushBody = shellFunctionBody(pushSource, 'repair_compat_manifest_before_push');
    expect(pushBody).toMatch(/git diff-tree[\s\S]*data\/seo-404-compat\/part-\*\.json/);
    expect(pushBody).toMatch(/\[ -n "\$touched" \] \|\| return 0/);
    expect(pushBody.indexOf('[ -n "$touched" ] || return 0'))
      .toBeLessThan(pushBody.indexOf('repair-compat-manifest.mjs'));
    expect(pushSource.match(/repair_compat_manifest_before_push \|\| exit 1/g)).toHaveLength(2);

    const commitSource = fs.readFileSync(path.join(ROOT, 'scripts/lib/git-commit-data.sh'), 'utf8');
    const worktreeBody = shellFunctionBody(commitSource, 'repair_compat_manifest_in_worktree');
    expect(worktreeBody).toContain('for f in "${RESOLVED_FILES[@]}"');
    expect(worktreeBody).toContain(
      'data/seo-404-compat/part-*.json|data/seo-404-compat/manifest.json',
    );
    expect(worktreeBody).toMatch(/\[ "\$compat_touched" = true \] \|\| return 0/);
    expect(worktreeBody.indexOf('[ "$compat_touched" = true ] || return 0'))
      .toBeLessThan(worktreeBody.indexOf('repair-compat-manifest.mjs'));

    const compatFileScan = commitSource.slice(
      commitSource.indexOf('effective_files=()'),
      commitSource.indexOf('isolated_phase_add skip-scan'),
    );
    expect(compatFileScan).toContain(
      'data/seo-404-compat/part-*.json|data/seo-404-compat/manifest.json',
    );
    expect(compatFileScan).toContain('compat_store_touched=true');
    expect(commitSource).toMatch(
      /if \[ "\$compat_store_touched" = true \]; then\s+repair_compat_manifest_in_index/,
    );
    const indexBody = shellFunctionBody(commitSource, 'repair_compat_manifest_in_index');
    expect(indexBody).toContain('repair-compat-manifest.mjs');
  });
});

function shellFunctionBody(source: string, functionName: string): string {
  const match = source.match(new RegExp('\\n' + functionName + '\\(\\) \\{([\\s\\S]*?)\\n\\}'));
  if (!match) throw new Error('Missing shell function: ' + functionName);
  return match[1];
}

function sourceWithoutComments(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('compat consumers choose the reader that matches their write contract', () => {
  const REPAIRING_PRODUCERS = [
    'scripts/mine-all-job-slugs.mjs',
    'scripts/discover-404s-via-cloudflare.mjs',
    'scripts/discover-404s-via-inspection.mjs',
    'scripts/ingest-gsc-coverage-404s.ts',
    'scripts/sync-gsc-orphans.mjs',
    'scripts/build-search-cluster-301-map.mjs',
  ];

  it.each(REPAIRING_PRODUCERS)('%s uses the strict reader with validated manifest repair', (relativePath) => {
    const source = sourceWithoutComments(relativePath);
    expect(source).toMatch(
      /readCompatPathsStrictWithManifestRepair\s*\(\s*ROOT\s*\)/,
    );
  });

  it('prune-404-compat-paths repairs validated metadata before rewriting the set', () => {
    const source = sourceWithoutComments('scripts/prune-404-compat-paths.ts');
    expect(source).toContain('readCompatPathsStrictWithManifestRepair(ROOT).data');
    expect(source).toMatch(/writeCompatPaths\s*\(/);
  });

  it('the conflict resolver keeps the independently counted post-merge strict reader', () => {
    const source = sourceWithoutComments('scripts/lib/resolve-404-compat-conflict.mjs');
    expect(source).toMatch(
      /readCompatPathsStrictAfterMerge\s*\(\s*process\.cwd\(\)\s*,\s*finalTotal\s*\)/,
    );
    expect(source).not.toContain('readCompatPathsStrictWithManifestRepair');
    expect(source).not.toContain('repairCompatManifest');
  });
});
