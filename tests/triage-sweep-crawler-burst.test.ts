/**
 * triage-sweep — budget di route diretto crawler→agent:fix (#5514).
 *
 * Il vecchio `ROUTE_FIX_CAP=5` era nato come anti-burst ma era calibrato sul
 * numero sbagliato: la coda che doveva proteggere ha profondità **1**, non 5.
 * `issue-fix.yml` usa `concurrency: group: issue-fix` + `cancel-in-progress:
 * false`, e con cancel=false GitHub tiene una sola run pending per gruppo —
 * ogni nuova pending sfratta la precedente. Cinque `agent:fix` applicati nello
 * stesso run dello sweep garantivano quindi quattro run cancellate.
 * Misurato il 2026-08-08 alle 09:02: 5 `[crawler-health]` etichettate insieme,
 * 1 lavorata, 4 issue ferme due giorni (#5392 #5393 #5394 #5395).
 */

import { describe, it, expect } from 'vitest';
import { crawlerDirectFixBudget } from '../scripts/ci/triage-sweep.mjs';

describe('crawlerDirectFixBudget', () => {
  it('concede UN route diretto a slot libero (immediatezza preservata nel caso comune)', () => {
    expect(crawlerDirectFixBudget({ inFlightFixRuns: 0, openFixLabeled: 0 })).toBe(1);
  });

  it('azzera il budget se una run issue-fix è già in volo', () => {
    expect(crawlerDirectFixBudget({ inFlightFixRuns: 1, openFixLabeled: 0 })).toBe(0);
  });

  it('azzera il budget se una issue aperta porta già agent:fix (la label È il claim)', () => {
    // Una run appena triggerata può non essere ancora in `gh run list`: la
    // label arriva prima. Guardare solo le run lascerebbe la finestra di race
    // in cui lo sfratto è ancora possibile.
    expect(crawlerDirectFixBudget({ inFlightFixRuns: 0, openFixLabeled: 1 })).toBe(0);
  });

  it('fail-closed su errore API (+Infinity dal conteggio run) → tutto in coda', () => {
    // La coda non è una perdita: il followup-drainer promuove uno alla volta.
    expect(crawlerDirectFixBudget({ inFlightFixRuns: Number.POSITIVE_INFINITY, openFixLabeled: 0 })).toBe(0);
    expect(crawlerDirectFixBudget({ inFlightFixRuns: Number.NaN, openFixLabeled: 0 })).toBe(0);
  });

  it('`--cap 0` disattiva del tutto il route diretto (debug)', () => {
    expect(crawlerDirectFixBudget({ inFlightFixRuns: 0, openFixLabeled: 0, cap: 0 })).toBe(0);
  });

  it('non inventa budget quando il cap è invalido', () => {
    expect(crawlerDirectFixBudget({ inFlightFixRuns: 0, openFixLabeled: 0, cap: Number.NaN })).toBe(0);
    expect(crawlerDirectFixBudget({ inFlightFixRuns: 0, openFixLabeled: 0, cap: -3 })).toBe(0);
  });

  it('N crawler in un solo sweep → al massimo 1 label diretta, gli altri in coda', () => {
    // Simulazione del 2026-08-08: 5 crawler nello stesso run.
    const budget = crawlerDirectFixBudget({ inFlightFixRuns: 0, openFixLabeled: 0 });
    let routedFix = 0;
    let queued = 0;
    for (let i = 0; i < 5; i++) {
      if (routedFix < budget) routedFix++;
      else queued++;
    }
    expect(routedFix).toBe(1);
    expect(queued).toBe(4); // prima erano 4 SFRATTATI, ora 4 in coda
  });
});
