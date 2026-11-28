// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(import.meta.dirname, '../scripts/dev/install-swiss-runner.sh');
const roots: string[] = [];
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { encoding: 'utf8' });

/** A site checkout cloned from a local "origin", whose runner stub prints the code state it was started with. */
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'swiss-runner-update-'));
  roots.push(home);
  const work = join(home, 'seed');
  mkdirSync(join(work, 'scripts/assisted-application'), { recursive: true });
  mkdirSync(join(work, 'functions'), { recursive: true });
  mkdirSync(join(work, 'data/jobs-crawler-adapters/adapters'), { recursive: true });
  writeFileSync(join(work, 'scripts/assisted-application/local-runner.mjs'), 'console.log(`STATE=${process.env.SWISS_RUNNER_CODE_STATE || ""}`);\n');
  for (const file of ['package.json', 'package-lock.json', 'functions/package.json', 'functions/package-lock.json']) writeFileSync(join(work, file), '{}\n');
  writeFileSync(join(work, 'data/jobs-crawler-adapters/adapters/a.json'), '{"v":1}\n');
  writeFileSync(join(work, 'data/ledger.jsonl'), 'row\n');
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'seed');
  const origin = join(home, 'origin.git');
  execFileSync('git', ['clone', '-q', '--bare', work, origin]);
  const site = join(home, 'site');
  execFileSync('git', ['clone', '-q', origin, site]);
  const env = { ...process.env, HOME: home, SWISS_RUNNER_SITE: site, SWISS_RUNNER_LOG_DIR: join(home, 'logs'), SWISS_RUNNER_STATE_DIR: join(home, 'state') };
  const advanceOrigin = () => {
    writeFileSync(join(work, 'scripts/assisted-application/new.mjs'), 'export {};\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'advance');
    git(work, 'push', '-q', origin, 'main');
  };
  const run = () => execFileSync('bash', [SCRIPT, 'run'], { cwd: site, encoding: 'utf8', env });
  const log = () => { try { return readFileSync(join(home, 'logs/swiss-runner.log'), 'utf8'); } catch { return ''; } };
  return { home, site, advanceOrigin, run, log };
}

afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('install-swiss-runner update_checkout', () => {
  it('data files dirtied by cron are backed up, restored, and the checkout fast-forwards', () => {
    const f = fixture();
    writeFileSync(join(f.site, 'data/jobs-crawler-adapters/adapters/a.json'), '{"v":2}\n');
    rmSync(join(f.site, 'data/ledger.jsonl'));
    f.advanceOrigin();

    expect(f.run()).toContain('STATE=\n');
    expect(readFileSync(join(f.site, 'data/jobs-crawler-adapters/adapters/a.json'), 'utf8')).toBe('{"v":1}\n');
    expect(readFileSync(join(f.site, 'data/ledger.jsonl'), 'utf8')).toBe('row\n');
    expect(git(f.site, 'rev-parse', 'HEAD')).toBe(git(f.site, 'rev-parse', 'origin/main'));
    const backups = readdirSync(join(f.home, 'state/data-backups'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(f.home, 'state/data-backups', backups[0]), 'utf8')).toContain('"v":2');
    expect(f.log()).toContain('restored 2 tracked data file(s)');
  });

  it('a change to code is never reset: the runner is stopped as stale_code and the file is kept', () => {
    const f = fixture();
    writeFileSync(join(f.site, 'scripts/assisted-application/local-runner.mjs'), 'console.log(`STATE=${process.env.SWISS_RUNNER_CODE_STATE || ""}`); // local edit\n');
    writeFileSync(join(f.site, 'data/ledger.jsonl'), 'changed\n');
    f.advanceOrigin();
    const before = git(f.site, 'rev-parse', 'HEAD');

    expect(f.run()).toContain('STATE=stale_code');
    expect(readFileSync(join(f.site, 'scripts/assisted-application/local-runner.mjs'), 'utf8')).toContain('local edit');
    expect(readFileSync(join(f.site, 'data/ledger.jsonl'), 'utf8')).toBe('changed\n');
    // HEAD stays where it was (no update with code changes) and origin's real tip (read from the origin repo,
    // since the stopped cycle does not even fetch) is ahead of it.
    expect(git(f.site, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(join(f.home, 'origin.git'), 'rev-parse', 'main')).not.toBe(before);
    expect(f.log()).toContain('local CODE changes');
  });

  it('a clean checkout simply fast-forwards', () => {
    const f = fixture();
    f.advanceOrigin();
    expect(f.run()).toContain('STATE=\n');
    expect(git(f.site, 'rev-parse', 'HEAD')).toBe(git(f.site, 'rev-parse', 'origin/main'));
  });

  it('a fast-forward that fails while origin is ahead is stale_code', () => {
    const f = fixture();
    // a local commit diverges from origin/main: no fast-forward possible
    writeFileSync(join(f.site, 'scripts/local-only.mjs'), 'export {};\n');
    git(f.site, 'add', '-A');
    git(f.site, 'commit', '-q', '-m', 'local');
    f.advanceOrigin();
    expect(f.run()).toContain('STATE=stale_code');
    expect(f.log()).toContain('fast-forward to origin/main failed');
  });
});
