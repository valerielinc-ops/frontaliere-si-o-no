/**
 * followup-drainer — un `fu-attempt` conta i tentativi FALLITI, e una run che
 * ha consegnato una PR non è un tentativo fallito.
 *
 * Regressione misurata il 2026-09-07 sul sito. Il RESCUE arriva al ramo
 * età-tentativi per esclusione, e la premessa scritta che rendeva corretto quel
 * per-esclusione era «`pr-created` non arriva qui: `hasFixPR` lo intercetta
 * prima». `hasFixPR` interroga solo `--state open` (e deve: con `--state all`
 * una PR mergiata teneva la issue in-flight per sempre, #1049/#1707/#1824),
 * mentre la PR di un fix mergia in ~20-25 min contro i 30 di
 * `ORPHAN_MIN_AGE_MIN`. Quando il RESCUE guarda, la PR è già mergiata e
 * invisibile: la run RIUSCITA si prende un `fu-attempt`, e al terzo giro la
 * issue viene dichiarata `fu-parked` — «tre volte tentata invano» — su un
 * lavoro che è stato fatto tre volte davvero.
 *
 * Sulle 47 issue `fu-attempt:3` aperte: 28 hanno `pr-created` come ultimo
 * verdetto, 30 hanno almeno una PR reale su `fix/issue-N`, solo 11 non hanno
 * alcun marker (il caso «run davvero morta» per cui il contatore esiste).
 * Caso di scuola #7769: tre run, tre PR (#7862 #7877 #7881), `fu-parked` +
 * `fu-attempt:3`.
 */

import { describe, it, expect } from 'vitest';
import { deliveredThisAttempt, crawlerFixDecision, NON_RETRYABLE, ZERO_WORK } from '../scripts/ci/followup-drainer.mjs';

describe('deliveredThisAttempt — una run che consegna non consuma un tentativo', () => {
  it('#7769: primo giro, una PR prodotta, zero tentativi addebitati → passaggio libero', () => {
    expect(deliveredThisAttempt({ outcome: 'pr-created', prCountEver: 1, attempt: 0 })).toBe(true);
  });

  it('secondo e terzo giro dell\'aggregata: ogni giro aggiunge una PR sua → sempre libero', () => {
    expect(deliveredThisAttempt({ outcome: 'pr-created', prCountEver: 2, attempt: 1 })).toBe(true);
    expect(deliveredThisAttempt({ outcome: 'pr-created', prCountEver: 3, attempt: 2 })).toBe(true);
  });

  it('lo STESSO commento riletto al tick dopo NON regala un secondo passaggio', () => {
    // `latestFixOutcome` rilegge lo stesso `pr-created` a ogni tick: senza il
    // confronto col contatore, una sola PR terrebbe la issue in re-queue
    // gratuito per sempre. Il passaggio libero costa una PR NUOVA.
    expect(deliveredThisAttempt({ outcome: 'pr-created', prCountEver: 1, attempt: 1 })).toBe(false);
    expect(deliveredThisAttempt({ outcome: 'pr-created', prCountEver: 2, attempt: 3 })).toBe(false);
  });

  it('nessuna PR mai prodotta → è una run morta, il tentativo si addebita', () => {
    expect(deliveredThisAttempt({ outcome: 'pr-created', prCountEver: 0, attempt: 0 })).toBe(false);
  });

  it('errore gh (`fixPRCountEver` → 0) addebita il tentativo: un glitch di rete non regala passaggi', () => {
    expect(deliveredThisAttempt({ outcome: 'pr-created', prCountEver: 0, attempt: 2 })).toBe(false);
  });

  it('run senza verdetto (crash / max-turns): resta il caso per cui il contatore esiste', () => {
    expect(deliveredThisAttempt({ outcome: null, prCountEver: 5, attempt: 0 })).toBe(false);
    expect(deliveredThisAttempt({ outcome: 'max-turns', prCountEver: 5, attempt: 0 })).toBe(false);
  });

  it('nessun altro verdetto passa: solo `pr-created` prova che è stata consegnata una PR', () => {
    for (const outcome of [...NON_RETRYABLE, ...ZERO_WORK, 'overlap-skip', 'pr-already-open']) {
      expect(deliveredThisAttempt({ outcome, prCountEver: 9, attempt: 0 })).toBe(false);
    }
  });

  it('valori non finiti non aprono il ramo (nessun NaN che disarma il contatore)', () => {
    expect(deliveredThisAttempt({ outcome: 'pr-created', prCountEver: NaN, attempt: 0 })).toBe(false);
    expect(deliveredThisAttempt({ outcome: 'pr-created', prCountEver: 2, attempt: NaN })).toBe(true);
  });
});

describe('crawlerFixDecision — stesso difetto nel gemello crawler (AGENTS.md #6, classe non file)', () => {
  const old = 40; // > ORPHAN_MIN_AGE_MIN: la PR e' gia' mergiata quando il RESCUE guarda

  it('PR consegnata e mergiata: ri-accoda senza consumare il tentativo', () => {
    const d = crawlerFixDecision({ outcome: 'pr-created', prCountEver: 1, attempt: 0, hasPR: false, ageMin: old });
    expect(d.action).toBe('requeue-delivered');
    expect(d.nextAttempt).toBe(0);
  });

  it('non degenera in park: tre giri, tre PR, contatore fermo a zero', () => {
    for (const [prCountEver, attempt] of [[1, 0], [2, 0], [3, 0]] as const) {
      const d = crawlerFixDecision({ outcome: 'pr-created', prCountEver, attempt, hasPR: false, ageMin: old });
      expect(d.action).toBe('requeue-delivered');
      expect(d.nextAttempt).toBe(0);
    }
  });

  it('stesso marker riletto senza una PR nuova: torna a essere un tentativo consumato', () => {
    const d = crawlerFixDecision({ outcome: 'pr-created', prCountEver: 1, attempt: 1, hasPR: false, ageMin: old });
    expect(d.action).toBe('requeue');
    expect(d.nextAttempt).toBe(2);
  });

  it('run davvero morta (nessun verdetto): il ramo eta\'-tentativi resta intatto', () => {
    const d = crawlerFixDecision({ outcome: null, prCountEver: 0, attempt: 0, hasPR: false, ageMin: old });
    expect(d.action).toBe('requeue');
    expect(d.nextAttempt).toBe(1);
  });

  it('PR ancora APERTA: prevale lo skip, il ramo consegnato non lo scavalca', () => {
    const d = crawlerFixDecision({ outcome: 'pr-created', prCountEver: 1, attempt: 0, hasPR: true, ageMin: old });
    expect(d.action).toBe('skip');
  });

  it('i verdetti fermi restano park: `already-fixed` chiude il ciclo delle aggregate', () => {
    const d = crawlerFixDecision({ outcome: 'already-fixed', prCountEver: 3, attempt: 0, hasPR: false, ageMin: old });
    expect(d.action).toBe('park-verdict');
  });
});
