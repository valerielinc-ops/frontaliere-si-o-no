/**
 * rebaseActionForLgtmPr — decisione di pr-autorebase per una PR near-merge
 * behind>0. Guard contro il LIVELOCK osservato 2026-06-17: una PR LGTM'd
 * non-collision con head ORFANA (nessun check vitest, lasciata da un rebase
 * precedente) deve essere SANATA (dispatch tests), NON ri-rebasata — altrimenti
 * ogni tick orfanizza una nuova head e il vitest non chiude mai verde
 * (#2415 rebasata 3× in 15min su main caldo, mai mergiata).
 *
 * `collisionRisk` (bool grezzo dalla label) è stato sostituito da
 * `collisionBlocked` (#6039): il chiamante lo calcola col gate PRECISO di
 * auto-merge-eval (collisionGateDecision), non più "la label è presente" —
 * la funzione pura qui sotto resta agnostica di COME collisionBlocked è
 * derivato, testa solo che, dato il booleano, la decisione sia corretta.
 */
import { describe, it, expect } from 'vitest';
import { rebaseActionForLgtmPr } from '../scripts/ci/pr-autorebase.mjs';

describe('rebaseActionForLgtmPr (#2415 rebase-thrash livelock guard)', () => {
  it('REGRESSIONE #2415: LGTM non-collision + head orfana (no vitest) → heal, NON rebase', () => {
    expect(rebaseActionForLgtmPr({
      lgtm: true, collisionBlocked: false, vitestConclusion: '', hasVitestCheck: false,
    })).toBe('heal');
  });

  it('LGTM non-collision + vitest success presente → skip (auto-merge la mergia behind)', () => {
    expect(rebaseActionForLgtmPr({
      lgtm: true, collisionBlocked: false, vitestConclusion: 'success', hasVitestCheck: true,
    })).toBe('skip');
  });

  it('LGTM non-collision + vitest pending ma check PRESENTE (shard in corso) → skip (non orfana)', () => {
    expect(rebaseActionForLgtmPr({
      lgtm: true, collisionBlocked: false, vitestConclusion: '', hasVitestCheck: true,
    })).toBe('skip');
  });

  it('vitest=failure → rebase (eredita i fix di main)', () => {
    expect(rebaseActionForLgtmPr({
      lgtm: true, collisionBlocked: false, vitestConclusion: 'failure', hasVitestCheck: true,
    })).toBe('rebase');
  });

  it('REGRESSIONE #6039: collision-risk ma gate collisione NON blocca (peer inclusi/nessun peer mergiato) → NON forzare rebase anche con vitest verde', () => {
    expect(rebaseActionForLgtmPr({
      lgtm: true, collisionBlocked: false, vitestConclusion: 'success', hasVitestCheck: true,
    })).toBe('skip');
  });

  it('collision-risk + gate collisione BLOCCA (peer mergiato non incluso in head) → rebase', () => {
    expect(rebaseActionForLgtmPr({
      lgtm: true, collisionBlocked: true, vitestConclusion: 'success', hasVitestCheck: true,
    })).toBe('rebase');
  });

  it('collision-risk bloccato + head orfana → rebase (NON heal)', () => {
    expect(rebaseActionForLgtmPr({
      lgtm: true, collisionBlocked: true, vitestConclusion: '', hasVitestCheck: false,
    })).toBe('rebase');
  });

  it('non-LGTM → rebase (non near-merge-as-is)', () => {
    expect(rebaseActionForLgtmPr({
      lgtm: false, collisionBlocked: false, vitestConclusion: 'success', hasVitestCheck: true,
    })).toBe('rebase');
  });
});
