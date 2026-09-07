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

  it('armare il salto azzera il contatore: dopo la scadenza servono N righe NUOVE', () => {
    // È LA convenzione che separa le due simulazioni della stessa regola
    // (17,8 min in workspace#27 contro 23,9 in workspace#24). Qui è fissata
    // sull'estremo conservativo: il contatore NON riprende da dove era
    // rimasto, così un'azienda riparabile non viene risaltata dopo una sola
    // riga sterile. Se qualcuno la cambia, questo test cade e il guadagno
    // atteso va rimisurato invece che ereditato.
    let ledger: Record<string, unknown> = {};
    ledger = runCascade(ledger, 1, 0).ledger; // sterile 1
    ledger = runCascade(ledger, 2, 0).ledger; // sterile 2 -> armato
    expect((ledger.marriott as { sterile: number }).sterile).toBe(0);

    // Run 3-5 saltate, run 6 rientra.
    for (const run of [3, 4, 5]) expect(runCascade(ledger, run, 0).skipped).toBe(true);
    const back = runCascade(ledger, 6, 0);
    expect(back.skipped).toBe(false);
    // Una SOLA riga sterile dopo il rientro non basta a risaltare.
    expect((back.ledger.marriott as { sterile: number }).sterile).toBe(1);
    expect(runCascade(back.ledger, 7, 0).skipped).toBe(false);
  });

  it('la firma non cambia quando cambia solo la finestra del cap', () => {
    // Il 🔴 di review #7901: se la firma si calcola sulla fetta capped invece
    // che sull'insieme pieno dei pending, cambia da sola fra due run —
    // `orderPendingByTraffic` riordina su job-popularity aggiornato ogni run e
    // i job liberati dalle ALTRE aziende fanno entrare in finestra job più in
    // basso. `sameSource` diventa false, `sterile` torna a 1 e il salto non si
    // arma mai: una quarta via di disarmo, silenziosa. Qui si pinna che la
    // firma dipende SOLO dall'insieme dei job dell'azienda.
    const full = [
      { slug: 'a', title: 'Receptionist' },
      { slug: 'b', title: 'Night Auditor' },
      { slug: 'c', title: 'Concierge' },
    ];
    // Stesso insieme, ordine diverso (il riordino per traffico): firma uguale.
    expect(companySourceSignature([full[2], full[0], full[1]])).toBe(
      companySourceSignature(full),
    );
    // Un sottoinsieme — cioè quel che vedrebbe la fetta capped — è una firma
    // DIVERSA: è proprio il motivo per cui non va usata come sorgente.
    expect(companySourceSignature(full.slice(0, 2))).not.toBe(
      companySourceSignature(full),
    );
  });

  it('N e K restano quelli ratificati dalla simulazione', () => {
    // Cambiarli e' lecito, ma il valore atteso (23,9 min recuperati, 2 cleared
    // persi) e' misurato su questa coppia: va rimisurato, non ereditato.
    expect(COMPANY_STERILE_RUNS).toBe(2);
    expect(COMPANY_SKIP_RUNS).toBe(3);
  });
});
