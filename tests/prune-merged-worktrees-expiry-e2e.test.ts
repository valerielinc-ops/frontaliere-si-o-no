import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const OLD = new Date(NOW - 5 * DAY);
const RECENT = new Date(NOW - DAY);
const SCRIPT = path.join(process.cwd(), 'scripts', 'prune-merged-worktrees.mjs');

let root = '';
let clone = '';
let origin = '';
let bin = '';
let env: NodeJS.ProcessEnv = {};
let oldHead = '';
let dryRun = '';
let applyRun = '';
let failureRun = '';
let orphanDryRun = '';
let orphanApplyRun = '';
let oldAheadHead = '';
let zeroWorktree = '';
let scratchWorktree = '';
let raceWorktree = '';

function git(cwd: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): string {
  // Dopo la configurazione dello shim usato per simulare la race, il fixture
  // continua a creare branch/worktree: usa il binario reale per non far
  // dipendere lo stato iniziale del fixture dal wrapper del processo sotto
  // test. `runScript()` mantiene invece PATH con lo shim, come richiesto dalla
  // prova di mutazione tra snapshot e rimozione.
  const gitBinary = env.PRUNE_REAL_GIT || 'git';
  return execFileSync(gitBinary, args, {
    cwd,
    env: { ...env, ...extraEnv },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function write(cwd: string, file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), content);
}

function commit(cwd: string, file: string, content: string, daysAgo = 5): string {
  write(cwd, file, content);
  git(cwd, ['add', file]);
  const stamp = `@${Math.floor((NOW - daysAgo * DAY) / 1000)} +0000`;
  git(cwd, ['commit', '-q', '-m', `add ${file}`], { GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp });
  return git(cwd, ['rev-parse', 'HEAD']);
}

function worktreePath(name: string): string {
  return path.join(clone, '.claude', 'worktrees', name);
}

function ageWorktree(name: string, when = OLD): void {
  const worktree = worktreePath(name);
  const admin = git(worktree, ['rev-parse', '--absolute-git-dir']);
  for (const file of [path.join(admin, 'HEAD'), path.join(admin, 'index'), path.join(admin, 'logs', 'HEAD'), worktree]) {
    if (fs.existsSync(file)) fs.utimesSync(file, when, when);
  }
}

function ageBranch(name: string, when = OLD): void {
  const log = path.join(clone, '.git', 'logs', 'refs', 'heads', ...name.split('/'));
  if (fs.existsSync(log)) fs.utimesSync(log, when, when);
}

function makeBranch(name: string, file: string, content: string, daysAgo = 5): string {
  git(clone, ['checkout', '-q', '-b', name, 'main']);
  const head = commit(clone, file, content, daysAgo);
  git(clone, ['checkout', '-q', 'main']);
  ageBranch(name);
  return head;
}

function addWorktree(name: string, branch: string): void {
  git(clone, ['worktree', 'add', '-q', worktreePath(name), branch]);
  ageWorktree(name);
}

function runScript(args: string[] = []): string {
  return execFileSync('node', [SCRIPT, ...args], { cwd: clone, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function remoteTags(): string {
  try {
    return execFileSync('git', ['--git-dir', origin, 'show-ref', '--tags'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}

function refExists(ref: string): boolean {
  try {
    git(clone, ['show-ref', '--verify', '--quiet', ref]);
    return true;
  } catch {
    return false;
  }
}

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prune-expiry-e2e-')));
  bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const gitconfig = path.join(root, 'gitconfig');
  fs.writeFileSync(gitconfig, '');
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
  git(clone, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  oldHead = commit(clone, 'base.txt', 'base\n', 5);
  git(clone, ['push', '-q', '-u', 'origin', 'main']);
  git(clone, ['remote', 'set-head', 'origin', 'main']);

  oldAheadHead = makeBranch('fix/issue-123-old', 'old.txt', 'old\n');
  makeBranch('recent-work', 'recent.txt', 'recent\n', 2);
  makeBranch('fix/issue-129-scratch', 'scratch.txt', 'scratch\n');
  scratchWorktree = worktreePath('scratch-worktree');
  addWorktree('scratch-worktree', 'fix/issue-129-scratch');
  write(scratchWorktree, '.pr-body-prune-expiry.md', 'draft\n');
  fs.utimesSync(path.join(scratchWorktree, '.pr-body-prune-expiry.md'), OLD, OLD);
  ageWorktree('scratch-worktree');
  ageBranch('fix/issue-129-scratch');
  makeBranch('fix/issue-130-race', 'race.txt', 'base\n');
  raceWorktree = worktreePath('race-worktree');
  addWorktree('race-worktree', 'fix/issue-130-race');
  ageWorktree('race-worktree');
  ageBranch('fix/issue-130-race');
  makeBranch('dirty-worktree', 'dirty-base.txt', 'base\n');
  makeBranch('busy-worktree', 'busy.txt', 'busy\n');
  const openHead = makeBranch('open-worktree', 'open.txt', 'open\n');
  zeroWorktree = `zero-old-${oldHead.slice(0, 8)}`;
  git(clone, ['branch', zeroWorktree, 'main']);
  git(clone, ['worktree', 'add', '-q', worktreePath(zeroWorktree), zeroWorktree]);
  ageWorktree(zeroWorktree);

  addWorktree('old-ahead', 'fix/issue-123-old');
  addWorktree('recent-work', 'recent-work');
  addWorktree('dirty-worktree', 'dirty-worktree');
  write(worktreePath('dirty-worktree'), 'uncommitted.txt', 'work\n');
  fs.utimesSync(path.join(worktreePath('dirty-worktree'), 'uncommitted.txt'), OLD, OLD);
  ageWorktree('dirty-worktree');
  addWorktree('busy-worktree', 'busy-worktree');
  addWorktree('open-worktree', 'open-worktree');
  git(clone, ['worktree', 'add', '-q', '--detach', worktreePath('hooks-main'), 'main']);
  ageWorktree('hooks-main');
  ageBranch('fix/issue-123-old');
  ageBranch('recent-work', RECENT);
  ageBranch('dirty-worktree');
  ageBranch('busy-worktree');
  ageBranch('open-worktree');
  ageBranch(zeroWorktree);

  env.FAKE_LSOF_CWDS = path.join(worktreePath('busy-worktree'), 'scripts');
  const fixture = {
    open: [{ number: 9001, state: 'OPEN', baseRefName: 'main', headRefName: 'open-worktree', headRefOid: openHead }],
    all: [],
    commitPulls: {},
  };
  const fixturePath = path.join(root, 'gh-fixture.json');
  fs.writeFileSync(fixturePath, JSON.stringify(fixture));
  env.FAKE_GH_FIXTURE = fixturePath;
  fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const fx = JSON.parse(fs.readFileSync(process.env.FAKE_GH_FIXTURE, 'utf8'));
const out = (value) => { process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value)); process.exit(0); };
if (args[0] === '--version') out('gh version 0.0.0-fixture\\n');
if (args[0] === 'repo' && args[1] === 'view') out('acme/site\\n');
if (args[0] === 'pr' && args[1] === 'list') {
  if (args.includes('--head')) out(fx.all.filter((pr) => pr.headRefName === args[args.indexOf('--head') + 1]));
  out(args[args.indexOf('--state') + 1] === 'open' ? fx.open : fx.all);
}
if (args[0] === 'api') {
  const target = args.find((value) => value.startsWith('repos/')) || '';
  const match = target.match(/commits\\/([0-9a-f]{40})\\/pulls/);
  if (match) out([fx.commitPulls[match[1]] || []]);
  if (args[1] === 'graphql') out({ data: { repository: {} } });
}
process.exit(1);
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'lsof'), `#!/bin/sh
for p in $(printf '%s' "$FAKE_LSOF_CWDS" | tr ':' ' '); do printf 'p1\\nn%s\\n' "$p"; done
exit 0
`, { mode: 0o755 });

  dryRun = runScript();
  const dryTags = remoteTags();
  expect(dryRun).toContain('dry-run: niente rimosso');
  expect(dryRun).toContain('snapshot prima della rimozione');
  expect(dryTags).toBe('');

  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(bin, 'git'), `#!/usr/bin/env node
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === 'push' && args.some((arg) => arg.includes('/fix/issue-130-race')) && !fs.existsSync(process.env.PRUNE_RACE_MARKER)) {
  fs.writeFileSync(process.env.PRUNE_RACE_MARKER, 'mutated\\n');
  fs.writeFileSync(process.env.PRUNE_RACE_FILE, 'race changed during apply\\n');
}
const result = spawnSync(process.env.PRUNE_REAL_GIT, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
`, { mode: 0o755 });
  env.PRUNE_REAL_GIT = realGit;
  env.PRUNE_RACE_FILE = path.join(raceWorktree, 'race.txt');
  env.PRUNE_RACE_MARKER = path.join(root, 'race-marker');
  applyRun = runScript(['--apply']);

  makeBranch('fix/issue-126-push-fail', 'fail.txt', 'fail\n');
  addWorktree('push-fail', 'fix/issue-126-push-fail');
  ageWorktree('push-fail');
  ageBranch('fix/issue-126-push-fail');
  const updateHook = path.join(origin, 'hooks', 'update');
  fs.writeFileSync(updateHook, '#!/bin/sh\ncase "$1" in refs/tags/*) exit 1;; esac\nexit 0\n');
  fs.chmodSync(updateHook, 0o755);
  failureRun = runScript(['--apply']);

  fs.rmSync(updateHook);
  const orphanHead = makeBranch('worktree-agent-issue-128-expired', 'orphan.txt', 'orphan\n');
  ageBranch('worktree-agent-issue-128-expired');
  orphanDryRun = runScript(['--orphans-only']);
  orphanApplyRun = runScript(['--apply', '--orphans-only']);

  // Variabile usata per mantenere esplicito nel fixture che questi SHA sono
  // davvero diversi: il tag remoto dell'orfano deve puntare alla sua testa.
  expect(orphanHead).not.toBe(oldHead);
}, 120000);

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('scadenza con snapshot per worktree e branch', () => {
  it('il dry-run non modifica worktree, branch, tag o inventario', () => {
    expect(dryRun).toMatch(/worktree da rimuovere \(3\)/);
    expect(dryRun).toContain('riassunto: snapshot da creare 2');
  });

  it('crea e verifica il tag remoto prima di rimuovere il lavoro scaduto', () => {
    expect(applyRun).toContain('snapshot remoto');
    expect(fs.existsSync(worktreePath('old-ahead'))).toBe(false);
    expect(refExists('refs/heads/fix/issue-123-old')).toBe(false);
    const tags = remoteTags().split('\n');
    expect(tags.some((line) => line.startsWith(`${oldAheadHead} refs/tags/`))).toBe(true);
    expect(tags.some((line) => line.includes('/fix/issue-123-old'))).toBe(true);
    expect(tags.some((line) => line.includes(`/${zeroWorktree}`))).toBe(false);
    expect(applyRun).toContain('snapshot creati 2');
  });

  it('rimuove 0-ahead senza snapshot e conserva le esclusioni', () => {
    expect(fs.existsSync(worktreePath(zeroWorktree))).toBe(false);
    expect(fs.existsSync(worktreePath('recent-work'))).toBe(true);
    expect(fs.existsSync(scratchWorktree)).toBe(true);
    expect(fs.existsSync(worktreePath('dirty-worktree'))).toBe(true);
    expect(fs.existsSync(worktreePath('busy-worktree'))).toBe(true);
    expect(fs.existsSync(worktreePath('open-worktree'))).toBe(true);
    expect(fs.existsSync(worktreePath('hooks-main'))).toBe(true);
    expect(fs.existsSync(worktreePath('push-fail'))).toBe(true);
    expect(refExists('refs/heads/fix/issue-129-scratch')).toBe(true);
  });

  it('lascia il worktree se diventa sporco tra snapshot e rimozione', () => {
    expect(applyRun).toContain('worktree diventato sporco durante lo sweep');
    expect(fs.existsSync(raceWorktree)).toBe(true);
    expect(refExists('refs/heads/fix/issue-130-race')).toBe(true);
  });

  it('non rimuove nulla se il push dello snapshot fallisce', () => {
    expect(failureRun).toContain('FALLITO snapshot fix/issue-126-push-fail');
    expect(fs.existsSync(worktreePath('push-fail'))).toBe(true);
    expect(refExists('refs/heads/fix/issue-126-push-fail')).toBe(true);
  });

  it('registra branch, SHA, issue, commit e file toccati nell’inventario locale', () => {
    const gitCommon = path.resolve(clone, git(clone, ['rev-parse', '--git-common-dir']));
    const inventory = fs.readFileSync(path.join(gitCommon, 'frontaliere-worktree-expiry-inventory.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    const item = inventory.find((entry) => entry.branch === 'fix/issue-123-old');
    expect(item).toMatchObject({ branch: 'fix/issue-123-old', issue: '123', commits: 1, kind: 'expiry' });
    expect(item.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(item.files).toContain('old.txt');
  });
});

describe('--orphans-only prudente', () => {
  it('usa la stessa soglia in dry-run e poi conserva il branch in un tag remoto', () => {
    expect(orphanDryRun).toContain('candidati scaduti: 1');
    expect(orphanDryRun).toContain('dry-run: niente rimosso');
    expect(orphanApplyRun).toContain('branch rimossi: 1');
    expect(refExists('refs/heads/worktree-agent-issue-128-expired')).toBe(false);
    expect(remoteTags()).toContain('/worktree-agent-issue-128-expired');
  });
});
