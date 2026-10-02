import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Esegue scripts/prune-merged-worktrees.mjs su un clone usa-e-getta, con `gh`
// e `lsof` finti in testa al PATH. Ogni caso riproduce un worktree che il
// 2026-10-02 lo script lasciava indietro (o il controcaso che deve restare):
//   • body della PR non tracciato in un worktree con PR MERGED      → via
//   • file non tracciato vero nello stesso stato                     → resta
//   • worktree senza PR, 0-ahead, fermo da giorni                    → via
//   • stesso stato ma attivo di recente, o in uso da un processo     → resta
//   • senza PR ma con un commit proprio                              → resta
//   • detached dentro l'HEAD di una PR MERGED, compare API in 422    → via
//   • detached su un commit che nessuna PR contiene                  → resta
//   • branch di risoluzione dentro una PR MERGED, compare API in 422 → via
//   • checkout interrotto (niente index, solo contenuto di HEAD)     → via
//   • checkout interrotto con un file che HEAD non ha                → resta
//   • directory orfana fatta solo di .DS_Store                       → via
//   • directory orfana con un file vero, o modificata di recente     → resta
//   • hooks-main e worktree locked                                    → restano

const SCRIPT = path.join(process.cwd(), 'scripts', 'prune-merged-worktrees.mjs');
const OLD = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);

let root = '';
let clone = '';
let bin = '';
let env: NodeJS.ProcessEnv = {};
const sha: Record<string, string> = {};
let dryRun = '';
let applyRun = '';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commitFile(cwd: string, file: string, content: string): string {
  fs.writeFileSync(path.join(cwd, file), content);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', `add ${file}`);
  return git(cwd, 'rev-parse', 'HEAD');
}

function wt(name: string): string {
  return path.join(clone, '.claude', 'worktrees', name);
}

// Invecchia i segnali di attività che lo script legge: HEAD, index e reflog
// del worktree, più la sua radice.
function age(worktreePath: string): void {
  const admin = git(worktreePath, 'rev-parse', '--absolute-git-dir');
  for (const p of [path.join(admin, 'HEAD'), path.join(admin, 'index'), path.join(admin, 'logs', 'HEAD'), worktreePath]) {
    if (fs.existsSync(p)) fs.utimesSync(p, OLD, OLD);
  }
}

function ageTree(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) ageTree(full);
    fs.utimesSync(full, OLD, OLD);
  }
  fs.utimesSync(dir, OLD, OLD);
}

function runScript(args: string[]): string {
  return execFileSync('node', [SCRIPT, ...args], { cwd: clone, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prune-wt-e2e-')));
  bin = path.join(root, 'bin');
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
    FAKE_GH_FIXTURE: path.join(root, 'gh-fixture.json'),
    FAKE_LSOF_CWDS: '',
  };

  const origin = path.join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch', 'main', origin], { env });
  clone = path.join(root, 'site');
  execFileSync('git', ['clone', '-q', origin, clone], { env, stdio: 'ignore' });
  git(clone, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  sha.A = commitFile(clone, 'a.txt', 'base\n');
  git(clone, 'push', '-q', '-u', 'origin', 'main');
  git(clone, 'remote', 'set-head', 'origin', 'main');

  // Commit dei branch "di lavoro", creati dal checkout principale.
  git(clone, 'checkout', '-q', '-b', 'feat-merged');
  sha.F1 = commitFile(clone, 'f1.txt', 'f1\n');
  git(clone, 'checkout', '-q', 'main');
  git(clone, 'checkout', '-q', '-b', 'feat-merged-dirty');
  sha.F2 = commitFile(clone, 'f2.txt', 'f2\n');
  git(clone, 'checkout', '-q', 'main');
  git(clone, 'checkout', '-q', '-b', 'idle-ahead');
  sha.G = commitFile(clone, 'g.txt', 'g\n');
  git(clone, 'checkout', '-q', 'main');
  // PR #2 (squash): R1 è un commit intermedio, R2 l'HEAD mergiato. R2 resta
  // nel clone tramite un ref fuori da refs/heads, come un HEAD di PR fetchato.
  git(clone, 'checkout', '-q', '-b', 'pr-two');
  sha.R1 = commitFile(clone, 'r1.txt', 'r1\n');
  sha.R2 = commitFile(clone, 'r2.txt', 'r2\n');
  git(clone, 'update-ref', 'refs/pull-heads/2', sha.R2);
  git(clone, 'checkout', '-q', 'main');
  git(clone, 'branch', '-q', '-D', 'pr-two');
  git(clone, 'branch', '-q', 'resolve-branch', sha.R1);
  git(clone, 'checkout', '-q', '-b', 'tmp-unrelated');
  sha.U = commitFile(clone, 'u.txt', 'u\n');
  git(clone, 'checkout', '-q', 'main');

  fs.mkdirSync(path.join(clone, '.claude', 'worktrees'), { recursive: true });
  const add = (...args: string[]) => git(clone, 'worktree', 'add', '-q', ...args);
  add(wt('feat-merged'), 'feat-merged');
  fs.writeFileSync(path.join(wt('feat-merged'), '.pr-body-feat.md'), '## Implementato\n');
  add(wt('feat-merged-dirty'), 'feat-merged-dirty');
  fs.writeFileSync(path.join(wt('feat-merged-dirty'), 'notes.ts'), 'export const x = 1;\n');
  add('-b', 'idle-main', wt('idle-main'), 'origin/main');
  add('-b', 'fresh-main', wt('fresh-main'), 'origin/main');
  add('-b', 'busy-main', wt('busy-main'), 'origin/main');
  add(wt('idle-ahead'), 'idle-ahead');
  add('--detach', wt('resolve-detached'), sha.R1);
  add('--detach', wt('detached-unrelated'), sha.U);
  git(clone, 'branch', '-q', '-D', 'tmp-unrelated');
  add('--no-checkout', '-b', 'aborted', wt('aborted'), 'origin/main');
  fs.writeFileSync(path.join(wt('aborted'), 'a.txt'), 'base\n'); // identico a HEAD
  add('--no-checkout', '-b', 'aborted-work', wt('aborted-work'), 'origin/main');
  fs.writeFileSync(path.join(wt('aborted-work'), 'new.ts'), 'lavoro\n');
  add('--detach', wt('hooks-main'), 'origin/main');
  add('-b', 'locked-main', wt('locked-main'), 'origin/main');
  git(clone, 'worktree', 'lock', wt('locked-main'));

  for (const name of ['feat-merged', 'feat-merged-dirty', 'idle-main', 'busy-main', 'idle-ahead',
    'resolve-detached', 'detached-unrelated', 'aborted', 'aborted-work', 'hooks-main', 'locked-main']) {
    age(wt(name));
  }

  // Directory che git non conosce più.
  const ghost = wt('ghost');
  fs.mkdirSync(ghost);
  fs.writeFileSync(path.join(ghost, '.DS_Store'), 'x');
  ageTree(ghost);
  const ghostWork = wt('ghost-work');
  fs.mkdirSync(ghostWork);
  fs.writeFileSync(path.join(ghostWork, 'x.ts'), 'lavoro\n');
  ageTree(ghostWork);
  const ghostFresh = wt('ghost-fresh');
  fs.mkdirSync(ghostFresh);
  fs.writeFileSync(path.join(ghostFresh, '.DS_Store'), 'x');

  fs.writeFileSync(env.FAKE_GH_FIXTURE as string, JSON.stringify({
    open: [],
    all: [
      { state: 'MERGED', baseRefName: 'main', headRefName: 'feat-merged', headRefOid: sha.F1 },
      { state: 'MERGED', baseRefName: 'main', headRefName: 'feat-merged-dirty', headRefOid: sha.F2 },
    ],
    commitPulls: {
      [sha.R1]: [{ number: 2, state: 'closed', merged_at: '2026-09-27T17:04:58Z', base: { ref: 'main' }, head: { sha: sha.R2 } }],
    },
  }));
  // `gh` finto: risponde alle sole chiamate dello script; la compare API
  // risponde come GitHub sui diff grandi (422), così la prova deve essere locale.
  fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
const fx = JSON.parse(fs.readFileSync(process.env.FAKE_GH_FIXTURE, 'utf8'));
const out = (v) => { process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v)); process.exit(0); };
if (a[0] === '--version') out('gh version 0.0.0-fixture\\n');
if (a[0] === 'repo' && a[1] === 'view') out('acme/site\\n');
if (a[0] === 'pr' && a[1] === 'list') {
  const state = a[a.indexOf('--state') + 1];
  if (a.includes('--head')) out([]);
  out(state === 'open' ? fx.open : fx.all);
}
if (a[0] === 'api') {
  const target = a.find((x) => x.startsWith('repos/')) || '';
  const m = target.match(/commits\\/([0-9a-f]{40})\\/pulls/);
  if (m) out([fx.commitPulls[m[1]] || []]);
  process.stderr.write('{"message":"Server Error: Sorry, this diff is taking too long to generate.","status":"422"}');
  process.exit(1);
}
process.exit(1);
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'lsof'), `#!/bin/sh
for p in $(printf '%s' "$FAKE_LSOF_CWDS" | tr ':' ' '); do printf 'p1\\nn%s\\n' "$p"; done
exit 0
`, { mode: 0o755 });
  env.FAKE_LSOF_CWDS = path.join(wt('busy-main'), 'scripts');

  dryRun = runScript([]);
  applyRun = runScript(['--apply']);
}, 120000);

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('prune-merged-worktrees.mjs su un clone di prova', () => {
  it('il dry-run non tocca niente', () => {
    expect(dryRun).toContain('dry-run: niente rimosso');
    expect(dryRun).toMatch(/worktree da rimuovere \(4\)/);
    expect(dryRun).toMatch(/directory orfane da rimuovere \(1\)/);
  });

  it.each([
    ['feat-merged', 'body della PR non tracciato, PR MERGED con HEAD esatto'],
    ['idle-main', 'nessuna PR, 0-ahead, fermo da giorni'],
    ['resolve-detached', 'detached dentro una PR MERGED, compare API in 422'],
    ['aborted', 'checkout interrotto con solo contenuto di HEAD'],
    ['ghost', 'directory orfana fatta di soli residui'],
  ])('rimuove %s (%s)', (name) => {
    expect(fs.existsSync(wt(name)), applyRun).toBe(false);
  });

  it.each([
    ['feat-merged-dirty', 'file non tracciato vero'],
    ['fresh-main', 'attivo di recente'],
    ['busy-main', 'un processo ha la cwd dentro'],
    ['idle-ahead', 'commit senza PR'],
    ['detached-unrelated', 'commit in nessuna PR'],
    ['aborted-work', 'checkout interrotto con un file che HEAD non ha'],
    ['hooks-main', 'worktree degli hook'],
    ['locked-main', 'locked'],
    ['ghost-work', 'directory orfana con un file vero'],
    ['ghost-fresh', 'directory orfana modificata di recente'],
  ])('tiene %s (%s)', (name) => {
    expect(fs.existsSync(wt(name)), applyRun).toBe(true);
  });

  it('cancella i branch rimossi e quello di risoluzione, tiene gli altri', () => {
    const branches = git(clone, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n');
    for (const gone of ['feat-merged', 'idle-main', 'aborted', 'resolve-branch']) expect(branches).not.toContain(gone);
    for (const kept of ['feat-merged-dirty', 'fresh-main', 'busy-main', 'idle-ahead', 'aborted-work', 'locked-main']) {
      expect(branches).toContain(kept);
    }
  });

  it('lascia uno snapshot dei commit che non sono su main', () => {
    const tags = git(clone, 'tag', '--list', 'snapshot/*', '--format=%(refname:short) %(objectname)').split('\n');
    expect(tags.some((t) => t.startsWith('snapshot/purge/feat-merged-') && t.endsWith(sha.F1))).toBe(true);
    expect(tags.some((t) => t.startsWith('snapshot/purge/resolve-branch-') && t.endsWith(sha.R1))).toBe(true);
    expect(tags.some((t) => t.startsWith(`snapshot/purge/detached-${sha.R1.slice(0, 12)}-`) && t.endsWith(sha.R1))).toBe(true);
  });

  it('git non conosce più i worktree rimossi', () => {
    const listed = git(clone, 'worktree', 'list', '--porcelain');
    for (const gone of ['feat-merged', 'idle-main', 'resolve-detached', 'aborted']) {
      expect(listed).not.toContain(`${wt(gone)}\n`);
    }
    expect(applyRun).toMatch(/applicate \d+ rimozioni\./);
    expect(applyRun).not.toContain('FALLIT');
  });
});
