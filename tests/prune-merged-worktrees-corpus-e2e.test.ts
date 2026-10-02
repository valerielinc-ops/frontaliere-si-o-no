import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Lo sweep lanciato nel CORPUS (stesso script del sito, cwd nel checkout del
// corpus) su un workspace di prova con due repo e le cartelle `.wt/` della
// root. Ogni caso viene dallo smaltimento manuale del 2026-10-02 (45 worktree,
// 12 directory orfane, tutti già consegnati), o è il suo controcaso:
//   • HEAD della PR MERGED solo in refs/pull/N/head (branch remoto cancellato) → via
//     - PR MERGED la cui head non esiste da nessuna parte                     → resta
//   • symlink node_modules non tracciato (relativo e assoluto)                 → via, il target resta intatto
//     - symlink non tracciato con un altro nome                               → resta
//   • PR di trasporto rifatta sopra main, file identici a un commit della PR   → via
//     - file diverso da tutti i commit della PR                              → resta
//   • PR CLOSED ma commit e sporco identici a origin/main                     → via
//     - uno sporco diverso                                                    → resta
//   • HEAD == headRefOid di una PR MERGED con un altro nome / detached        → via
//   • PR trovata dallo SHA: il body non tracciato è rumore                     → via
//   • detached sulla head di una PR CLOSED da 10 giorni (refs/pull/N/head)     → via
//   • commit superato dallo sporco = main, commit = head di una PR CLOSED     → via
//     - stessa forma senza nessuna PR con quella head                         → resta
//   • root `.wt/`: worktree registrato nell'altro repo                         → resta
//     - residuo dell'altro repo con i file identici al suo main               → via
//     - residuo con un file mai stato in git                                  → resta

const SCRIPT = path.join(process.cwd(), 'scripts', 'prune-merged-worktrees.mjs');
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const at = (msAgo: number) => new Date(NOW - msAgo);

let ws = '';
let corpus = '';
let site = '';
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

function commit(cwd: string, msg: string, msAgo: number, files: Record<string, string> = {}): string {
  for (const [file, content] of Object.entries(files)) { write(cwd, file, content); git(cwd, ['add', file]); }
  const date = `@${Math.floor((NOW - msAgo) / 1000)} +0000`;
  git(cwd, ['commit', '-q', '--allow-empty', '-m', msg], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  return git(cwd, ['rev-parse', 'HEAD']);
}

const cwt = (name: string) => path.join(corpus, '.claude', 'worktrees', name);
const rootWt = (name: string) => path.join(ws, '.wt', name);

function age(worktreePath: string, when: Date = at(5 * DAY)): void {
  const admin = git(worktreePath, ['rev-parse', '--absolute-git-dir']);
  for (const p of [path.join(admin, 'HEAD'), path.join(admin, 'index'), path.join(admin, 'logs', 'HEAD'), worktreePath]) {
    if (fs.existsSync(p)) fs.utimesSync(p, when, when);
  }
}

function ageTree(dir: string, when: Date): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) ageTree(full, when);
    fs.lutimesSync(full, when, when);
  }
  fs.utimesSync(dir, when, when);
}

function runScript(args: string[]): string {
  return execFileSync('node', [SCRIPT, ...args], { cwd: corpus, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function cloneOf(name: string): { origin: string; dir: string } {
  const origin = path.join(ws, `${name}-origin.git`);
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch', 'main', origin], { env });
  const dir = path.join(ws, name);
  execFileSync('git', ['clone', '-q', origin, dir], { env, stdio: 'ignore' });
  git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  return { origin, dir };
}

const merged = (number: number, headRefName: string, headRefOid: string) => ({
  number, state: 'MERGED', baseRefName: 'main', headRefName, headRefOid, closedAt: at(DAY).toISOString(),
});

beforeAll(() => {
  ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prune-corpus-e2e-')));
  const bin = path.join(ws, 'bin');
  fs.mkdirSync(bin);
  // Il marcatore del workspace: lo sweep riconosce la root dalla presenza di bin/site-hook.
  fs.writeFileSync(path.join(bin, 'site-hook'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const gitconfig = path.join(ws, 'gitconfig');
  fs.writeFileSync(gitconfig, '');
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ['FRONTALIERE_SITE_HOOKS_DIR', 'FRONTALIERE_WORKSPACE', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete base[k];
  env = {
    ...base,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    FAKE_GH_FIXTURE: path.join(ws, 'gh-fixture.json'),
    FAKE_LSOF_CWDS: '',
  };

  // --- il SITO: un secondo repo del workspace ----------------------------------
  const s = cloneOf('frontaliere-si-o-no');
  site = s.dir;
  commit(site, 'site base', 20 * DAY, { 'site.txt': 'sito\n', 'lib/a.mjs': 'export const a = 1;\n' });
  git(site, ['push', '-q', '-u', 'origin', 'main']);
  git(site, ['remote', 'set-head', 'origin', 'main']);

  // --- il CORPUS: qui gira lo sweep ------------------------------------------
  const c = cloneOf('frontaliere-articles');
  corpus = c.dir;
  sha.A = commit(corpus, 'base', 30 * DAY, { 'a.txt': 'base\n', 'twin.txt': 'v0\n', 'c.txt': 'c0\n', 'd.txt': 'd0\n' });
  // Come nel corpus vero: node_modules NON è in .gitignore, e il symlink nei
  // worktree compare come `?? node_modules`.
  fs.mkdirSync(path.join(corpus, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(corpus, 'node_modules', 'pkg', 'index.js'), 'resta\n');
  git(corpus, ['push', '-q', '-u', 'origin', 'main']);
  git(corpus, ['remote', 'set-head', 'origin', 'main']);

  // #70: la head esiste solo in refs/pull/70/head sull'origin (branch remoto
  // cancellato al merge). Si costruisce in un altro clone: nel corpus arriva
  // solo F1, mai F2.
  const pusher = path.join(ws, 'pusher');
  execFileSync('git', ['clone', '-q', c.origin, pusher], { env, stdio: 'ignore' });
  sha.F1 = commit(pusher, 'fix: parte 1', 6 * DAY, { 'f.txt': 'f1\n' });
  git(pusher, ['push', '-q', 'origin', 'HEAD:refs/heads/tmp-f1']);
  sha.F2 = commit(pusher, 'fix: parte 2', 6 * DAY - 60000, { 'f.txt': 'f2\n' });
  git(pusher, ['push', '-q', 'origin', `${sha.F2}:refs/pull/70/head`]);
  git(corpus, ['fetch', '-q', 'origin', 'tmp-f1']);
  git(corpus, ['branch', '-q', 'repair-pr-70', sha.F1]);
  git(pusher, ['push', '-q', 'origin', '--delete', 'tmp-f1']);
  // #71: head mai pubblicata da nessuna parte.
  sha.G1 = commit(pusher, 'fix: g', 6 * DAY, { 'g.txt': 'g1\n' });
  git(pusher, ['push', '-q', 'origin', 'HEAD:refs/heads/tmp-g1']);
  sha.G2 = commit(pusher, 'fix: g2', 6 * DAY - 60000, { 'g.txt': 'g2\n' });
  git(corpus, ['fetch', '-q', 'origin', 'tmp-g1']);
  git(corpus, ['branch', '-q', 'repair-pr-71', sha.G1]);
  git(pusher, ['push', '-q', 'origin', '--delete', 'tmp-g1']);
  fs.rmSync(pusher, { recursive: true, force: true });

  // main avanza: twin.txt v1 (la PR di trasporto partirà da qui), c.txt e d.txt
  // con il contenuto che la PR CLOSED aveva già.
  git(corpus, ['checkout', '-q', 'main']);
  sha.Mt = commit(corpus, 'main: twin v1, c e d', 4 * DAY, { 'twin.txt': 'v1\n', 'c.txt': 'c-main\n', 'd.txt': 'd-main\n' });
  // #72: PR di trasporto rifatta sopra main.
  git(corpus, ['checkout', '-q', '-b', 'tmp-pr-72', sha.Mt]);
  commit(corpus, 'chore: porta il gemello', 3 * DAY, { 'twin.txt': 'v2\n' });
  sha.X72 = commit(corpus, 'chore: gemello aggiornato', 3 * DAY - 60000, { 'twin.txt': 'v2b\n' });
  git(corpus, ['update-ref', 'refs/pull-heads/72', sha.X72]);
  // #74 / #75: PR MERGED riconosciute dallo SHA, non dal nome.
  git(corpus, ['checkout', '-q', '-b', 'tmp-pr-74', sha.Mt]);
  sha.X74 = commit(corpus, 'feat: 74', 3 * DAY, { 'p74.txt': '74\n' });
  git(corpus, ['checkout', '-q', '-b', 'tmp-pr-75', sha.Mt]);
  sha.X75 = commit(corpus, 'deps: aggiorna', 3 * DAY, { 'p75.txt': '75\n' });
  git(corpus, ['update-ref', 'refs/pull-heads/74', sha.X74]);
  git(corpus, ['update-ref', 'refs/pull-heads/75', sha.X75]);
  git(corpus, ['checkout', '-q', 'main']);
  for (const b of ['tmp-pr-72', 'tmp-pr-74', 'tmp-pr-75']) git(corpus, ['branch', '-q', '-D', b]);
  // Squash di #72, #74, #75 su main (dopo Mt): poi main cambia ancora twin.txt.
  write(corpus, 'twin.txt', 'v2b\n');
  git(corpus, ['add', 'twin.txt']);
  fs.writeFileSync(path.join(ws, 'msg'), 'chore: trasporto gemelli (#72)\n\n* chore: porta il gemello\n\n* chore: gemello aggiornato\n');
  git(corpus, ['commit', '-q', '-F', path.join(ws, 'msg')], { GIT_COMMITTER_DATE: `@${Math.floor((NOW - 2 * DAY - 60000) / 1000)} +0000` });
  // Titoli degli squash diversi dai soggetti dei commit: #74 e #75 si
  // riconoscono solo dallo SHA della head.
  commit(corpus, 'feat: lotto 74 (#74)', 2 * DAY - 60000, { 'p74.txt': '74\n' });
  commit(corpus, 'chore: lotto dipendenze (#75)', 2 * DAY - 120000, { 'p75.txt': '75\n' });
  git(corpus, ['push', '-q', 'origin', 'main']);

  // Branch locali dal main VECCHIO (prima di Mt).
  const localFrom = (name: string, from: string, files: Record<string, string>, msg: string) => {
    git(corpus, ['checkout', '-q', '-b', name, from]);
    const head = commit(corpus, msg, 3 * DAY - 180000, files);
    git(corpus, ['checkout', '-q', 'main']);
    return head;
  };
  // Stesso soggetto del commit della PR: la candidata si trova nel corpo dello squash.
  sha.T1 = localFrom('transport-local', sha.A, { 'twin.txt': 'v2\n' }, 'chore: porta il gemello');
  sha.T2 = localFrom('transport-off', sha.A, { 'twin.txt': 'v3\n' }, 'chore: porta il gemello');
  sha.K1 = localFrom('closed-same', sha.A, { 'c.txt': 'c-main\n' }, 'fix: c come poi su main');
  sha.K2 = localFrom('closed-diff', sha.A, { 'c.txt': 'c-main\n' }, 'fix: c come poi su main (bis)');
  git(corpus, ['branch', '-q', 'merge-deps-local', sha.X75]);
  // #77 MERGED: worktree con un nome diverso e il body della PR non tracciato.
  git(corpus, ['checkout', '-q', '-b', 'tmp-pr-77', sha.Mt]);
  sha.X77 = commit(corpus, 'feat: 77', 3 * DAY, { 'p77.txt': '77\n' });
  git(corpus, ['checkout', '-q', 'main']);
  git(corpus, ['branch', '-q', '-D', 'tmp-pr-77']);
  git(corpus, ['update-ref', 'refs/pull-heads/77', sha.X77]);
  git(corpus, ['branch', '-q', 'local-77-body', sha.X77]);
  // #78 CLOSED da 10 giorni, detached sulla sua head: resta in refs/pull/78/head.
  sha.K78 = localFrom('tmp-78', sha.A, { 'k78.txt': '78\n' }, 'feat: 78 chiusa');
  git(corpus, ['branch', '-q', '-D', 'tmp-78']);
  // #79 CLOSED: il commit porta c.txt vecchio, lo sporco lo riporta a main.
  sha.K79 = localFrom('closed-override', sha.A, { 'c.txt': 'c-vecchio\n' }, 'fix: c vecchio');
  sha.K80 = localFrom('override-no-pr', sha.A, { 'c.txt': 'c-vecchio-bis\n' }, 'fix: c vecchio bis');

  // --- worktree del corpus ------------------------------------------------------
  fs.mkdirSync(path.join(corpus, '.claude', 'worktrees'), { recursive: true });
  const add = (...args: string[]) => git(corpus, ['worktree', 'add', '-q', ...args]);
  for (const name of ['repair-pr-70', 'repair-pr-71', 'transport-local', 'transport-off', 'closed-same', 'closed-diff', 'merge-deps-local',
    'local-77-body', 'closed-override', 'override-no-pr']) {
    add(cwt(name), name);
  }
  add('--detach', cwt('detached-74'), sha.X74);
  add('--detach', cwt('closed-78'), sha.K78);
  write(cwt('local-77-body'), 'PR_BODY.md', '## Implementato\n'); // PR trovata dallo SHA: body = rumore
  write(cwt('closed-override'), 'c.txt', 'c-main\n');
  write(cwt('override-no-pr'), 'c.txt', 'c-main\n');
  for (const name of ['nm-link', 'nm-link-abs', 'link-other']) add('-b', name, cwt(name), 'origin/main');
  fs.symlinkSync('../../../node_modules', path.join(cwt('nm-link'), 'node_modules'));
  fs.symlinkSync(path.join(corpus, 'node_modules'), path.join(cwt('nm-link-abs'), 'node_modules'));
  fs.symlinkSync(path.join(corpus, 'node_modules'), path.join(cwt('link-other'), 'tooling')); // non è node_modules
  write(cwt('closed-same'), 'd.txt', 'd-main\n'); // sporco = origin/main
  write(cwt('closed-diff'), 'd.txt', 'd-altro\n'); // sporco diverso da main
  for (const name of ['repair-pr-70', 'repair-pr-71', 'transport-local', 'transport-off', 'closed-same', 'closed-diff',
    'merge-deps-local', 'detached-74', 'nm-link', 'nm-link-abs', 'link-other', 'local-77-body', 'closed-78', 'closed-override',
    'override-no-pr']) {
    age(cwt(name));
  }

  // --- la `.wt/` della root ---------------------------------------------------------
  fs.mkdirSync(path.join(ws, '.wt'), { recursive: true });
  git(site, ['worktree', 'add', '-q', '-b', 'site-live', rootWt('site-live'), 'origin/main']);
  age(rootWt('site-live'));
  const orphan = (name: string, files: Record<string, string>) => {
    for (const [file, content] of Object.entries(files)) write(rootWt(name), file, content);
    ageTree(rootWt(name), at(5 * DAY));
  };
  orphan('site-residue', { 'site.txt': 'sito\n', 'lib/a.mjs': 'export const a = 1;\n', '.DS_Store': 'x' });
  orphan('foreign', { 'site.txt': 'sito\n', 'nuovo.mjs': 'mai in git\n' });
  fs.symlinkSync(path.join(corpus, 'node_modules'), path.join(rootWt('site-residue'), 'node_modules'));
  fs.lutimesSync(path.join(rootWt('site-residue'), 'node_modules'), at(5 * DAY), at(5 * DAY));
  fs.utimesSync(rootWt('site-residue'), at(5 * DAY), at(5 * DAY));

  // --- GitHub finto ----------------------------------------------------------------
  fs.writeFileSync(env.FAKE_GH_FIXTURE as string, JSON.stringify({
    open: [],
    all: [
      merged(70, 'fix/issue-70', sha.F2),
      merged(71, 'fix/issue-71', sha.G2),
      merged(72, 'transport/identical-twins-1', sha.X72),
      { number: 73, state: 'CLOSED', baseRefName: 'main', headRefName: 'closed-same', headRefOid: sha.K1, closedAt: at(2 * DAY).toISOString() },
      { number: 76, state: 'CLOSED', baseRefName: 'main', headRefName: 'closed-diff', headRefOid: sha.K2, closedAt: at(2 * DAY).toISOString() },
      merged(74, 'feat-74', sha.X74),
      merged(77, 'feat-77', sha.X77),
      { number: 78, state: 'CLOSED', baseRefName: 'main', headRefName: 'feat-78', headRefOid: sha.K78, closedAt: at(10 * DAY).toISOString() },
      { number: 79, state: 'CLOSED', baseRefName: 'main', headRefName: 'fix-c', headRefOid: sha.K79, closedAt: at(2 * DAY).toISOString() },
      merged(75, 'update-all-dependencies', sha.X75),
    ],
  }));
  fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
const fx = JSON.parse(fs.readFileSync(process.env.FAKE_GH_FIXTURE, 'utf8'));
const out = (v) => { process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v)); process.exit(0); };
if (a[0] === '--version') out('gh version 0.0.0-fixture\\n');
if (a[0] === 'repo' && a[1] === 'view') out('acme/corpus\\n');
if (a[0] === 'pr' && a[1] === 'list') {
  const state = a[a.indexOf('--state') + 1];
  if (a.includes('--head')) out(fx.all.filter((p) => p.headRefName === a[a.indexOf('--head') + 1]));
  out(state === 'open' ? fx.open : fx.all);
}
if (a[0] === 'issue' && a[1] === 'list') out([]);
if (a[0] === 'api' && a[1] === 'graphql') out({ data: { repository: {} } });
if (a[0] === 'api') {
  const target = a.find((x) => x.startsWith('repos/')) || '';
  if (/commits\\/[0-9a-f]{40}\\/pulls/.test(target)) out([[]]);
  process.stderr.write('{"message":"Server Error","status":"422"}');
  process.exit(1);
}
process.exit(1);
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'lsof'), `#!/bin/sh
exit 0
`, { mode: 0o755 });

  dryRun = runScript([]);
  applyRun = runScript(['--apply']);
}, 180000);

afterAll(() => {
  if (ws) fs.rmSync(ws, { recursive: true, force: true });
});

describe('sweep nel corpus, su un workspace con due repo', () => {
  it('il dry-run pianifica senza toccare niente', () => {
    expect(dryRun).toContain('dry-run: niente rimosso');
    for (const name of ['repair-pr-70', 'nm-link', 'transport-local', 'closed-same', 'merge-deps-local']) expect(dryRun).toContain(cwt(name));
  });

  it.each([
    ['repair-pr-70', 'HEAD della PR scaricata da refs/pull/70/head'],
    ['nm-link', 'symlink node_modules relativo'],
    ['nm-link-abs', 'symlink node_modules assoluto'],
    ['transport-local', 'file identici a un commit della PR di trasporto'],
    ['closed-same', 'PR CLOSED ma commit e sporco identici a origin/main'],
    ['merge-deps-local', 'HEAD == head di #75 con un altro nome'],
    ['detached-74', 'detached sulla head di #74'],
    ['local-77-body', 'PR #77 trovata dallo SHA: il body non tracciato è rumore'],
    ['closed-78', 'detached sulla head di #78 CLOSED da 10 giorni'],
    ['closed-override', 'commit superato dallo sporco = main, versione committata in refs/pull/79/head'],
  ])('rimuove %s (%s)', (name) => {
    expect(fs.existsSync(cwt(name)), applyRun).toBe(false);
  });

  it.each([
    ['repair-pr-71', 'head della PR mai pubblicata'],
    ['transport-off', 'file diverso da tutti i commit della PR'],
    ['closed-diff', 'sporco diverso da main'],
    ['link-other', 'symlink non tracciato con un altro nome'],
    ['override-no-pr', 'la versione committata non vive in nessuna head di PR'],
  ])('tiene %s (%s)', (name) => {
    expect(fs.existsSync(cwt(name)), applyRun).toBe(true);
  });

  it('il symlink si toglie senza seguirlo: il node_modules del checkout principale resta', () => {
    expect(fs.readFileSync(path.join(corpus, 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe('resta\n');
  });

  it('la head di #70 è arrivata con il fetch di refs/pull/70/head', () => {
    expect(git(corpus, ['cat-file', '-t', sha.F2])).toBe('commit');
    expect(applyRun).toMatch(/repair-pr-70\] — contenuto nella PR #70 MERGED/);
  });

  it('root .wt/: tocca solo ciò che nessun repo registra, e prova con i ref del repo giusto', () => {
    expect(fs.existsSync(rootWt('site-live'))).toBe(true); // registrato nel sito
    expect(fs.existsSync(rootWt('site-residue'))).toBe(false); // file = main del sito
    expect(fs.existsSync(rootWt('foreign'))).toBe(true);
    expect(dryRun).toMatch(/site-residue — nessun worktree registrato in nessun repo, 2 file identici a main di frontaliere-si-o-no/);
    expect(fs.readFileSync(path.join(corpus, 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe('resta\n');
  });

  it('lascia un tag sui commit rimossi e applica senza errori', () => {
    const tags = git(corpus, ['tag', '--list', 'snapshot/*', '--format=%(refname:short) %(objectname)']).split('\n');
    expect(tags.some((t) => t.startsWith('snapshot/purge/repair-pr-70-') && t.endsWith(sha.F1))).toBe(true);
    expect(tags.some((t) => t.startsWith('snapshot/purge/transport-local-') && t.endsWith(sha.T1))).toBe(true);
    expect(tags.some((t) => t.startsWith('snapshot/purge/closed-same-') && t.endsWith(sha.K1))).toBe(true);
    expect(applyRun).toMatch(/applicate \d+ rimozioni\./);
    expect(applyRun).not.toContain('FALLIT');
  });
});
