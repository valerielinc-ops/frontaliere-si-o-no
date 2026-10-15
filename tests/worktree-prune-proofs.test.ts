import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  canRemoveClosedAtHead,
  canRemoveWithProof,
  CLOSED_AT_HEAD_MIN_AGE_MS,
  DELETED,
  GENERATED_PATHS,
  isCommitContained,
  isDirtyContained,
  isMergeContained,
  isOrphanSkippablePath,
  isProvenOrphan,
  isReappliedClosedPr,
  issueNumbersInBranch,
  namePrefixCandidates,
  needsProofSnapshot,
  orphanWindow,
  reportAnnotation,
  squashPrNumber,
  squashSubjects,
} from '../scripts/lib/branch-purge-policy.mjs';
import {
  gitBlobId,
  isDanglingGitPointer,
  makeContentProver,
  makeGitRunner,
  nodeModulesLinks,
  removeTreeNoFollow,
  splitFileChunks,
} from '../scripts/lib/merged-content-proof.mjs';
import { classifyDirtyEntries, isNodeModulesLinkEntry } from '../scripts/lib/worktree-dirty.mjs';

// Le prove nate dallo smaltimento manuale del 2026-10-02: per ognuna il caso
// che lo sweep deve rimuovere e il controcaso che deve restare.

const DAY = 24 * 60 * 60 * 1000;

describe('commit contenuto in una PR MERGED', () => {
  const file = { path: 'a.ts', binary: false, matched: true, inverseMatched: false, inSquash: true };

  it('antenato, vuoto o assorbito dall\'albero della PR', () => {
    expect(isCommitContained({ ancestor: true })).toBe(true);
    expect(isCommitContained({ empty: true })).toBe(true);
    expect(isCommitContained({ absorbed: true })).toBe(true);
  });

  it('ogni file con il patch-id di un file della PR (cherry-pick, split o squash diversi)', () => {
    expect(isCommitContained({ files: [file, { ...file, path: 'b.ts' }] })).toBe(true);
  });

  it.each([
    ['un file senza corrispondenza', { matched: false }],
    ['revertito nella PR (l\'inverso è un commit della PR)', { inverseMatched: true }],
    ['file che lo squash non tocca più', { inSquash: false }],
    ['file binario', { binary: true }],
  ])('resta con %s', (_label, override) => {
    expect(isCommitContained({ files: [file, { ...file, path: 'b.ts', ...override }] })).toBe(false);
  });

  it('niente fatti, niente prova', () => {
    expect(isCommitContained(null)).toBe(false);
    expect(isCommitContained({ files: [] })).toBe(false);
  });
});

describe('merge rifatto (stessi genitori di un merge della PR)', () => {
  it('si rimuove se differisce dal gemello solo in file generati', () => {
    expect(isMergeContained({ twinDiff: [] })).toBe(true);
    expect(isMergeContained({ twinDiff: ['.github/corpus-workflows/contract.json'] })).toBe(true);
  });

  it('resta con una risoluzione diversa scritta a mano o senza gemello', () => {
    expect(isMergeContained({ twinDiff: ['.github/corpus-workflows/contract.json', 'package.json'] })).toBe(false);
    expect(isMergeContained({ twinDiff: ['package-lock.json'] })).toBe(false);
    expect(isMergeContained({ twinDiff: null })).toBe(false);
  });

  it('la lista dei generati è esplicita e stretta', () => {
    expect(GENERATED_PATHS).toEqual(['.github/corpus-workflows/contract.json']);
  });
});

describe('sporco già committato altrove', () => {
  const allowed = new Set(['b1', 'b2', DELETED]);

  it('ogni versione locale è un blob ammesso per quel path', () => {
    expect(isDirtyContained([
      { status: ' M', path: 'a.ts', versions: ['b2', 'b1'], allowed },
      { status: ' D', path: 'c.ts', versions: [DELETED, 'b1'], allowed },
    ])).toBe(true);
  });

  it.each([
    ['contenuto diverso', { status: ' M', versions: ['b9', 'b1'] }],
    ['index diverso dal working tree e da tutto', { status: 'MM', versions: ['b2', 'b8'] }],
    ['rename', { status: 'R ', versions: ['b2', 'b2'] }],
    ['file non tracciato', { status: '??', versions: ['b2', DELETED] }],
  ])('resta con %s', (_label, entry) => {
    expect(isDirtyContained([{ path: 'a.ts', allowed, ...entry }])).toBe(false);
  });

  it('i non tracciati valgono solo se il chiamante li ammette (vecchio checkout di main)', () => {
    const entry = { status: '??', path: 'new.ts', versions: ['b2', DELETED], allowed };
    expect(isDirtyContained([entry], { allowUntracked: true })).toBe(true);
    expect(isDirtyContained([{ ...entry, versions: ['b7', DELETED] }], { allowUntracked: true })).toBe(false);
  });

  it('nessuna voce non è una prova', () => {
    expect(isDirtyContained([])).toBe(false);
  });
});

describe('guardie delle prove', () => {
  const ok = { proven: true, idle: true, busy: false, busyKnown: true, ghOk: true };

  it('rimuove solo con prova e tutte le guardie', () => {
    expect(canRemoveWithProof(ok)).toBe(true);
  });

  it.each([
    ['senza prova', { proven: false }],
    ['attivo di recente', { idle: false }],
    ['in uso', { busy: true }],
    ['lsof illeggibile', { busyKnown: false }],
    ['gh indisponibile', { ghOk: false }],
  ])('resta %s', (_label, override) => {
    expect(canRemoveWithProof({ ...ok, ...override })).toBe(false);
  });

  it('lascia sempre un tag, salvo uno snapshot già presente', () => {
    expect(needsProofSnapshot({ hasSnapshot: false })).toBe(true);
    expect(needsProofSnapshot({ hasSnapshot: true })).toBe(false);
  });
});

describe('PR CLOSED con HEAD identico alla sua head', () => {
  const now = Date.UTC(2026, 9, 2);
  const pr = { number: 9590, state: 'CLOSED', headRefOid: 'a'.repeat(40), closedAt: new Date(now - 9 * DAY).toISOString() };

  it('si rimuove: il commit resta in refs/pull/N/head', () => {
    expect(canRemoveClosedAtHead({ pr, head: 'a'.repeat(40), dirty: false, now })).toBe(true);
  });

  it.each([
    ['chiusa da meno di 7 giorni', { pr: { ...pr, closedAt: new Date(now - 2 * DAY).toISOString() } }],
    ['commit locali in più', { head: 'b'.repeat(40) }],
    ['sporco significativo', { dirty: true }],
    ['data di chiusura assente', { pr: { ...pr, closedAt: null } }],
    ['PR MERGED (non è questa regola)', { pr: { ...pr, state: 'MERGED' } }],
  ])('resta se %s', (_label, override) => {
    expect(canRemoveClosedAtHead({ pr, head: 'a'.repeat(40), dirty: false, now, ...override })).toBe(false);
  });

  it('la soglia è una settimana', () => {
    expect(CLOSED_AT_HEAD_MIN_AGE_MS).toBe(7 * DAY);
  });
});

describe('PR CLOSED riapplicata dal flusso automatico', () => {
  const closedPr = { number: 9939, state: 'CLOSED' };
  const issue = {
    number: 9980, state: 'CLOSED', stateReason: 'COMPLETED',
    title: 'Conflitto con main dopo LGTM: riapplicare la PR #9939 su main',
  };
  const reapplyPr = { number: 9986, state: 'MERGED', baseRefName: 'main', headRefName: 'fix/issue-9980' };

  it('si rimuove con la catena completa', () => {
    expect(isReappliedClosedPr({ closedPr, issue, reapplyPr, baseBranch: 'main' })).toBe(true);
    expect(isReappliedClosedPr({
      closedPr, issue: { ...issue, title: 'Conflitto con main: riapplicare la PR #9939 su main' }, reapplyPr, baseBranch: 'main',
    })).toBe(true);
  });

  it.each([
    ['l\'issue nomina un\'altra PR', { issue: { ...issue, title: 'Conflitto con main dopo LGTM: riapplicare la PR #99390 su main' } }],
    ['l\'issue è NOT_PLANNED', { issue: { ...issue, stateReason: 'NOT_PLANNED' } }],
    ['l\'issue è aperta', { issue: { ...issue, state: 'OPEN' } }],
    ['la riapplicazione non è mergiata', { reapplyPr: { ...reapplyPr, state: 'CLOSED' } }],
    ['la riapplicazione è di un\'altra issue', { reapplyPr: { ...reapplyPr, headRefName: 'fix/issue-9981' } }],
    ['la riapplicazione punta a un altro base', { reapplyPr: { ...reapplyPr, baseRefName: 'staging' } }],
    ['la PR non è chiusa ma mergiata', { closedPr: { ...closedPr, state: 'MERGED' } }],
  ])('resta se %s', (_label, override) => {
    expect(isReappliedClosedPr({ closedPr, issue, reapplyPr, baseBranch: 'main', ...override })).toBe(false);
  });
});

describe('directory orfane provate', () => {
  it('salta solo rumore e cache', () => {
    for (const rel of ['.DS_Store', 'x/.DS_Store', 'node_modules/a.js', 'a/.cache/b', 'tsconfig.tsbuildinfo']) {
      expect(isOrphanSkippablePath(rel), rel).toBe(true);
    }
    for (const rel of ['src/a.ts', '.env', 'tmp/report.md', 'data/x.json']) {
      expect(isOrphanSkippablePath(rel), rel).toBe(false);
    }
  });

  it('si rimuove solo se ogni file è rumore, ignorato o in main', () => {
    const files = [{ skippable: true }, { ignored: true }, { matched: true }];
    expect(isProvenOrphan({ files, idle: true })).toBe(true);
    expect(isProvenOrphan({ files: [...files, { matched: false }], idle: true })).toBe(false);
    expect(isProvenOrphan({ files, idle: false })).toBe(false);
  });

  it('la finestra va da due giorni prima a un giorno dopo l\'ultima scrittura', () => {
    expect(orphanWindow(10 * DAY)).toEqual({ sinceMs: 8 * DAY, untilMs: 11 * DAY });
    expect(orphanWindow(0)).toBeNull();
  });
});

describe('PR candidate e annotazioni', () => {
  it('numeri nel nome del branch, date escluse', () => {
    expect(issueNumbersInBranch('fix-issue-9920-fingerprint-20260926')).toEqual([9920]);
    expect(issueNumbersInBranch('worker-site-9336-20260920')).toEqual([9336]);
    expect(issueNumbersInBranch('fix/issue-9920')).toEqual([9920]);
    expect(issueNumbersInBranch('top50-e2e-final-20261001')).toEqual([]);
    // Date con i separatori e numeri con lo zero davanti: non sono issue.
    expect(issueNumbersInBranch('fix-cache-2026-09-20')).toEqual([]);
    expect(issueNumbersInBranch('worker-site-9336-2026-09-20')).toEqual([9336]);
    expect(issueNumbersInBranch('release-v2-07')).toEqual([]);
  });

  it('candidate per nome: la head stessa o una sua variante', () => {
    const prs = [
      { headRefName: 'automerge-pr-surface-v2-20260916-r1' },
      { headRefName: 'automerge-pr-surface-v2-20260916' },
      { headRefName: 'automerge-pr-surface-v2-2026091' },
      { headRefName: 'other' },
    ];
    expect(namePrefixCandidates('automerge-pr-surface-v2-20260916', prs).map((p) => p.headRefName))
      .toEqual(['automerge-pr-surface-v2-20260916-r1', 'automerge-pr-surface-v2-20260916']);
  });

  it('soggetti dello squash: titolo e righe `* soggetto`', () => {
    expect(squashPrNumber('feat: moltiplicare il loop della ricerca lavoro (#9105)')).toBe(9105);
    expect(squashPrNumber('chore: senza numero')).toBeNull();
    expect(squashSubjects('feat: loop (#9105)', '* fix(job-board): preserve visits\n\n*  fix(seo):  gate rails \nCo-authored-by: x'))
      .toEqual(['feat: loop', 'fix(job-board): preserve visits', 'fix(seo): gate rails']);
  });

  it('le annotazioni dicono dove guardare senza autorizzare niente', () => {
    expect(reportAnnotation({ partialPr: { number: 9959, unproven: 2, example: 'abcdef1234567890' } }))
      .toBe('probabile superato da #9959: 2 commit non provati dentro la PR (es. abcdef123456) — verifica');
    expect(reportAnnotation({ closedIssue: { number: 9336, stateReason: 'COMPLETED' } }))
      .toContain('issue #9336 chiusa (COMPLETED): non prova che il contenuto sia su main');
    expect(reportAnnotation({ tmpOnly: { number: 10753, count: 3 } })).toContain('solo file non tracciati sotto tmp/');
    expect(reportAnnotation({ staleDirty: { days: 9, what: 'PR #1 mergiata' } })).toContain('probabile superato');
    expect(reportAnnotation({})).toBe('');
  });
});

describe('symlink node_modules (worktree del corpus)', () => {
  it('un node_modules non tracciato che è un symlink è rumore; una cartella vera no', () => {
    const link = (p: string) => p === 'node_modules';
    expect(isNodeModulesLinkEntry({ status: '??', path: 'node_modules' }, link)).toBe(true);
    expect(isNodeModulesLinkEntry({ status: '??', path: 'node_modules' }, () => false)).toBe(false);
    expect(isNodeModulesLinkEntry({ status: ' M', path: 'node_modules' }, link)).toBe(false);
    expect(isNodeModulesLinkEntry({ status: '??', path: 'node_modules' }, undefined)).toBe(false);
    const { significant, ignored } = classifyDirtyEntries([
      { status: '??', path: 'node_modules' },
      { status: '??', path: 'generator/node_modules/' },
    ], { isSymlink: link });
    expect(ignored).toEqual(['node_modules']);
    expect(significant).toEqual(['generator/node_modules/']);
  });

  it('la rimozione toglie il link senza seguirlo', () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prune-nofollow-')));
    const target = path.join(base, 'main-node-modules');
    fs.mkdirSync(path.join(target, 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(target, 'pkg', 'index.js'), 'x\n');
    const wtDir = path.join(base, 'wt');
    fs.mkdirSync(path.join(wtDir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(wtDir, 'sub', 'a.txt'), 'a\n');
    fs.symlinkSync(target, path.join(wtDir, 'node_modules'));
    fs.symlinkSync('../main-node-modules', path.join(wtDir, 'sub', 'node_modules'));
    expect(nodeModulesLinks(wtDir, ['node_modules', 'sub/node_modules', 'sub/a.txt'])).toEqual(['node_modules', 'sub/node_modules']);
    expect(removeTreeNoFollow(wtDir)).toBe(true);
    expect(fs.existsSync(wtDir)).toBe(false);
    expect(fs.readFileSync(path.join(target, 'pkg', 'index.js'), 'utf8')).toBe('x\n');
    fs.rmSync(base, { recursive: true });
  });
});

describe('fatti letti da git', () => {
  let repo = '';
  const env: NodeJS.ProcessEnv = {};
  const g = (...args: string[]) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' }).trim();
  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), content);
  };
  const commit = (msg: string) => { g('add', '-A'); g('commit', '-q', '-m', msg); return g('rev-parse', 'HEAD'); };
  let prover: ReturnType<typeof makeContentProver>;

  beforeAll(() => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prune-proofs-')));
    const gitconfig = path.join(repo, '..', `${path.basename(repo)}.gitconfig`);
    fs.writeFileSync(gitconfig, '');
    Object.assign(env, process.env, {
      GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    });
    delete env.GIT_DIR;
    delete env.GIT_INDEX_FILE;
    execFileSync('git', ['init', '-q', '--initial-branch', 'main', repo], { env });
    write('base.txt', 'uno\ndue\ntre\n');
    commit('base');
    g('update-ref', 'refs/remotes/origin/main', 'HEAD');
    prover = makeContentProver({ git: makeGitRunner(repo), mainRef: 'origin/main' });
  });

  afterAll(() => {
    if (repo) {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(`${repo}.gitconfig`, { force: true });
    }
  });

  it('spezza il patch per file e riconosce i binari', () => {
    const chunks = splitFileChunks([
      `commit ${'a'.repeat(40)}`, '',
      'diff --git a/x.txt b/x.txt', '--- a/x.txt', '+++ b/x.txt', '@@ -1 +1 @@', '-a', '+b',
      'diff --git a/img.png b/img.png', 'Binary files a/img.png and b/img.png differ',
      'diff --git a/gone.txt b/gone.txt', 'deleted file mode 100644', '--- a/gone.txt', '+++ /dev/null', '@@ -1 +0,0 @@', '-x',
    ].join('\n'));
    expect(chunks.map((c) => [c.path, c.binary])).toEqual([['x.txt', false], ['img.png', true], ['gone.txt', false]]);
  });

  it('un path che git cita tra virgolette non si associa a nessun file: la prova fallisce', () => {
    // core.quotePath=false lascia in chiaro i non-ASCII, ma tab, newline e
    // virgolette restano citati: il pezzo resta senza path, quindi senza
    // corrispondenza nello squash e senza prova (mai una rimozione).
    const [chunk] = splitFileChunks([
      'diff --git "a/x\\ty.txt" "b/x\\ty.txt"', '--- "a/x\\ty.txt"', '+++ "b/x\\ty.txt"', '@@ -1 +1 @@', '-a', '+b',
    ].join('\n'));
    expect(chunk.path).toBeNull();
    expect(isCommitContained({ files: [{ path: chunk.path, binary: false, matched: true, inverseMatched: false, inSquash: false }] }))
      .toBe(false);
  });

  it('l\'id del blob coincide con quello di git', () => {
    write('blob.txt', 'contenuto\n');
    expect(gitBlobId(fs.readFileSync(path.join(repo, 'blob.txt')))).toBe(g('hash-object', 'blob.txt'));
    fs.rmSync(path.join(repo, 'blob.txt'));
  });

  it('cherry-pick in una PR poi modificato: equivalente per patch-id', () => {
    g('checkout', '-q', '-b', 'pr', 'main');
    write('alpha.txt', 'alpha\n');
    commit('feat: add alpha');
    write('alpha.txt', 'alpha v2\n');
    const prHead = commit('feat: evolve alpha');
    g('checkout', '-q', '-b', 'local', 'main');
    write('alpha.txt', 'alpha\n');
    const tip = commit('feat: add alpha (locale)');
    const proof = prover.proveChain(tip, prHead);
    expect(proof.proven).toBe(true);
    // Il file locale è identico al blob del primo commit della PR (CA5), e lo
    // squash tocca ancora alpha.txt.
    expect(proof.how).toMatch(/identici a blob di commit della PR|per patch-id/);
  });

  it('cherry-pick revertito nella PR: resta', () => {
    g('checkout', '-q', '-b', 'pr-rev', 'main');
    write('gamma.txt', 'gamma\n');
    const picked = commit('feat: add gamma');
    g('revert', '--no-edit', picked);
    write('delta.txt', 'delta\n');
    const prHead = commit('feat: delta');
    g('checkout', '-q', '-b', 'local-rev', 'main');
    write('gamma.txt', 'gamma\n');
    // Messaggio diverso: con lo stesso secondo sarebbe lo STESSO commit della PR.
    const tip = commit('feat: add gamma (locale)');
    expect(prover.proveChain(tip, prHead)).toMatchObject({ proven: false, example: tip });
  });

  it('una differenza solo di indentazione non è equivalenza (YAML)', () => {
    g('checkout', '-q', '-b', 'pr-yaml', 'main');
    write('conf.yml', 'a:\n  b: 1\n  c: 2\n');
    const prHead = commit('feat: c sotto a');
    g('checkout', '-q', '-b', 'local-yaml', 'main');
    write('conf.yml', 'a:\n  b: 1\nc: 2\n');
    const tip = commit('feat: c in radice');
    expect(prover.proveChain(tip, prHead).proven).toBe(false);
  });

  it('un commit in più senza equivalente: resta', () => {
    g('checkout', '-q', '-b', 'local-extra', 'local');
    write('extra.txt', 'solo qui\n');
    const tip = commit('feat: solo locale');
    expect(prover.proveChain(tip, g('rev-parse', 'pr')).proven).toBe(false);
  });

  it('un file non tracciato fa fallire la prova dello sporco, tmp/ diventa annotazione', () => {
    g('checkout', '-q', 'pr');
    write('tmp/note.md', 'appunti\n');
    const head = g('rev-parse', 'HEAD');
    expect(prover.dirtyProof(repo, head, head)).toMatchObject({ proven: false, tmpOnly: 1 });
    fs.rmSync(path.join(repo, 'tmp'), { recursive: true });
    expect(prover.dirtyProof(repo, head, head)).toMatchObject({ proven: true, clean: true });
  });

  it('merge rifatto: provato col gemello, mai se il confronto col gemello non si legge', () => {
    // Ultimo caso del blocco: sposta origin/main in avanti.
    g('checkout', '-q', 'main');
    write('main-only.txt', 'm\n');
    const mainCommit = commit('main: avanti');
    g('update-ref', 'refs/remotes/origin/main', mainCommit);
    g('checkout', '-q', '-b', 'pr-merge', 'main~1');
    write('y.txt', 'y1\n');
    const y1 = commit('feat: y');
    g('merge', '-q', '--no-edit', mainCommit);
    write('y2.txt', 'y2\n');
    const prHead = commit('feat: y2');
    g('checkout', '-q', '--detach', y1);
    g('merge', '-q', '--no-edit', '-m', 'merge rifatto in locale', mainCommit);
    const redo = g('rev-parse', 'HEAD');
    g('checkout', '-q', 'main');
    const real = makeGitRunner(repo);
    expect(makeContentProver({ git: real, mainRef: 'origin/main' }).proveChain(redo, prHead).proven).toBe(true);
    const failingTwinDiff = (args: string[], opts?: { input?: string }) => (
      args.includes('diff') && args.includes('--name-only') && args.includes(redo) ? null : real(args, opts));
    expect(makeContentProver({ git: failingTwinDiff, mainRef: 'origin/main' }).proveChain(redo, prHead).proven).toBe(false);
  });

  it('PR di trasporto rifatta sopra main: file identici a un commit della PR (CA5)', () => {
    g('checkout', '-q', 'main');
    const oldMain = g('rev-parse', 'HEAD');
    write('twin.txt', 'v1\n');
    const mainTwin = commit('main: twin v1');
    g('update-ref', 'refs/remotes/origin/main', mainTwin);
    // La PR parte dal main nuovo; il ramo locale dal main vecchio: stessi
    // file finali, patch diverse. La PR poi cambia ancora il file.
    g('checkout', '-q', '-b', 'pr-transport', mainTwin);
    write('twin.txt', 'v2\n');
    commit('chore: porta il gemello');
    write('twin.txt', 'v2b\n');
    const prHead = commit('chore: gemello aggiornato');
    g('checkout', '-q', '-b', 'local-transport', oldMain);
    write('twin.txt', 'v2\n');
    const tip = commit('chore: porta il gemello (locale)');
    const proof = prover.proveChain(tip, prHead);
    expect(proof).toMatchObject({ proven: true });
    expect(proof.how).toContain('identici a blob di commit della PR');
    g('checkout', '-q', '-b', 'local-transport-off', oldMain);
    write('twin.txt', 'v3\n');
    expect(prover.proveChain(commit('chore: gemello diverso'), prHead).proven).toBe(false);
    g('checkout', '-q', 'main');
  });

  it('commit e sporco identici a origin/main (CA6), e il controcaso', () => {
    // Da prima di main-only.txt e twin.txt: il commit porta twin.txt come su
    // main, lo sporco (non tracciato) main-only.txt come su main.
    g('checkout', '-q', '-b', 'closed-same', 'main~2');
    write('twin.txt', 'v1\n');
    const head = commit('fix: stessa cosa arrivata su main per altra strada');
    write('main-only.txt', 'm\n');
    expect(prover.identicalToMain(repo, head)).toMatchObject({ proven: true, files: 2 });
    write('base.txt', 'diverso\n'); // sporco che main non ha: niente prova
    expect(prover.identicalToMain(repo, head)).toMatchObject({ proven: false });
    g('checkout', '-q', '--', 'base.txt');
    write('main-only.txt', 'altro\n');
    expect(prover.identicalToMain(repo, head)).toMatchObject({ proven: false });
    fs.rmSync(path.join(repo, 'main-only.txt'));
    // Il commit porta twin.txt diverso da main, lo sporco lo riporta a main:
    // la versione committata è "overridden" (vale solo se HEAD è una head di PR).
    g('checkout', '-q', '-b', 'closed-override', 'main~2');
    write('twin.txt', 'vecchia\n');
    const overrideHead = commit('fix: twin vecchia');
    write('twin.txt', 'v1\n');
    expect(prover.identicalToMain(repo, overrideHead)).toMatchObject({ proven: true, overridden: ['twin.txt'] });
    g('checkout', '-q', '--', 'twin.txt');
    g('checkout', '-q', 'main');
  });

  it('un HEAD che arriva dopo un fetch è visto: in memoria solo i commit presenti', () => {
    const missing = 'f'.repeat(40);
    expect(prover.hasCommit(missing)).toBe(false);
    expect(prover.hasCommit(g('rev-parse', 'HEAD'))).toBe(true);
  });

  it('un puntatore .git verso un gitdir sparito è un residuo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-gitptr-'));
    fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${path.join(dir, 'non-esiste')}\n`);
    expect(isDanglingGitPointer(path.join(dir, '.git'))).toBe(true);
    fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${dir}\n`);
    expect(isDanglingGitPointer(path.join(dir, '.git'))).toBe(false);
    fs.rmSync(dir, { recursive: true });
  });
});
