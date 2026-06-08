/**
 * followup-drainer — la logica che decide se un follow-up «agent:fix vecchio
 * senza PR» va ri-accodato (run davvero morta) o parcheggiato subito (abort
 * pulita con verdetto deterministico). Regressione di #1478: il rescue
 * ri-accodava le abort `no-root-cause`/`blocked-*` come se fossero orfane,
 * generando 3 run Claude identiche per issue prima del park. Ora il marker
 * FIX_OUTCOME le distingue e le parcheggia al primo giro.
 */

import { describe, it, expect } from 'vitest';
// @ts-expect-error — modulo .mjs senza tipi
import { latestFixOutcomeFromComments, NON_RETRYABLE } from '../scripts/ci/followup-drainer.mjs';

type Comment = { body?: string; createdAt?: string };
const at = (n: number) => new Date(2026, 0, n).toISOString();

describe('latestFixOutcomeFromComments', () => {
  it('estrae il codice del marker', () => {
    const c: Comment[] = [{ body: '<!-- FIX_OUTCOME: no-root-cause -->\nblah', createdAt: at(1) }];
    expect(latestFixOutcomeFromComments(c)).toBe('no-root-cause');
  });

  it('prende il marker PIÙ RECENTE quando ce ne sono più d\'uno', () => {
    const c: Comment[] = [
      { body: '<!-- FIX_OUTCOME: no-root-cause -->', createdAt: at(1) },
      { body: '<!-- FIX_OUTCOME: pr-created -->', createdAt: at(3) },
    ];
    expect(latestFixOutcomeFromComments(c)).toBe('pr-created');
  });

  it('ignora i fallback del backstop ("post-step deterministico")', () => {
    const c: Comment[] = [
      { body: '<!-- FIX_OUTCOME: no-root-cause -->', createdAt: at(1) },
      { body: '<!-- FIX_OUTCOME: no-pr-unspecified -->\npost-step deterministico', createdAt: at(2) },
    ];
    // il backstop non conta → vince l'unico verdetto autentico
    expect(latestFixOutcomeFromComments(c)).toBe('no-root-cause');
  });

  it('null senza marker (run crashata → resta ri-tentabile)', () => {
    expect(latestFixOutcomeFromComments([{ body: 'solo testo', createdAt: at(1) }])).toBeNull();
    expect(latestFixOutcomeFromComments([])).toBeNull();
    expect(latestFixOutcomeFromComments(undefined as unknown as Comment[])).toBeNull();
  });

  it('case-insensitive sul codice', () => {
    expect(latestFixOutcomeFromComments([{ body: '<!-- FIX_OUTCOME: No-Root-Cause -->', createdAt: at(1) }]))
      .toBe('no-root-cause');
  });
});

describe('NON_RETRYABLE (quali esiti → park immediato)', () => {
  it('include gli esiti deterministici-fermi', () => {
    for (const code of ['no-root-cause', 'blocked-workflows-scope', 'blocked-secrets',
      'blocked-admin-settings', 'revenue-tracker-manual', 'already-fixed']) {
      expect(NON_RETRYABLE.has(code)).toBe(true);
    }
  });

  it('ESCLUDE i transienti (ri-tentabili) e il path sano', () => {
    // overlap-skip/pr-already-open: la PR bloccante può mergiare → ri-tentabile.
    // pr-created: sano, non arriva mai al rescue (hasFixPR lo intercetta).
    for (const code of ['overlap-skip', 'pr-already-open', 'pr-created']) {
      expect(NON_RETRYABLE.has(code)).toBe(false);
    }
  });
});
