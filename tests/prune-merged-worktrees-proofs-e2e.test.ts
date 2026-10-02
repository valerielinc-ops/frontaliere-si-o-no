import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Le prove di contenuto di scripts/prune-merged-worktrees.mjs sul clone di
// prova, con `gh` e `lsof` finti. Ogni worktree riproduce un caso che il
// 2026-10-02 è stato smaltito a mano (o il controcaso che deve restare):
//   • commit cherry-pickato in una PR poi mergiata, trovata dal corpo dello squash → via
//     - lo stesso commit revertito nella PR, o con un commit in più               → resta
//   • commit diviso in due commit della PR (patch-id per file), PR trovata per nome → via
//   • sporco tracciato identico a un blob della PR                                   → via
//     - sporco diverso                                                               → resta
//   • merge rifatto che differisce dal gemello della PR solo nel file generato     → via
//     - stesso merge con una risoluzione scritta a mano                             → resta
//   • PR CLOSED riapplicata (issue COMPLETED + PR fix/issue-N MERGED), con sporco  → via
//     - PR CLOSED senza issue di riapplicazione                                     → resta
//   • PR CLOSED con HEAD == headRefOid chiusa da 10 giorni (body PR = rumore)       → via
//     - chiusa da 2 giorni, o con un commit locale in più                           → resta
//   • HEAD antenato della head di un'altra PR MERGED, propria PR CLOSED              → via
//     - con un commit in più: resta, annotato «probabile superato»
//   • body della PR non tracciato SENZA PR                                           → resta
//   • vecchio checkout di main (tutto lo sporco = un commit first-parent)           → via
//     - un file che non coincide, o attivo da meno di 7 giorni                      → resta
//   • directory orfana con tutti i file in main allo stesso path                     → via
//     - un file che esiste solo in un commit irraggiungibile, o mai esistito         → resta
//   • branch senza worktree equivalente per patch-id                                 → cancellato
//   • issue nel nome chiusa: resta, annotato

const SCRIPT = path.join(process.cwd(), 'scripts', 'prune-merged-worktrees.mjs');
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const at = (msAgo: number) => new Date(NOW - msAgo);

let root = '';
let clone = '';
let bin = '';
let env: NodeJS.ProcessEnv = {};
const sha: Record<string, string> = {};
let dryRun = '';
let applyRun = '';

function git(cwd: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): string {
  return execFileSync('git', args, { cwd, env: { ...env, ...extraEnv }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function write(cwd: string, file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), content);
}

// Commit con una data esplicita: le finestre di main (vecchio checkout,
// directory orfane) leggono le date dei commit first-parent.
function commit(cwd: string, msg: string, msAgo: number, files: Record<string, string | null> = {}): string {
  for (const [file, content] of Object.entries(files)) {
    if (content === null) git(cwd, ['rm', '-q', file]);
    else { write(cwd, file, content); git(cwd, ['add', file]); }
  }
  const date = `@${Math.floor((NOW - msAgo) / 1000)} +0000`;
  git(cwd, ['commit', '-q', '--allow-empty', '-m', msg], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  return git(cwd, ['rev-parse', 'HEAD']);
}

function wt(name: string): string {
  return path.join(clone, '.claude', 'worktrees', name);
}

function setTimes(p: string, when: Date): void {
  if (fs.existsSync(p)) fs.utimesSync(p, when, when);
}

// Invecchia i segnali di attività che lo script legge: HEAD, index e reflog
// del worktree, più la sua radice.
function age(worktreePath: string, when: Date = at(5 * DAY), indexWhen: Date = when): void {
  const admin = git(worktreePath, ['rev-parse', '--absolute-git-dir']);
  for (const p of [path.join(admin, 'HEAD'), path.join(admin, 'logs', 'HEAD'), worktreePath]) setTimes(p, when);
  setTimes(path.join(admin, 'index'), indexWhen);
}

function ageTree(dir: string, when: Date): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) ageTree(full, when);
    fs.utimesSync(full, when, when);
  }
  fs.utimesSync(dir, when, when);
}

function runScript(args: string[]): string {
  return execFileSync('node', [SCRIPT, ...args], { cwd: clone, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// Un ramo di PR creato e poi tolto da refs/heads: l'HEAD resta nel clone in
// refs/pull-heads/<n>, come un HEAD di PR fetchato.
function prBranch(n: number, from: string, build: () => void): string {
  git(clone, ['checkout', '-q', '-b', `tmp-pr-${n}`, from]);
  build();
  const head = git(clone, ['rev-parse', 'HEAD']);
  git(clone, ['update-ref', `refs/pull-heads/${n}`, head]);
  git(clone, ['checkout', '-q', 'main']);
  git(clone, ['branch', '-q', '-D', `tmp-pr-${n}`]);
  return head;
}

function localBranch(name: string, from: string, build: () => void = () => {}): string {
  git(clone, ['checkout', '-q', '-b', name, from]);
  build();
  const head = git(clone, ['rev-parse', 'HEAD']);
  git(clone, ['checkout', '-q', 'main']);
  return head;
}

const merged = (number: number, headRefName: string, headRefOid: string) => ({
  number, state: 'MERGED', baseRefName: 'main', headRefName, headRefOid, closedAt: at(DAY).toISOString(),
});
const closed = (number: number, headRefName: string, headRefOid: string, closedAgo: number) => ({
  number, state: 'CLOSED', baseRefName: 'main', headRefName, headRefOid, closedAt: at(closedAgo).toISOString(),
});

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prune-proofs-e2e-')));
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
  git(clone, ['symbolic-ref', 'HEAD', 'refs/heads/main']);

  // --- main, con date crescenti ------------------------------------------------
  sha.A = commit(clone, 'base', 40 * DAY, {
    'a.txt': 'base\n', 'w.txt': 'w0\n', '.gitignore': 'dist/\n', 's1.txt': 's1-old\n', 's2.txt': 's2\n',
    '.github/corpus-workflows/contract.json': '{"sourceCommit":"0"}\n', 'y.txt': 'y0\n',
  });
  sha.M1 = commit(clone, 'main: m1', 12 * DAY, { 'm1.txt': 'm1\n' });
  sha.Mx = commit(clone, 'main: refresh contract', 11 * DAY, { '.github/corpus-workflows/contract.json': '{"sourceCommit":"mx"}\n' });
  sha.M2 = commit(clone, 'main: s1 nuovo, s2 via, s3', 10 * DAY, { 's1.txt': 's1-new\n', 's2.txt': null, 's3.txt': 's3\n' });
  sha.W1 = commit(clone, 'main: w1', 6 * DAY, { 'w.txt': 'w1\n' });

  // --- PR e branch locali ------------------------------------------------------
  // #10: cherry-pick poi modificato nella PR.
  sha.X2 = prBranch(10, sha.A, () => {
    sha.X1 = commit(clone, 'feat: add alpha', 5 * DAY, { 'alpha.txt': 'alpha\n' });
    commit(clone, 'feat: evolve alpha', 5 * DAY - 60000, { 'alpha.txt': 'alpha v2\n' });
  });
  sha.C1 = localBranch('cherry-local', sha.A, () => { commit(clone, 'feat: add alpha', 4 * DAY, { 'alpha.txt': 'alpha\n' }); });
  sha.C1e = localBranch('cherry-extra', sha.A, () => {
    commit(clone, 'feat: add alpha', 4 * DAY - 60000, { 'alpha.txt': 'alpha\n' });
    commit(clone, 'feat: solo locale', 4 * DAY - 120000, { 'extra.txt': 'extra\n' });
  });
  sha.C1b = localBranch('cherry-branch-only', sha.A, () => { commit(clone, 'feat: add alpha', 4 * DAY - 180000, { 'alpha.txt': 'alpha\n' }); });
  // #11: il commit cherry-pickato viene revertito nella PR.
  sha.X5 = prBranch(11, sha.A, () => {
    commit(clone, 'feat: add gamma', 5 * DAY, { 'gamma.txt': 'gamma\n' });
    git(clone, ['revert', '--no-edit', 'HEAD']);
    commit(clone, 'feat: delta', 5 * DAY - 60000, { 'delta.txt': 'delta\n' });
  });
  sha.C2 = localBranch('cherry-reverted', sha.A, () => { commit(clone, 'feat: add gamma', 4 * DAY, { 'gamma.txt': 'gamma\n' }); });
  // #12 (head `split-local-r1`): il commit locale è diviso in due commit della PR.
  sha.X8 = prBranch(12, sha.A, () => {
    commit(clone, 'p', 5 * DAY, { 'p.txt': 'p\n' });
    commit(clone, 'q', 5 * DAY - 60000, { 'q.txt': 'q\n' });
    commit(clone, 'p2', 5 * DAY - 120000, { 'p.txt': 'p2\n' });
  });
  sha.C4 = localBranch('split-local', sha.A, () => { commit(clone, 'feat: p and q', 4 * DAY, { 'p.txt': 'p\n', 'q.txt': 'q\n' }); });
  // #13 / #15: worktree fermo a un commit intermedio della propria PR, sporco.
  sha.D2 = prBranch(13, sha.A, () => {
    sha.D1 = commit(clone, 'r v1', 5 * DAY, { 'r.txt': 'v1\n' });
    commit(clone, 'r v2', 5 * DAY - 60000, { 'r.txt': 'v2\n' });
  });
  git(clone, ['branch', '-q', 'dirty-proven', sha.D1]);
  sha.E2 = prBranch(15, sha.A, () => {
    sha.E1 = commit(clone, 'r2 v1', 5 * DAY, { 'r2.txt': 'v1\n' });
    commit(clone, 'r2 v2', 5 * DAY - 60000, { 'r2.txt': 'v2\n' });
  });
  git(clone, ['branch', '-q', 'dirty-unproven', sha.E1]);
  // #14: la PR ha unito main con un merge; in locale lo stesso merge rifatto.
  sha.Y2 = prBranch(14, sha.A, () => {
    sha.Y1 = commit(clone, 'feat: y', 5 * DAY, { 'y.txt': 'y1\n' });
    git(clone, ['merge', '-q', '--no-edit', sha.Mx]);
    sha.Ym = git(clone, ['rev-parse', 'HEAD']);
    commit(clone, 'feat: y2', 5 * DAY - 60000, { 'y2.txt': 'y2\n' });
  });
  const redo = (name: string, file: string, content: string) => {
    git(clone, ['checkout', '-q', '--detach', sha.Y1]);
    git(clone, ['merge', '-q', '--no-commit', sha.Mx]);
    write(clone, file, content);
    git(clone, ['add', file]);
    git(clone, ['commit', '-q', '--no-edit']);
    sha[name] = git(clone, ['rev-parse', 'HEAD']);
    git(clone, ['checkout', '-q', 'main']);
  };
  redo('Mloc', '.github/corpus-workflows/contract.json', '{"sourceCommit":"locale"}\n');
  redo('Mhand', 'y.txt', 'y1 risolto a mano\n');
  // #51 CLOSED riapplicata da #53 (issue #52); #61 CLOSED senza riapplicazione.
  sha.F2 = prBranch(51, sha.A, () => {
    sha.F1 = commit(clone, 'fix: issue 50 parte 1', 5 * DAY, { 'f.txt': 'f1\n' });
    commit(clone, 'fix: issue 50 parte 2', 5 * DAY - 60000, { 'f.txt': 'f2\n' });
  });
  git(clone, ['branch', '-q', 'fix-issue-50-local', sha.F1]);
  sha.G2 = prBranch(61, sha.A, () => {
    sha.G1 = commit(clone, 'fix: issue 60 parte 1', 5 * DAY, { 'g.txt': 'g1\n' });
    commit(clone, 'fix: issue 60 parte 2', 5 * DAY - 60000, { 'g.txt': 'g2\n' });
  });
  git(clone, ['branch', '-q', 'fix-issue-60-local', sha.G1]);
  // #20/#21/#22: PR CLOSED con l'HEAD locale (o il suo genitore) come head.
  sha.H20 = localBranch('closed-at-head', sha.A, () => { commit(clone, 'feat: chiusa', 4 * DAY, { 'h20.txt': 'h\n' }); });
  sha.H21 = localBranch('closed-recent', sha.A, () => { commit(clone, 'feat: chiusa da poco', 4 * DAY, { 'h21.txt': 'h\n' }); });
  sha.H22p = localBranch('closed-extra', sha.A, () => {
    commit(clone, 'feat: chiusa con extra', 4 * DAY, { 'h22.txt': 'h\n' });
    commit(clone, 'feat: extra locale', 4 * DAY - 60000, { 'h22b.txt': 'h\n' });
  });
  sha.H22 = git(clone, ['rev-parse', 'closed-extra~1']);
  // #30 CLOSED, ma il commit è dentro la head di #31 MERGED.
  sha.K2 = prBranch(31, sha.A, () => {
    sha.K1 = commit(clone, 'feat: k1', 5 * DAY, { 'k.txt': 'k1\n' });
    commit(clone, 'feat: k2', 5 * DAY - 60000, { 'k.txt': 'k2\n' });
  });
  git(clone, ['branch', '-q', 'closed-in-other', sha.K1]);
  sha.K3 = localBranch('closed-in-other-extra', sha.K1, () => { commit(clone, 'feat: k3 solo locale', 4 * DAY, { 'k3.txt': 'k3\n' }); });
  sha.I77 = localBranch('worker-site-77-20260920', sha.A, () => { commit(clone, 'fix: lavoro 77', 4 * DAY, { 'i77.txt': 'x\n' }); });
  // Un commit che nessun ref raggiunge: il suo blob esiste solo nell'object DB.
  git(clone, ['checkout', '-q', '-b', 'tmp-unreachable', 'main']);
  commit(clone, 'irraggiungibile', 5 * DAY, { 'u.txt': 'solo irraggiungibile\n' });
  git(clone, ['checkout', '-q', 'main']);
  git(clone, ['branch', '-q', '-D', 'tmp-unreachable']);

  // --- squash su main --------------------------------------------------------
  commit(clone, 'feat: alpha loop (#10)', 2 * DAY, { 'alpha.txt': 'alpha v2\n' });
  fs.writeFileSync(path.join(root, 'msg'), 'feat: delta (#11)\n\n* feat: add gamma\n\n* Revert "feat: add gamma"\n\n* feat: delta\n');
  write(clone, 'delta.txt', 'delta\n');
  git(clone, ['add', 'delta.txt']);
  git(clone, ['commit', '-q', '-F', path.join(root, 'msg')], { GIT_COMMITTER_DATE: `@${Math.floor((NOW - 2 * DAY + 60000) / 1000)} +0000` });
  fs.writeFileSync(path.join(root, 'msg'), 'feat: alpha again (#10)\n\n* feat: add alpha\n\n* feat: evolve alpha\n');
  git(clone, ['commit', '-q', '--allow-empty', '-F', path.join(root, 'msg')], { GIT_COMMITTER_DATE: `@${Math.floor((NOW - 2 * DAY + 120000) / 1000)} +0000` });
  fs.writeFileSync(path.join(root, 'msg'), 'feat: k (#31)\n\n* feat: k1\n\n* feat: k2\n');
  git(clone, ['commit', '-q', '--allow-empty', '-F', path.join(root, 'msg')], { GIT_COMMITTER_DATE: `@${Math.floor((NOW - 2 * DAY + 180000) / 1000)} +0000` });
  commit(clone, 'main: w2', 60 * 60 * 1000, { 'w.txt': 'w2\n' });
  git(clone, ['push', '-q', '-u', 'origin', 'main']);
  git(clone, ['remote', 'set-head', 'origin', 'main']);

  // --- worktree --------------------------------------------------------------
  fs.mkdirSync(path.join(clone, '.claude', 'worktrees'), { recursive: true });
  const add = (...args: string[]) => git(clone, ['worktree', 'add', '-q', ...args]);
  for (const name of ['cherry-local', 'cherry-extra', 'cherry-reverted', 'split-local', 'dirty-proven', 'dirty-unproven',
    'fix-issue-50-local', 'fix-issue-60-local', 'closed-at-head', 'closed-recent', 'closed-extra',
    'closed-in-other', 'closed-in-other-extra', 'worker-site-77-20260920']) {
    add(wt(name), name);
  }
  write(wt('dirty-proven'), 'r.txt', 'v2\n'); // = blob di #13 più avanti
  write(wt('dirty-unproven'), 'r2.txt', 'v3\n'); // in nessun commit
  write(wt('fix-issue-50-local'), 'f.txt', 'f2\n'); // = blob della head di #51
  write(wt('closed-at-head'), '.pr-body-closed.md', '## Implementato\n'); // body della PR: rumore
  add('--detach', wt('merge-redo'), sha.Mloc);
  add('--detach', wt('merge-redo-hand'), sha.Mhand);
  add('-b', 'idle-main-body', wt('idle-main-body'), 'origin/main');
  write(wt('idle-main-body'), '.pr-body.md', '## Implementato\nPR non ancora aperta\n');
  // Vecchi checkout di main: HEAD a M1, contenuto di M2.
  for (const name of ['stale-checkout', 'stale-partial', 'stale-recent']) {
    add('-b', name, wt(name), sha.M1);
    write(wt(name), 's1.txt', 's1-new\n');
    fs.rmSync(path.join(wt(name), 's2.txt'));
    write(wt(name), 's3.txt', name === 'stale-partial' ? 's3 diverso\n' : 's3\n');
  }

  for (const name of ['cherry-local', 'cherry-extra', 'cherry-reverted', 'split-local', 'dirty-proven', 'dirty-unproven',
    'merge-redo', 'merge-redo-hand', 'fix-issue-50-local', 'fix-issue-60-local', 'closed-at-head', 'closed-recent',
    'closed-extra', 'closed-in-other', 'closed-in-other-extra', 'idle-main-body', 'worker-site-77-20260920']) {
    age(wt(name));
  }
  const nearM2 = at(10 * DAY - 60 * 60 * 1000);
  age(wt('stale-checkout'), nearM2);
  age(wt('stale-partial'), nearM2);
  age(wt('stale-recent'), at(3 * DAY), nearM2);
  // Branch senza worktree: l'attività è il suo reflog.
  setTimes(path.join(clone, '.git', 'logs', 'refs', 'heads', 'cherry-branch-only'), at(5 * DAY));

  // --- directory orfane --------------------------------------------------------
  const orphan = (name: string, files: Record<string, string>) => {
    const dir = wt(name);
    for (const [file, content] of Object.entries(files)) write(dir, file, content);
    ageTree(dir, at(5 * DAY));
  };
  orphan('ghost-proven', {
    'a.txt': 'base\n', // = main adesso
    'w.txt': 'w1\n', // = main sei giorni fa, nella finestra
    'dist/out.js': 'build\n', // ignorato da .gitignore
    'node_modules/x/index.js': 'x\n',
    '.DS_Store': 'x',
    '.git': `gitdir: ${path.join(clone, '.git', 'worktrees', 'sparito')}\n`,
  });
  orphan('ghost-unreachable', { 'a.txt': 'base\n', 'u.txt': 'solo irraggiungibile\n' });
  orphan('ghost-foreign', { 'a.txt': 'base\n', 'nuovo.ts': 'mai esistito\n' });

  // --- GitHub finto --------------------------------------------------------------
  fs.writeFileSync(env.FAKE_GH_FIXTURE as string, JSON.stringify({
    open: [],
    all: [
      merged(10, 'alpha-loop', sha.X2),
      merged(11, 'gamma-delta', sha.X5),
      merged(12, 'split-local-r1', sha.X8),
      merged(13, 'dirty-proven', sha.D2),
      merged(15, 'dirty-unproven', sha.E2),
      merged(14, 'y-feature', sha.Y2),
      closed(51, 'fix/issue-50', sha.F2, 6 * DAY),
      merged(53, 'fix/issue-52', sha.F2),
      closed(61, 'fix/issue-60', sha.G2, 6 * DAY),
      closed(20, 'closed-at-head', sha.H20, 10 * DAY),
      closed(21, 'closed-recent', sha.H21, 2 * DAY),
      closed(22, 'closed-extra', sha.H22, 10 * DAY),
      closed(30, 'closed-in-other', sha.K1, 2 * DAY),
      merged(31, 'other-31', sha.K2),
      closed(32, 'closed-in-other-extra', sha.K3, 2 * DAY),
    ],
    commitPulls: {
      [sha.K1]: [{ number: 31, state: 'closed', merged_at: at(DAY).toISOString(), base: { ref: 'main' }, head: { sha: sha.K2, ref: 'other-31' } }],
      [sha.Y1]: [{ number: 14, state: 'closed', merged_at: at(DAY).toISOString(), base: { ref: 'main' }, head: { sha: sha.Y2, ref: 'y-feature' } }],
    },
    issues: {
      52: { number: 52, state: 'CLOSED', stateReason: 'COMPLETED', title: 'Conflitto con main dopo LGTM: riapplicare la PR #51 su main' },
      77: { number: 77, state: 'CLOSED', stateReason: 'COMPLETED', title: 'Lavoro 77' },
    },
  }));
  fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
const fx = JSON.parse(fs.readFileSync(process.env.FAKE_GH_FIXTURE, 'utf8'));
const out = (v) => { process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v)); process.exit(0); };
const fail = () => { process.stderr.write('{"message":"Server Error","status":"422"}'); process.exit(1); };
if (a[0] === '--version') out('gh version 0.0.0-fixture\\n');
if (a[0] === 'repo' && a[1] === 'view') out('acme/site\\n');
if (a[0] === 'pr' && a[1] === 'list') {
  const state = a[a.indexOf('--state') + 1];
  if (a.includes('--head')) out(fx.all.filter((p) => p.headRefName === a[a.indexOf('--head') + 1]));
  out(state === 'open' ? fx.open : fx.all);
}
if (a[0] === 'issue' && a[1] === 'list') {
  const q = a[a.indexOf('--search') + 1] || '';
  const phrase = (q.match(/"([^"]+)"/) || [])[1] || '';
  out(Object.values(fx.issues).filter((i) => i.title.includes(phrase + ' ')));
}
if (a[0] === 'api' && a[1] === 'graphql') {
  const q = a.find((x) => x.startsWith('query=')) || '';
  const repository = {};
  for (const m of q.matchAll(/i(\\d+): issueOrPullRequest/g)) {
    const i = fx.issues[m[1]];
    repository['i' + m[1]] = i ? { __typename: 'Issue', state: i.state, stateReason: i.stateReason } : null;
  }
  out({ data: { repository } });
}
if (a[0] === 'api') {
  const target = a.find((x) => x.startsWith('repos/')) || '';
  const c = target.match(/commits\\/([0-9a-f]{40})\\/pulls/);
  if (c) out([fx.commitPulls[c[1]] || []]);
  const p = target.match(/pulls\\/(\\d+)$/);
  if (p) {
    const pr = fx.all.find((x) => x.number === Number(p[1]));
    if (!pr) fail();
    out({ number: pr.number, state: pr.state === 'OPEN' ? 'open' : 'closed', merged_at: pr.state === 'MERGED' ? pr.closedAt : null,
      closed_at: pr.closedAt, base: { ref: pr.baseRefName }, head: { ref: pr.headRefName, sha: pr.headRefOid } });
  }
  fail();
}
process.exit(1);
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'lsof'), `#!/bin/sh
for p in $(printf '%s' "$FAKE_LSOF_CWDS" | tr ':' ' '); do printf 'p1\\nn%s\\n' "$p"; done
exit 0
`, { mode: 0o755 });

  dryRun = runScript([]);
  applyRun = runScript(['--apply']);
}, 180000);

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

const REMOVED: Array<[string, string]> = [
  ['cherry-local', 'cherry-pick in #10, PR trovata dal corpo dello squash'],
  ['split-local', 'commit diviso in due commit di #12, PR trovata per nome'],
  ['dirty-proven', 'sporco identico al blob di #13 più avanti'],
  ['merge-redo', 'merge rifatto, diverso dal gemello solo nel file generato'],
  ['fix-issue-50-local', '#51 CLOSED riapplicata da #53, sporco nella head di #51'],
  ['closed-at-head', '#20 CLOSED da 10 giorni con HEAD identico'],
  ['closed-in-other', 'HEAD antenato della head di #31 MERGED'],
  ['stale-checkout', 'vecchio checkout di main'],
  ['ghost-proven', 'directory orfana con tutti i file in main'],
];

const KEPT: Array<[string, string]> = [
  ['cherry-reverted', 'cherry-pick revertito nella PR'],
  ['cherry-extra', 'un commit senza equivalente'],
  ['dirty-unproven', 'sporco in nessun commit'],
  ['merge-redo-hand', 'risoluzione scritta a mano'],
  ['fix-issue-60-local', 'PR CLOSED senza riapplicazione'],
  ['closed-recent', 'PR CLOSED da 2 giorni'],
  ['closed-extra', 'commit locale oltre la head della PR CLOSED'],
  ['closed-in-other-extra', 'commit oltre la head di #31'],
  ['idle-main-body', 'body di una PR non ancora aperta'],
  ['stale-partial', 'un file diverso dal commit di main'],
  ['stale-recent', 'attivo da meno di 7 giorni'],
  ['ghost-unreachable', 'file solo in un commit irraggiungibile'],
  ['ghost-foreign', 'file mai stato in git'],
  ['worker-site-77-20260920', 'issue nel nome chiusa: non è una prova'],
];

describe('prove di contenuto su un clone di prova', () => {
  it('il dry-run pianifica senza toccare niente', () => {
    expect(dryRun).toContain('dry-run: niente rimosso');
    for (const [name] of REMOVED) expect(dryRun).toContain(wt(name));
    expect(dryRun).toMatch(/costo: [\d.]+ s, di cui prove [\d.]+ s; \d+ chiamate gh\./);
  });

  it.each(REMOVED)('rimuove %s (%s)', (name) => {
    expect(fs.existsSync(wt(name)), applyRun).toBe(false);
  });

  it.each(KEPT)('tiene %s (%s)', (name) => {
    expect(fs.existsSync(wt(name)), applyRun).toBe(true);
  });

  it('lascia un tag su ogni commit rimosso che non era su main', () => {
    const tags = git(clone, ['tag', '--list', 'snapshot/*', '--format=%(refname:short) %(objectname)']).split('\n');
    const tagged = (prefix: string, target: string) => tags.some((t) => t.startsWith(prefix) && t.endsWith(target));
    expect(tagged('snapshot/purge/cherry-local-', sha.C1)).toBe(true);
    expect(tagged('snapshot/purge/split-local-', sha.C4)).toBe(true);
    expect(tagged('snapshot/purge/dirty-proven-', sha.D1)).toBe(true);
    expect(tagged(`snapshot/purge/detached-${sha.Mloc.slice(0, 12)}-`, sha.Mloc)).toBe(true);
    expect(tagged('snapshot/purge/fix-issue-50-local-', sha.F1)).toBe(true);
    expect(tagged('snapshot/purge/closed-at-head-', sha.H20)).toBe(true);
    expect(tagged('snapshot/purge/stale-checkout-', sha.M1)).toBe(true);
    expect(tagged('snapshot/purge/cherry-branch-only-', sha.C1b)).toBe(true);
  });

  it('cancella il branch senza worktree equivalente per patch-id', () => {
    const branches = git(clone, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).split('\n');
    expect(branches).not.toContain('cherry-branch-only');
    expect(branches).not.toContain('cherry-local');
    expect(branches).toContain('cherry-reverted');
  });

  it('annota i casi probabili senza rimuoverli', () => {
    expect(dryRun).toMatch(/closed-in-other-extra\] → .*probabile superato da #31/);
    expect(dryRun).toMatch(/worker-site-77-20260920\] → .*issue #77 chiusa \(COMPLETED\): non prova che il contenuto sia su main/);
    expect(dryRun).toMatch(/ghost-unreachable → .*u\.txt, diverso da main/);
  });

  it('ricorda solo gli esiti negativi, per branch e tip', () => {
    const cache = JSON.parse(fs.readFileSync(path.join(clone, '.git', 'frontaliere-prune-proofs.json'), 'utf8'));
    expect(Object.keys(cache)).toContain(`cherry-reverted@${sha.C2}`);
    expect(Object.keys(cache).some((k) => k.startsWith('cherry-local@'))).toBe(false);
    expect(Object.keys(cache).some((k) => k.startsWith('dirty-unproven@'))).toBe(false); // sporco: mai in cache
  });

  it('applica senza errori', () => {
    expect(applyRun).toMatch(/applicate \d+ rimozioni\./);
    expect(applyRun).not.toContain('FALLIT');
    expect(applyRun).not.toContain('SALTATA');
  });
});
