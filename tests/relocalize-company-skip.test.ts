import { describe, it, expect } from 'vitest';
import {
  COMPANY_SKIP_RUNS,
  COMPANY_STERILE_RUNS,
  companySourceSignature,
  nextCompanySkipEntry,
  shouldSkipCompany,
} from '../scripts/relocalize-pending-jobs.mjs';

/**
 * Gate della regola di salto per azienda sterile
 * (valerielinc-ops/frontaliere-workspace#24).
 *
 * Il freno PER JOB (`MAX_RETRANSLATION_ATTEMPTS`) non scatta mai: il contatore
 * avanza solo se la ritraduzione ha CAMBIATO l'output, il ri-flag di un job
 * incompleto lo azzera, e il re-crawl riscrive lo slice da zero. Il contatore
 * per AZIENDA sopravvive a tutte e tre le vie perche' osserva il risultato di
 * una `runSharedCrawler` avvenuta davvero.
 *
 * Lo scenario canonico e' `marriott` nella serie di 10 artifact
 * `translation-thinking-ab` del 2026-09-05/07: `cleared == 0` su tre run
 * consecutive (33946200758, 33975963053, 34015450260) e poi 1 su ciascuna
 * delle due successive. Con N=2/K=3 va saltata e poi RIENTRA da sola — il
 * riarmo e' la meta' della regola che, se si rompe, tiene fuori per sempre
 * un'azienda riparabile.
 */

const SIG = companySourceSignature([{ slug: 'a', title: 'Receptionist' }]);

/** Una run del cascade: osserva `cleared` e restituisce il ledger aggiornato. */
function runCascade(
  ledger: Record<string, unknown>,
  runCounter: number,
  cleared: number,
  signature = SIG,
) {
  const skipped = shouldSkipCompany(ledger.marriott, runCounter, signature);
  if (skipped) return { skipped, ledger };
  const entry = nextCompanySkipEntry(ledger.marriott, {
    cleared,
    runCounter,
    signature,
  });
  const next = { ...ledger };
  if (entry) next.marriott = entry;
  else delete next.marriott;
  return { skipped, ledger: next };
}

describe('salto per azienda sterile — scenario marriott (N=2, K=3)', () => {
  it('salta dopo N run sterili e riarma da sola dopo K run', () => {
    let ledger: Record<string, unknown> = {};
    const seen: Array<{ run: number; skipped: boolean }> = [];

    // Run 1-2: cleared == 0, l'azienda gira comunque (sta accumulando).
    // Run 3-5: saltata. Run 6+: riarmata, torna a girare.
    for (let run = 1; run <= 7; run += 1) {
      const cleared = run <= 3 ? 0 : 1;
      const res = runCascade(ledger, run, cleared);
      ledger = res.ledger;
      seen.push({ run, skipped: res.skipped });
    }

    expect(seen.map((s) => s.skipped)).toEqual([
      false, // run 1 — prima riga sterile
      false, // run 2 — seconda riga sterile: arma il salto
      true, // run 3
      true, // run 4
      true, // run 5
      false, // run 6 — scadenza passata: RIENTRA
      false, // run 7
    ]);
  });

  it('una sola run produttiva azzera il contatore (non si arriva mai a N)', () => {
    let ledger: Record<string, unknown> = {};
    // 0, 0 arriverebbe a N: un 1 in mezzo deve resettare.
    for (const cleared of [0, 1, 0, 1, 0]) {
      const run = 1;
      const res = runCascade(ledger, run, cleared);
      expect(res.skipped).toBe(false);
      ledger = res.ledger;
    }
    expect(shouldSkipCompany(ledger.marriott, 99, SIG)).toBe(false);
  });

  it('un sorgente cambiato riarma SUBITO, senza aspettare K', () => {
    let ledger: Record<string, unknown> = {};
    ledger = runCascade(ledger, 1, 0).ledger;
    ledger = runCascade(ledger, 2, 0).ledger;
    // Stesso sorgente: saltata.
    expect(runCascade(ledger, 3, 0).skipped).toBe(true);
    // Nuovo testo da tradurre: l'osservazione «sterile» non vale piu'.
    const fresh = companySourceSignature([
      { slug: 'a', title: 'Receptionist' },
      { slug: 'b', title: 'Night Auditor' },
    ]);
    expect(fresh).not.toBe(SIG);
    expect(runCascade(ledger, 3, 0, fresh).skipped).toBe(false);
  });

  it('la firma sorgente non dipende dall’ordine dei job', () => {
    const a = companySourceSignature([
      { slug: 'a', title: 'Receptionist' },
      { slug: 'b', title: 'Night Auditor' },
    ]);
    const b = companySourceSignature([
      { slug: 'b', title: 'Night Auditor' },
      { slug: 'a', title: 'Receptionist' },
    ]);
    expect(a).toBe(b);
  });

  it('N e K restano quelli ratificati dalla simulazione', () => {
    // Cambiarli e' lecito, ma il valore atteso (23,9 min recuperati, 2 cleared
    // persi) e' misurato su questa coppia: va rimisurato, non ereditato.
    expect(COMPANY_STERILE_RUNS).toBe(2);
    expect(COMPANY_SKIP_RUNS).toBe(3);
  });
});
