import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const RECONCILE_SCRIPT = path.join(ROOT, 'scripts/ci/reconcile-data-refresh-main.mjs');
const COMPAT_DRIVER = path.join(ROOT, 'scripts/ci/merge-compat-shard.mjs');
const temporaryRepositories: string[] = [];
const TEST_GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'compat-reconcile-test',
  GIT_AUTHOR_EMAIL: 'compat-reconcile-test@example.invalid',
  GIT_COMMITTER_NAME: 'compat-reconcile-test',
  GIT_COMMITTER_EMAIL: 'compat-reconcile-test@example.invalid',
};

afterEach(() => {
  for (const repository of temporaryRepositories.splice(0)) {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function git(repository: string, args: string[]) {
  return execFileSync('git', args, {
    cwd: repository,
    env: TEST_GIT_ENV,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function writeJson(repository: string, relativePath: string, value: unknown) {
  const file = path.join(repository, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function commit(repository: string, message: string) {
  git(repository, ['add', '-A']);
  git(repository, ['commit', '-q', '-m', message]);
  return git(repository, ['rev-parse', 'HEAD']);
}

function createScenario() {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-refresh-reconcile-'));
  temporaryRepositories.push(repository);
  git(repository, ['init', '-q', '-b', 'main']);
  git(repository, ['config', 'user.name', 'compat-reconcile-test']);
  git(repository, ['config', 'user.email', 'compat-reconcile-test@example.invalid']);
  fs.writeFileSync(
    path.join(repository, '.gitattributes'),
    'data/seo-404-compat/part-*.json merge=compat-shard\n',
  );
  writeJson(repository, 'data/cf-hot-404s.json', {
    generatedAt: '2026-10-07T00:00:00.000Z',
    source: 'cloudflare',
    paths: [
      { path: '/base', hits: 4, lastSeen: '2026-10-07' },
      { path: '/aged-out', hits: 3, lastSeen: '2026-09-01' },
    ],
  });
  writeJson(repository, 'data/seo-404-compat/part-00.json', { paths: ['/base', '/deleted'] });
  writeJson(repository, 'data/seo-404-compat/manifest.json', {
    source: 'cloudflare',
    lastUpdated: '2026-10-07',
    shardCount: 1,
    totalPaths: 2,
  });
  const base = commit(repository, 'base compatibility store');

  git(repository, ['config', 'merge.compat-shard.driver', `node ${COMPAT_DRIVER} %O %A %B`]);
  git(repository, ['checkout', '-q', '-b', 'refresh']);
  writeJson(repository, 'data/cf-hot-404s.json', {
    generatedAt: '2026-10-08T02:00:00.000Z',
    source: 'cloudflare',
    paths: [
      { path: '/base', hits: 6, lastSeen: '2026-10-08' },
      { path: '/refresh', hits: 9, lastSeen: '2026-10-08' },
    ],
  });
  writeJson(repository, 'data/seo-404-compat/part-00.json', { paths: ['/base', '/refresh'] });
  writeJson(repository, 'data/seo-404-compat/manifest.json', {
    source: 'cloudflare',
    lastUpdated: '2026-10-08',
    shardCount: 1,
    totalPaths: 2,
  });
  const refresh = commit(repository, 'refresh compatibility store');

  git(repository, ['checkout', '-q', 'main']);
  writeJson(repository, 'data/cf-hot-404s.json', {
    generatedAt: '2026-10-08T01:00:00.000Z',
    source: 'cloudflare',
    paths: [
      { path: '/base', hits: 8, lastSeen: '2026-10-08' },
      { path: '/main', hits: 7, lastSeen: '2026-10-08' },
    ],
  });
  writeJson(repository, 'data/seo-404-compat/part-00.json', { paths: ['/base', '/main'] });
  writeJson(repository, 'data/seo-404-compat/manifest.json', {
    source: 'cloudflare',
    lastUpdated: '2026-10-09',
    shardCount: 1,
    totalPaths: 2,
  });
  const main = commit(repository, 'main compatibility store update');

  git(repository, ['checkout', '-q', 'refresh']);
  return { repository, base, refresh, main };
}

function createNoShardScenario() {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-refresh-no-shard-'));
  temporaryRepositories.push(repository);
  git(repository, ['init', '-q', '-b', 'main']);
  git(repository, ['config', 'user.name', 'compat-reconcile-test']);
  git(repository, ['config', 'user.email', 'compat-reconcile-test@example.invalid']);
  writeJson(repository, 'data/cf-hot-404s.json', {
    generatedAt: '2026-10-07T00:00:00.000Z',
    source: 'cloudflare',
    paths: [{ path: '/base', hits: 4, lastSeen: '2026-10-07' }],
  });
  writeJson(repository, 'data/seo-404-compat/manifest.json', {
    source: 'cloudflare',
    lastUpdated: '2026-10-07',
    shardCount: 3,
    totalPaths: 3,
  });
  const base = commit(repository, 'base compatibility manifest without shards');

  git(repository, ['checkout', '-q', '-b', 'refresh']);
  writeJson(repository, 'data/cf-hot-404s.json', {
    generatedAt: '2026-10-08T02:00:00.000Z',
    source: 'cloudflare',
    paths: [{ path: '/refresh', hits: 9, lastSeen: '2026-10-08' }],
  });
  writeJson(repository, 'data/seo-404-compat/manifest.json', {
    source: 'cloudflare',
    lastUpdated: '2026-10-08',
    shardCount: 3,
    totalPaths: 3,
  });
  const refresh = commit(repository, 'refresh compatibility manifest without shards');

  git(repository, ['checkout', '-q', 'main']);
  writeJson(repository, 'data/cf-hot-404s.json', {
    generatedAt: '2026-10-08T01:00:00.000Z',
    source: 'cloudflare',
    paths: [{ path: '/main', hits: 7, lastSeen: '2026-10-08' }],
  });
  writeJson(repository, 'data/seo-404-compat/manifest.json', {
    source: 'cloudflare',
    lastUpdated: '2026-10-09',
    shardCount: 3,
    totalPaths: 3,
  });
  const main = commit(repository, 'main compatibility manifest without shards');

  git(repository, ['checkout', '-q', 'refresh']);
  return { repository, base, refresh, main };
}

function createManifestDeletionScenario() {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-refresh-manifest-delete-'));
  temporaryRepositories.push(repository);
  git(repository, ['init', '-q', '-b', 'main']);
  git(repository, ['config', 'user.name', 'compat-reconcile-test']);
  git(repository, ['config', 'user.email', 'compat-reconcile-test@example.invalid']);
  writeJson(repository, 'data/cf-hot-404s.json', {
    generatedAt: '2026-10-07T00:00:00.000Z',
    source: 'cloudflare',
    paths: [{ path: '/base', hits: 4, lastSeen: '2026-10-07' }],
  });
  writeJson(repository, 'data/seo-404-compat/manifest.json', {
    source: 'cloudflare',
    lastUpdated: '2026-10-07',
    shardCount: 1,
    totalPaths: 1,
  });
  const base = commit(repository, 'base compatibility manifest');

  git(repository, ['checkout', '-q', '-b', 'refresh']);
  writeJson(repository, 'data/cf-hot-404s.json', {
    generatedAt: '2026-10-08T02:00:00.000Z',
    source: 'cloudflare',
    paths: [{ path: '/refresh', hits: 9, lastSeen: '2026-10-08' }],
  });
  const refresh = commit(repository, 'refresh keeps base compatibility manifest');

  git(repository, ['checkout', '-q', 'main']);
  fs.rmSync(path.join(repository, 'data/seo-404-compat/manifest.json'));
  writeJson(repository, 'data/cf-hot-404s.json', {
    generatedAt: '2026-10-08T01:00:00.000Z',
    source: 'cloudflare',
    paths: [{ path: '/main', hits: 7, lastSeen: '2026-10-08' }],
  });
  const main = commit(repository, 'main deletes compatibility manifest');

  git(repository, ['checkout', '-q', 'refresh']);
  return { repository, base, refresh, main };
}

function createCompatDeletionScenario() {
  const scenario = createScenario();
  const compatFiles = [
    'data/cf-hot-404s.json',
    'data/seo-404-compat/part-00.json',
    'data/seo-404-compat/manifest.json',
  ];

  git(scenario.repository, ['checkout', '-q', 'refresh']);
  for (const file of compatFiles) fs.rmSync(path.join(scenario.repository, file));
  const refresh = commit(scenario.repository, 'refresh deletes compatibility data');

  git(scenario.repository, ['checkout', '-q', 'main']);
  for (const file of compatFiles) fs.rmSync(path.join(scenario.repository, file));
  const main = commit(scenario.repository, 'main deletes compatibility data');

  git(scenario.repository, ['checkout', '-q', 'refresh']);
  return { ...scenario, refresh, main };
}

describe('compatibility data refresh reconciliation', () => {
  it('merges Cloudflare data and recomputes the compat manifest after main moves', () => {
    const scenario = createScenario();
    const result = spawnSync(process.execPath, [
      RECONCILE_SCRIPT,
      '--compat',
      '--base', scenario.base,
      '--main', scenario.main,
      '--message', 'reconcile compatibility data test',
    ], {
      cwd: scenario.repository,
      env: { ...TEST_GIT_ENV, GIT_NO_LAZY_FETCH: '1' },
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('resolved 2 compatibility conflict(s)');

    const hot = JSON.parse(fs.readFileSync(
      path.join(scenario.repository, 'data/cf-hot-404s.json'),
      'utf8',
    ));
    expect(hot.paths).toEqual([
      { path: '/refresh', hits: 9, lastSeen: '2026-10-08' },
      { path: '/base', hits: 8, lastSeen: '2026-10-08' },
      { path: '/main', hits: 7, lastSeen: '2026-10-08' },
    ]);
    expect(hot.paths).not.toContainEqual(expect.objectContaining({ path: '/aged-out' }));

    const shard = JSON.parse(fs.readFileSync(
      path.join(scenario.repository, 'data/seo-404-compat/part-00.json'),
      'utf8',
    ));
    expect(shard.paths).toEqual(['/base', '/main', '/refresh']);

    const manifest = JSON.parse(fs.readFileSync(
      path.join(scenario.repository, 'data/seo-404-compat/manifest.json'),
      'utf8',
    ));
    expect(manifest).toEqual({
      source: 'cloudflare',
      lastUpdated: '2026-10-09',
      shardCount: 1,
      totalPaths: 3,
    });
    expect(git(scenario.repository, ['rev-list', '--parents', '-n', '1', 'HEAD']).split(' ').slice(1))
      .toEqual([scenario.refresh, scenario.main]);
  });

  it('reports zero shards when the merged tree has no compatibility shard files', () => {
    const scenario = createNoShardScenario();
    const result = spawnSync(process.execPath, [
      RECONCILE_SCRIPT,
      '--compat',
      '--base', scenario.base,
      '--main', scenario.main,
      '--message', 'reconcile empty compatibility shard set',
    ], {
      cwd: scenario.repository,
      env: { ...TEST_GIT_ENV, GIT_NO_LAZY_FETCH: '1' },
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
    const manifest = JSON.parse(fs.readFileSync(
      path.join(scenario.repository, 'data/seo-404-compat/manifest.json'),
      'utf8',
    ));
    expect(manifest.shardCount).toBe(0);
    expect(manifest.totalPaths).toBe(0);
  });

  it('keeps a manifest deletion when the refresh side is unchanged from base', () => {
    const scenario = createManifestDeletionScenario();
    const result = spawnSync(process.execPath, [
      RECONCILE_SCRIPT,
      '--compat',
      '--base', scenario.base,
      '--main', scenario.main,
      '--message', 'reconcile deleted compatibility manifest',
    ], {
      cwd: scenario.repository,
      env: { ...TEST_GIT_ENV, GIT_NO_LAZY_FETCH: '1' },
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(git(scenario.repository, ['ls-files', '--stage', '--', 'data/seo-404-compat/manifest.json']))
      .toBe('');
    expect(git(scenario.repository, ['ls-tree', '-r', '--name-only', 'HEAD', '--', 'data/seo-404-compat/manifest.json']))
      .toBe('');
  });

  it('preserves bilateral deletion and removes compatibility files from the worktree', () => {
    const scenario = createCompatDeletionScenario();
    const result = spawnSync(process.execPath, [
      RECONCILE_SCRIPT,
      '--compat',
      '--base', scenario.base,
      '--main', scenario.main,
      '--message', 'reconcile deleted compatibility store',
    ], {
      cwd: scenario.repository,
      env: { ...TEST_GIT_ENV, GIT_NO_LAZY_FETCH: '1' },
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
    for (const file of [
      'data/cf-hot-404s.json',
      'data/seo-404-compat/part-00.json',
      'data/seo-404-compat/manifest.json',
    ]) {
      expect(fs.existsSync(path.join(scenario.repository, file)), file).toBe(false);
      expect(git(scenario.repository, ['ls-files', '--', file]), file).toBe('');
    }
    expect(git(scenario.repository, ['ls-files', '--deleted'])).toBe('');
  });
});
