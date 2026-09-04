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
import { pickLayoutShiftAudit } from '../scripts/audit-cls-live.mjs';

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
