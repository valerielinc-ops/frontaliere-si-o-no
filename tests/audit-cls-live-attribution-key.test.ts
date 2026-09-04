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
import { pickLayoutShiftAudit, compactShiftItems, layoutShiftAuditSource } from '../scripts/audit-cls-live.mjs';

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
    expect(pickLayoutShiftAudit({ 'layout-shifts': NEW_AUDIT })).toBe(NEW_AUDIT);
  });

  it('non torna undefined su una risposta PSI reale priva della chiave vecchia', () => {
    // La forma esatta osservata il 2026-09-04: la vecchia chiave NON c'e'.
    const audits = { 'cumulative-layout-shift': { score: 0.97 }, 'layout-shifts': NEW_AUDIT };
    const picked = pickLayoutShiftAudit(audits);
    expect(picked?.details?.items?.[0]?.node?.selector).toBe('div.ft-rail-grid-x');
  });

  it('cade sulla chiave ritirata per i report Lighthouse archiviati', () => {
    expect(pickLayoutShiftAudit({ 'layout-shift-elements': OLD_AUDIT })).toBe(OLD_AUDIT);
  });

  it('la chiave nuova vince quando ci sono entrambe', () => {
    const picked = pickLayoutShiftAudit({ 'layout-shifts': NEW_AUDIT, 'layout-shift-elements': OLD_AUDIT });
    expect(picked).toBe(NEW_AUDIT);
  });

  it('undefined quando non c\'e\' nessuna delle due, senza lanciare', () => {
    expect(pickLayoutShiftAudit({})).toBeUndefined();
    expect(pickLayoutShiftAudit(undefined)).toBeUndefined();
  });
});

describe('layoutShiftAuditSource — quale chiave ha risposto', () => {
  // `attribution.score` non misura la stessa cosa nelle due chiavi (audit
  // binario sulla vecchia, CLS scalato sulla nuova): senza `source` un
  // confronto storico su quel numero cambia significato in silenzio.
  it('nomina la chiave nuova quando c\'e\'', () => {
    expect(layoutShiftAuditSource({ 'layout-shifts': NEW_AUDIT })).toBe('layout-shifts');
  });
  it('nomina la chiave vecchia sui report archiviati', () => {
    expect(layoutShiftAuditSource({ 'layout-shift-elements': OLD_AUDIT })).toBe('layout-shift-elements');
  });
  it('null quando non risponde nessuna delle due', () => {
    expect(layoutShiftAuditSource({})).toBeNull();
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
  // partire il grid PSI completo (rete live) dentro il worker vitest, che poi
  // moriva su uno dei `process.exit()` di `run()`. Il test che pinna il
  // contratto era lo stesso che innescava il gate.
  it('`run()` sta dietro il main-module guard', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../scripts/audit-cls-live.mjs'), 'utf-8');
    expect(src, 'run() non deve essere invocata al top-level: l\'import deve restare inerte')
      .toMatch(/if \(import\.meta\.url === pathToFileURL\(process\.argv\[1\] \|\| ''\)\.href\) \{/);
    expect(src).not.toMatch(/^run\(\)\.catch/m);
  });
});
