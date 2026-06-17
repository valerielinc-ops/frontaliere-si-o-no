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
import { latestCompletedVitestConclusion } from '../scripts/ci/lib/vitestCheck.mjs';
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
