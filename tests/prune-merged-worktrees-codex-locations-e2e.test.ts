import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runIsolatedPruner } from './helpers/runIsolatedPruner';

// Worktree creati dagli agenti Codex fuori dalle cartelle canoniche. Fino al
// 2026-11-24 il pruner li ignorava: 18 in `~/.codex-worktrees` fermi dal 16/11
// sul Mac agenti, 30 `frontaliere-si-o-no-worktree-*` dal 29/10 sul Mac
// principale. Valgono le stesse prove e guardie degli altri worktree, sia nella
// sweep normale sia nel reclaim a disco basso (che prima aveva un elenco suo):
//   • `~/.codex-worktrees/<nome>`, 0-ahead, fermo da giorni              → via
//   • `<checkout>-worktree-<nome>` nella cartella del checkout           → via
//   • `<checkout>-worktree-<nome>` nella cartella sopra                  → via
//   • `<checkout>-worktree-<nome>` altrove (es. Scrivania)               → resta
//   • `<checkout>-worktreeish` (somiglia ma non è la convenzione)        → resta
//   • `<checkout>-worktree-<nome>` con attività recente                  → resta
//   • `CODEX_HOME/worktrees/<nome>` (app Codex; `~/.codex/worktrees`)    → resta

const SCRIPT = path.join(process.cwd(), 'scripts', 'prune-merged-worktrees.mjs');
const OLD = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);

type Fixture = { root: string; clone: string; env: NodeJS.ProcessEnv; paths: Record<string, string> };

function makeGit(env: NodeJS.ProcessEnv) {
  return (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function age(git: ReturnType<typeof makeGit>, worktreePath: string): void {
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

function createFixture(prefix: string, extraEnv: NodeJS.ProcessEnv): Fixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const gitconfig = path.join(root, 'gitconfig');
  fs.writeFileSync(gitconfig, '');
  const base: NodeJS.ProcessEnv = { ...process.env };
  delete base.FRONTALIERE_SITE_HOOKS_DIR;
  delete base.GIT_DIR;
  delete base.GIT_WORK_TREE;
  delete base.GIT_INDEX_FILE;
  const env: NodeJS.ProcessEnv = {
    ...base,
    HOME: root,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    // Il default reale è `~/.codex`: qui `worktrees/` corrisponde a ISOLATION_RE
    // e il test prova davvero l'esclusione dei worktree dell'app Codex.
    CODEX_HOME: path.join(root, '.codex'),
    ...extraEnv,
  };
  const git = makeGit(env);

  const origin = path.join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch', 'main', origin], { env });
  const workspace = path.join(root, 'ws');
  fs.mkdirSync(workspace);
  const clone = path.join(workspace, 'site');
  execFileSync('git', ['clone', '-q', origin, clone], { env, stdio: 'ignore' });
  git(clone, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  fs.writeFileSync(path.join(clone, 'a.txt'), 'base\n');
  git(clone, 'add', 'a.txt');
  git(clone, 'commit', '-q', '-m', 'base');
  git(clone, 'push', '-q', '-u', 'origin', 'main');
  git(clone, 'remote', 'set-head', 'origin', 'main');

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

  const paths: Record<string, string> = {
    codexCli: path.join(root, '.codex-worktrees', 'codex-cli-idle'),
    sibling: path.join(workspace, 'site-worktree-sibling-idle'),
    parentSibling: path.join(root, 'site-worktree-parent-idle'),
    farSibling: path.join(root, 'elsewhere', 'site-worktree-far-idle'),
    lookalike: path.join(workspace, 'site-worktreeish'),
    siblingFresh: path.join(workspace, 'site-worktree-sibling-fresh'),
    appManaged: path.join(root, '.codex', 'worktrees', 'managed-idle'),
  };
  for (const p of Object.values(paths)) fs.mkdirSync(path.dirname(p), { recursive: true });
  for (const [key, p] of Object.entries(paths)) {
    git(clone, 'worktree', 'add', '-q', '-b', key, p, 'origin/main');
    if (key !== 'siblingFresh') age(git, p);
  }
  return { root, clone, env, paths };
}

function expectCodexScope(fixture: Fixture, run: string): void {
  for (const key of ['codexCli', 'sibling', 'parentSibling']) {
    expect(fs.existsSync(fixture.paths[key]), `${key}\n${run}`).toBe(false);
  }
  for (const key of ['farSibling', 'lookalike', 'siblingFresh', 'appManaged']) {
    expect(fs.existsSync(fixture.paths[key]), `${key}\n${run}`).toBe(true);
  }
  expect(fs.existsSync(path.join(fixture.clone, 'a.txt'))).toBe(true);
}

const fixtures: Fixture[] = [];

describe('prune-merged-worktrees.mjs: posizioni dei worktree Codex', () => {
  let sweep: Fixture;
  let sweepRun = '';
  beforeAll(() => {
    // Soglia del reclaim a 1 byte: qui si prova la sweep normale anche su un
    // host con poco disco libero.
    sweep = createFixture('prune-wt-codex-loc-', { PRUNE_RECLAIM_MIN_FREE_BYTES: '1' });
    fixtures.push(sweep);
    sweepRun = runIsolatedPruner(SCRIPT, ['--apply'], sweep.root, sweep.clone, sweep.env);
  }, 120000);

  it('rimuove i worktree Codex fermi e puliti, tiene sosia, lontani, recenti e quelli dell\'app Codex', () => {
    expectCodexScope(sweep, sweepRun);
  });
});

describe('reclaim a disco basso: stesse posizioni dei worktree Codex', () => {
  let reclaim: Fixture;
  let reclaimRun = '';
  beforeAll(() => {
    // Soglia altissima: --apply entra nel reclaim ed esce prima della sweep, come
    // sul Mac principale con pochi GiB liberi.
    reclaim = createFixture('prune-wt-codex-reclaim-', { PRUNE_RECLAIM_MIN_FREE_BYTES: String(Number.MAX_SAFE_INTEGER) });
    fixtures.push(reclaim);
    reclaimRun = runIsolatedPruner(SCRIPT, ['--apply'], reclaim.root, reclaim.clone, reclaim.env);
  }, 120000);

  it('il reclaim rimuove anche i worktree Codex e rispetta le stesse esclusioni', () => {
    expectCodexScope(reclaim, reclaimRun);
  });
});

afterAll(() => {
  for (const fixture of fixtures) fs.rmSync(fixture.root, { recursive: true, force: true });
});
