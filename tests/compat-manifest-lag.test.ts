// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ADDITIVE_COMPAT_READ,
  COMPAT_SHARD_COUNT,
  compatManifestFile,
  compatShardFile,
  compatShardIndex,
  readCompatPathsStrict,
  refreshCompatManifest,
  writeCompatPaths,
} from '../scripts/lib/compat-paths-store.mjs';

// 2026-11-15, build 43728895227: `prep` died on
//   manifest declares 6411550 paths, but complete shards contain 6411560
// because a merge unioned the compat shards (merge=compat-shard driver) while
// manifest.json kept ONE side's totalPaths. These tests pin (1) how the strict
// reader treats a lagging/leading manifest, (2) the reproduction of the merge
// that produces the lag, and (3) the realignment that closes it.

const ROOT = path.resolve(__dirname, '..');
const REFRESH_CLI = path.join(ROOT, 'scripts/ci/refresh-compat-manifest.mjs');
const PUSH_HELPER = path.join(ROOT, 'scripts/lib/git-push-with-retry.sh');

let rootDir: string;

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-manifest-lag-'));
});

afterEach(() => {
  vi.restoreAllMocks();
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

function seed(dir: string, count: number, extra: Record<string, unknown> = {}) {
  const paths = Array.from({ length: count }, (_, i) => `/lag/p${String(i).padStart(4, '0')}/`);
  writeCompatPaths({ source: 'test-source', lastUpdated: '2026-11-15', ...extra, paths }, dir);
  return paths;
}

describe('readCompatPathsStrict — manifest total vs shards', () => {
  it('keeps refusing a lagging manifest by default (destructive rewrites stay exact)', () => {
    seed(rootDir, 12);
    setManifestTotal(rootDir, 2);
    expect(() => readCompatPathsStrict(rootDir)).toThrow(
      /manifest declares 2 paths, but complete shards contain 12; refusing destructive rewrite/,
    );
  });

  it('tolerates a manifest total BELOW the shards (surplus) with a warning carrying both numbers', () => {
    const paths = seed(rootDir, 12);
    setManifestTotal(rootDir, 2);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = readCompatPathsStrict(rootDir, ADDITIVE_COMPAT_READ);

    expect(result.paths.slice().sort()).toEqual(paths.slice().sort());
    expect(result.source).toBe('test-source');
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toBe(
      '[compat-paths-store] WARNING manifest totalPaths lags its shards: manifest declares 2 paths, '
      + 'complete shards contain 12 (+10); the shards are complete, unique and correctly assigned, '
      + 'so nothing is lost; continuing. Realign with: node scripts/ci/refresh-compat-manifest.mjs',
    );
  });

  it('reports a surplus through onManifestSurplus instead of console.warn when given', () => {
    seed(rootDir, 5);
    setManifestTotal(rootDir, 4);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seen: Array<{ declaredTotalPaths: number; actualTotalPaths: number }> = [];

    readCompatPathsStrict(rootDir, {
      allowManifestSurplus: true,
      onManifestSurplus: (info: { declaredTotalPaths: number; actualTotalPaths: number }) => seen.push(info),
    });

    expect(seen).toEqual([expect.objectContaining({ declaredTotalPaths: 4, actualTotalPaths: 5 })]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not warn when the manifest matches', () => {
    seed(rootDir, 5);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(readCompatPathsStrict(rootDir, ADDITIVE_COMPAT_READ).paths).toHaveLength(5);
    expect(warn).not.toHaveBeenCalled();
  });

  it('rejects a manifest total ABOVE the shards (possible truncation) even in surplus mode', () => {
    seed(rootDir, 5);
    setManifestTotal(rootDir, 9);
    expect(() => readCompatPathsStrict(rootDir, ADDITIVE_COMPAT_READ)).toThrow(
      /manifest declares 9 paths, but complete shards contain 5/,
    );
  });

  it('still rejects a missing shard in surplus mode', () => {
    seed(rootDir, 12);
    setManifestTotal(rootDir, 2);
    fs.rmSync(compatShardFile(3, rootDir));
    expect(() => readCompatPathsStrict(rootDir, ADDITIVE_COMPAT_READ)).toThrow(/incomplete shard set/);
  });

  it('still rejects a corrupt shard in surplus mode', () => {
    seed(rootDir, 12);
    setManifestTotal(rootDir, 2);
    fs.writeFileSync(compatShardFile(0, rootDir), '{');
    expect(() => readCompatPathsStrict(rootDir, ADDITIVE_COMPAT_READ)).toThrow(/cannot read part-00\.json/);
  });

  it('still rejects a duplicate path across shards in surplus mode', () => {
    seed(rootDir, 12);
    setManifestTotal(rootDir, 2);
    const first = JSON.parse(fs.readFileSync(compatShardFile(0, rootDir), 'utf8')).paths[0]
      ?? JSON.parse(fs.readFileSync(compatShardFile(1, rootDir), 'utf8')).paths[0];
    const sourceIndex = compatShardIndex(first);
    const target = compatShardFile((sourceIndex + 1) % COMPAT_SHARD_COUNT, rootDir);
    const targetJson = JSON.parse(fs.readFileSync(target, 'utf8'));
    targetJson.paths.push(first);
    fs.writeFileSync(target, JSON.stringify(targetJson));
    expect(() => readCompatPathsStrict(rootDir, ADDITIVE_COMPAT_READ)).toThrow(/duplicate path|assigned to shard/);
  });

  it('still rejects a path stored in the wrong shard in surplus mode', () => {
    writeCompatPaths({ paths: ['/wrong-shard/'] }, rootDir);
    setManifestTotal(rootDir, 0);
    const sourceIndex = compatShardIndex('/wrong-shard/');
    const targetIndex = (sourceIndex + 1) % COMPAT_SHARD_COUNT;
    fs.writeFileSync(compatShardFile(sourceIndex, rootDir), JSON.stringify({ paths: [] }));
    fs.writeFileSync(compatShardFile(targetIndex, rootDir), JSON.stringify({ paths: ['/wrong-shard/'] }));
    expect(() => readCompatPathsStrict(rootDir, ADDITIVE_COMPAT_READ)).toThrow(/assigned to shard/);
  });

  it('still rejects an invalid manifest shape in surplus mode', () => {
    seed(rootDir, 5);
    fs.writeFileSync(compatManifestFile(rootDir), JSON.stringify({ shardCount: 16, totalPaths: 'x' }));
    expect(() => readCompatPathsStrict(rootDir, ADDITIVE_COMPAT_READ)).toThrow(/invalid shard manifest/);
  });
});

describe('refreshCompatManifest', () => {
  it('realigns a lagging total with the byte-identical serialisation of writeCompatPaths and touches no shard', () => {
    seed(rootDir, 12, { custom: 'kept' });
    const expectedManifest = fs.readFileSync(compatManifestFile(rootDir), 'utf8');
    const shardBytes = Array.from({ length: COMPAT_SHARD_COUNT }, (_, i) => fs.readFileSync(compatShardFile(i, rootDir), 'utf8'));
    setManifestTotal(rootDir, 2);

    const result = refreshCompatManifest(rootDir);

    expect(result).toEqual({ declaredTotalPaths: 2, actualTotalPaths: 12, changed: true });
    expect(fs.readFileSync(compatManifestFile(rootDir), 'utf8')).toBe(expectedManifest);
    expect(Array.from({ length: COMPAT_SHARD_COUNT }, (_, i) => fs.readFileSync(compatShardFile(i, rootDir), 'utf8')))
      .toEqual(shardBytes);
    expect(Object.keys(manifestOf(rootDir))).toEqual(['source', 'lastUpdated', 'custom', 'shardCount', 'totalPaths']);
    expect(() => readCompatPathsStrict(rootDir)).not.toThrow();
  });

  it('also realigns a total ABOVE the shards (the shards are the source of truth)', () => {
    seed(rootDir, 5);
    setManifestTotal(rootDir, 9);
    expect(refreshCompatManifest(rootDir)).toEqual({ declaredTotalPaths: 9, actualTotalPaths: 5, changed: true });
    expect(manifestOf(rootDir).totalPaths).toBe(5);
  });

  it('is a no-op on a coherent store', () => {
    seed(rootDir, 5);
    const before = fs.readFileSync(compatManifestFile(rootDir), 'utf8');
    expect(refreshCompatManifest(rootDir)).toEqual({ declaredTotalPaths: 5, actualTotalPaths: 5, changed: false });
    expect(fs.readFileSync(compatManifestFile(rootDir), 'utf8')).toBe(before);
  });

  it('check mode reports the drift without writing', () => {
    seed(rootDir, 12);
    setManifestTotal(rootDir, 2);
    const before = fs.readFileSync(compatManifestFile(rootDir), 'utf8');
    expect(refreshCompatManifest(rootDir, { check: true })).toEqual({ declaredTotalPaths: 2, actualTotalPaths: 12, changed: true });
    expect(fs.readFileSync(compatManifestFile(rootDir), 'utf8')).toBe(before);
  });

  it('never repairs a broken shard set by re-counting it', () => {
    seed(rootDir, 12);
    setManifestTotal(rootDir, 2);
    fs.rmSync(compatShardFile(5, rootDir));
    expect(() => refreshCompatManifest(rootDir)).toThrow(/incomplete shard set/);
    expect(manifestOf(rootDir).totalPaths).toBe(2);
  });

  it('skips a checkout without shards', () => {
    expect(refreshCompatManifest(rootDir)).toEqual({
      declaredTotalPaths: null,
      actualTotalPaths: 0,
      changed: false,
      skipped: 'no-shards',
    });
  });

  it('CLI: --check exits 1 on drift, default run realigns, exit 2 on a broken shard set', () => {
    seed(rootDir, 12);
    setManifestTotal(rootDir, 2);

    const check = spawnSync('node', [REFRESH_CLI, '--root', rootDir, '--check'], { encoding: 'utf8' });
    expect(check.status).toBe(1);
    expect(check.stderr).toContain('manifest declares 2 paths but the shards contain 12');

    const fix = spawnSync('node', [REFRESH_CLI, '--root', rootDir], { encoding: 'utf8' });
    expect(fix.status).toBe(0);
    expect(fix.stdout).toContain('realigned manifest totalPaths 2 -> 12');

    const again = spawnSync('node', [REFRESH_CLI, '--root', rootDir, '--check'], { encoding: 'utf8' });
    expect(again.status).toBe(0);

    fs.writeFileSync(compatShardFile(0, rootDir), '{');
    const broken = spawnSync('node', [REFRESH_CLI, '--root', rootDir], { encoding: 'utf8' });
    expect(broken.status).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Reproduction with real git and the real merge driver.
// ---------------------------------------------------------------------------

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function initRepo(dir: string) {
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'compat-test@example.test');
  git(dir, 'config', 'user.name', 'compat test');
  // The driver and its imports, as committed in the real repo.
  fs.mkdirSync(path.join(dir, 'scripts/ci'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'scripts/lib'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'scripts/ci/merge-compat-shard.mjs'), path.join(dir, 'scripts/ci/merge-compat-shard.mjs'));
  for (const f of ['compat-path-safety.mjs', 'mid-plugins-flag.mjs']) {
    fs.copyFileSync(path.join(ROOT, 'scripts/lib', f), path.join(dir, 'scripts/lib', f));
  }
  fs.writeFileSync(path.join(dir, '.gitattributes'), 'data/seo-404-compat/part-*.json merge=compat-shard\n');
  git(dir, 'config', 'merge.compat-shard.driver', 'node scripts/ci/merge-compat-shard.mjs %O %A %B');
}

function commitAll(dir: string, message: string) {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
}

const BASE = Array.from({ length: 40 }, (_, i) => `/base/b${String(i).padStart(3, '0')}/`);
const range = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `/${prefix}/${String(i).padStart(3, '0')}/`);

describe('reproduction: shards merged by the compat-shard driver leave a stale manifest', () => {
  it('both branches change totalPaths: the manifest conflicts and a hand resolution keeping one side lags the shards', () => {
    initRepo(rootDir);
    writeCompatPaths({ source: 's', lastUpdated: '2026-11-14', paths: BASE }, rootDir);
    commitAll(rootDir, 'base');

    // "main": URL Inspection adds 6 paths.
    git(rootDir, 'checkout', '-q', '-b', 'inspection');
    writeCompatPaths({ source: 's', lastUpdated: '2026-11-15', paths: [...BASE, ...range('insp', 6)] }, rootDir);
    commitAll(rootDir, 'inspection');

    // The Cloudflare branch: 9 paths, of which 3 overlap with the inspection ones.
    git(rootDir, 'checkout', '-q', 'main');
    git(rootDir, 'checkout', '-q', '-b', 'cloudflare');
    writeCompatPaths({ source: 's', lastUpdated: '2026-11-15', paths: [...BASE, ...range('cf', 6), ...range('insp', 3)] }, rootDir);
    commitAll(rootDir, 'cloudflare');

    const merge = spawnSync('git', ['merge', '--no-edit', 'inspection'], { cwd: rootDir, encoding: 'utf8' });
    expect(merge.status).not.toBe(0);
    expect(git(rootDir, 'diff', '--name-only', '--diff-filter=U').trim()).toBe('data/seo-404-compat/manifest.json');

    // The shards were merged cleanly by the driver (union): 40 + 6 + 6 = 52 paths...
    // ...while the manifest is resolved by hand by taking the PR side (the incident).
    git(rootDir, 'checkout', '--ours', 'data/seo-404-compat/manifest.json');
    git(rootDir, 'add', 'data/seo-404-compat/manifest.json');
    git(rootDir, 'commit', '-q', '--no-edit');

    expect(manifestOf(rootDir).totalPaths).toBe(40 + 6 + 3);
    expect(() => readCompatPathsStrict(rootDir)).toThrow(
      /manifest declares 49 paths, but complete shards contain 52; refusing destructive rewrite/,
    );

    // Closed: tolerated by the additive readers, realigned by the refresh.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(readCompatPathsStrict(rootDir, ADDITIVE_COMPAT_READ).paths).toHaveLength(52);
    expect(String(warn.mock.calls[0][0])).toContain('manifest declares 49 paths, complete shards contain 52 (+3)');
    expect(refreshCompatManifest(rootDir)).toMatchObject({ declaredTotalPaths: 49, actualTotalPaths: 52, changed: true });
    expect(readCompatPathsStrict(rootDir).paths).toHaveLength(52);
  });

  it('only one branch changes totalPaths: the merge is silent and clean, and the lag is invisible to git', () => {
    initRepo(rootDir);
    writeCompatPaths({ source: 's', lastUpdated: '2026-11-14', paths: BASE }, rootDir);
    commitAll(rootDir, 'base');

    // Producer A drops 4 resolved paths: total 36.
    git(rootDir, 'checkout', '-q', '-b', 'producer-a');
    writeCompatPaths({ source: 's', lastUpdated: '2026-11-14', paths: BASE.slice(4) }, rootDir);
    commitAll(rootDir, 'producer a (-4)');

    // Producer B drops the same 4 and adds 4 new ones: its net total is unchanged,
    // so manifest.json is identical to the base on this branch.
    git(rootDir, 'checkout', '-q', 'main');
    git(rootDir, 'checkout', '-q', '-b', 'producer-b');
    writeCompatPaths({ source: 's', lastUpdated: '2026-11-14', paths: [...BASE.slice(4), ...range('b', 4)] }, rootDir);
    commitAll(rootDir, 'producer b (-4 +4)');
    expect(git(rootDir, 'diff', '--name-only', 'main', 'HEAD')).not.toContain('manifest.json');

    git(rootDir, 'merge', '--no-edit', 'producer-a');

    // git merged manifest.json cleanly to producer A's total; the shards hold 40 paths.
    expect(manifestOf(rootDir).totalPaths).toBe(36);
    expect(() => readCompatPathsStrict(rootDir)).toThrow(
      /manifest declares 36 paths, but complete shards contain 40; refusing destructive rewrite/,
    );
    expect(refreshCompatManifest(rootDir)).toMatchObject({ declaredTotalPaths: 36, actualTotalPaths: 40, changed: true });
    expect(readCompatPathsStrict(rootDir).paths).toHaveLength(40);
  });
});

describe('git-push-with-retry.sh realigns the compat manifest after a rebase', () => {
  it('folds the corrected manifest into the head commit before pushing', () => {
    const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-push-remote-'));
    const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-push-seed-'));
    const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-push-local-'));
    const writerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-push-writer-'));
    const wrapDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-push-wrap-'));
    try {
      git(remoteDir, 'init', '-q', '--bare', '-b', 'main');

      initRepo(seedDir);
      writeCompatPaths({ source: 's', lastUpdated: '2026-11-14', paths: BASE }, seedDir);
      commitAll(seedDir, 'seed');
      git(seedDir, 'remote', 'add', 'origin', remoteDir);
      git(seedDir, 'push', '-q', 'origin', 'HEAD:main');

      for (const dir of [localDir, writerDir]) {
        git(dir, 'clone', '-q', '--branch', 'main', remoteDir, '.');
        git(dir, 'config', 'user.email', 'compat-test@example.test');
        git(dir, 'config', 'user.name', 'compat test');
      }

      // Another producer lands first: it drops 4 resolved paths and writes its (coherent) manifest, total 36.
      writeCompatPaths({ source: 's', lastUpdated: '2026-11-15', paths: BASE.slice(4) }, writerDir);
      commitAll(writerDir, 'producer a');
      git(writerDir, 'push', '-q', 'origin', 'HEAD:main');

      // Our producer drops the same 4 and adds 4 new ones, net zero: its manifest is the base one.
      writeCompatPaths({ source: 's', lastUpdated: '2026-11-14', paths: [...BASE.slice(4), ...range('b', 4)] }, localDir);
      commitAll(localDir, 'producer b');

      const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
      const sentinel = path.join(wrapDir, 'first-push-rejected');
      const wrapper = path.join(wrapDir, 'git');
      fs.writeFileSync(
        wrapper,
        `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "push" ] && [ ! -f "\${COMPAT_PUSH_SENTINEL}" ]; then
  : > "\${COMPAT_PUSH_SENTINEL}"
  echo "simulated first push rejection" >&2
  exit 1
fi
exec "\${COMPAT_PUSH_REAL_GIT}" "$@"
`,
      );
      fs.chmodSync(wrapper, 0o755);

      const out = execFileSync('bash', [PUSH_HELPER, '--max-attempts', '3'], {
        cwd: localDir,
        env: {
          ...process.env,
          PATH: `${wrapDir}:${process.env.PATH || ''}`,
          COMPAT_PUSH_REAL_GIT: realGit,
          COMPAT_PUSH_SENTINEL: sentinel,
        },
        encoding: 'utf8',
      });

      expect(out).toContain('Compat manifest total realigned with its shards');
      // Exactly the commit that was local, with the manifest folded in (no extra commit).
      expect(git(remoteDir, 'log', '--format=%s', 'main').trim().split('\n')).toEqual(['producer b', 'producer a', 'seed']);
      const pushedManifest = JSON.parse(git(remoteDir, 'show', 'main:data/seo-404-compat/manifest.json'));
      expect(pushedManifest.totalPaths).toBe(40);
      expect(pushedManifest.source).toBe('s');
      // The helper runs in a temporary clone and the local Node toolchain may
      // leave an untracked node_modules directory there. The assertion is
      // about the pushed tracked tree, not that environment-only directory.
      expect(git(localDir, 'status', '--porcelain', '--untracked-files=no')).toBe('');
      expect(() => readCompatPathsStrict(localDir)).not.toThrow();
    } finally {
      for (const dir of [remoteDir, seedDir, localDir, writerDir, wrapDir]) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 60_000);

  it('is wired in both helpers and never runs without the compat store in the pushed diff', () => {
    const push = fs.readFileSync(PUSH_HELPER, 'utf8');
    expect(push).toContain('realign_compat_manifest');
    expect(push).toContain('git diff-tree -r --name-only --no-renames "origin/${BRANCH}" HEAD -- data/seo-404-compat/');
    const commitData = fs.readFileSync(path.join(ROOT, 'scripts/lib/git-commit-data.sh'), 'utf8');
    const refreshAt = commitData.indexOf('refresh-compat-manifest.mjs');
    const pruneAt = commitData.indexOf('PRUNE_404_STRICT=1 npx tsx scripts/prune-404-compat-paths.ts');
    expect(refreshAt).toBeGreaterThan(0);
    expect(pruneAt).toBeGreaterThan(refreshAt);
  });
});

// ---------------------------------------------------------------------------
// Which scripts may tolerate the lag.
// ---------------------------------------------------------------------------

function code(relativePath: string): string {
  return fs
    .readFileSync(path.join(ROOT, relativePath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('which compat consumers tolerate a lagging manifest', () => {
  // They merge new observations into the set and rewrite it through writeCompatPaths (which
  // recomputes the manifest) behind assertCompatFloor.
  const PRODUCERS = [
    'scripts/discover-404s-via-cloudflare.mjs',
    'scripts/discover-404s-via-inspection.mjs',
    'scripts/ingest-gsc-coverage-404s.ts',
    'scripts/sync-gsc-orphans.mjs',
    'scripts/build-search-cluster-301-map.mjs',
    'scripts/mine-all-job-slugs.mjs',
  ];
  // They REMOVE paths: a shard set that does not match its manifest must stop them.
  const REMOVERS = ['scripts/prune-404-compat-paths.ts', 'scripts/lib/resolve-404-compat-conflict.mjs'];

  it.each(PRODUCERS)('%s reads through the additive mode only', (relativePath) => {
    const source = code(relativePath);
    expect(source).toContain('ADDITIVE_COMPAT_READ');
    expect(source).not.toMatch(/readCompatPathsStrict\(\s*ROOT\s*\)/);
  });

  it.each(REMOVERS)('%s keeps the exact strict read', (relativePath) => {
    const source = code(relativePath);
    expect(source).toContain('readCompatPathsStrict');
    expect(source).not.toContain('ADDITIVE_COMPAT_READ');
    expect(source).not.toContain('allowManifestSurplus');
  });
});
