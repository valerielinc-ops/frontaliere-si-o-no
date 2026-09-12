/**
 * followup-drainer — un `fu-attempt` conta i tentativi FALLITI, e una run che
 * ha consegnato una PR poi mergiata non e' un tentativo fallito.
 *
 * Il RESCUE raggiunge il ramo eta'-tentativi per esclusione, e la premessa
 * scritta che rendeva corretto quel per-esclusione era «`pr-created` non arriva
 * qui: `hasFixPR` lo intercetta prima». `hasFixPR` interroga solo `--state open`
 * (e deve: con `--state all` una PR mergiata teneva la issue in-flight per
 * sempre, #1049/#1707/#1824), mentre la PR di un fix mergia in ~20-25 min contro
 * i 30 di `ORPHAN_MIN_AGE_MIN`. Quando il RESCUE guarda, la PR e' gia' mergiata
 * e invisibile: la run RIUSCITA si prende un `fu-attempt`, e al terzo giro la
 * issue viene dichiarata `fu-parked` — «tre volte tentata invano» — su un lavoro
 * che e' stato fatto tre volte davvero.
 *
 * Misurato sul sito il 2026-09-07, sulle 47 issue `fu-attempt:3` aperte (42
 * `fu-parked`): 28 hanno `pr-created` come ultimo verdetto e 30 hanno almeno una
 * PR reale su `fix/issue-N`; solo 11 non hanno alcun marker, il caso «run
 * davvero morta» per cui il contatore esiste. Caso di scuola #7769: tre run, tre
 * PR (#7862 #7877 #7881), e `fu-parked` + `fu-attempt:3`.
 *
 * La correzione e' il ramo `DELIVERED` gia' provato nel corpus (#733/#973),
 * portato qui verbatim perche' il file e' voce `identical` nel manifest del
 * ciclo e due implementazioni diverse dello stesso ramo sarebbero drift
 * permanente. Il ramo NON puo' leggersi sul solo marker: `outcome` e «nessuna PR
 * aperta» sono stati PERSISTENTI della issue, quindi va scopato alla run
 * corrente — promozione, poi marker, poi merge.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  isDeliveredThisRun,
  isConcurrentRepromotion,
  lastLabelEventAt,
  lastFixPromotion,
  latestFixOutcomeEntryFromComments,
  crawlerFixDecision,
  DELIVERED,
  NON_RETRYABLE,
  ZERO_WORK,
} from '../scripts/ci/followup-drainer.mjs';

const T = (min: number) => Date.UTC(2026, 8, 7, 0, min, 0);

describe('isDeliveredThisRun — la consegna va scopata alla run corrente', () => {
  it('promozione, poi marker, poi merge: e\' la consegna di QUESTA run', () => {
    expect(isDeliveredThisRun({ outcome: 'pr-created', promotedAt: T(0), outcomeAt: T(20), mergedAt: T(25) })).toBe(true);
  });

  it('marker STANTIO (del ciclo precedente): la run corrente e\' morta, il tentativo si consuma', () => {
    // Senza questa condizione un solo `pr-created` renderebbe gratuita ogni run
    // morta successiva e il contatore non salirebbe mai piu'.
    expect(isDeliveredThisRun({ outcome: 'pr-created', promotedAt: T(30), outcomeAt: T(20), mergedAt: T(40) })).toBe(false);
  });

  it('merge PRECEDENTE alla promozione: non e\' atterrato niente in questo ciclo', () => {
    expect(isDeliveredThisRun({ outcome: 'pr-created', promotedAt: T(30), outcomeAt: T(35), mergedAt: T(10) })).toBe(false);
  });

  it('nessun merge (PR chiusa senza merge, o mai mergiata): niente gratuita\'', () => {
    // `hasFixPR` non distingue il merge dalla chiusura senza merge: li' non e'
    // atterrato niente e la premessa del ramo e' falsa.
    expect(isDeliveredThisRun({ outcome: 'pr-created', promotedAt: T(0), outcomeAt: T(20), mergedAt: null })).toBe(false);
  });

  it('promozione illeggibile (glitch gh → null): fail-CLOSED sul ramo bounded', () => {
    expect(isDeliveredThisRun({ outcome: 'pr-created', promotedAt: null, outcomeAt: T(20), mergedAt: T(25) })).toBe(false);
  });

  it('solo `pr-created` apre il ramo: nessun altro verdetto prova una consegna', () => {
    for (const outcome of [...NON_RETRYABLE, ...ZERO_WORK, 'max-turns', 'overlap-skip', 'pr-already-open']) {
      expect(isDeliveredThisRun({ outcome, promotedAt: T(0), outcomeAt: T(20), mergedAt: T(25) })).toBe(false);
    }
    expect(isDeliveredThisRun({ outcome: null, promotedAt: T(0), outcomeAt: T(20), mergedAt: T(25) })).toBe(false);
    expect(DELIVERED.has('pr-created')).toBe(true);
  });

  it('argomento assente non rompe il predicato', () => {
    expect(isDeliveredThisRun()).toBe(false);
    expect(isDeliveredThisRun({} as never)).toBe(false);
  });
});

describe('lastFixPromotion — quando comincia la run corrente, e chi l\'ha promossa', () => {
  const ev = (event: string, name: string, min: number) => ({ event, label: { name }, created_at: new Date(T(min)).toISOString() });

  it('l\'ultima `agent:fix` vince, non la prima', () => {
    const events = [ev('labeled', 'agent:fix', 5), ev('labeled', 'agent:fix', 60)];
    expect(lastFixPromotion(events).at).toBe(T(60));
    expect(lastLabelEventAt(events, 'agent:fix')).toBe(T(60));
  });

  it('la firma del drainer e\' la coppia ravvicinata add `agent:fix` + remove `agent:fix-queued`', () => {
    const events = [ev('labeled', 'agent:fix', 60), ev('unlabeled', 'agent:fix-queued', 60)];
    expect(lastFixPromotion(events).byDrainer).toBe(true);
  });

  it('promozione di un writer concorrente: nessuna coppia, quindi non e\' del drainer', () => {
    // triage-sweep e recycle-stale-prs scrivono `agent:fix` senza avere
    // `agent:fix-queued` da togliere.
    expect(lastFixPromotion([ev('labeled', 'agent:fix', 60)]).byDrainer).toBe(false);
  });

  it('nessuna promozione in timeline → `at` null (fail-closed a valle)', () => {
    expect(lastFixPromotion([ev('labeled', 'follow-up', 5)]).at).toBeNull();
    expect(lastLabelEventAt([], 'agent:fix')).toBeNull();
  });
});

describe('isConcurrentRepromotion — la consegna reale letta come run morta va vista, non subita', () => {
  const promo = (at: number | null, byDrainer: boolean) => ({ at, byDrainer });

  it('consegna + merge PRIMA di una promozione NON del drainer: e\' l\'anomalia', () => {
    expect(isConcurrentRepromotion({
      outcome: 'pr-created', outcomeAt: T(10), mergedAt: T(15), promotion: promo(T(30), false),
    })).toBe(true);
  });

  it('stessa forma ma promozione DEL drainer: e\' il ciclo normale, non un\'anomalia', () => {
    expect(isConcurrentRepromotion({
      outcome: 'pr-created', outcomeAt: T(10), mergedAt: T(15), promotion: promo(T(30), true),
    })).toBe(false);
  });

  it('marker e merge DOPO la promozione: e\' una consegna corrente, la gestisce isDeliveredThisRun', () => {
    expect(isConcurrentRepromotion({
      outcome: 'pr-created', outcomeAt: T(40), mergedAt: T(45), promotion: promo(T(30), false),
    })).toBe(false);
  });
});

describe('latestFixOutcomeEntryFromComments — il verdetto porta il suo timestamp', () => {
  it('rende codice e istante dell\'ultimo marker autentico', () => {
    const e = latestFixOutcomeEntryFromComments([
      { body: '<!-- FIX_OUTCOME: no-root-cause -->', createdAt: new Date(T(5)).toISOString() },
      { body: '<!-- FIX_OUTCOME: pr-created -->', createdAt: new Date(T(20)).toISOString() },
    ]);
    expect(e).toEqual({ outcome: 'pr-created', at: T(20) });
  });

  it('senza marker: entrambi null, cioe\' il caso run-davvero-morta', () => {
    expect(latestFixOutcomeEntryFromComments([{ body: 'testo', createdAt: new Date(T(1)).toISOString() }]))
      .toEqual({ outcome: null, at: null });
  });
});

describe('crawlerFixDecision — stesso ramo nel gemello crawler (AGENTS.md #6, la classe non il file)', () => {
  const old = 40; // > ORPHAN_MIN_AGE_MIN: quando il RESCUE guarda, la PR e' gia' mergiata

  it('consegna di questa run: ri-arma senza consumare il tentativo', () => {
    const d = crawlerFixDecision({
      outcome: 'pr-created', promotedAt: T(0), outcomeAt: T(20), mergedAt: T(25),
      ageMin: old, attempt: 0, hasPR: false,
    });
    expect(d.action).toBe('requeue-delivered');
    expect(d.nextAttempt).toBe(0);
  });

  it('marker stantio: torna a essere un tentativo consumato, e il park resta raggiungibile', () => {
    // Critico per i crawler: non passano ne' dal parked-retry ne' dall'age-out,
    // quindi `park-attempts` e' la loro UNICA uscita.
    const d = crawlerFixDecision({
      outcome: 'pr-created', promotedAt: T(30), outcomeAt: T(10), mergedAt: T(15),
      ageMin: old, attempt: 2, hasPR: false,
    });
    expect(d.action).toBe('park-attempts');
    expect(d.nextAttempt).toBe(3);
  });

  it('run davvero morta senza verdetto: il ramo eta\'-tentativi resta intatto', () => {
    const d = crawlerFixDecision({ outcome: null, ageMin: old, attempt: 0, hasPR: false });
    expect(d.action).toBe('requeue');
    expect(d.nextAttempt).toBe(1);
  });

  it('PR ancora APERTA: prevale lo skip, il ramo consegnato non lo scavalca', () => {
    const d = crawlerFixDecision({
      outcome: 'pr-created', promotedAt: T(0), outcomeAt: T(20), mergedAt: T(25),
      ageMin: old, attempt: 0, hasPR: true,
    });
    expect(d.action).toBe('skip');
  });

  it('`already-fixed` continua a parcheggiare: e\' cio\' che limita il ciclo delle aggregate', () => {
    const d = crawlerFixDecision({
      outcome: 'already-fixed', promotedAt: T(0), outcomeAt: T(20), mergedAt: T(25),
      ageMin: old, attempt: 0, hasPR: false,
    });
    expect(d.action).toBe('park-verdict');
  });
});

/**
 * Guardie STRUTTURALI, gemelle di quelle del corpus. I casi sopra provano che i
 * predicati sono giusti; queste provano che il ramo resta CABLATO dove serve.
 * Un ramo `DELIVERED` scollegato dal gate, o la vecchia premessa rimessa in un
 * commento, riaprirebbero il buco senza rompere un solo test di comportamento.
 */
describe('il cablaggio del ramo DELIVERED non si scollega in silenzio', () => {
  const src = readFileSync(new URL('../scripts/ci/followup-drainer.mjs', import.meta.url), 'utf8');

  it('la premessa falsificata non sopravvive alla sua falsificazione', () => {
    // «`pr-created` non arriva qui: `hasFixPR` lo intercetta prima» è falsa
    // appena la PR viene mergiata: chi la riscrive riapre il difetto.
    expect(src).not.toMatch(/`pr-created` non arriva qui/);
  });

  it('il rescue queue-managed ha il ramo, ed è qualificato da isDeliveredThisRun', () => {
    const stuck = src.slice(src.indexOf('for (const iss of stuckFix) {'));
    const branch = /if \(outcome && DELIVERED\.has\(outcome\)\) \{([\s\S]*?)\n {4}\}/.exec(stuck);
    expect(branch, 'il rescue queue-managed deve avere il ramo DELIVERED').toBeTruthy();
    // Il re-queue gratuito deve passare dal gate sulla run corrente, e le due
    // letture devono venire dal merge REALE e dalla promozione — non
    // dall'assenza di PR aperte, che è ciò che sbagliava.
    expect(branch![1]).toMatch(/isDeliveredThisRun\(\{/);
    expect(branch![1]).toMatch(/mergedAt = mergedFixPrAt\(/);
    expect(branch![1]).toMatch(/promotedAt: promotion\.at/);
  });

  it('il rescue queue-managed scarta i marker della promozione precedente', () => {
    const start = src.indexOf('for (const iss of stuckFix) {');
    const end = src.indexOf('for (const iss of crawlerFix) {', start);
    const queue = src.slice(start, end);
    expect(queue).toMatch(/const rawOutcome = outcomeEntry\.outcome/);
    expect(queue).toMatch(/const promotion = !hasPR && rawOutcome !== null/);
    expect(queue).toMatch(/const outcome = outcomeForCurrentPromotion\(\{/);
    expect(queue).toMatch(/promotedAt: promotion\.at/);
  });

  it('il gemello crawler riceve le stesse tre letture, o il buco si riapre da quel lato', () => {
    const crawler = src.slice(src.indexOf('for (const iss of crawlerFix) {'));
    expect(crawler).toMatch(/outcomeAt: entry\.at/);
    expect(crawler).toMatch(/mergedAt = delivered \? mergedFixPrAt\(/);
    expect(crawler).toMatch(/promotedAt: promotion\.at/);
  });
});

describe('il checkpoint WIP parcheggiato viene salvato prima dell age-out', () => {
  const src = readFileSync(new URL('../scripts/ci/followup-drainer.mjs', import.meta.url), 'utf8');

  it('ri-accoda i parked con branch live e difende anche la chiusura', () => {
    const run = src.slice(src.indexOf('export function runDrain()'));
    const ageOutAt = run.indexOf('// --- AGE-OUT CLOSE:');
    expect(ageOutAt).toBeGreaterThanOrEqual(0);
    const preAgeOut = run.slice(0, ageOutAt);
    expect(preAgeOut).toMatch(/const parkedForWip = listIssues\(LBL_PARKED\)/);
    expect(preAgeOut).toMatch(/const recoverable = recoverableFixBranch\(iss\.number\)/);
    expect(preAgeOut).toMatch(/RE-QUEUE PARKED-WIP/);
    expect(preAgeOut).toMatch(/add = \[LBL_QUEUED/);
    expect(preAgeOut).toMatch(/remove = \[LBL_PARKED, 'needs-human'/);

    const parentAt = run.indexOf('// --- PARENT-CLOSE:');
    const ageOut = run.slice(ageOutAt, parentAt);
    expect(ageOut).toMatch(/const liveWip = recoverableFixBranch\(iss\.number\)/);
    expect(ageOut).toMatch(/AGE-OUT skip #\$\{iss\.number\}: checkpoint WIP live/);
  });
});
