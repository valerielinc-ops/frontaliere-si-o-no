import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const directories: string[] = [];
const identity = {
  GIT_AUTHOR_NAME: 'frontaliere-automation[bot]',
  GIT_AUTHOR_EMAIL: '296434481+frontaliere-automation[bot]@users.noreply.github.com',
  GIT_COMMITTER_NAME: 'frontaliere-automation[bot]',
  GIT_COMMITTER_EMAIL: '296434481+frontaliere-automation[bot]@users.noreply.github.com',
};

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function git(cwd: string, args: string[]) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...identity },
  }).trim();
}

function write(repo: string, file: string, content: string) {
  const target = path.join(repo, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

// Every file the publisher runs: a fixture repository needs all of them.
const PUBLISHER_RUNTIME_FILES = [
  'scripts/lib/open-data-refresh-pr.sh',
  'scripts/lib/old-history-guard.mjs',
  'scripts/lib/run-bounded-command.mjs',
  'scripts/lib/single-flight-lock.mjs',
  'scripts/lib/git-add-resolved.mjs',
  'scripts/lib/resolve-git-add-path.mjs',
  'scripts/lib/read-git-blob.mjs',
  'scripts/ci/merge-open-data-refresh.mjs',
  'scripts/ci/open-data-refresh-merge.mjs',
  'scripts/ci/reconcile-data-refresh-main.mjs',
];

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-checkout-'));
  directories.push(directory);
  const repo = path.join(directory, 'source');
  const remote = path.join(directory, 'remote.git');
  fs.mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  for (const file of PUBLISHER_RUNTIME_FILES) write(repo, file, fs.readFileSync(path.join(ROOT, file), 'utf8'));
  // The body gate is tested separately; this fixture exercises real Git and
  // module imports without a GitHub connection or its automation surface.
  write(repo, 'scripts/ci/pr-body-check-gate.mjs', 'process.exit(0);\n');
  write(repo, 'scripts/crawler.mjs', 'console.log("old crawler");\n');
  write(repo, 'data/cache.json', '{"version":"base"}\n');
  write(repo, 'data/history.jsonl', '{"run":"base"}\n');
  write(repo, 'data/unpublished.json', '{"version":"base"}\n');
  write(repo, 'data/events-geocode-cache.json', '{"common":{"lat":1,"lng":2}}\n');
  write(repo, 'data/events-translation-cache.json', '{"title":{"en":"base"}}\n');
  write(repo, 'packages/articles/content/body.ts', 'export default "base";\n');
  write(repo, 'packages/articles/content/image-credits/blog/cover.json', '{"source":"base"}\n');
  fs.mkdirSync(path.join(repo, 'services'));
  fs.symlinkSync('../packages/articles/content/body.ts', path.join(repo, 'services/body.ts'));
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'fixture base']);
  const base = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['checkout', '-q', '-b', 'chore/refresh']);
  write(repo, 'scripts/ci/merge-open-data-refresh.mjs', 'throw new Error("stale reconciler");\n');
  write(repo, 'data/cache.json', '{"version":"pending"}\n');
  write(repo, 'data/history.jsonl', '{"run":"base"}\n{"run":"pending"}\n');
  write(repo, 'data/pending-only.json', '{"preserved":true}\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'pending refresh from old code']);
  git(repo, ['checkout', '-q', 'main']);
  write(repo, 'scripts/crawler.mjs', 'console.log("current crawler");\n');
  git(repo, ['add', 'scripts/crawler.mjs']);
  git(repo, ['commit', '-q', '-m', 'current crawler']);
  git(directory, ['init', '--bare', '-q', remote]);
  git(repo, ['remote', 'add', 'origin', remote]);
  git(repo, ['push', '-q', 'origin', 'main', 'chore/refresh']);
  git(repo, ['config', `url.${remote}.insteadOf`, 'https://x-access-token:fixture-token@github.com/fixture/publisher.git']);
  const bin = path.join(directory, 'bin');
  fs.mkdirSync(bin);
  const gh = path.join(bin, 'gh');
  fs.writeFileSync(gh, `#!/bin/sh\nif [ "$REFRESH_FIXTURE_GH_FAIL" = 1 ]; then exit 19; fi\nif [ "$1 $2" = "pr list" ]; then echo 42; fi\nif [ "$1" = "api" ]; then echo ${base}; fi\n`);
  fs.chmodSync(gh, 0o755);
  const body = path.join(directory, 'body.md');
  fs.writeFileSync(body, '## Implementato\n- Fixture refresh.\n\n## Non implementato (ancora)\n- Nessuno.\n');
  return { repo, remote, bin, body, base };
}

function publish(setup: ReturnType<typeof fixture>, fail = false, extraArgs: string[] = []) {
  return spawnSync('bash', [
    'scripts/lib/open-data-refresh-pr.sh',
    '--path', 'data/cache.json', '--path', 'data/history.jsonl', '--path', 'services/body.ts',
    '--resolve-symlinks', '--branch', 'chore/refresh', '--commit-message', 'fixture refresh',
    '--title', 'Fixture refresh', '--body-file', setup.body,
    ...extraArgs,
  ], {
    cwd: setup.repo, encoding: 'utf8',
    env: {
      ...process.env, ...identity,
      PATH: `${setup.bin}${path.delimiter}${process.env.PATH || ''}`,
      GH_TOKEN: 'fixture-token', GITHUB_REPOSITORY: 'fixture/publisher',
      REFRESH_FIXTURE_GH_FAIL: fail ? '1' : '0',
    },
  });
}

function publishPlain(setup: ReturnType<typeof fixture>, extraArgs: string[] = []) {
  // Same call shape as sync-articles-sitemaps.yml: plain `git add`, no symlink
  // resolution, required paths first and the optional directory last.
  return spawnSync('bash', [
    'scripts/lib/open-data-refresh-pr.sh',
    '--path', 'data/cache.json', '--path', 'data/history.jsonl',
    ...extraArgs,
    '--branch', 'chore/refresh', '--commit-message', 'fixture refresh',
    '--title', 'Fixture refresh', '--body-file', setup.body,
  ], {
    cwd: setup.repo, encoding: 'utf8',
    env: {
      ...process.env, ...identity,
      PATH: `${setup.bin}${path.delimiter}${process.env.PATH || ''}`,
      GH_TOKEN: 'fixture-token', GITHUB_REPOSITORY: 'fixture/publisher',
      REFRESH_FIXTURE_GH_FAIL: '0',
    },
  });
}

describe('optional refresh paths (sync run 37515283217)', () => {
  // The article sync lists `public/images/generated`, a directory that does not
  // exist until the publisher emits its first governed cover. `git add` aborted
  // with `fatal: pathspec ... did not match any files` and the whole refresh —
  // corpus, sitemaps, feeds — was lost with it.
  it.each([
    ['plain git add', publishPlain],
    ['resolved symlinks', (setup: ReturnType<typeof fixture>, extra: string[]) => publish(setup, false, extra)],
  ] as const)('skips an optional path that does not exist yet and publishes the rest (%s)', (_mode, run) => {
    const setup = fixture();
    write(setup.repo, 'data/cache.json', '{"version":"current"}\n');
    const result = run(setup, ['--optional-path', 'public/images/generated']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      'Optional refresh path absent and untracked, nothing to stage: public/images/generated',
    );
    expect(git(setup.remote, ['show', 'chore/refresh:data/cache.json'])).toBe('{"version":"current"}');
  });

  it('stages an optional path once the producer has created it', () => {
    const setup = fixture();
    write(setup.repo, 'data/cache.json', '{"version":"current"}\n');
    // A sidecar, not a fake image: the reconciler refuses unreadable images.
    write(setup.repo, 'public/images/generated/credits.json', '{"cover":"governed"}\n');
    const result = publishPlain(setup, ['--optional-path', 'public/images/generated']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('Optional refresh path absent');
    expect(git(setup.remote, ['show', 'chore/refresh:public/images/generated/credits.json'])).toBe('{"cover":"governed"}');
  });

  it.each([false, true])('stages only a generated sparse file, never an absent tracked sibling (force=%s)', (force) => {
    const setup = fixture();
    write(setup.repo, 'public/images/generated/existing.json', '{"cover":"old"}\n');
    git(setup.repo, ['add', 'public/images/generated/existing.json']);
    git(setup.repo, ['commit', '-q', '-m', 'tracked sparse sibling']);
    git(setup.repo, ['push', '-q', 'origin', 'main']);
    git(setup.repo, ['checkout', '-q', 'chore/refresh']);
    write(setup.repo, 'public/images/generated/existing.json', '{"cover":"old"}\n');
    git(setup.repo, ['add', 'public/images/generated/existing.json']);
    git(setup.repo, ['commit', '-q', '-m', 'tracked sparse sibling']);
    git(setup.repo, ['push', '-q', 'origin', 'chore/refresh']);
    git(setup.repo, ['checkout', '-q', 'main']);
    git(setup.repo, ['sparse-checkout', 'init', '--no-cone']);
    git(setup.repo, ['sparse-checkout', 'set', '--no-cone', '/data/', '/scripts/']);
    write(setup.repo, 'data/cache.json', '{"version":"current"}\n');
    write(setup.repo, 'public/images/generated/new.json', '{"cover":"new"}\n');
    const result = publishPlain(setup, [
      ...(force ? ['--force'] : []),
      '--optional-path', 'public/images/generated',
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(git(setup.remote, ['show', 'chore/refresh:public/images/generated/existing.json'])).toBe('{"cover":"old"}');
    expect(git(setup.remote, ['show', 'chore/refresh:public/images/generated/new.json'])).toBe('{"cover":"new"}');
  });

  it.each([
    ['plain git add', publishPlain],
    ['resolved symlinks', (setup: ReturnType<typeof fixture>, extra: string[]) => publish(setup, false, extra)],
  ] as const)('skips an optional directory that exists but has nothing to stage (%s)', (_mode, run) => {
    // The producer may create the directory before it writes the first file.
    // Git has nothing to add there, so the path must not enter the staging set.
    const setup = fixture();
    write(setup.repo, 'data/cache.json', '{"version":"current"}\n');
    fs.mkdirSync(path.join(setup.repo, 'public/images/generated'), { recursive: true });
    const result = run(setup, ['--optional-path', 'public/images/generated']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain('did not match any files');
    expect(result.stdout).toContain(
      'Optional refresh path has nothing to stage: public/images/generated',
    );
    expect(git(setup.remote, ['show', 'chore/refresh:data/cache.json'])).toBe('{"version":"current"}');
  });

  it('stages the deletion of a tracked optional directory that disappeared', () => {
    // Tracked on main, then removed by the producer: the optional path no
    // longer exists on disk but the index still knows its child, and the
    // refresh must carry the deletion instead of skipping the path.
    const setup = fixture();
    write(setup.repo, 'public/images/generated/credits.json', '{"cover":"governed"}\n');
    git(setup.repo, ['add', 'public/images/generated/credits.json']);
    git(setup.repo, ['commit', '-q', '-m', 'tracked cover sidecar']);
    git(setup.repo, ['push', '-q', 'origin', 'main']);
    fs.rmSync(path.join(setup.repo, 'public/images/generated'), { recursive: true });
    write(setup.repo, 'data/cache.json', '{"version":"current"}\n');
    const result = publishPlain(setup, ['--optional-path', 'public/images/generated']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('Optional refresh path');
    const tree = git(setup.remote, ['ls-tree', '-r', '--name-only', 'chore/refresh']);
    expect(tree).not.toContain('public/images/generated/credits.json');
    expect(git(setup.remote, ['show', 'chore/refresh:data/cache.json'])).toBe('{"version":"current"}');
  });

  it('treats a repeated optional path as one', () => {
    const setup = fixture();
    write(setup.repo, 'data/cache.json', '{"version":"current"}\n');
    write(setup.repo, 'public/images/generated/credits.json', '{"cover":"governed"}\n');
    const result = publishPlain(setup, [
      '--optional-path', 'public/images/generated',
      '--optional-path', 'public/images/generated',
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(git(setup.remote, ['show', 'chore/refresh:public/images/generated/credits.json'])).toBe('{"cover":"governed"}');
  });

  it('judges an optional alias at its real path when symlinks are resolved', () => {
    // The alias directory is a symlink: git cannot list untracked files
    // through it, so the decision must be taken on the resolved path.
    const setup = fixture();
    fs.symlinkSync('../packages/articles/content', path.join(setup.repo, 'services/content-alias'));
    write(setup.repo, 'data/cache.json', '{"version":"current"}\n');
    write(setup.repo, 'packages/articles/content/fresh.ts', 'export default "fresh";\n');
    const result = publish(setup, false, ['--optional-path', 'services/content-alias/fresh.ts']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('Optional refresh path');
    expect(git(setup.remote, ['show', 'chore/refresh:packages/articles/content/fresh.ts'])).toBe('export default "fresh";');
  });

  it('keeps failing loudly when a REQUIRED path matches nothing', () => {
    const setup = fixture();
    const pendingHead = git(setup.remote, ['rev-parse', 'chore/refresh']);
    write(setup.repo, 'data/cache.json', '{"version":"current"}\n');
    const result = publishPlain(setup, ['--path', 'public/images/generated']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("pathspec 'public/images/generated' did not match any files");
    expect(git(setup.remote, ['rev-parse', 'chore/refresh'])).toBe(pendingHead);
  });

  it('declares the generated covers directory optional in the article sync workflow', () => {
    const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/sync-articles-sitemaps.yml'), 'utf8');
    expect(workflow).toContain('--optional-path public/images/generated');
    expect(workflow).not.toContain('--path public/images/generated');
  });
});

describe('data publisher preserves its source checkout', () => {
  it('carries destination-only image-credit records into a stable branch with old deletions', () => {
    const setup = fixture();
    // Simulate the failed historical refresh: the stable branch deleted a
    // credit file that the current main snapshot still carries unchanged.
    git(setup.repo, ['checkout', '-q', 'chore/refresh']);
    fs.rmSync(path.join(setup.repo, 'packages/articles/content/image-credits'), { recursive: true });
    git(setup.repo, ['add', '-A', 'packages/articles/content/image-credits']);
    git(setup.repo, ['commit', '-q', '-m', 'old stable refresh deleted cover credits']);
    git(setup.repo, ['push', '-q', 'origin', 'chore/refresh']);
    git(setup.repo, ['checkout', '-q', 'main']);

    write(setup.repo, 'data/cache.json', '{"version":"current"}\n');
    const result = publish(setup, false, ['--path', 'packages/articles/content']);

    expect(result.status, result.stderr).toBe(0);
    expect(git(setup.remote, ['show', 'chore/refresh:packages/articles/content/image-credits/blog/cover.json']))
      .toBe('{"source":"base"}');
  });

  it('uses current helper dependencies and preserves source code across consecutive publishes', () => {
    const setup = fixture();
    write(setup.repo, 'data/cache.json', '{"version":"current"}\n');
    write(setup.repo, 'data/history.jsonl', '{"run":"base"}\n{"run":"current"}\n');
    write(setup.repo, 'services/body.ts', 'export default "current";\n');
    write(setup.repo, 'data/unpublished.json', '{"version":"unpublished"}\n');
    const first = publish(setup);
    expect(first.stderr, first.stdout).not.toContain('ERR_MODULE_NOT_FOUND');
    expect(first.status, first.stderr).toBe(0);
    expect(git(setup.repo, ['branch', '--show-current'])).toBe('main');
    expect(execFileSync(process.execPath, ['scripts/crawler.mjs'], { cwd: setup.repo, encoding: 'utf8' }).trim()).toBe('current crawler');
    expect(fs.readFileSync(path.join(setup.repo, 'data/unpublished.json'), 'utf8')).toBe('{"version":"unpublished"}\n');
    expect(git(setup.remote, ['show', 'chore/refresh:data/cache.json'])).toBe('{"version":"current"}');
    expect(git(setup.remote, ['show', 'chore/refresh:data/history.jsonl'])).toBe('{"run":"base"}\n{"run":"pending"}\n{"run":"current"}');
    expect(git(setup.remote, ['show', 'chore/refresh:packages/articles/content/body.ts'])).toBe('export default "current";');
    expect(git(setup.remote, ['show', 'chore/refresh:data/pending-only.json'])).toBe('{"preserved":true}');
    write(setup.repo, 'data/cache.json', '{"version":"second"}\n');
    const second = publish(setup);
    expect(second.status, second.stderr).toBe(0);
    expect(git(setup.remote, ['show', 'chore/refresh:data/cache.json'])).toBe('{"version":"second"}');
    expect(git(setup.repo, ['worktree', 'list', '--porcelain']).match(/^worktree /gm)).toHaveLength(1);
  });

  it.each([false, true])('leaves code and uncommitted data intact on publication failure (main reconciliation: %s)', (reconcileMain) => {
    const setup = fixture();
    const pendingHead = git(setup.remote, ['rev-parse', 'chore/refresh']);
    write(setup.repo, 'data/cache.json', '{"version":"current"}\n');
    write(setup.repo, 'data/unpublished.json', '{"version":"unpublished"}\n');
    expect(publish(setup, true, reconcileMain ? ['--reconcile-main'] : []).status).not.toBe(0);
    if (reconcileMain) expect(git(setup.remote, ['rev-parse', 'chore/refresh'])).toBe(pendingHead);
    expect(git(setup.repo, ['branch', '--show-current'])).toBe('main');
    expect(fs.readFileSync(path.join(setup.repo, 'scripts/crawler.mjs'), 'utf8')).toContain('current crawler');
    expect(fs.readFileSync(path.join(setup.repo, 'data/unpublished.json'), 'utf8')).toBe('{"version":"unpublished"}\n');
    expect(git(setup.repo, ['worktree', 'list', '--porcelain']).match(/^worktree /gm)).toHaveLength(1);
  });

  it.each([false, true])('reconciles conflicting event caches in a shallow clone (no fresh changes: %s)', (noFreshChanges) => {
    const setup = fixture();
    git(setup.repo, ['checkout', '-q', 'chore/refresh']);
    write(setup.repo, 'data/events-geocode-cache.json', '{"common":{"lat":1,"lng":2},"pending":{"lat":3,"lng":4}}\n');
    write(setup.repo, 'data/events-translation-cache.json', '{"title":{"en":"base","de":"pending"}}\n');
    git(setup.repo, ['add', 'data/events-geocode-cache.json', 'data/events-translation-cache.json']);
    git(setup.repo, ['commit', '-q', '-m', 'pending cache additions']);
    git(setup.repo, ['push', '-q', 'origin', 'chore/refresh']);
    git(setup.repo, ['checkout', '-q', 'main']);
    write(setup.repo, 'data/events-geocode-cache.json', '{"common":{"lat":5,"lng":6},"main":{"lat":7,"lng":8}}\n');
    write(setup.repo, 'data/events-translation-cache.json', '{"title":{"en":"corrected","fr":"main"}}\n');
    git(setup.repo, ['add', 'data/events-geocode-cache.json', 'data/events-translation-cache.json']);
    git(setup.repo, ['commit', '-q', '-m', 'main cache additions']);
    const mainHead = git(setup.repo, ['rev-parse', 'HEAD']);
    git(setup.repo, ['push', '-q', 'origin', 'main']);
    const shallow = path.join(path.dirname(setup.repo), 'shallow');
    git(setup.repo, ['clone', '-q', '--depth=1', '--branch', 'main', `file://${setup.remote}`, shallow]);
    setup.repo = shallow;
    git(setup.repo, ['config', `url.${setup.remote}.insteadOf`, 'https://x-access-token:fixture-token@github.com/fixture/publisher.git']);
    expect(spawnSync('git', ['cat-file', '-e', `${setup.base}^{commit}`], { cwd: setup.repo }).status).not.toBe(0);
    if (!noFreshChanges) write(setup.repo, 'data/cache.json', '{"version":"current"}\n');
    write(setup.repo, 'data/unpublished.json', '{"version":"unpublished"}\n');
    const sourceHead = git(setup.repo, ['rev-parse', 'HEAD']);
    const result = publish(setup, false, ['--reconcile-main']);
    expect(result.status, result.stderr).toBe(0);
    const geo = JSON.parse(git(setup.remote, ['show', 'chore/refresh:data/events-geocode-cache.json']));
    expect(geo).toEqual({ common: { lat: 5, lng: 6 }, main: { lat: 7, lng: 8 }, pending: { lat: 3, lng: 4 } });
    const translations = JSON.parse(git(setup.remote, ['show', 'chore/refresh:data/events-translation-cache.json']));
    expect(translations).toEqual({ title: { en: 'corrected', fr: 'main', de: 'pending' } });
    expect(git(setup.remote, ['rev-parse', 'chore/refresh^2'])).toBe(mainHead);
    if (noFreshChanges) expect(git(setup.repo, ['rev-parse', 'HEAD'])).toBe(sourceHead);
    expect(git(setup.remote, ['show', '-s', '--format=%an|%ae|%cn|%ce', 'chore/refresh'])).toBe(
      `${identity.GIT_AUTHOR_NAME}|${identity.GIT_AUTHOR_EMAIL}|${identity.GIT_COMMITTER_NAME}|${identity.GIT_COMMITTER_EMAIL}`,
    );
    expect(git(setup.repo, ['rev-parse', '--is-shallow-repository'])).toBe('true');
    expect(git(setup.repo, ['cat-file', '-t', setup.base])).toBe('commit');
    expect(git(setup.remote, ['merge-tree', '--write-tree', 'main', 'chore/refresh'])).not.toContain('CONFLICT');
    expect(fs.readFileSync(path.join(setup.repo, 'data/unpublished.json'), 'utf8')).toBe('{"version":"unpublished"}\n');
    expect(git(setup.repo, ['worktree', 'list', '--porcelain']).match(/^worktree /gm)).toHaveLength(1);
  });

  it('does not push a main reconciliation with conflicts outside event caches', () => {
    const setup = fixture();
    git(setup.repo, ['checkout', '-q', 'chore/refresh']);
    write(setup.repo, 'data/unexpected.json', '{"branch":"pending"}\n');
    git(setup.repo, ['add', 'data/unexpected.json']);
    git(setup.repo, ['commit', '-q', '-m', 'pending unexpected data']);
    git(setup.repo, ['push', '-q', 'origin', 'chore/refresh']);
    const pendingHead = git(setup.remote, ['rev-parse', 'chore/refresh']);
    git(setup.repo, ['checkout', '-q', 'main']);
    write(setup.repo, 'data/unexpected.json', '{"branch":"main"}\n');
    git(setup.repo, ['add', 'data/unexpected.json']);
    git(setup.repo, ['commit', '-q', '-m', 'main unexpected data']);
    git(setup.repo, ['push', '-q', 'origin', 'main']);
    write(setup.repo, 'data/cache.json', '{"version":"current"}\n');
    write(setup.repo, 'data/unpublished.json', '{"version":"unpublished"}\n');
    const result = publish(setup, false, ['--reconcile-main']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Unresolved refresh conflict outside event caches: data/unexpected.json');
    expect(git(setup.remote, ['rev-parse', 'chore/refresh'])).toBe(pendingHead);
    expect(fs.readFileSync(path.join(setup.repo, 'data/unpublished.json'), 'utf8')).toBe('{"version":"unpublished"}\n');
    expect(git(setup.repo, ['worktree', 'list', '--porcelain']).match(/^worktree /gm)).toHaveLength(1);
  });
});

// ── A new stable branch while main keeps moving (issue 12262) ────────────────
const PUSH_URL = 'https://x-access-token:fixture-token@github.com/fixture/publisher.git';
const NEW_BRANCH = 'chore/sitemap-fixture';

/**
 * A runner in the state of the hub job at the moment it pushes: a depth-1
 * checkout of main and, when `afterHistoryGuard`, the two fetches the history
 * guard makes once it can reach its marker (treeless marker, then a treeless
 * `--unshallow` of main). The remote is a bare repository with a real history;
 * the fake `gh` performs the two Git-refs calls on it and logs every call.
 */
function movingMainFixture({ afterHistoryGuard }: { afterHistoryGuard: boolean }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-push-base-'));
  directories.push(directory);
  const seed = path.join(directory, 'seed');
  const remote = path.join(directory, 'remote.git');
  const runner = path.join(directory, 'runner');
  fs.mkdirSync(seed);
  git(seed, ['init', '-q', '-b', 'main']);
  for (const file of PUBLISHER_RUNTIME_FILES) write(seed, file, fs.readFileSync(path.join(ROOT, file), 'utf8'));
  write(seed, 'scripts/ci/pr-body-check-gate.mjs', 'process.exit(0);\n');
  let round = 0;
  const commitRound = () => {
    round += 1;
    for (let dir = 1; dir <= 4; dir += 1) {
      for (let file = 1; file <= 5; file += 1) write(seed, `data/dir${dir}/file${file}.txt`, `round ${round} dir ${dir} file ${file}\n`);
    }
    git(seed, ['add', '-A']);
    git(seed, ['commit', '-q', '-m', `round ${round}`]);
  };
  for (let index = 0; index < 3; index += 1) commitRound();
  // Stands for the previous history, where the guard's marker lives.
  git(seed, ['checkout', '-q', '-b', 'old-history']);
  commitRound();
  const marker = git(seed, ['rev-parse', 'HEAD']);
  git(seed, ['checkout', '-q', 'main']);
  for (let index = 0; index < 9; index += 1) commitRound();

  git(directory, ['init', '--bare', '-q', '-b', 'main', remote]);
  git(remote, ['config', 'uploadpack.allowFilter', 'true']);
  git(remote, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
  // Every push is kept as a pack and nothing repacks behind the test's back,
  // so the packs count exactly what was sent, objects the remote already had
  // included. (After a push Git starts `maintenance run --auto` detached: left
  // on, it merges the packs while the test is still counting.)
  git(remote, ['config', 'receive.unpackLimit', '1']);
  for (const key of ['receive.autogc', 'maintenance.auto']) git(remote, ['config', key, 'false']);
  git(remote, ['config', 'gc.auto', '0']);
  git(seed, ['push', '-q', remote, 'main:refs/heads/main', 'old-history:refs/pull/1/head']);
  // GitHub does not advertise refs/pull/* to a pusher.
  git(remote, ['config', 'receive.hideRefs', 'refs/pull']);
  const historyObjects = git(seed, ['rev-list', '--objects', 'main']).split('\n').length;

  git(directory, ['clone', '-q', '--depth=1', '--no-tags', '--branch', 'main', `file://${remote}`, runner]);
  git(runner, ['config', `url.${remote}.insteadOf`, PUSH_URL]);
  git(runner, ['config', 'maintenance.auto', 'false']);
  git(runner, ['config', 'gc.auto', '0']);
  if (afterHistoryGuard) {
    git(runner, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--filter=tree:0', PUSH_URL, marker]);
    git(runner, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--unshallow', '--filter=tree:0', PUSH_URL, 'refs/heads/main']);
  }
  const checkout = git(runner, ['rev-parse', 'HEAD']);

  const bin = path.join(directory, 'bin');
  fs.mkdirSync(bin);
  const ghLog = path.join(directory, 'gh.log');
  fs.writeFileSync(ghLog, '');
  const gh = path.join(bin, 'gh');
  fs.writeFileSync(gh, [
    '#!/usr/bin/env node',
    "const { spawnSync } = require('node:child_process');",
    "const fs = require('node:fs');",
    `const remote = ${JSON.stringify(remote)};`,
    'const args = process.argv.slice(2);',
    `fs.appendFileSync(${JSON.stringify(ghLog)}, args.join(' ') + '\\n');`,
    "const onRemote = (gitArgs) => spawnSync('git', ['--git-dir=' + remote, ...gitArgs], { encoding: 'utf8' });",
    "const fail = (message) => { process.stderr.write('gh: ' + message + '\\n'); process.exit(1); };",
    "if (args[0] === 'api') {",
    "  let method = 'GET'; let endpoint = ''; const fields = {};",
    '  for (let i = 1; i < args.length; i += 1) {',
    "    if (args[i] === '-X') { method = args[i + 1]; i += 1; }",
    "    else if (args[i] === '-f') { const at = args[i + 1].indexOf('='); fields[args[i + 1].slice(0, at)] = args[i + 1].slice(at + 1); i += 1; }",
    "    else if (args[i] === '--jq') { i += 1; }",
    "    else if (!args[i].startsWith('-')) endpoint = args[i];",
    '  }',
    "  const heads = 'repos/fixture/publisher/git/refs/heads/';",
    "  if (method === 'POST' && endpoint === 'repos/fixture/publisher/git/refs') {",
    "    if (process.env.REFRESH_FIXTURE_REFS_API === 'down') fail('Service Unavailable (HTTP 503)');",
    "    if (onRemote(['rev-parse', '--verify', '-q', fields.ref]).status === 0) fail('Reference already exists (HTTP 422)');",
    "    if (onRemote(['cat-file', '-e', fields.sha + '^{commit}']).status !== 0) fail('Object does not exist (HTTP 422)');",
    "    if (onRemote(['update-ref', fields.ref, fields.sha]).status !== 0) fail('update-ref failed');",
    '  } else if (method === \'DELETE\' && endpoint.startsWith(heads)) {',
    "    const ref = 'refs/heads/' + endpoint.slice(heads.length);",
    '    // REST deletes whatever is there: if another run lands first, its commit goes with the branch.',
    "    if (process.env.REFRESH_FIXTURE_CONCURRENT_TIP) onRemote(['update-ref', ref, process.env.REFRESH_FIXTURE_CONCURRENT_TIP]);",
    "    onRemote(['update-ref', '-d', ref]);",
    '  }',
    '  process.exit(0);',
    '}',
    "if (args[0] === 'pr' && args[1] === 'create') process.stdout.write('https://github.com/fixture/publisher/pull/1\\n');",
    'process.exit(0);',
    '',
  ].join('\n'));
  fs.chmodSync(gh, 0o755);
  const body = path.join(directory, 'body.md');
  fs.writeFileSync(body, '## Implementato\n- Fixture sitemap.\n\n## Non implementato (ancora)\n- Nessuno.\n');

  return {
    directory, remote, runner, bin, body, checkout, historyObjects,
    ghCalls: () => fs.readFileSync(ghLog, 'utf8'),
    // A push to main: from now on the remote's main tip is a commit the runner does not have.
    advanceMain: () => {
      commitRound();
      git(seed, ['push', '-q', remote, 'main:refs/heads/main']);
    },
  };
}

/** Objects held in the remote's packs; with `receive.unpackLimit=1` a push adds exactly what it sent. */
function packedObjects(remote: string) {
  const match = /^in-pack: (\d+)$/m.exec(git(remote, ['count-objects', '-v']));
  if (!match) throw new Error('count-objects did not report in-pack');
  return Number(match[1]);
}

function remoteBranch(remote: string, branch: string) {
  const result = spawnSync('git', ['rev-parse', '--verify', '-q', `refs/heads/${branch}`], { cwd: remote, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function publishSitemap(setup: ReturnType<typeof movingMainFixture>, env: Record<string, string> = {}) {
  write(setup.runner, 'public/sitemap-topics-fixture.xml', '<urlset/>\n');
  const trace = path.join(setup.directory, 'trace2.jsonl');
  const before = packedObjects(setup.remote);
  const startedAt = Date.now();
  const result = spawnSync('bash', [
    'scripts/lib/open-data-refresh-pr.sh',
    '--path', 'public/sitemap-topics-fixture.xml',
    '--branch', NEW_BRANCH, '--commit-message', 'fixture sitemap',
    '--title', 'Fixture sitemap', '--body-file', setup.body,
  ], {
    cwd: setup.runner, encoding: 'utf8', timeout: 120_000,
    env: {
      ...process.env, ...identity,
      PATH: `${setup.bin}${path.delimiter}${process.env.PATH || ''}`,
      GH_TOKEN: 'fixture-token', GITHUB_REPOSITORY: 'fixture/publisher',
      GIT_TRACE2_EVENT: trace,
      ...env,
    },
  });
  // A lazy fetch is the child Git starts to download an object it was only
  // promised. Counted under the push alone: trace2 session ids nest, so every
  // process a push starts carries the push's id as a prefix. (The guard makes
  // its own attempts here, looking for a marker this fixture does not have.)
  const events = !fs.existsSync(trace) ? [] : fs.readFileSync(trace, 'utf8').split('\n').filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter((event) => event && Array.isArray(event.argv) && typeof event.sid === 'string');
  const pushes = events.filter((event) => event.event === 'start' && event.argv.includes('push')).map((event) => event.sid as string);
  const lazyFetchesByPush = events.filter((event) => event.event === 'child_start'
    && event.argv.includes('fetch.negotiationAlgorithm=noop')
    && pushes.some((sid) => event.sid === sid || event.sid.startsWith(`${sid}/`))).length;
  return {
    result, lazyFetchesByPush, pushes: pushes.length,
    objectsSent: packedObjects(setup.remote) - before,
    seconds: (Date.now() - startedAt) / 1000,
    output: `${result.stdout}${result.stderr}`,
  };
}

/**
 * Makes the remote refuse every refresh push. A deletion (all-zero new id)
 * passes the hook, so only its lease decides. `onRefusal` and `onDeletion` are
 * shell run at those moments (`$refusals` counts the refusals): what someone
 * else does to the branch while this run is failing or cleaning up.
 */
function refuseRefreshPushes(setup: ReturnType<typeof movingMainFixture>, { onRefusal = '', onDeletion = '' } = {}) {
  const hook = path.join(setup.remote, 'hooks', 'pre-receive');
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, [
    '#!/bin/sh',
    'deletion=1',
    'while read -r _old new _ref; do',
    '  case "$new" in 0000000000000000000000000000000000000000) ;; *) deletion=0 ;; esac',
    'done',
    // The hook runs inside the push's quarantine, where Git forbids ref updates.
    'unset GIT_QUARANTINE_PATH GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'if [ "$deletion" = 1 ]; then',
    `  ${onDeletion || ':'}`,
    '  exit 0',
    'fi',
    'refusals=$(( $(cat fixture-refusals 2>/dev/null || echo 0) + 1 ))',
    'echo "$refusals" > fixture-refusals',
    onRefusal,
    'echo "fixture: push refused" >&2',
    'exit 1',
    '',
  ].join('\n'));
  fs.chmodSync(hook, 0o755);
}

// A commit that adds one file in a new directory: commit, root tree, `public` tree, blob.
const OBJECTS_OF_THE_REFRESH = 4;

describe('a new stable branch is pushed from a base the remote has (issue 12262)', () => {
  it('replays the fetches the history guard really makes', () => {
    // The fixture puts the runner in the guard's end state by hand, because the
    // guard's marker is a constant of the real repository. Keep the two in step.
    const guard = fs.readFileSync(path.join(ROOT, 'scripts/lib/old-history-guard.mjs'), 'utf8');
    expect(guard).toContain("'--unshallow',\n      '--filter=tree:0',");
    expect(guard).toMatch(/'--no-write-fetch-head',\n\s+'--filter=tree:0',\n\s+remote,\n\s+commitRef,/);
    const setup = movingMainFixture({ afterHistoryGuard: true });
    expect(git(setup.runner, ['rev-parse', '--is-shallow-repository'])).toBe('false');
    expect(git(setup.runner, ['config', '--get-regexp', '^remote\\..*\\.promisor$'])).toContain('true');
  });

  it.each([
    ['after the history guard completed the graph (treeless clone)', true],
    ['from the plain depth-1 checkout', false],
  ])('sends only this run\'s commit when main moved, %s', (_label, afterHistoryGuard) => {
    const setup = movingMainFixture({ afterHistoryGuard });
    setup.advanceMain();
    const run = publishSitemap(setup);
    expect(run.result.status, run.output).toBe(0);
    // Without the base the same push sends the whole history (treeless clone)
    // or the whole snapshot (depth-1), every one of them an object the remote has.
    expect(setup.historyObjects).toBeGreaterThan(200);
    expect({ objectsSent: run.objectsSent, lazyFetchesByPush: run.lazyFetchesByPush, pushes: run.pushes })
      .toEqual({ objectsSent: OBJECTS_OF_THE_REFRESH, lazyFetchesByPush: 0, pushes: 1 });
    expect(run.output).toContain(`Created ${NEW_BRANCH} on the remote at this run's base commit ${setup.checkout}.`);
    expect(git(setup.remote, ['rev-parse', `${NEW_BRANCH}^`])).toBe(setup.checkout);
    expect(git(setup.remote, ['show', `${NEW_BRANCH}:public/sitemap-topics-fixture.xml`])).toBe('<urlset/>');
    expect(setup.ghCalls()).toContain(`api -X POST repos/fixture/publisher/git/refs -f ref=refs/heads/${NEW_BRANCH} -f sha=${setup.checkout}`);
    expect(setup.ghCalls()).toContain('pr create');
  }, 60_000);

  it('stops in seconds, without downloading history, when the base cannot be created and main moved', () => {
    const setup = movingMainFixture({ afterHistoryGuard: true });
    setup.advanceMain();
    const run = publishSitemap(setup, { REFRESH_FIXTURE_REFS_API: 'down' });
    expect(run.result.status, run.output).not.toBe(0);
    expect(run.output).toContain(`${NEW_BRANCH} could not be created on the remote at this run's base commit before the push`);
    expect(run.output).toContain('stable refresh branch push failed after 3 bounded attempts');
    expect(run.pushes).toBe(3);
    expect(run.lazyFetchesByPush).toBe(0);
    expect(run.objectsSent).toBe(0);
    expect(run.seconds).toBeLessThan(45);
    expect(remoteBranch(setup.remote, NEW_BRANCH)).toBeNull();
    expect(setup.ghCalls()).not.toContain('pr create');
  }, 60_000);

  it('still publishes when the base cannot be created and main did not move', () => {
    const setup = movingMainFixture({ afterHistoryGuard: true });
    const run = publishSitemap(setup, { REFRESH_FIXTURE_REFS_API: 'down' });
    expect(run.result.status, run.output).toBe(0);
    expect(git(setup.remote, ['rev-parse', `${NEW_BRANCH}^`])).toBe(setup.checkout);
    expect(run.objectsSent).toBe(OBJECTS_OF_THE_REFRESH);
    expect(run.lazyFetchesByPush).toBe(0);
  }, 60_000);

  it('removes the base it created when the push keeps failing', () => {
    const setup = movingMainFixture({ afterHistoryGuard: true });
    refuseRefreshPushes(setup);
    const run = publishSitemap(setup);
    expect(run.result.status, run.output).not.toBe(0);
    expect(run.output).toContain('stable refresh branch push failed after 3 bounded attempts');
    expect(run.output).toContain(`Removed ${NEW_BRANCH} from the remote`);
    expect(remoteBranch(setup.remote, NEW_BRANCH)).toBeNull();
    // One creation for three attempts: a base this run made is reused, not reconciled.
    expect(setup.ghCalls().match(/api -X POST/g)).toHaveLength(1);
    expect(setup.ghCalls()).not.toContain('pr create');
    expect(git(setup.runner, ['worktree', 'list', '--porcelain']).match(/^worktree /gm)).toHaveLength(1);
  }, 60_000);

  it('leaves the branch alone when another run advances it at the moment of the cleanup', () => {
    const setup = movingMainFixture({ afterHistoryGuard: true });
    setup.advanceMain();
    const elsewhere = git(setup.remote, ['rev-parse', 'refs/heads/main']);
    expect(elsewhere).not.toBe(setup.checkout);
    // Every read of the branch still shows this run's base. Another run's
    // refresh lands exactly when the cleanup's deletion arrives.
    refuseRefreshPushes(setup, { onDeletion: `git update-ref refs/heads/${NEW_BRANCH} ${elsewhere}` });
    const run = publishSitemap(setup, { REFRESH_FIXTURE_CONCURRENT_TIP: elsewhere });
    expect(run.result.status, run.output).not.toBe(0);
    expect(remoteBranch(setup.remote, NEW_BRANCH)).toBe(elsewhere);
    expect(run.output).toContain(`${NEW_BRANCH} was not removed from the remote`);
    expect(run.output).not.toContain(`Removed ${NEW_BRANCH} from the remote`);
    // The cleanup is a push with a lease on the base commit, never a bare REST delete.
    expect(setup.ghCalls()).not.toContain('-X DELETE');
  }, 60_000);

  it('creates the base again when it disappeared before the retry', () => {
    const setup = movingMainFixture({ afterHistoryGuard: true });
    setup.advanceMain();
    // The first push is refused and the empty branch is cleaned up meanwhile; the second goes through.
    refuseRefreshPushes(setup, { onRefusal: `if [ "$refusals" -ge 2 ]; then exit 0; fi; git update-ref -d refs/heads/${NEW_BRANCH}` });
    const run = publishSitemap(setup);
    expect(run.result.status, run.output).toBe(0);
    expect(setup.ghCalls().match(/api -X POST/g)).toHaveLength(2);
    expect({ objectsSent: run.objectsSent, lazyFetchesByPush: run.lazyFetchesByPush, pushes: run.pushes })
      .toEqual({ objectsSent: OBJECTS_OF_THE_REFRESH, lazyFetchesByPush: 0, pushes: 2 });
    expect(git(setup.remote, ['rev-parse', `${NEW_BRANCH}^`])).toBe(setup.checkout);
    expect(setup.ghCalls()).toContain('pr create');
  }, 60_000);

  it('gives every push of the publisher a time cap, and the new-branch push no lazy fetch', () => {
    const helper = fs.readFileSync(path.join(ROOT, 'scripts/lib/open-data-refresh-pr.sh'), 'utf8');
    // The label a capped command carries is prose that may say "git push": set it aside.
    const lines = helper.split('\n').map((line) => line.replace(/(run_bounded "\$[A-Z_]+") "[^"]*"/, '$1 <label>'));
    const pushLines = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => !line.trimStart().startsWith('#') && /(^|\s)git(\s+-c\s+\S+)*\s+push(\s|$)/.test(line));
    // Two forms for a new branch (compat and not), one over an existing tip, one that removes an unused base.
    expect(pushLines).toHaveLength(4);
    for (const { index } of pushLines) {
      // The command the push line belongs to starts at most two lines above it.
      const command = lines.slice(Math.max(0, index - 2), index + 1).join('\n');
      expect(command, `line ${index + 1}`).toContain('run_bounded "$PUSH_TIMEOUT_SECONDS" <label>');
    }
    expect(helper).toMatch(/env GIT_NO_LAZY_FETCH=1 \\\n\s+git -c http\.https:\/\/github\.com\/\.extraheader= push "\$PUSH_URL" "HEAD:\$\{BRANCH\}"/);
    expect(helper).toMatch(/elif push_new_stable_branch; then/);
    // The cleanup deletes with a lease on the base commit; a REST delete has no such condition.
    expect(helper).toMatch(/--force-with-lease="refs\/heads\/\$\{BRANCH\}:\$\{REFRESH_BASE\}" \\\n\s+"\$PUSH_URL" ":refs\/heads\/\$\{BRANCH\}"/);
    expect(helper).not.toContain('-X DELETE');
  });
});

describe('bounded command runner', () => {
  const bounded = (args: string[]) => spawnSync(process.execPath, ['scripts/lib/run-bounded-command.mjs', ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 20_000,
  });

  it('stops a command that outlives its cap and names it', () => {
    const startedAt = Date.now();
    const result = bounded(['--timeout-seconds', '1', '--label', 'git push of the new stable branch', '--', process.execPath, '-e', 'setTimeout(() => {}, 30000);']);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(124);
    expect(result.stderr).toContain('::error::git push of the new stable branch timed out after 1 second');
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });

  it('stops the helpers the command started, not only the command', () => {
    const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-group-')), 'alive');
    directories.push(path.dirname(marker));
    // The command starts a child that would write the marker after the cap.
    const child = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x'), 2500);`;
    const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { stdio: 'ignore' }); setTimeout(() => {}, 30000);`;
    const result = bounded(['--timeout-seconds', '1', '--label', 'group', '--', process.execPath, '-e', parent]);
    expect(result.status).toBe(124);
    spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 3000);']);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('passes the status and the output of a command that ends in time', () => {
    const result = bounded(['--timeout-seconds', '10', '--label', 'quick', '--', process.execPath, '-e', "console.log('out'); process.exit(7);"]);
    expect(result.status).toBe(7);
    expect(result.stdout).toBe('out\n');
    expect(result.stderr).toBe('');
  });

  it('refuses to run without a cap or a label', () => {
    expect(bounded(['--label', 'x', '--', 'true']).status).toBe(2);
    expect(bounded(['--timeout-seconds', '0', '--label', 'x', '--', 'true']).status).toBe(2);
    expect(bounded(['--timeout-seconds', '5', '--', 'true']).status).toBe(2);
    // Past the range of a timer the delay would fire at once and stop a healthy command.
    expect(bounded(['--timeout-seconds', '2147484', '--label', 'x', '--', 'true']).status).toBe(2);
    expect(bounded(['--timeout-seconds', '2147483', '--label', 'x', '--', 'true']).status).toBe(0);
  });

  it('stops a command that ignores the signal a cancelled job sends', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-signal-'));
    directories.push(directory);
    const ready = path.join(directory, 'ready');
    const stubborn = `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'x'); setInterval(() => {}, 1000);`;
    const wrapper = spawn(process.execPath, [
      'scripts/lib/run-bounded-command.mjs', '--timeout-seconds', '60', '--label', 'stubborn', '--', process.execPath, '-e', stubborn,
    ], { cwd: ROOT, stdio: 'ignore' });
    const exited = once(wrapper, 'exit');
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fs.existsSync(ready)).toBe(true);
    const signalledAt = Date.now();
    wrapper.kill('SIGTERM');
    const [status] = await exited;
    expect(Date.now() - signalledAt).toBeLessThan(5_000);
    expect(status).toBe(137);
  });
});
