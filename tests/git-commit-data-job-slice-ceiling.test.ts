// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { JOB_SLICE_CEILING_BYTES, jobSliceCeilingBytes } from '../scripts/lib/main-push-guard.mjs';
import { EXPIRED_SLICE_SIZE_LIMIT_BYTES } from '../scripts/lib/related-search-output-limit.mjs';

/**
 * The isolated commit path merges the expired archive file by file. Two cases
 * need the whole archive: a row that changed file while another writer edited
 * the archive, and a merged file above the push-safety ceiling. The ceiling is
 * lowered through JOB_SLICE_CEILING_BYTES so the fixtures stay small.
 *
 * Every repository lives in a temporary directory.
 */
const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT_PATH = resolve(ROOT, 'scripts/lib/git-commit-data.sh');
const GUARD_PATH = resolve(ROOT, 'scripts/lib/main-push-guard.mjs');
const BASH_BIN = ['/opt/homebrew/bin/bash', '/usr/local/bin/bash'].find(existsSync) ?? 'bash';
const MONOLITH = 'data/jobs/expired/by-crawler/acme.json';
const SHARD = 'data/jobs/expired/by-crawler/acme.shard-001.json';
const SHARD_2 = 'data/jobs/expired/by-crawler/acme.shard-002.json';
const CEILING = 6_000;

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'gcd-ceiling-'));
  roots.push(dir);
  return dir;
};

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

type Row = Record<string, unknown> & { slug: string };

const row = (n: number | string, extra: Record<string, unknown> = {}): Row => ({
  slug: `posting-${n}`,
  companyKey: 'acme',
  title: `Posting ${n}`,
  slugByLocale: { it: `posting-${n}` },
  expiredAt: new Date(Date.now() - 86_400_000).toISOString(),
  description: `${n} `.repeat(700).slice(0, 1_400),
  ...extra,
});

const withOldRoute = (entry: Row, slug: string): Row => ({ ...entry, previousSlugsByLocale: { it: [slug] } });

function write(repo: string, filePath: string, value: unknown) {
  mkdirSync(dirname(join(repo, filePath)), { recursive: true });
  writeFileSync(join(repo, filePath), `${JSON.stringify(value, null, 2)}\n`);
}

function clone(origin: string) {
  const dir = tmp();
  execFileSync('git', ['clone', '-q', origin, dir]);
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  return dir;
}

function harness(seed: Record<string, unknown>) {
  const origin = tmp();
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', origin]);
  const writer = clone(origin);
  for (const [filePath, value] of Object.entries(seed)) write(writer, filePath, value);
  write(writer, 'keep.txt', 'keep');
  git(writer, 'add', '.');
  git(writer, 'commit', '-q', '-m', 'seed');
  git(writer, 'push', '-q', 'origin', 'HEAD:main');
  return { origin, writer, other: clone(origin) };
}

function publish(repo: string, files: Record<string, unknown>) {
  for (const [filePath, value] of Object.entries(files)) write(repo, filePath, value);
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'other writer');
  git(repo, 'push', '-q', 'origin', 'HEAD:main');
}

function commitData(repo: string, env: Record<string, string> = {}) {
  const result = spawnSync(BASH_BIN, [SCRIPT_PATH, '--slice-only', 'data commit', 'data/jobs/expired/by-crawler/'], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      JOBS_SLICE_FILE: '',
      DATA_PIPELINE_LEASE: '0',
      MAX_PUSH_ATTEMPTS: '3',
      SKIP_AI_TRANSLATION: '1',
      SLUG_HISTORY_SUMMARY_FILE: join(repo, 'no-such-summary.txt'),
      JOBS_HOUSEKEEPING_PROOF_DIR: join(tmpdir(), 'gcd-ceiling-no-proofs'),
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
      GITHUB_RUN_ID: '',
      GITHUB_REPOSITORY: '',
      GITHUB_OUTPUT: '',
      ...env,
    },
  });
  return { status: result.status, log: `${result.stdout}${result.stderr}` };
}

function published(origin: string) {
  const files = git(origin, 'ls-tree', '--name-only', 'main', 'data/jobs/expired/by-crawler/').split('\n').filter(Boolean);
  const byFile = files.map((file) => {
    const raw = execFileSync('git', ['show', `main:${file}`], { cwd: origin, maxBuffer: 16 * 1024 * 1024 });
    return { file, bytes: raw.length, rows: JSON.parse(raw.toString('utf8')) as Row[] };
  });
  return { byFile, rows: byFile.flatMap((entry) => entry.rows) };
}

const slugs = (rows: Row[]) => rows.map((entry) => entry.slug).sort();
const routes = (entry: Row | undefined) => JSON.stringify(entry ?? {});

// Each case runs the real commit script one or two times against a real remote.
describe('git-commit-data: whole-archive merge of the sharded expired archive', { timeout: 120_000 }, () => {
  it('keeps the remote edit of a row this writer moved to a shard', () => {
    const { origin, writer, other } = harness({ [MONOLITH]: [row(1), row(2), row(3)] });
    publish(other, { [MONOLITH]: [row(1), row(2), withOldRoute(row(3), 'remote-old-route')] });
    write(writer, MONOLITH, [row(1), row(2)]);
    write(writer, SHARD, [row(3, { location: 'Lugano' })]);

    const result = commitData(writer);
    expect(result.status, result.log).toBe(0);
    const { rows } = published(origin);
    expect(slugs(rows)).toEqual(['posting-1', 'posting-2', 'posting-3']);
    const moved = rows.find((entry) => entry.slug === 'posting-3');
    expect(routes(moved)).toContain('remote-old-route');
    expect(moved?.location).toBe('Lugano');
  });

  it('keeps the local edit of a row the remote moved to a shard', () => {
    const { origin, writer, other } = harness({ [MONOLITH]: [row(1), row(2), row(3)] });
    publish(other, { [MONOLITH]: [row(1), row(2)], [SHARD]: [row(3)] });
    write(writer, MONOLITH, [row(1), row(2), withOldRoute(row(3), 'local-old-route')]);

    const result = commitData(writer);
    expect(result.status, result.log).toBe(0);
    const { rows } = published(origin);
    expect(slugs(rows)).toEqual(['posting-1', 'posting-2', 'posting-3']);
    expect(routes(rows.find((entry) => entry.slug === 'posting-3'))).toContain('local-old-route');
  });

  // Not --extra-only: the deleted shard reaches the script through the directory
  // expansion, and the whole-archive merge must see it as deleted.
  function threeFiles(deletedRow: Row = row(3)) {
    const t = harness({ [MONOLITH]: [row(1), row(2)], [SHARD]: [deletedRow], [SHARD_2]: [row(4), row(5)] });
    // The remote moves posting-5 to another file.
    publish(t.other, { [MONOLITH]: [row(1), row(2), row(5)], [SHARD_2]: [row(4)] });
    write(t.writer, SHARD_2, [withOldRoute(row(4), 'local-old-route'), row(5)]);
    return t;
  }

  it('keeps the rows of a shard this writer deleted out of the published archive', () => {
    const { origin, writer } = threeFiles();
    rmSync(join(writer, SHARD));

    const result = commitData(writer);
    expect(result.status, result.log).toBe(0);
    expect(result.log).toContain('whole-archive merge of acme');
    const { rows } = published(origin);
    expect(slugs(rows)).toEqual(['posting-1', 'posting-2', 'posting-4', 'posting-5']);
    expect(routes(rows.find((entry) => entry.slug === 'posting-4'))).toContain('local-old-route');
  });

  it('does not read a shard the sparse checkout never materialised as deleted', () => {
    const { origin, writer } = threeFiles();
    git(writer, 'update-index', '--skip-worktree', SHARD);
    rmSync(join(writer, SHARD));

    const result = commitData(writer);
    expect(result.status, result.log).toBe(0);
    expect(result.log).toContain('whole-archive merge of acme');
    expect(slugs(published(origin).rows)).toEqual(['posting-1', 'posting-2', 'posting-3', 'posting-4', 'posting-5']);
  });

  it('refuses a whole-archive merge in which a deleted file empties most of the archive', () => {
    const { origin, writer } = threeFiles(row(3, { description: 'x'.repeat(1_400_000) }));
    rmSync(join(writer, SHARD));

    const result = commitData(writer);
    expect(result.status, result.log).toBe(1);
    expect(result.log).toContain('whole-archive merge failed for expired archive acme');
    expect(slugs(published(origin).rows)).toContain('posting-3');
  });

  it('shards a merge whose two sides fit the ceiling but whose union does not', () => {
    const { origin, writer, other } = harness({ [MONOLITH]: [row(1), row(2)] });
    publish(other, { [MONOLITH]: [row(1), row(2), row('remote')] });
    write(writer, MONOLITH, [row(1), row(2), row('local')]);

    const result = commitData(writer, { JOB_SLICE_CEILING_BYTES: String(CEILING) });
    expect(result.status, result.log).toBe(0);
    const { byFile, rows } = published(origin);
    expect(byFile.length).toBeGreaterThan(1);
    for (const entry of byFile) expect(entry.bytes, entry.file).toBeLessThanOrEqual(CEILING);
    expect(slugs(rows)).toEqual(['posting-1', 'posting-2', 'posting-local', 'posting-remote']);
  });

  it('re-places the archive on the retry after a rejected push, and keeps it on the next commit of the job', () => {
    const { origin, writer, other } = harness({ [MONOLITH]: [row(1), row(2)] });
    write(writer, MONOLITH, [row(1), row(2), row('local')]);
    write(other, MONOLITH, [row(1), row(2), row('remote')]);
    git(other, 'commit', '-q', '-am', 'concurrent writer');
    const shim = tmp();
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    writeFileSync(join(shim, 'git'), [
      '#!/bin/bash',
      'for arg in "$@"; do',
      `  if [ "$arg" = push ] && [ ! -f '${shim}/raced' ]; then`,
      `    touch '${shim}/raced'; '${realGit}' -C '${other}' push -q origin HEAD:main >/dev/null 2>&1`,
      '  fi',
      'done',
      `exec '${realGit}' "$@"`,
      '',
    ].join('\n'));
    writeFileSync(join(shim, 'sleep'), '#!/bin/bash\nexit 0\n');
    chmodSync(join(shim, 'git'), 0o755);
    chmodSync(join(shim, 'sleep'), 0o755);
    const env = { JOB_SLICE_CEILING_BYTES: String(CEILING), PATH: `${shim}${delimiter}${process.env.PATH ?? ''}` };

    const first = commitData(writer, env);
    expect(first.status, first.log).toBe(0);
    expect(first.log).toContain('Push rejected (attempt 1/3)');
    const afterFirst = published(origin);
    expect(slugs(afterFirst.rows)).toEqual(['posting-1', 'posting-2', 'posting-local', 'posting-remote']);

    // The worktree and the merge base are still the pre-push ones, while main
    // holds the re-placed archive: edit this writer's row again.
    const localRows = JSON.parse(readFileSync(join(writer, MONOLITH), 'utf8')) as Row[];
    write(writer, MONOLITH, localRows.map((entry) => (
      entry.slug === 'posting-local' ? withOldRoute(entry, 'second-commit-route') : entry)));

    const second = commitData(writer, env);
    expect(second.status, second.log).toBe(0);
    const after = published(origin);
    expect(slugs(after.rows)).toEqual(['posting-1', 'posting-2', 'posting-local', 'posting-remote']);
    expect(routes(after.rows.find((entry) => entry.slug === 'posting-local'))).toContain('second-commit-route');
    for (const entry of after.byFile) expect(entry.bytes, entry.file).toBeLessThanOrEqual(CEILING);
  });
});

describe('main-push-guard: job slice ceiling', () => {
  const ACTIVE = 'data/jobs/by-crawler/acme.json';

  function candidate(seed: string, next: string) {
    const repo = tmp();
    execFileSync('git', ['init', '-q', '--initial-branch=main', repo]);
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    mkdirSync(dirname(join(repo, ACTIVE)), { recursive: true });
    writeFileSync(join(repo, ACTIVE), seed);
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'seed');
    const base = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, ACTIVE), next);
    git(repo, 'commit', '-q', '-am', 'next');
    return spawnSync(process.execPath, [GUARD_PATH, '--repo', repo, '--base', base, '--candidate', 'HEAD', '--check-only'], {
      encoding: 'utf8',
      env: { ...process.env, JOB_SLICE_CEILING_BYTES: '1000' },
    });
  }

  it('refuses a slice that grows past the ceiling', () => {
    const result = candidate('[]\n', 'x'.repeat(1001));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${ACTIVE} (1001 bytes)`);
  });

  it('lets an already oversize slice shrink', () => {
    expect(candidate('x'.repeat(3000), 'x'.repeat(2000)).status).toBe(0);
  });

  it('warns while an active slice still has room', () => {
    const result = candidate('[]\n', 'x'.repeat(900));
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('::warning::');
  });

  it('pins the ceiling to the expired store limit and only lets the override lower it', () => {
    expect(JOB_SLICE_CEILING_BYTES).toBe(EXPIRED_SLICE_SIZE_LIMIT_BYTES);
    expect(jobSliceCeilingBytes({ JOB_SLICE_CEILING_BYTES: String(JOB_SLICE_CEILING_BYTES * 2) })).toBe(JOB_SLICE_CEILING_BYTES);
  });
});
