/**
 * latestCompletedVitestConclusion — selezione robusta del verdetto vitest
 * sull'HEAD usata dal gate auto-merge (auto-merge-eval.mjs) e da pr-autorebase.
 *
 * Regressione #2394: un SHA immutabile può portare PIÙ check-run con lo stesso
 * nome `vitest (unit + integration)` (run `pull_request` + workflow_dispatch
 * manuali di tests.yml). Il vecchio `[...][0].conclusion` ne pescava uno per
 * ordine API: un dispatch cancellato (→ `failure`) poteva mascherare il
 * `success` reale → auto-merge bloccato pur coi test verdi. Qui fissiamo che
 * vince l'ultimo COMPLETATO per `completed_at`, ignorando i run in-progress.
 */
import { describe, it, expect } from 'vitest';
import {
  latestCompletedVitestConclusion,
  vitestFailureIsTransientCancellation,
} from '../scripts/ci/lib/vitestCheck.mjs';
import { VITEST_CHECK_NAME } from '../scripts/ci/lib/constants.mjs';

const vitest = (conclusion: string | null, completed_at: string | null, status = 'completed') => ({
  name: VITEST_CHECK_NAME,
  status,
  conclusion,
  completed_at,
});

describe('latestCompletedVitestConclusion (#2394 stale-check-run guard)', () => {
  it('scenario #2394: dispatch cancellato (failure, più vecchio) + success (più recente) → success', () => {
    const runs = [
      vitest('failure', '2026-06-17T07:59:55Z'), // workflow_dispatch cancellato
      vitest('success', '2026-06-17T08:07:03Z'), // pull_request verde, più recente
    ];
    expect(latestCompletedVitestConclusion(runs)).toBe('success');
  });

  it('ordine API inverso non cambia il verdetto (invariante all’ordine)', () => {
    const runs = [
      vitest('success', '2026-06-17T08:07:03Z'),
      vitest('failure', '2026-06-17T07:59:55Z'),
    ];
    expect(latestCompletedVitestConclusion(runs)).toBe('success');
  });

  it('regressione reale: success (vecchio) + failure (più recente) → failure (blocca)', () => {
    const runs = [
      vitest('success', '2026-06-17T08:00:00Z'),
      vitest('failure', '2026-06-17T08:30:00Z'),
    ];
    expect(latestCompletedVitestConclusion(runs)).toBe('failure');
  });

  it('un run in-progress (senza completed_at) NON blocca: vince l’ultimo completato', () => {
    const runs = [
      vitest('success', '2026-06-17T08:07:03Z'),
      vitest(null, null, 'in_progress'), // dispatch manuale appeso
    ];
    expect(latestCompletedVitestConclusion(runs)).toBe('success');
  });

  it('nessun vitest concluso (solo pending) → "" (gate attende, invariante #1454)', () => {
    expect(latestCompletedVitestConclusion([vitest(null, null, 'queued')])).toBe('');
  });

  it('nessun check-run vitest presente → ""', () => {
    const runs = [{ name: 'lighthouse', status: 'completed', conclusion: 'success', completed_at: '2026-06-17T08:00:00Z' }];
    expect(latestCompletedVitestConclusion(runs)).toBe('');
  });

  it('ignora check-run con altro nome anche se più recenti', () => {
    const runs = [
      vitest('success', '2026-06-17T08:00:00Z'),
      { name: 'build', status: 'completed', conclusion: 'failure', completed_at: '2026-06-17T09:00:00Z' },
    ];
    expect(latestCompletedVitestConclusion(runs)).toBe('success');
  });

  it('input non-array → "" (difensivo, niente throw)', () => {
    expect(latestCompletedVitestConclusion(undefined as unknown as [])).toBe('');
    expect(latestCompletedVitestConclusion(null as unknown as [])).toBe('');
  });
});

/**
 * vitestFailureIsTransientCancellation (#2438): l'aggregatore `vitest (unit +
 * integration)` collassa OGNI shard non-`success` (incluso `cancelled` da
 * concurrency) in un unico `failure`. Il helper riapre gli shard per distinguere
 * una cancellazione transient (sicura da ri-dispatchare / heal) da un test rotto
 * reale (NON ri-eseguire). Una PR LGTM+behind=0 con questo `failure` transient
 * altrimenti resta ferma: pr-autorebase la skippava, auto-merge esige `success`.
 */
const agg = (conclusion: string | null, completed_at: string | null, status = 'completed') => ({
  name: VITEST_CHECK_NAME,
  status,
  conclusion,
  completed_at,
});
const shard = (n: number, conclusion: string | null, status = 'completed') => ({
  name: `vitest shard ${n}/4`,
  status,
  conclusion,
  completed_at: status === 'completed' ? '2026-06-17T08:00:00Z' : null,
});
const cancelledRun = [
  agg('failure', '2026-06-17T08:05:00Z'),
  shard(1, 'cancelled'),
  shard(2, 'cancelled'),
  shard(3, 'success'),
  shard(4, 'cancelled'),
];

describe('vitestFailureIsTransientCancellation (#2438 cancelled→failure heal)', () => {
  it('aggregatore failure + shard cancelled (nessun fail reale) → true (heal)', () => {
    expect(vitestFailureIsTransientCancellation(cancelledRun)).toBe(true);
  });

  it('tutti gli shard cancellati → true', () => {
    expect(
      vitestFailureIsTransientCancellation([
        agg('failure', '2026-06-17T08:05:00Z'),
        shard(1, 'cancelled'),
        shard(2, 'cancelled'),
        shard(3, 'cancelled'),
        shard(4, 'cancelled'),
      ]),
    ).toBe(true);
  });

  it('un shard FAILURE reale (+ altri cancelled) → false (NON ri-eseguire, AGENTS #5)', () => {
    expect(
      vitestFailureIsTransientCancellation([
        agg('failure', '2026-06-17T08:05:00Z'),
        shard(1, 'failure'),
        shard(2, 'cancelled'),
        shard(3, 'success'),
        shard(4, 'cancelled'),
      ]),
    ).toBe(false);
  });

  it('uno shard timed_out → false (fail reale, non transient)', () => {
    expect(
      vitestFailureIsTransientCancellation([
        agg('failure', '2026-06-17T08:05:00Z'),
        shard(1, 'timed_out'),
        shard(2, 'cancelled'),
        shard(3, 'cancelled'),
        shard(4, 'cancelled'),
      ]),
    ).toBe(false);
  });

  it('nessuno shard cancelled (failure aggregato senza cancellazioni) → false', () => {
    // Difensivo: aggregatore failure ma shard tutti success (es. aggregatore
    // rosso per ragione propria) → niente cancellazione da sanare.
    expect(
      vitestFailureIsTransientCancellation([
        agg('failure', '2026-06-17T08:05:00Z'),
        shard(1, 'success'),
        shard(2, 'success'),
        shard(3, 'success'),
        shard(4, 'success'),
      ]),
    ).toBe(false);
  });

  it('run fresco pendente (shard in_progress) → false (attende, non ri-dispatcha)', () => {
    expect(
      vitestFailureIsTransientCancellation([
        ...cancelledRun,
        shard(1, null, 'in_progress'),
      ]),
    ).toBe(false);
  });

  it('aggregatore in_progress sopra agli shard cancellati → false (run fresco pendente)', () => {
    expect(
      vitestFailureIsTransientCancellation([
        ...cancelledRun,
        agg(null, null, 'queued'),
      ]),
    ).toBe(false);
  });

  it('ultimo aggregatore COMPLETATO è success (run fresco già verde) → false', () => {
    expect(
      vitestFailureIsTransientCancellation([
        ...cancelledRun,
        agg('success', '2026-06-17T08:20:00Z'),
        shard(1, 'success'),
        shard(2, 'success'),
        shard(3, 'success'),
        shard(4, 'success'),
      ]),
    ).toBe(false);
  });

  it('aggregatore failure ma NESSUN check-run shard presente → false', () => {
    expect(
      vitestFailureIsTransientCancellation([agg('failure', '2026-06-17T08:05:00Z')]),
    ).toBe(false);
  });

  it('nessun check-run vitest del tutto → false', () => {
    expect(
      vitestFailureIsTransientCancellation([
        { name: 'lighthouse', status: 'completed', conclusion: 'success', completed_at: '2026-06-17T08:00:00Z' },
      ]),
    ).toBe(false);
  });

  it('input non-array → false (difensivo, niente throw)', () => {
    expect(vitestFailureIsTransientCancellation(undefined as unknown as [])).toBe(false);
    expect(vitestFailureIsTransientCancellation(null as unknown as [])).toBe(false);
  });
});
