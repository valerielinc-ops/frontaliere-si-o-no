// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandAccumulatorPaths } from '../scripts/ci/assert-accumulator-write.mjs';
import {
  URL_FIRST_SEEN_DIR,
  URL_FIRST_SEEN_SHARD_IDS,
  urlFirstSeenShardFileName,
} from '../scripts/lib/url-first-seen-store.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts/ci/assert-accumulator-write.mjs');

const created: string[] = [];
function tempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assert-accumulator-shards-'));
  created.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const MIB = 1024 * 1024;

/** A repo whose HEAD has 16 shards of 2 MiB each (over the 1 MB floor). */
function repoWithShards(): string {
  const repo = tempRepo();
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q', '--initial-branch=main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  fs.mkdirSync(path.join(repo, URL_FIRST_SEEN_DIR), { recursive: true });
  for (const id of URL_FIRST_SEEN_SHARD_IDS) {
    fs.writeFileSync(path.join(repo, URL_FIRST_SEEN_DIR, urlFirstSeenShardFileName(id)), 'x'.repeat(2 * MIB));
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'shards');
  return repo;
}

function run(repo: string, ...args: string[]) {
  return spawnSync('node', [SCRIPT, ...args], { cwd: repo, encoding: 'utf8' });
}

describe('assert-accumulator-write on a sharded accumulator', () => {
  it('expands a directory argument to every shard on disk and at HEAD', () => {
    const repo = repoWithShards();
    fs.unlinkSync(path.join(repo, URL_FIRST_SEEN_DIR, 'c.json'));
    const inRepo = (rel: string) => path.join(repo, rel);
    const expanded = expandAccumulatorPaths([`${URL_FIRST_SEEN_DIR}/`, 'plain/file.jsonl'], {
      exec: ((cmd: string, args: string[], opts: object) => execFileSync(cmd, args, { ...opts, cwd: repo })) as typeof execFileSync,
      readdir: ((dir: string, opts: object) => fs.readdirSync(inRepo(dir), opts)) as typeof fs.readdirSync,
      stat: ((p: string) => fs.statSync(inRepo(p))) as typeof fs.statSync,
    });
    expect(expanded).toContain(`${URL_FIRST_SEEN_DIR}/c.json`); // gone from the tree, still tracked
    expect(expanded.filter((p: string) => p.startsWith(`${URL_FIRST_SEEN_DIR}/`))).toHaveLength(16);
    expect(expanded).toContain('plain/file.jsonl'); // plain arguments pass through
  });

  it('passes when every shard keeps its size or grows', () => {
    const repo = repoWithShards();
    fs.appendFileSync(path.join(repo, URL_FIRST_SEEN_DIR, '5.json'), 'y'.repeat(MIB));
    const result = run(repo, `${URL_FIRST_SEEN_DIR}/`);
    expect(result.status, result.stderr).toBe(0);
  });

  it('fails when ONE shard collapses (>70% shrink)', () => {
    const repo = repoWithShards();
    fs.writeFileSync(path.join(repo, URL_FIRST_SEEN_DIR, '9.json'), '{}\n');
    const result = run(repo, `${URL_FIRST_SEEN_DIR}/`);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`${URL_FIRST_SEEN_DIR}/9.json`);
    expect(result.stderr).toContain('catastrophic truncation avoided');
  });

  it('fails when a shard vanished from the working tree (a missing file counts as 0 bytes)', () => {
    const repo = repoWithShards();
    fs.unlinkSync(path.join(repo, URL_FIRST_SEEN_DIR, '2.json'));
    const result = run(repo, `${URL_FIRST_SEEN_DIR}/`);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`${URL_FIRST_SEEN_DIR}/2.json`);
  });

  it('does not check a shard that is new (absent at HEAD): the first sharded publish adds them', () => {
    const repo = tempRepo();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    git('init', '-q', '--initial-branch=main');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');
    fs.writeFileSync(path.join(repo, 'README'), 'x');
    git('add', '-A');
    git('commit', '-q', '-m', 'seed');
    fs.mkdirSync(path.join(repo, URL_FIRST_SEEN_DIR), { recursive: true });
    for (const id of URL_FIRST_SEEN_SHARD_IDS) {
      fs.writeFileSync(path.join(repo, URL_FIRST_SEEN_DIR, urlFirstSeenShardFileName(id)), '{}\n');
    }
    const result = run(repo, `${URL_FIRST_SEEN_DIR}/`);
    expect(result.status, result.stderr).toBe(0);
  });

  it('still accepts plain files (dist-size-history.jsonl)', () => {
    const repo = repoWithShards();
    const result = run(repo, `${URL_FIRST_SEEN_DIR}/0.json`);
    expect(result.status, result.stderr).toBe(0);
  });
});
