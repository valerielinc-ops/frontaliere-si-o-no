/**
 * followup-drainer — rescue delle issue CRAWLER (#5514).
 *
 * I crawler sono l'unica categoria `route='fix'` (agent:fix diretto) e per ciò
 * stesso l'unica esclusa dal rescue orfani (`isQueueManaged`). Il ramo dedicato
 * che esisteva prima copriva SOLO `outcome === 'max-turns'` e faceva `continue`
 * su tutto il resto — quindi anche sul caso più frequente: la run CANCELLATA
 * dalla coda concurrency di issue-fix (profondità 1, ogni nuova pending sfratta
 * la precedente), che non lascia nessun marker FIX_OUTCOME. Risultato misurato
 * il 2026-08-10: #5392 #5393 #5394 #5395 ferme da due giorni con `agent:fix`
 * addosso, mai lavorate, invisibili a ogni strato di recupero.
 *
 * Questi test fissano il contratto di `crawlerFixDecision`:
 *   - nessun verdetto + vecchia  → RI-ARMA (la run non ha prodotto alcun
 *     verdetto: non c'è niente da cui dedurre che il fix sia impossibile);
 *   - `max-turns`                → PARK (comportamento pre-esistente, non regredito);
 *   - oltre il tetto di tentativi → PARK con `needs-human` (bound del ri-arma).
 */

import { describe, it, expect } from 'vitest';
import {
  crawlerFixDecision,
  CRAWLER_MAX_ATTEMPTS,
} from '../scripts/ci/followup-drainer.mjs';

// Una issue crawler "vecchia" secondo ORPHAN_MIN_AGE_MIN (30min) di default.
const OLD = 45;

describe('crawlerFixDecision — run cancellata dalla coda (nessun verdetto)', () => {
  it('RI-ARMA una crawler vecchia senza PR e senza marker, consumando un tentativo', () => {
    const d = crawlerFixDecision({ outcome: null, ageMin: OLD, attempt: 0 });
    expect(d.action).toBe('requeue');
    expect(d.nextAttempt).toBe(1);
    // La ragione deve nominare il caso reale: è la stringa che finisce nei log
    // del drainer, e senza di essa il difetto torna invisibile.
    expect(d.reason).toMatch(/nessun verdetto/i);
  });

  it('continua a ri-armare finché resta sotto il tetto', () => {
    const d = crawlerFixDecision({ outcome: null, ageMin: OLD, attempt: 1 });
    expect(d.action).toBe('requeue');
    expect(d.nextAttempt).toBe(2);
  });

  it('NON tocca una crawler troppo giovane (run può non essersi ancora registrata)', () => {
    // Oltre la finestra di settling ma sotto ORPHAN_MIN_AGE_MIN → si aspetta.
    expect(crawlerFixDecision({ outcome: null, ageMin: 10, attempt: 0 }).action).toBe('skip');
  });

  it('conta come "settling" una promozione freschissima → il drain rinvia di un tick', () => {
    // Era il secondo buco dello stesso incidente: i crawler non entravano in
    // `settlingPromotions`, quindi il DRAIN poteva promuovere un SECONDO
    // candidato mentre la run del crawler non era ancora visibile → due pending
    // → sfratto. La sesta run cancellata del 2026-08-08 non era un crawler.
    expect(crawlerFixDecision({ outcome: null, ageMin: 1, attempt: 0 }).action).toBe('settling');
  });

  it('NON tocca una crawler che ha già prodotto una PR fix', () => {
    expect(crawlerFixDecision({ outcome: null, ageMin: OLD, attempt: 0, hasPR: true }).action).toBe('skip');
  });
});

describe('crawlerFixDecision — max-turns agisce SUBITO (nessuna regressione)', () => {
  it('parka al primo max-turns, senza aspettare la soglia orfano', () => {
    // Un marker FIX_OUTCOME prova che la run è TERMINATA: qui la guardia d'età
    // non serve, e agire subito preserva il timing del park che c'era prima.
    const fresh = crawlerFixDecision({ outcome: 'max-turns', ageMin: 0.5, attempt: 0 });
    expect(fresh.action).toBe('park-max-turns');
    const old = crawlerFixDecision({ outcome: 'max-turns', ageMin: OLD, attempt: 2 });
    expect(old.action).toBe('park-max-turns');
    // Il park per verdetto non consuma un tentativo.
    expect(old.nextAttempt).toBe(2);
  });

  it('#7280: eleggibile allo scorporo → decompose, non park', () => {
    // L'invariante di questo blocco è «max-turns non si ri-accoda tal quale»,
    // e regge: `decompose` non è un re-arm, è lo stadio che riscrive l'input.
    // Il park incondizionato era invece un'ASIMMETRIA col gemello di questo
    // stesso file: la path queue-managed manda `outcome === 'max-turns'` alla
    // DECOMPOSE-ROUTE, i crawler no — e `needs-human` non ha altra uscita che
    // lo sweep settimanale (7 delle 28 misurate il 2026-09-04).
    const d = crawlerFixDecision({ outcome: 'max-turns', ageMin: 0.5, attempt: 1, decomposeEligible: true });
    expect(d.action).toBe('decompose');
    expect(d.nextAttempt).toBe(1); // nessun tentativo consumato
    // Il default resta il park: chi non passa il flag non cambia comportamento.
    expect(crawlerFixDecision({ outcome: 'max-turns', ageMin: OLD, attempt: 0 }).action).toBe('park-max-turns');
    // E un verdetto FERMO non diventa uno scorporo per il solo fatto di essere
    // eleggibile: è fermo, non troppo grande.
    for (const outcome of ['no-root-cause', 'already-fixed']) {
      expect(crawlerFixDecision({ outcome, ageMin: OLD, attempt: 0, decomposeEligible: true }).action, outcome).toBe('park-verdict');
    }
  });

  it('parka anche i verdetti non-ri-tentabili (abort pulita del fixer)', () => {
    for (const outcome of ['no-root-cause', 'blocked-admin-settings', 'already-fixed']) {
      expect(crawlerFixDecision({ outcome, ageMin: OLD, attempt: 0 }).action).toBe('park-verdict');
    }
  });
});

describe('crawlerFixDecision — il bound del ri-arma', () => {
  it(`parka con needs-human all'ultimo tentativo (tetto ${CRAWLER_MAX_ATTEMPTS})`, () => {
    const d = crawlerFixDecision({ outcome: null, ageMin: OLD, attempt: CRAWLER_MAX_ATTEMPTS - 1 });
    expect(d.action).toBe('park-attempts');
    expect(d.nextAttempt).toBe(CRAWLER_MAX_ATTEMPTS);
    expect(d.reason).toMatch(new RegExp(`${CRAWLER_MAX_ATTEMPTS}/${CRAWLER_MAX_ATTEMPTS}`));
  });

  it('resta parkata oltre il tetto (nessun ri-arma infinito)', () => {
    expect(crawlerFixDecision({ outcome: null, ageMin: OLD, attempt: 99 }).action).toBe('park-attempts');
  });

  it('il tetto è 3: le label fu-attempt:N esistono solo per N∈{1,2,3}', () => {
    // Non è un numero arbitrario: `gh issue edit --add-label` fallisce su una
    // label inesistente, quindi un tetto più alto sarebbe rotto in produzione.
    expect(CRAWLER_MAX_ATTEMPTS).toBe(3);
  });

  it('un tetto custom è rispettato (override via env in debug)', () => {
    const d = crawlerFixDecision({ outcome: null, ageMin: OLD, attempt: 0, maxAttempts: 1 });
    expect(d.action).toBe('park-attempts');
  });
});

describe('crawlerFixDecision — quota esaurita: nessun tentativo consumato', () => {
  it('HOLD finché la finestra 429 è aperta (la issue resta il beacon)', () => {
    const d = crawlerFixDecision({ outcome: 'rate-limited', ageMin: OLD, attempt: 1, quotaBackoffActive: true });
    expect(d.action).toBe('hold-quota');
    expect(d.nextAttempt).toBe(1); // invariato
  });

  it('ri-accoda a finestra chiusa SENZA consumare un tentativo', () => {
    // La run è morta prima di leggere la issue (0 turni, $0): la issue è
    // intatta, un tentativo si consuma quando l'agent PROVA.
    const d = crawlerFixDecision({ outcome: 'rate-limited', ageMin: OLD, attempt: 2, quotaBackoffActive: false });
    expect(d.action).toBe('requeue-zero-work');
    expect(d.nextAttempt).toBe(2); // invariato: NON porta al park
  });
});

describe('crawlerFixDecision — esiti transienti', () => {
  it('tratta overlap-skip / pr-already-open come ri-tentabili (la PR bloccante può mergiare)', () => {
    for (const outcome of ['overlap-skip', 'pr-already-open']) {
      const d = crawlerFixDecision({ outcome, ageMin: OLD, attempt: 0 });
      expect(d.action).toBe('requeue');
      expect(d.nextAttempt).toBe(1);
    }
  });
});
