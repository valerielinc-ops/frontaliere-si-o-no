import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runIsolatedPruner } from './helpers/runIsolatedPruner';
import {
  DEFAULT_RECLAIM_FREE_BYTES,
  DEFAULT_RECLAIM_IDLE_MINUTES,
  reclaimFreeThresholdBytes,
  reclaimIdleMs,
} from '../scripts/lib/worktree-reclaimer.mjs';

const HOUR = 60 * 60 * 1000;
const SCRIPT = path.join(process.cwd(), 'scripts', 'prune-merged-worktrees.mjs');

let root = '';
let clone = '';
let origin = '';
let bin = '';
let env: NodeJS.ProcessEnv = {};
let mainHead = '';
let corruptHead = '';
let realGit = '';

function git(cwd: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): string {
  return execFileSync(env.PRUNE_REAL_GIT || 'git', args, {
    cwd,
    env: { ...env, ...extraEnv },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function write(cwd: string, file: string, content: string): void {
  const target = path.join(cwd, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function commit(cwd: string, message: string): string {
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-q', '-m', message]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

function worktreePath(name: string): string {
  return path.join(clone, '.claude', 'worktrees', name);
}

function age(name: string, when = new Date(Date.now() - 3 * HOUR)): void {
  const worktree = worktreePath(name);
  const admin = git(worktree, ['rev-parse', '--absolute-git-dir']);
  for (const file of [path.join(admin, 'HEAD'), path.join(admin, 'logs', 'HEAD'), worktree]) {
    if (fs.existsSync(file)) fs.utimesSync(file, when, when);
  }
  for (const file of fs.readdirSync(worktree, { withFileTypes: true })) {
    if (file.name === '.git') continue;
    const full = path.join(worktree, file.name);
    if (fs.existsSync(full) && !fs.lstatSync(full).isDirectory()) fs.utimesSync(full, when, when);
  }
}

function addBranchWorktree(name: string): string {
  const branch = `reclaim-${name}`;
  git(clone, ['worktree', 'add', '-q', '-b', branch, worktreePath(name), 'main']);
  return branch;
}

function run(args: string[], extraEnv: NodeJS.ProcessEnv = {}): string {
  return runIsolatedPruner(SCRIPT, args, root, clone, { ...env, ...extraEnv });
}

function refExists(ref: string): boolean {
  try { git(clone, ['show-ref', '--verify', '--quiet', ref]); return true; } catch { return false; }
}

function tagFor(name: string, suffix = ''): string {
  const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  return `snapshot/${name}${suffix}-${stamp}`;
}

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prune-reclaim-e2e-')));
  bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const gitconfig = path.join(root, 'gitconfig');
  fs.writeFileSync(gitconfig, '');
  realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    FAKE_LSOF_CWDS: '',
  };

  origin = path.join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch', 'main', origin], { env });
  clone = path.join(root, 'site');
  execFileSync('git', ['clone', '-q', origin, clone], { env, stdio: 'ignore' });
  write(clone, 'real.txt', 'base\n');
  write(clone, 'kept-a.txt', 'a\n');
  write(clone, 'kept-b.txt', 'b\n');
  mainHead = commit(clone, 'fixture base');
  git(clone, ['push', '-q', 'origin', 'main']);

  const corruptBranch = addBranchWorktree('corrupt-index');
  write(worktreePath('corrupt-index'), 'merged.txt', 'merged branch head\n');
  corruptHead = commit(worktreePath('corrupt-index'), 'merged branch head');
  write(worktreePath('corrupt-index'), 'real.txt', 'real edit hidden by corrupt index\n');
  git(worktreePath('corrupt-index'), ['update-index', '--remove', '--', 'real.txt', 'kept-a.txt', 'kept-b.txt']);
  age('corrupt-index');

  const aheadBranch = addBranchWorktree('clean-ahead');
  write(worktreePath('clean-ahead'), 'ahead.txt', 'committed branch work\n');
  git(worktreePath('clean-ahead'), ['add', 'ahead.txt']);
  git(worktreePath('clean-ahead'), ['commit', '-q', '-m', 'ahead work']);
  age('clean-ahead');

  addBranchWorktree('active');
  write(worktreePath('active'), 'real.txt', 'active edit\n');
  age('active');

  addBranchWorktree('snapshot-fail');
  write(worktreePath('snapshot-fail'), 'real.txt', 'must not be lost\n');
  age('snapshot-fail');

  addBranchWorktree('body-no-pr');
  write(worktreePath('body-no-pr'), '.pr-body-pending.md', 'pending PR body\n');
  age('body-no-pr');

  git(clone, ['worktree', 'add', '-q', '--detach', worktreePath('detached'), mainHead]);
  age('detached');
  git(clone, ['worktree', 'add', '-q', '--detach', worktreePath('hooks-main'), mainHead]);
  age('hooks-main');

  fs.writeFileSync(path.join(root, 'gh-fixture.json'), JSON.stringify({
    open: [],
    all: [{ state: 'MERGED', baseRefName: 'main', headRefName: corruptBranch, headRefOid: corruptHead }],
  }));
  fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const fixture = JSON.parse(fs.readFileSync(process.env.FAKE_GH_FIXTURE, 'utf8'));
const out = (value) => { process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value)); process.exit(0); };
if (args[0] === '--version') out('gh version reclaim-fixture\\n');
if (args[0] === 'pr' && args[1] === 'list') {
  if (args.includes('--head')) out([]);
  out(args[args.indexOf('--state') + 1] === 'open' ? fixture.open : fixture.all);
}
process.exit(1);
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'lsof'), `#!/bin/sh
if [ -n "$FAKE_LSOF_CWDS" ]; then printf 'p1\\nn%s\\n' "$FAKE_LSOF_CWDS"; fi
exit 0
`, { mode: 0o755 });
  env.FAKE_GH_FIXTURE = path.join(root, 'gh-fixture.json');
  env.FAKE_LSOF_CWDS = path.join(worktreePath('active'), 'scripts');
  void aheadBranch;
});
afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('prune-merged-worktrees --reclaim', () => {
  it('mantiene le soglie configurabili separate: emergenza 60 min e routine più lunga', () => {
    expect(reclaimIdleMs({})).toBe(DEFAULT_RECLAIM_IDLE_MINUTES * 60 * 1000);
    expect(reclaimIdleMs({ PRUNE_RECLAIM_IDLE_MINUTES: '180' })).toBe(180 * 60 * 1000);
    expect(reclaimFreeThresholdBytes({})).toBe(DEFAULT_RECLAIM_FREE_BYTES);
    expect(reclaimFreeThresholdBytes({ PRUNE_RECLAIM_MIN_FREE_BYTES: '12345' })).toBe(12345);
  });

  it('misura il contenuto reale, crea snapshot canonici e non cancella branch', () => {
    const dryRun = run(['--reclaim']);
    expect(dryRun).toContain('dry-run: niente rimosso');
    expect(dryRun).toContain('corrupt-index');
    expect(dryRun).toContain('in uso: processo con cwd dentro');
    expect(fs.existsSync(worktreePath('corrupt-index'))).toBe(true);

    const failBin = path.join(root, 'fail-bin');
    fs.mkdirSync(failBin);
    fs.writeFileSync(path.join(failBin, 'git'), `#!/bin/sh
case "$*" in
  *snapshot-fail*commit-tree*) exit 97 ;;
esac
exec "$PRUNE_REAL_GIT" "$@"
`, { mode: 0o755 });
    const applied = run(['--reclaim', '--apply'], {
      PATH: `${failBin}${path.delimiter}${env.PATH}`,
      PRUNE_REAL_GIT: realGit,
    });

    expect(applied).toContain('report finale');
    expect(fs.existsSync(worktreePath('corrupt-index'))).toBe(false);
    expect(fs.existsSync(worktreePath('clean-ahead'))).toBe(false);
    expect(fs.existsSync(worktreePath('detached'))).toBe(false);
    expect(fs.existsSync(worktreePath('active'))).toBe(true);
    expect(fs.existsSync(worktreePath('hooks-main'))).toBe(true);
    expect(fs.existsSync(worktreePath('snapshot-fail'))).toBe(true);
    expect(fs.existsSync(worktreePath('body-no-pr'))).toBe(false);

    expect(refExists('refs/heads/reclaim-corrupt-index')).toBe(true);
    expect(refExists('refs/heads/reclaim-clean-ahead')).toBe(true);
    expect(refExists(`refs/tags/${tagFor('corrupt-index')}`)).toBe(true);
    expect(refExists(`refs/tags/${tagFor('detached', '-head')}`)).toBe(true);
    const snapshot = tagFor('corrupt-index');
    expect(git(clone, ['show', '-s', '--format=%an <%ae>', snapshot])).toBe('Valerie Linc <valerielinc@gmail.com>');
    expect(git(clone, ['show', '-s', '--format=%P', snapshot])).toBe(corruptHead);
    expect(git(clone, ['show', `${snapshot}:real.txt`])).toContain('real edit hidden by corrupt index');
    expect(git(clone, ['rev-parse', `${tagFor('detached', '-head')}^{commit}`])).toBe(mainHead);
    expect(git(clone, ['show', `${tagFor('body-no-pr')}:.pr-body-pending.md`])).toContain('pending PR body');
  }, 120000);

  it('attiva il recupero sotto soglia e consente una soglia routine più lunga', () => {
    const autoBranch = addBranchWorktree('automatic');
    write(worktreePath('automatic'), 'real.txt', 'automatic recovery\n');
    age('automatic');
    const automatic = run(['--apply'], { PRUNE_RECLAIM_MIN_FREE_BYTES: '999999999999999' });
    expect(automatic).toContain('trigger automatico');
    expect(fs.existsSync(worktreePath('automatic'))).toBe(false);
    expect(refExists(`refs/heads/${autoBranch}`)).toBe(true);
    expect(refExists(`refs/tags/${tagFor('automatic')}`)).toBe(true);

    addBranchWorktree('routine');
    age('routine', new Date(Date.now() - 2 * HOUR));
    const routineGuard = run(['--reclaim', '--apply'], { PRUNE_RECLAIM_IDLE_MINUTES: '180' });
    expect(routineGuard).toContain('attività recente');
    expect(fs.existsSync(worktreePath('routine'))).toBe(true);
    const emergency = run(['--reclaim', '--apply'], { PRUNE_RECLAIM_IDLE_MINUTES: '60' });
    expect(emergency).toContain('rimosso');
    expect(fs.existsSync(worktreePath('routine'))).toBe(false);

    addBranchWorktree('index-fresh');
    write(worktreePath('index-fresh'), 'real.txt', 'index mtime is not activity\n');
    age('index-fresh');
    const index = git(worktreePath('index-fresh'), ['rev-parse', '--absolute-git-dir']);
    fs.utimesSync(path.join(index, 'index'), new Date(), new Date());
    const indexIgnored = run(['--reclaim', '--apply']);
    expect(indexIgnored).toContain('index-fresh');
    expect(fs.existsSync(worktreePath('index-fresh'))).toBe(false);
  }, 120000);
});
