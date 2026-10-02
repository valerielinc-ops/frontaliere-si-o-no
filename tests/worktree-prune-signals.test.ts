import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { CRON_MANAGED_GLOBS, isCronManagedPath } from '../scripts/lib/cron-managed-paths.mjs';

import {
  classifyDirty,
  classifyDirtyEntries,
  classifyDirtyPaths,
  isPrScratchPath,
  parsePorcelainEntries,
  parsePorcelainPaths,
} from '../scripts/lib/worktree-dirty.mjs';
import {
  headQueryCommand,
  isMergedIntoBaseAtHead,
  isMergedPullRequestToBase,
  makePrStateResolver,
  normalizeAssociatedPr,
  pickBestAssociatedPr,
  pickBestPrState,
  SAFE_BRANCH_RE,
} from '../scripts/lib/pr-state-window.mjs';
import {
  canDeleteClosedCandidate,
  canDeleteIssueFix,
  canRemoveIdleOnMain,
  hasAncestryProof,
  IDLE_WORKTREE_MS,
  isAbortedCheckout,
  isIdleSince,
  isOrphanResidueFile,
  isPathBusy,
  isRemovableOrphanDir,
  needsSnapshot,
} from '../scripts/lib/branch-purge-policy.mjs';

// I due segnali che il 2026-09-04 tenevano in vita 21 worktree per 14 GB:
//   • la finestra `gh pr list --limit 400` copre nove giorni su questo repo, e
//     lo squash-merge rende `ahead > 0` permanente → il branch di una PR
//     mergiata più vecchia della finestra restava report-only per sempre;
//   • lo sporco del worktree era output di cron, non lavoro, ma bastava a
//     bloccare la rimozione.

describe('percorsi gestiti dai cron', () => {
  it('riconosce i file scritti dai workflow, non dalle persone', () => {
    expect(isCronManagedPath('data/gsc-orphan-queries-clusters.json')).toBe(true);
    expect(isCronManagedPath('data/parser-quality-report.json')).toBe(true);
    expect(isCronManagedPath('data/jobs/by-crawler/coop.json')).toBe(true);
    expect(isCronManagedPath('data/jobs/expired/by-crawler/coop.json')).toBe(true);
    expect(isCronManagedPath('data/prospector/crawlers/accor.json')).toBe(true);
  });

  it('non rivendica codice o test', () => {
    expect(isCronManagedPath('scripts/lib/accor-job-parser.mjs')).toBe(false);
    expect(isCronManagedPath('tests/accor-crawler.test.ts')).toBe(false);
    expect(isCronManagedPath('AGENTS.md')).toBe(false);
  });

  it('la glob attraversa gli slash come fa il pathspec di git', () => {
    // `data/seo-404-compat/*` deve prendere anche le sottodirectory: con
    // `[^/]*` un file annidato sfuggirebbe e tornerebbe a contare come lavoro.
    expect(isCronManagedPath('data/seo-404-compat/2026/08/snapshot.json')).toBe(true);
  });

  it('resta la sorgente unica condivisa con local-ignore-cron.sh', () => {
    const sh = fs.readFileSync(
      path.join(process.cwd(), 'scripts/dev/local-ignore-cron.sh'), 'utf8',
    );
    // Lo script di shell deve LEGGERE il modulo, non riscrivere la lista:
    // due copie derivano appena qualcuno aggiunge un cron da una parte sola.
    expect(sh).toContain('scripts/lib/cron-managed-paths.mjs');
    expect(CRON_MANAGED_GLOBS.length).toBeGreaterThan(20);
    for (const glob of CRON_MANAGED_GLOBS) {
      expect(sh.includes(`"${glob}"`)).toBe(false);
    }
  });
});

describe('porcelain', () => {
  it('non perde il path quando lo stato ha lo spazio iniziale', () => {
    // ` M file` (non-staged) e `M  file` (staged) hanno entrambi il path in
    // colonna 4: un trim sull'output sfaserebbe la prima riga di un carattere.
    expect(parsePorcelainPaths(' M services/a.ts\nM  scripts/b.mjs\n?? tests/c.ts'))
      .toEqual(['services/a.ts', 'scripts/b.mjs', 'tests/c.ts']);
  });

  it('su un rename conta la destinazione', () => {
    expect(parsePorcelainPaths('R  vecchio.ts -> nuovo.ts')).toEqual(['nuovo.ts']);
  });
});

describe('classificazione dello sporco', () => {
  it('separa il lavoro dal rumore di macchina', () => {
    const { significant, ignored } = classifyDirtyPaths([
      'data/gsc-orphan-queries-clusters.json',
      'data/jobs/by-crawler/coop.json',
      'scripts/lib/accor-job-parser.mjs',
      'AGENTS.md',
    ]);

    // Un .md tracciato e' lavoro: nessuna euristica sul nome lo declassa.
    expect(significant).toEqual(['scripts/lib/accor-job-parser.mjs', 'AGENTS.md']);
    expect(ignored).toEqual([
      'data/gsc-orphan-queries-clusters.json',
      'data/jobs/by-crawler/coop.json',
    ]);
  });

  it('non scarta niente in silenzio: ogni path esce da una delle due liste', () => {
    const paths = ['data/fuel-prices.json', 'services/x.ts', 'README.md'];
    const { significant, ignored } = classifyDirtyPaths(paths);
    expect([...significant, ...ignored].sort()).toEqual([...paths].sort());
  });
});

// 2026-10-02: 21 dei 44 worktree rimovibili erano trattenuti da un solo file
// non tracciato, il body della PR scritto per `gh pr create --body-file`.
describe('body della PR lasciato nel worktree', () => {
  it('riconosce i nomi usati dagli agenti, solo alla radice', () => {
    for (const name of ['.pr-body-9108.md', '.pr-body.md', '.pr-body-backfill-recovery-rerun.md',
      '.codex-pr-body.md', 'PR_BODY.md', '.issue-831-comment.md']) {
      expect(isPrScratchPath(name), name).toBe(true);
    }
    for (const name of ['docs/.pr-body.md', 'README.md', 'pr-body.md', '.issue-comment.md', '.pr-body-9108.ts']) {
      expect(isPrScratchPath(name), name).toBe(false);
    }
  });

  it('il porcelain conserva lo stato accanto al path', () => {
    expect(parsePorcelainEntries('?? .pr-body-1.md\n M PR_BODY.md\nR  a.ts -> b.ts')).toEqual([
      { status: '??', path: '.pr-body-1.md' },
      { status: ' M', path: 'PR_BODY.md' },
      { status: 'R ', path: 'b.ts' },
    ]);
  });

  it('ignora il body non tracciato, ma non un file tracciato con lo stesso nome', () => {
    const { significant, ignored } = classifyDirtyEntries([
      { status: '??', path: '.pr-body-9108.md' },
      { status: '??', path: '.issue-831-comment.md' },
      { status: ' M', path: 'PR_BODY.md' },
      { status: '??', path: 'notes.ts' },
      { status: ' M', path: 'data/jobs/by-crawler/coop.json' },
    ]);
    expect(ignored).toEqual(['.pr-body-9108.md', '.issue-831-comment.md', 'data/jobs/by-crawler/coop.json']);
    expect(significant).toEqual(['PR_BODY.md', 'notes.ts']);
  });

  it('uno stato git illeggibile non è "pulito"', () => {
    // Prima l'errore di `git status` diventava '' e quindi "nessuna modifica".
    const missing = path.join(os.tmpdir(), `worktree-che-non-esiste-${process.pid}`);
    expect(classifyDirty(missing)).toEqual({ significant: [], ignored: [], error: true });
  });
});

describe('worktree senza PR già interamente su main', () => {
  const ok = { dirty: false, ahead: 0, idle: true, busy: false, busyKnown: true, ghOk: true };

  it('si rimuove solo con tutte le prove insieme', () => {
    expect(canRemoveIdleOnMain(ok)).toBe(true);
  });

  it.each([
    ['sporco', { dirty: true }],
    ['con commit propri', { ahead: 1 }],
    ['ahead sconosciuto', { ahead: null }],
    ['attivo di recente', { idle: false }],
    ['in uso da un processo', { busy: true }],
    ['lsof non disponibile', { busyKnown: false }],
    ['stato PR non leggibile', { ghOk: false }],
  ])('resta se %s', (_label, override) => {
    expect(canRemoveIdleOnMain({ ...ok, ...override })).toBe(false);
  });

  it('inattivo vuol dire fermo da almeno IDLE_WORKTREE_MS', () => {
    const now = Date.UTC(2026, 9, 2);
    expect(isIdleSince(now - IDLE_WORKTREE_MS - 1, { now })).toBe(true);
    expect(isIdleSince(now - 60 * 60 * 1000, { now })).toBe(false);
    expect(isIdleSince(0, { now })).toBe(false);
    expect(isIdleSince(Number.NaN, { now })).toBe(false);
  });

  it('una cwd dentro il worktree lo tiene, un fratello con lo stesso prefisso no', () => {
    const cwds = ['/repo/.claude/worktrees/wt-1/scripts'];
    expect(isPathBusy('/repo/.claude/worktrees/wt-1', cwds)).toBe(true);
    expect(isPathBusy('/repo/.claude/worktrees/wt-1', ['/repo/.claude/worktrees/wt-1'])).toBe(true);
    expect(isPathBusy('/repo/.claude/worktrees/wt-10', cwds)).toBe(false);
    expect(isPathBusy('/repo/.claude/worktrees/wt-1', [])).toBe(false);
  });

  it('checkout interrotto: niente index e solo contenuto identico a HEAD', () => {
    expect(isAbortedCheckout({ hasIndex: false, onlyHeadContent: true })).toBe(true);
    expect(isAbortedCheckout({ hasIndex: true, onlyHeadContent: true })).toBe(false);
    expect(isAbortedCheckout({ hasIndex: false, onlyHeadContent: false })).toBe(false);
  });
});

describe('directory orfane sotto le cartelle dei worktree', () => {
  it('considera residuo solo il rumore di macchina e il body PR alla radice', () => {
    for (const rel of ['.DS_Store', 'sub/.DS_Store', 'node_modules/.vite/vitest/x/results.json',
      'triad/node_modules/.vite/results.json', '.pr-body-content-first.md']) {
      expect(isOrphanResidueFile(rel), rel).toBe(true);
    }
    for (const rel of ['src/a.ts', '.git', '.env.example', 'sub/.pr-body.md', '.cache/tsc/tsconfig.tsbuildinfo']) {
      expect(isOrphanResidueFile(rel), rel).toBe(false);
    }
  });

  it('si cancella solo se ferma e fatta solo di residui', () => {
    expect(isRemovableOrphanDir({ files: ['.DS_Store'], idle: true })).toBe(true);
    expect(isRemovableOrphanDir({ files: [], idle: true })).toBe(true);
    expect(isRemovableOrphanDir({ files: ['.DS_Store'], idle: false })).toBe(false);
    expect(isRemovableOrphanDir({ files: ['.DS_Store', 'src/a.ts'], idle: true })).toBe(false);
  });
});

describe('stato PR oltre la finestra', () => {
  it('richiede merge su main e HEAD esatto prima di autorizzare il cleanup', () => {
    const merged = {
      state: 'MERGED',
      baseRefName: 'main',
      headRefOid: 'a'.repeat(40),
    };

    expect(isMergedIntoBaseAtHead(merged, {
      baseBranch: 'main',
      headOid: 'a'.repeat(40),
    })).toBe(true);
    expect(isMergedIntoBaseAtHead({ ...merged, baseRefName: 'release' }, {
      baseBranch: 'main',
      headOid: 'a'.repeat(40),
    })).toBe(false);
    expect(isMergedIntoBaseAtHead({ ...merged, headRefOid: 'b'.repeat(40) }, {
      baseBranch: 'main',
      headOid: 'a'.repeat(40),
    })).toBe(false);
    expect(isMergedIntoBaseAtHead({ ...merged, state: 'CLOSED' }, {
      baseBranch: 'main',
      headOid: 'a'.repeat(40),
    })).toBe(false);
  });

  it('interroga per --head il branch che la finestra non ha risolto', () => {
    const cache = new Map<string, string | undefined>();
    const chiamate: string[] = [];
    const resolve = makePrStateResolver({
      cache,
      runQuery: (cmd: string) => { chiamate.push(cmd); return '[{"state":"MERGED"}]'; },
    });

    // Il caso reale: #6313 mergiata, fuori dalle 400 PR della finestra.
    expect(resolve('fix-6298')).toBe('MERGED');
    expect(chiamate).toEqual([headQueryCommand('fix-6298')]);
  });

  it('usa la finestra quando ce l ha, senza pagare la query', () => {
    const cache = new Map([['gia-nota', 'OPEN']]);
    const resolve = makePrStateResolver({
      cache,
      runQuery: () => { throw new Error('non deve essere chiamata'); },
    });
    expect(resolve('gia-nota')).toBe('OPEN');
  });

  it('memorizza anche il miss: un branch senza PR non si interroga due volte', () => {
    const cache = new Map<string, string | undefined>();
    let n = 0;
    const resolve = makePrStateResolver({ cache, runQuery: () => { n++; return '[]'; } });

    expect(resolve('mai-in-pr')).toBeUndefined();
    expect(resolve('mai-in-pr')).toBeUndefined();
    expect(n).toBe(1);
  });

  it('non interroga un nome di branch che non saprebbe citare', () => {
    const resolve = makePrStateResolver({
      cache: new Map(),
      runQuery: () => { throw new Error('non deve essere chiamata'); },
    });
    expect(resolve("evil'; rm -rf /")).toBeUndefined();
    expect(SAFE_BRANCH_RE.test('codex/fix-6760-coverage')).toBe(true);
  });

  it('OPEN batte MERGED: una PR aperta protegge il branch', () => {
    expect(pickBestPrState([{ state: 'CLOSED' }, { state: 'OPEN' }, { state: 'MERGED' }])).toBe('OPEN');
    expect(pickBestPrState([{ state: 'CLOSED' }, { state: 'MERGED' }])).toBe('MERGED');
    expect(pickBestPrState([])).toBeUndefined();
  });

  it('segnala quali branch vengono dalla query mirata e non dalla finestra', () => {
    // Il chiamante deve poter distinguere i due casi: un CLOSED risolto qui
    // puo' venire da qualunque punto della storia, e CLOSED non e' MERGED —
    // il contenuto NON e' su main, quindi i commit unici del branch sono
    // l'unica copia. Senza questa distinzione la query allargherebbe il raggio
    // del delete a tutta la storia del repo.
    const viaHead = new Set<string>();
    const cache = new Map<string, string | undefined>([['dalla-finestra', 'CLOSED']]);
    const resolve = makePrStateResolver({ cache, viaHead, runQuery: () => '[{"state":"CLOSED"}]' });

    expect(resolve('dalla-finestra')).toBe('CLOSED');
    expect(resolve('fuori-finestra')).toBe('CLOSED');
    expect([...viaHead]).toEqual(['fuori-finestra']);
  });

  it('un branch senza PR non entra in viaHead', () => {
    const viaHead = new Set<string>();
    const resolve = makePrStateResolver({ cache: new Map(), viaHead, runQuery: () => '[]' });
    expect(resolve('mai-in-pr')).toBeUndefined();
    expect(viaHead.size).toBe(0);
  });

  it('gh assente: nessuna query e nessuna cancellazione decisa al buio', () => {
    const resolve = makePrStateResolver({
      cache: new Map(),
      runQuery: () => { throw new Error('non deve essere chiamata'); },
      enabled: false,
    });
    expect(resolve('qualsiasi')).toBeUndefined();
  });

  it('normalizza la risposta REST commit→PR: CLOSED con merged_at è MERGED', () => {
    expect(normalizeAssociatedPr({ state: 'closed', merged_at: '2026-09-16T07:48:58Z' })?.state)
      .toBe('MERGED');
    expect(normalizeAssociatedPr({ state: 'closed', merged_at: null })?.state).toBe('CLOSED');
  });

  it('sceglie la PR migliore solo sul base branch richiesto', () => {
    const merged = {
      number: 8812,
      state: 'closed',
      merged_at: '2026-09-16T07:48:58Z',
      base: { ref: 'main' },
    };
    const staging = {
      number: 8813,
      state: 'closed',
      merged_at: '2026-09-16T07:49:00Z',
      base: { ref: 'staging' },
    };
    expect(pickBestAssociatedPr([staging, merged], { baseBranch: 'main' })?.number).toBe(8812);
    expect(isMergedPullRequestToBase(merged, { baseBranch: 'main' })).toBe(true);
    expect(isMergedPullRequestToBase(staging, { baseBranch: 'main' })).toBe(false);
  });
});

describe('guardie del purge', () => {
  it('non cancella una PR/issue chiusa con commit locali unici', () => {
    expect(canDeleteClosedCandidate({ ahead: 3 })).toBe(false);
    expect(canDeleteClosedCandidate({ ahead: null })).toBe(false);
    expect(canDeleteClosedCandidate({ ahead: 0 })).toBe(true);
  });

  it('tratta not_planned come non-prova di lavoro completato', () => {
    expect(canDeleteIssueFix({ issueState: 'closed', issueReason: 'completed', ahead: 0 })).toBe(true);
    expect(canDeleteIssueFix({ issueState: 'closed', issueReason: 'not_planned', ahead: 0 })).toBe(false);
    expect(canDeleteIssueFix({ issueState: 'closed', issueReason: 'completed', ahead: 2 })).toBe(false);
  });

  it('richiede uno snapshot solo per un merged squashato non già taggato', () => {
    expect(needsSnapshot({ prState: 'MERGED', ahead: 4, hasSnapshot: false })).toBe(true);
    expect(needsSnapshot({ prState: 'MERGED', ahead: 4, hasSnapshot: true })).toBe(false);
    expect(needsSnapshot({ prState: 'MERGED', ahead: 0, hasSnapshot: false })).toBe(false);
    expect(needsSnapshot({ prState: 'CLOSED', ahead: 4, hasSnapshot: false })).toBe(false);
  });

  it('accetta solo il confronto che dimostra che il tip locale è antenato della PR', () => {
    expect(hasAncestryProof({ status: 'ahead', ahead_by: 8, behind_by: 0 })).toBe(true);
    expect(hasAncestryProof({ status: 'behind', ahead_by: 0, behind_by: 2 })).toBe(false);
    expect(hasAncestryProof({ status: 'diverged', ahead_by: 1, behind_by: 1 })).toBe(false);
    expect(hasAncestryProof({ status: 'ahead', ahead_by: 8, behind_by: '0' })).toBe(false);
    expect(hasAncestryProof(null)).toBe(false);
  });
});

describe('scope del purge dei worktree', () => {
  const src = fs.readFileSync(
    path.join(process.cwd(), 'scripts', 'prune-merged-worktrees.mjs'),
    'utf8',
  );

  it('considera anche `.wt` senza allargarsi a directory simili', () => {
    const match = src.match(/const ISOLATION_RE\s*=\s*(\/[^;]+\/);/);
    expect(match, 'ISOLATION_RE non trovato in prune-merged-worktrees.mjs').toBeTruthy();
    const literal = match![1];
    const end = literal.lastIndexOf('/');
    const isolation = new RegExp(literal.slice(1, end), literal.slice(end + 1));

    expect(isolation.test('/workspace/.claude/worktrees/fix')).toBe(true);
    expect(isolation.test('/workspace/.worktrees/fix')).toBe(true);
    expect(isolation.test('/workspace/.wt/fix')).toBe(true);
    expect(isolation.test('/workspace/.wt-old/fix')).toBe(false);
    expect(isolation.test('/workspace/fix')).toBe(false);
  });
});

describe('local-ignore-cron.sh', () => {
  it('il comando che usa per caricare la lista rende davvero le glob', () => {
    // Lo stesso `node --input-type=module -e …` che gira dentro lo script: se
    // l'export cambia nome, qui esce vuoto e lo script abortisce invece di
    // silenziosamente non nascondere piu' niente.
    const inline = fs.readFileSync(
      path.join(process.cwd(), 'scripts/dev/local-ignore-cron.sh'), 'utf8',
    ).match(/'(import \{ CRON_MANAGED_GLOBS \}[^']+)'/);
    expect(inline).not.toBeNull();

    const out = execFileSync('node', ['--input-type=module', '-e', inline![1]], {
      encoding: 'utf8', cwd: process.cwd(),
    }).split('\n').filter(Boolean);

    expect(out).toEqual([...CRON_MANAGED_GLOBS]);
  });
});
