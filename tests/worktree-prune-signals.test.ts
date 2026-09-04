import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { CRON_MANAGED_GLOBS, isCronManagedPath } from '../scripts/lib/cron-managed-paths.mjs';
import {
  classifyDirtyPaths,
  parsePorcelainPaths,
  stripGitnexusBlocks,
} from '../scripts/lib/worktree-dirty.mjs';
import {
  headQueryCommand,
  makePrStateResolver,
  pickBestPrState,
  SAFE_BRANCH_RE,
} from '../scripts/lib/pr-state-window.mjs';

// I due segnali che il 2026-09-04 tenevano in vita 21 worktree per 14 GB:
//   • la finestra `gh pr list --limit 400` copre nove giorni su questo repo, e
//     lo squash-merge rende `ahead > 0` permanente → il branch di una PR
//     mergiata più vecchia della finestra restava report-only per sempre;
//   • lo sporco del worktree era output di cron o il blocco gitnexus, non
//     lavoro, ma bastava a bloccare la rimozione.

describe('percorsi gestiti dai cron', () => {
  it('riconosce i file scritti dai workflow, non dalle persone', () => {
    expect(isCronManagedPath('data/gsc-orphan-queries-clusters.json')).toBe(true);
    expect(isCronManagedPath('data/parser-quality-report.json')).toBe(true);
    expect(isCronManagedPath('data/jobs/by-crawler/coop.json')).toBe(true);
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
      'scripts/lib/accor-job-parser.mjs',
      'AGENTS.md',
    ], { isGitnexusOnly: (p) => p === 'AGENTS.md' });

    expect(significant).toEqual(['scripts/lib/accor-job-parser.mjs']);
    expect(ignored).toEqual(['data/gsc-orphan-queries-clusters.json', 'AGENTS.md']);
  });

  it('non scarta niente in silenzio: ogni path esce da una delle due liste', () => {
    const paths = ['data/fuel-prices.json', 'services/x.ts', 'README.md'];
    const { significant, ignored } = classifyDirtyPaths(paths);
    expect([...significant, ...ignored].sort()).toEqual([...paths].sort());
  });
});

describe('blocco gitnexus', () => {
  it('lo strip lascia identico un file il cui unico scarto e il blocco', () => {
    const head = '# Titolo\n\nCorpo.\n';
    const conGitnexus = '# Titolo\n\n<!-- gitnexus:start -->\ngenerato\n<!-- gitnexus:end -->\n\nCorpo.\n';
    expect(stripGitnexusBlocks(conGitnexus)).toBe(stripGitnexusBlocks(head));
  });

  it('una modifica vera sopravvive allo strip e resta significativa', () => {
    const head = '# Titolo\n\nCorpo.\n';
    const modificato = '# Titolo\n\n<!-- gitnexus:start -->\ngenerato\n<!-- gitnexus:end -->\n\nCorpo RISCRITTO.\n';
    expect(stripGitnexusBlocks(modificato)).not.toBe(stripGitnexusBlocks(head));
  });
});

describe('stato PR oltre la finestra', () => {
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
