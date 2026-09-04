/**
 * audit-cls-live — l'attribuzione del layout shift si legge dalla chiave che
 * Lighthouse pubblica DAVVERO.
 *
 * ## Il difetto che chiude, misurato
 *
 * `runPsi()` leggeva solo `audits['layout-shift-elements']`. Lighthouse ha
 * ritirato quella chiave in favore di `layout-shifts`, e PSI risponde solo con
 * la seconda: il campo `attribution.layoutShiftElements` tornava quindi `null`
 * a OGNI run, per ogni target, da quando la chiave e' cambiata.
 *
 * `null` qui e' indistinguibile da «la pagina non ha shift», e il costo e'
 * documentato: due analisi automatiche su #5785 (2026-08-13 e 2026-08-18) hanno
 * concluso «nessuna telemetria di attribuzione disponibile», e la issue #6454
 * e' rimasta in `needs-human` come UNICA classe A del backlog — una domanda per
 * il proprietario — mentre l'attribuzione era li' sotto un altro nome.
 *
 * Verificato il 2026-09-04 su una risposta PSI reale per
 * `/cerca-lavoro-ticino/` mobile: `layout-shift-elements` ASSENTE,
 * `layout-shifts` con 2 item, il primo dei quali vale il 99,7% dello shift
 * (`div.ft-rail-grid-x > div.min-w-0 > div.space-y-6 > div.space-y-3`,
 * score 0,0609 su 0,0611 totali).
 *
 * ## Perche' serviva estrarre una funzione
 *
 * La lettura viveva dentro `runPsi()`, che fa una chiamata di rete: nessun test
 * poteva raggiungerla senza mockare PSI, ed e' il motivo per cui il difetto e'
 * passato inosservato. `pickLayoutShiftAudit()` e' pura e riceve gli `audits`.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { pickLayoutShiftAudit, compactShiftItems } from '../scripts/audit-cls-live.mjs';

const NEW_AUDIT = {
  score: 1,
  details: { items: [{ score: 0.0609, node: { selector: 'div.ft-rail-grid-x' } }] },
};
const OLD_AUDIT = {
  score: 0.5,
  details: { items: [{ score: 0.2, node: { selector: 'div.legacy' } }] },
};

describe('pickLayoutShiftAudit', () => {
  it('preferisce `layout-shifts`, la chiave che Lighthouse pubblica oggi', () => {
    expect(pickLayoutShiftAudit({ 'layout-shifts': NEW_AUDIT }).audit).toBe(NEW_AUDIT);
  });

  it('non torna undefined su una risposta PSI reale priva della chiave vecchia', () => {
    // La forma esatta osservata il 2026-09-04: la vecchia chiave NON c'e'.
    const audits = { 'cumulative-layout-shift': { score: 0.97 }, 'layout-shifts': NEW_AUDIT };
    const { audit, source } = pickLayoutShiftAudit(audits);
    expect(audit?.details?.items?.[0]?.node?.selector).toBe('div.ft-rail-grid-x');
    expect(source).toBe('layout-shifts');
  });

  it('cade sulla chiave ritirata per i report Lighthouse archiviati', () => {
    expect(pickLayoutShiftAudit({ 'layout-shift-elements': OLD_AUDIT }).audit).toBe(OLD_AUDIT);
  });

  it('la chiave nuova vince quando ci sono entrambe', () => {
    const picked = pickLayoutShiftAudit({ 'layout-shifts': NEW_AUDIT, 'layout-shift-elements': OLD_AUDIT });
    expect(picked.audit).toBe(NEW_AUDIT);
    expect(picked.source).toBe('layout-shifts');
  });

  it('undefined quando non c\'e\' nessuna delle due, senza lanciare', () => {
    expect(pickLayoutShiftAudit({})).toEqual({ audit: undefined, source: null });
    expect(pickLayoutShiftAudit(undefined)).toEqual({ audit: undefined, source: null });
  });
});

describe('compactShiftItems — forma stabile e compatta', () => {
  it('proietta sempre {score, node:{selector,snippet,nodeLabel,boundingRect}}', () => {
    const out = compactShiftItems(NEW_AUDIT);
    expect(out).toHaveLength(1);
    expect(Object.keys(out![0]).sort()).toEqual(['node', 'score']);
    expect(Object.keys(out![0].node).sort()).toEqual(['boundingRect', 'nodeLabel', 'selector', 'snippet']);
    expect(out![0].node.selector).toBe('div.ft-rail-grid-x');
  });

  it('scarta `subItems`, che il solo `layout-shifts` puo\' portare e che gonfierebbe l\'artifact', () => {
    const fat = {
      details: {
        items: [{
          score: 0.5,
          node: { selector: 'div.a' },
          subItems: { items: Array.from({ length: 200 }, (_, i) => ({ cause: `c${i}`, extra: 'x'.repeat(500) })) },
        }],
      },
    };
    const out = compactShiftItems(fat)!;
    expect(out[0]).not.toHaveProperty('subItems');
    expect(JSON.stringify(out).length).toBeLessThan(400);
  });

  it('la stessa forma esce da entrambe le chiavi', () => {
    const a = compactShiftItems(NEW_AUDIT)![0];
    const b = compactShiftItems(OLD_AUDIT)![0];
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    expect(Object.keys(a.node).sort()).toEqual(Object.keys(b.node).sort());
  });

  it('taglia a `limit` e non lancia su audit vuoto o assente', () => {
    const many = { details: { items: Array.from({ length: 9 }, (_, i) => ({ score: i, node: { selector: `s${i}` } })) } };
    expect(compactShiftItems(many)).toHaveLength(5);
    expect(compactShiftItems(many, 2)).toHaveLength(2);
    expect(compactShiftItems(undefined)).toBeNull();
    expect(compactShiftItems({ details: {} })).toBeNull();
  });
});

describe('il modulo non esegue niente quando lo si importa', () => {
  // Il difetto trovato dalla review su PR #7287: `run()` era invocata al
  // top-level senza guard, quindi importare questo modulo dal test faceva
  // partire il grid PSI completo (TARGETS x STRATEGIES, rete live verso
  // frontaliereticino.ch) dentro il worker vitest, che poi moriva su uno dei
  // `process.exit()` di `run()`. Il test che pinna il contratto era lo stesso
  // che innescava il gate.
  //
  // Provato sul COMPORTAMENTO e non sul testo del guard (nit della seconda
  // review): asserire la stringa esatta `if (import.meta.url === ...)` fa
  // fallire qualunque riscrittura equivalente — per esempio estrarre un
  // `isMainModule()` — pur restando corretta. Ed e' proprio un test che
  // pinnava una stringa invece di un comportamento ad aver lasciato vivere per
  // settimane il difetto della chiave ritirata che questo file esiste per
  // impedire.
  it('un import in un processo pulito non produce NIENTE oltre al proprio marker', () => {
    const modUrl = pathToFileURL(path.resolve(__dirname, '../scripts/audit-cls-live.mjs')).href;
    const r = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `await import(${JSON.stringify(modUrl)}); console.log('INERT');`],
      { encoding: 'utf-8', timeout: 60_000 },
    );

    // L'asserzione e' sull'output INTERO di stdout, non sulla presenza del
    // marker: senza guard il marker viene stampato lo stesso — `run()` e' async
    // e non e' awaited, quindi l'import risolve e `INERT` esce PRIMA che il
    // grid PSI finisca. Un `toContain('INERT')` sarebbe verde in entrambi i
    // casi (misurato: passava in 771 ms senza guard).
    //
    // Riprodotto senza guard: stdout porta `INERT` seguito da
    // `Targets audited: 7 × 2 = 14` e dalla tabella del grid, e il processo
    // esce comunque 0 per il fail-open sui 429. stdout da solo discrimina.
    //
    // stderr NON entra nell'uguaglianza: Node ci scrive i propri warning
    // (`ExperimentalWarning`, `DeprecationWarning` da un import transitivo, o
    // uno nuovo introdotto da una minor), che renderebbero rosso un gate che
    // non e' regredito — un falso rosso auto-inflitto. Si guardano solo le
    // righe di stderr che NON sono warning di Node, dove finiscono gli `❌` di
    // `run()`.
    const stdout = (r.stdout ?? '').trim();
    const stderrLines = (r.stderr ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => !/^\(node:\d+\)|Warning:|^\s*at |--trace-(deprecation|warnings)/.test(l));

    expect(stdout, 'l\'import ha eseguito qualcosa: run() non e\' dietro il main-module guard').toBe('INERT');
    expect(stderrLines, 'il modulo ha scritto su stderr al solo import').toEqual([]);
    expect(r.status).toBe(0);
  });
});
