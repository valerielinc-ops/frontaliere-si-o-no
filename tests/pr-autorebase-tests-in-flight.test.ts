/**
 * testsRunInFlightOnHead — guardia di pr-autorebase contro il LIVELOCK misurato
 * il 2026-08-18 sulla PR #6037 (branch `fix/unsub-window-and-channel`): la suite
 * `tests` dura 16-21 min, l'autorebase scatta a ogni merge su main (pochi minuti
 * l'uno dall'altro) e ogni push cancella il `tests` in corso
 * (`19:09 cancelled · 19:11 · 19:25 · 19:25 · 19:33`, mai un `success`).
 * `pr-review-loop` parte SOLO su `workflow_run[tests].conclusion == 'success'`
 * → niente review → la PR resta `stale-review` → l'autorebase ricomincia.
 *
 * Invariante testata: si salta il rebase SOLO se il run in volo è sulla head
 * ATTUALE. Un run in volo su una head VECCHIA non produrrà mai il segnale che
 * serve, quindi deferire per lui sarebbe uno stallo gratuito.
 */
import { describe, it, expect } from 'vitest';
import { testsRunInFlightOnHead } from '../scripts/ci/pr-autorebase.mjs';

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);

describe('testsRunInFlightOnHead (#6037 autorebase↔tests livelock guard)', () => {
  it('REGRESSIONE #6037: run in_progress sulla head ATTUALE → blocca (il push lo cancellerebbe)', () => {
    const r = testsRunInFlightOnHead({
      runs: [{ id: 111, status: 'in_progress', head_sha: HEAD }],
      head: HEAD,
    });
    expect(r).not.toBeNull();
    expect(r!.id).toBe(111);
    expect(r!.status).toBe('in_progress');
  });

  it('run queued sulla head attuale → blocca (occupa già lo slot di concurrency)', () => {
    expect(testsRunInFlightOnHead({
      runs: [{ id: 2, status: 'queued', head_sha: HEAD }], head: HEAD,
    })).not.toBeNull();
  });

  it('waiting / requested / pending sulla head attuale → bloccano (non terminali)', () => {
    for (const status of ['waiting', 'requested', 'pending']) {
      expect(testsRunInFlightOnHead({
        runs: [{ id: 3, status, head_sha: HEAD }], head: HEAD,
      }), status).not.toBeNull();
    }
  });

  it('CORRETTEZZA: run in volo su head VECCHIA (PR ripushata) → NON blocca', () => {
    expect(testsRunInFlightOnHead({
      runs: [{ id: 4, status: 'in_progress', head_sha: OLD }],
      head: HEAD,
    })).toBeNull();
  });

  it('run completed sulla head attuale → NON blocca (il segnale è già prodotto)', () => {
    expect(testsRunInFlightOnHead({
      runs: [{ id: 5, status: 'completed', head_sha: HEAD }], head: HEAD,
    })).toBeNull();
  });

  it('mix realistico: vecchi completed + vecchio in volo + attuale in volo → torna QUELLO attuale', () => {
    const r = testsRunInFlightOnHead({
      runs: [
        { id: 9, status: 'completed', head_sha: OLD },
        { id: 8, status: 'in_progress', head_sha: OLD },
        { id: 7, status: 'completed', head_sha: HEAD },
        { id: 6, status: 'queued', head_sha: HEAD },
      ],
      head: HEAD,
    });
    expect(r?.id).toBe(6);
  });

  it('nessun run / lista vuota / head assente → NON blocca (fail-open, nessuno stallo)', () => {
    expect(testsRunInFlightOnHead({ runs: [], head: HEAD })).toBeNull();
    expect(testsRunInFlightOnHead({ runs: undefined as never, head: HEAD })).toBeNull();
    expect(testsRunInFlightOnHead({ runs: [{ id: 1, status: 'in_progress', head_sha: HEAD }], head: '' })).toBeNull();
  });

  it('run malformati (null, senza head_sha, senza status) → ignorati senza throw', () => {
    expect(testsRunInFlightOnHead({
      runs: [null as never, {}, { status: 'in_progress' }, { head_sha: HEAD }],
      head: HEAD,
    })).toBeNull();
  });
});
