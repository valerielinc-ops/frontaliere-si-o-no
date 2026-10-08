import { execFileSync, spawnSync } from 'node:child_process';
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

describe('bounded network command runner', () => {
  it('interrupts a command that exceeds its cap and names the command', () => {
    const startedAt = Date.now();
    const result = spawnSync(process.execPath, [
      'scripts/lib/run-bounded-command.mjs',
      '--timeout-seconds', '1',
      '--label', 'git fetch stable branch',
      '--', process.execPath, '-e', 'setTimeout(() => {}, 30000);',
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 5_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(124);
    expect(`${result.stdout}${result.stderr}`).toContain('git fetch stable branch');
    expect(`${result.stdout}${result.stderr}`).toContain('timed out after 1 second');
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
});

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

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-checkout-'));
  directories.push(directory);
  const repo = path.join(directory, 'source');
  const remote = path.join(directory, 'remote.git');
  fs.mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  for (const file of [
    'scripts/lib/open-data-refresh-pr.sh',
    'scripts/lib/old-history-guard.mjs',
    'scripts/lib/single-flight-lock.mjs',
    'scripts/lib/run-bounded-command.mjs',
    'scripts/lib/git-add-resolved.mjs',
    'scripts/lib/resolve-git-add-path.mjs',
    'scripts/lib/read-git-blob.mjs',
    'scripts/ci/merge-open-data-refresh.mjs',
    'scripts/ci/open-data-refresh-merge.mjs',
    'scripts/ci/reconcile-data-refresh-main.mjs',
  ]) write(repo, file, fs.readFileSync(path.join(ROOT, file), 'utf8'));
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
