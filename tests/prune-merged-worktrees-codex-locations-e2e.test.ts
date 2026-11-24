import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runIsolatedPruner } from './helpers/runIsolatedPruner';

// Worktree creati dagli agenti Codex fuori dalle cartelle canoniche. Fino al
// 2026-11-24 il pruner li ignorava: 18 in `~/.codex-worktrees` fermi dal 16/11
// sul Mac agenti, 30 `frontaliere-si-o-no-worktree-*` dal 29/10 sul Mac
// principale. Valgono le stesse prove e guardie degli altri worktree:
//   • `.codex-worktrees/<nome>`, 0-ahead, fermo da giorni          → via
//   • `<checkout>-worktree-<nome>` accanto al checkout              → via
//   • `<checkout>-worktree-<nome>` in un'altra cartella             → via
//   • `<checkout>-worktreeish` (somiglia ma non è la convenzione)   → resta
//   • `<checkout>-worktree-<nome>` con attività recente             → resta
//   • `CODEX_HOME/worktrees/<nome>` (gestito dall'app Codex)        → resta

const SCRIPT = path.join(process.cwd(), 'scripts', 'prune-merged-worktrees.mjs');
const OLD = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);

let root = '';
let clone = '';
let env: NodeJS.ProcessEnv = {};
let applyRun = '';
const paths: Record<string, string> = {};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function age(worktreePath: string): void {
  const admin = git(worktreePath, 'rev-parse', '--absolute-git-dir');
  for (const p of [path.join(admin, 'HEAD'), path.join(admin, 'index'), path.join(admin, 'logs', 'HEAD'), worktreePath]) {
    if (fs.existsSync(p)) fs.utimesSync(p, OLD, OLD);
  }
  for (const entry of fs.readdirSync(worktreePath, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const full = path.join(worktreePath, entry.name);
    if (entry.isSymbolicLink()) fs.lutimesSync(full, OLD, OLD);
    else fs.utimesSync(full, OLD, OLD);
  }
}

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prune-wt-codex-loc-')));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const gitconfig = path.join(root, 'gitconfig');
  fs.writeFileSync(gitconfig, '');
  const base: NodeJS.ProcessEnv = { ...process.env };
  delete base.FRONTALIERE_SITE_HOOKS_DIR;
  delete base.GIT_DIR;
  delete base.GIT_WORK_TREE;
  delete base.GIT_INDEX_FILE;
  env = {
    ...base,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    CODEX_HOME: path.join(root, 'codex-home'),
  };

  const origin = path.join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch', 'main', origin], { env });
  clone = path.join(root, 'site');
  execFileSync('git', ['clone', '-q', origin, clone], { env, stdio: 'ignore' });
  git(clone, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  fs.writeFileSync(path.join(clone, 'a.txt'), 'base\n');
  git(clone, 'add', 'a.txt');
  git(clone, 'commit', '-q', '-m', 'base');
  git(clone, 'push', '-q', '-u', 'origin', 'main');
  git(clone, 'remote', 'set-head', 'origin', 'main');

  // `gh` finto senza PR; `lsof` finto senza processi nei worktree.
  fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env node
const a = process.argv.slice(2);
const out = (v) => { process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v)); process.exit(0); };
if (a[0] === '--version') out('gh version 0.0.0-fixture\\n');
if (a[0] === 'repo' && a[1] === 'view') out('acme/site\\n');
if (a[0] === 'pr' && a[1] === 'list') out([]);
if (a[0] === 'api') out([]);
process.exit(1);
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'lsof'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  paths.codexCli = path.join(root, '.codex-worktrees', 'codex-cli-idle');
  paths.sibling = `${clone}-worktree-sibling-idle`;
  paths.outerSibling = path.join(root, 'outer', 'site-worktree-outer-idle');
  paths.lookalike = `${clone}-worktreeish`;
  paths.siblingFresh = `${clone}-worktree-sibling-fresh`;
  paths.appManaged = path.join(env.CODEX_HOME as string, 'worktrees', 'managed-idle');
  for (const p of [paths.codexCli, paths.outerSibling, paths.appManaged]) fs.mkdirSync(path.dirname(p), { recursive: true });
  const add = (branch: string, p: string) => git(clone, 'worktree', 'add', '-q', '-b', branch, p, 'origin/main');
  add('codex-cli-idle', paths.codexCli);
  add('sibling-idle', paths.sibling);
  add('outer-sibling-idle', paths.outerSibling);
  add('sibling-lookalike', paths.lookalike);
  add('sibling-fresh', paths.siblingFresh);
  add('codex-app-managed', paths.appManaged);
  for (const key of ['codexCli', 'sibling', 'outerSibling', 'lookalike', 'appManaged']) age(paths[key]);

  applyRun = runIsolatedPruner(SCRIPT, ['--apply'], root, clone, env);
}, 120000);

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('prune-merged-worktrees.mjs: posizioni dei worktree Codex', () => {
  it.each([
    ['codexCli', '.codex-worktrees/<nome>'],
    ['sibling', '<checkout>-worktree-<nome> accanto al checkout'],
    ['outerSibling', '<checkout>-worktree-<nome> in un\'altra cartella'],
  ])('rimuove %s (%s) fermo, pulito e già su main', (key) => {
    expect(fs.existsSync(paths[key]), applyRun).toBe(false);
  });

  it('non tocca una cartella sorella che somiglia soltanto alla convenzione', () => {
    expect(fs.existsSync(paths.lookalike), applyRun).toBe(true);
  });

  it('tiene un worktree sorella con attività recente', () => {
    expect(fs.existsSync(paths.siblingFresh), applyRun).toBe(true);
  });

  it('lascia a Codex i worktree sotto CODEX_HOME/worktrees', () => {
    expect(fs.existsSync(paths.appManaged), applyRun).toBe(true);
  });

  it('non tocca mai il checkout principale', () => {
    expect(fs.existsSync(path.join(clone, 'a.txt'))).toBe(true);
    expect(git(clone, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
  });
});
