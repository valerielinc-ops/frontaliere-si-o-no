/**
 * rebaseActionForLgtmPr — decisione di pr-autorebase per una PR near-merge
 * behind>0. Guard contro il LIVELOCK osservato 2026-06-17: una PR LGTM'd
 * non-collision con head ORFANA (nessun check vitest, lasciata da un rebase
 * precedente) deve essere SANATA (dispatch tests), NON ri-rebasata — altrimenti
 * ogni tick orfanizza una nuova head e il vitest non chiude mai verde
 * (#2415 rebasata 3× in 15min su main caldo, mai mergiata).
 */
import { describe, it, expect } from 'vitest';
import { rebaseActionForLgtmPr } from '../scripts/ci/pr-autorebase.mjs';

describe('rebaseActionForLgtmPr (#2415 rebase-thrash livelock guard)', () => {
  it('REGRESSIONE #2415: LGTM non-collision + head orfana (no vitest) → heal, NON rebase', () => {
    expect(rebaseActionForLgtmPr({
      lgtm: true, collisionRisk: false, vitestConclusion: '', hasVitestCheck: false,
    })).toBe('heal');
  });

  it('LGTM non-collision + vitest success presente → skip (auto-merge la mergia behind)', () => {
    expect(rebaseActionForLgtmPr({
      lgtm: true, collisionRisk: false, vitestConclusion: 'success', hasVitestCheck: true,
    })).toBe('skip');
  });

  it('LGTM non-collision + vitest pending ma check PRESENTE (shard in corso) → skip (non orfana)', () => {
    expect(rebaseActionForLgtmPr({
      lgtm: true, collisionRisk: false, vitestConclusion: '', hasVitestCheck: true,
    })).toBe('skip');
  });

  it('vitest=failure → rebase (eredita i fix di main)', () => {
    expect(rebaseActionForLgtmPr({
      lgtm: true, collisionRisk: false, vitestConclusion: 'failure', hasVitestCheck: true,
    })).toBe('rebase');
  });

  it('collision-risk → rebase (il gate collisione esige 0-behind), anche con vitest verde', () => {
    expect(rebaseActionForLgtmPr({
      lgtm: true, collisionRisk: true, vitestConclusion: 'success', hasVitestCheck: true,
    })).toBe('rebase');
  });

  it('collision-risk + head orfana → rebase (NON heal): le collision vanno comunque rebasate', () => {
    expect(rebaseActionForLgtmPr({
      lgtm: true, collisionRisk: true, vitestConclusion: '', hasVitestCheck: false,
    })).toBe('rebase');
  });

  it('non-LGTM → rebase (non near-merge-as-is)', () => {
    expect(rebaseActionForLgtmPr({
      lgtm: false, collisionRisk: false, vitestConclusion: 'success', hasVitestCheck: true,
    })).toBe('rebase');
  });
});
