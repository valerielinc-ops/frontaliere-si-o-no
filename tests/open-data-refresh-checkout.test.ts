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
  return { repo, remote, bin, body };
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

describe('data publisher preserves its source checkout', () => {
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

  it('leaves current code and uncommitted data intact when publication fails', () => {
    const setup = fixture();
    write(setup.repo, 'data/cache.json', '{"version":"current"}\n');
    write(setup.repo, 'data/unpublished.json', '{"version":"unpublished"}\n');
    expect(publish(setup, true).status).not.toBe(0);
    expect(git(setup.repo, ['branch', '--show-current'])).toBe('main');
    expect(fs.readFileSync(path.join(setup.repo, 'scripts/crawler.mjs'), 'utf8')).toContain('current crawler');
    expect(fs.readFileSync(path.join(setup.repo, 'data/unpublished.json'), 'utf8')).toBe('{"version":"unpublished"}\n');
    expect(git(setup.repo, ['worktree', 'list', '--porcelain']).match(/^worktree /gm)).toHaveLength(1);
  });

  it('reconciles conflicting event caches against main with shallow branch tips', () => {
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
    write(setup.repo, 'data/cache.json', '{"version":"current"}\n');
    write(setup.repo, 'data/unpublished.json', '{"version":"unpublished"}\n');
    const result = publish(setup, false, ['--reconcile-main']);
    expect(result.status, result.stderr).toBe(0);
    const geo = JSON.parse(git(setup.remote, ['show', 'chore/refresh:data/events-geocode-cache.json']));
    expect(geo).toEqual({ common: { lat: 5, lng: 6 }, main: { lat: 7, lng: 8 }, pending: { lat: 3, lng: 4 } });
    const translations = JSON.parse(git(setup.remote, ['show', 'chore/refresh:data/events-translation-cache.json']));
    expect(translations).toEqual({ title: { en: 'corrected', fr: 'main', de: 'pending' } });
    expect(git(setup.remote, ['rev-parse', 'chore/refresh^2'])).toBe(mainHead);
    expect(git(setup.repo, ['rev-parse', '--is-shallow-repository'])).toBe('true');
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
