import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  addedLinesFromDiff,
  fileContentOnMain,
  prContentOnMainVerdict,
} from '../scripts/ci/pr-autorebase.mjs';

// #9741: pr-autorebase apriva «Conflitto con main dopo LGTM: riapplicare la
// PR #N» anche quando il contributo di #N era gia' su main, riapplicato e
// squash-mergiato da un'altra PR (#9693 → #9701, poi la issue #9708 e la PR
// duplicata #9704). Il repo sintetico qui sotto riproduce quella storia e un
// conflitto reale, con git vero: niente mock del confronto.

const SOURCE = readFileSync(new URL('../scripts/ci/pr-autorebase.mjs', import.meta.url), 'utf8');

let repo = '';

function git(...args: string[]): string {
  const res = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

function write(path: string, lines: string[]): void {
  const abs = join(repo, path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${lines.join('\n')}\n`);
}

function commit(message: string): string {
  git('add', '-A');
  git('commit', '-q', '-m', message);
  return git('rev-parse', 'HEAD');
}

function mergeTreeStatus(ours: string, theirs: string): number | null {
  return spawnSync('git', ['merge-tree', '--write-tree', ours, theirs], { cwd: repo, encoding: 'utf8' }).status;
}

const WORKFLOW_BASE = [
  'steps:',
  '  - run: |',
  "      if git status --porcelain | rg -q '.'; then",
  '        echo dirty',
  '      fi',
  "      rg -q 'marker' checkpoint.txt",
];
const WORKFLOW_PR = WORKFLOW_BASE.map((l) => l.replace('rg -q', 'grep -q'));

const TEST_BASE = [
  "describe('checkpoints', () => {",
  "  it('keeps markers', () => {",
  "    expect(block).toContain('has_dirty_slices');",
  "    expect(block).toContain('data/jobs/by-crawler data/jobs/expired/by-crawler');",
  "    expect(block).toContain('node scripts/assemble-jobs-dataset.mjs');",
  '  });',
  '});',
];
// La PR aggiunge due asserzioni e ne toglie una (come #9693).
const TEST_PR = [
  ...TEST_BASE.slice(0, 3),
  "    expect(block).toContain(\"git status --porcelain | grep -q '.'\");",
  "    expect(block).not.toContain('rg -q');",
  ...TEST_BASE.slice(4),
];

const shas: Record<string, string> = {};
// Ogni caso spawna git decine di volte: su un runner carico i 10 s di default
// dell'hook non bastano, e un timeout qui non direbbe niente sul confronto.
const GIT_TIMEOUT_MS = 120_000;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'autorebase-content-on-main-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgsign', 'false');

  write('.github/workflows/backfill.yml', WORKFLOW_BASE);
  write('tests/backfill.test.ts', TEST_BASE);
  write('src/untouched.ts', ['export const x = 1;']);
  shas.base = commit('base');

  // PR #9693: il contributo approvato.
  git('checkout', '-q', '-b', 'pr-9693');
  write('.github/workflows/backfill.yml', WORKFLOW_PR);
  write('tests/backfill.test.ts', TEST_PR);
  shas.pr = commit('fix(workflow): use portable checkpoint markers');

  // Main avanza sullo stesso test: nasce il conflitto (issue #9694).
  git('checkout', '-q', 'main');
  write('tests/backfill.test.ts', [
    ...TEST_BASE.slice(0, 3),
    "    expect(block).toContain('npm run test:backfill');",
    ...TEST_BASE.slice(3),
  ]);
  shas.mainBefore = commit('test: cover backfill npm script');

  // PR #9701: riapplica #9693 su main e viene squash-mergiata. Main conserva
  // l'asserzione che #9693 toglieva, come nel caso reale.
  write('.github/workflows/backfill.yml', WORKFLOW_PR);
  write('tests/backfill.test.ts', [
    ...TEST_BASE.slice(0, 3),
    "    expect(block).toContain(\"git status --porcelain | grep -q '.'\");",
    "    expect(block).not.toContain('rg -q');",
    "    expect(block).toContain('npm run test:backfill');",
    ...TEST_BASE.slice(3),
  ]);
  shas.mainAfterReapply = commit('fix(workflow): reapply portable checkpoint markers on main (#9701)');

  // Una PR che toglie soltanto una riga: la rimozione non si puo' dimostrare
  // applicata leggendo le righe aggiunte, quindi non e' «gia' su main».
  git('checkout', '-q', '-b', 'pr-removal', shas.base);
  write('src/untouched.ts', []);
  write('tests/backfill.test.ts', TEST_BASE.filter((l) => !l.includes('assemble-jobs-dataset')));
  shas.removalOnly = commit('chore: drop assertion');

  // Una PR che cancella un file ancora presente su main.
  git('checkout', '-q', '-b', 'pr-delete', shas.base);
  unlinkSync(join(repo, 'src/untouched.ts'));
  shas.deleteFile = commit('chore: delete untouched');

  // PR #9678: il conflitto risolto sul branch, poi squash-mergiato identico.
  git('checkout', '-q', '-b', 'pr-9678', shas.mainBefore);
  write('src/rewarded.ts', ['export const firstClick = true;']);
  shas.pr9678 = commit('fix(rewarded): start on first click');
  git('checkout', '-q', 'main');
  git('checkout', '-q', '-b', 'main-squash', shas.mainAfterReapply);
  write('src/rewarded.ts', ['export const firstClick = true;']);
  shas.mainSquash9678 = commit('fix(rewarded): start on first click (#9678)');
  git('checkout', '-q', 'main');
}, GIT_TIMEOUT_MS);

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe('pr-autorebase — contenuto della PR gia\' su main (#9741)', () => {
  it('#9693 dopo #9701: merge-tree vede un conflitto, --is-ancestor dice no, il confronto per blob dice «gia\' su main»', () => {
    expect(mergeTreeStatus(shas.mainAfterReapply, shas.pr)).toBe(1);
    const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', shas.pr, shas.mainAfterReapply], { cwd: repo });
    expect(ancestor.status).toBe(1);

    const verdict = prContentOnMainVerdict(shas.pr, { cwd: repo, mainRef: shas.mainAfterReapply });
    expect(verdict.state).toBe('on-main');
    expect(verdict.files).toEqual(['.github/workflows/backfill.yml', 'tests/backfill.test.ts']);
    expect(verdict.missing).toEqual([]);
  }, GIT_TIMEOUT_MS);

  it('#9693 prima di #9701: conflitto reale, il contributo non e\' su main → la issue resta', () => {
    expect(mergeTreeStatus(shas.mainBefore, shas.pr)).toBe(1);
    const verdict = prContentOnMainVerdict(shas.pr, { cwd: repo, mainRef: shas.mainBefore });
    expect(verdict.state).toBe('not-on-main');
    expect(verdict.missing).toEqual(['.github/workflows/backfill.yml', 'tests/backfill.test.ts']);
  }, GIT_TIMEOUT_MS);

  it('#9678: HEAD finale squash-mergiata con blob identici → gia\' su main', () => {
    const verdict = prContentOnMainVerdict(shas.pr9678, { cwd: repo, mainRef: shas.mainSquash9678 });
    expect(verdict.state).toBe('on-main');
  }, GIT_TIMEOUT_MS);

  it('una sola rimozione o una cancellazione non si dimostrano applicate', () => {
    expect(prContentOnMainVerdict(shas.removalOnly, { cwd: repo, mainRef: shas.mainAfterReapply }).state).toBe('not-on-main');
    expect(prContentOnMainVerdict(shas.deleteFile, { cwd: repo, mainRef: shas.mainAfterReapply }).state).toBe('not-on-main');
  }, GIT_TIMEOUT_MS);

  it('fail-closed: HEAD o main illeggibili danno unknown, mai on-main', () => {
    expect(prContentOnMainVerdict('f'.repeat(40), { cwd: repo, mainRef: 'main' }).state).toBe('unknown');
    expect(prContentOnMainVerdict(shas.pr, { cwd: repo, mainRef: 'origin/main' }).state).toBe('unknown');
    // HEAD gia' contenuta in main: nessun file rispetto al merge-base.
    expect(prContentOnMainVerdict(shas.base, { cwd: repo, mainRef: 'main' }).state).toBe('unknown');
  }, GIT_TIMEOUT_MS);
});

describe('pr-autorebase — confronto per file, parti pure (#9741)', () => {
  it('blob identici (anche entrambi assenti) bastano', () => {
    expect(fileContentOnMain({ prOid: 'a', mainOid: 'a', addedLines: [], prText: '', mainText: '' })).toBe(true);
    expect(fileContentOnMain({ prOid: null, mainOid: null, addedLines: [], prText: '', mainText: '' })).toBe(true);
  });

  it('righe aggiunte presenti su main almeno quante nell\'HEAD della PR', () => {
    const base = { prOid: 'a', mainOid: 'b' };
    expect(fileContentOnMain({ ...base, addedLines: ['x', ''], prText: 'x\ny', mainText: 'x\ny\nz' })).toBe(true);
    expect(fileContentOnMain({ ...base, addedLines: ['x'], prText: 'x\nx', mainText: 'x' })).toBe(false);
    expect(fileContentOnMain({ ...base, addedLines: ['w'], prText: 'w', mainText: 'x' })).toBe(false);
    expect(fileContentOnMain({ ...base, addedLines: ['', '  '], prText: '', mainText: '' })).toBe(false);
    expect(fileContentOnMain({ prOid: 'a', mainOid: null, addedLines: ['x'], prText: 'x', mainText: '' })).toBe(false);
  });

  it('legge solo le righe + dentro gli hunk, non l\'intestazione +++', () => {
    const diff = [
      'diff --git a/f b/f',
      '--- a/f',
      '+++ b/f',
      '@@ -1 +1,2 @@',
      '-old',
      '+new',
      '+++counter',
      '\\ No newline at end of file',
    ].join('\n');
    expect(addedLinesFromDiff(diff)).toEqual(['new', '++counter']);
  });

  it('l\'hand-off confronta i blob DOPO merge-tree e PRIMA di creare la issue; unknown non sopprime', () => {
    const fn = SOURCE.slice(SOURCE.indexOf('function handOffConflictToFixer('), SOURCE.indexOf('function commentConflictOnce('));
    const mergeTree = fn.indexOf("if (verdict.state !== 'conflicted')");
    const onMain = fn.indexOf('prContentOnMainVerdict(head)');
    const create = fn.indexOf("'issue', 'create'");
    expect(mergeTree).toBeGreaterThan(0);
    expect(onMain).toBeGreaterThan(mergeTree);
    expect(create).toBeGreaterThan(onMain);
    expect(fn).toMatch(/if \(onMain\.state === 'on-main'\) \{[\s\S]*?gia' su main[\s\S]*?return;\s*\}/);
  });
});
