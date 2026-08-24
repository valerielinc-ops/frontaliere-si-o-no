/**
 * followup-drainer — la logica che decide se un follow-up «agent:fix vecchio
 * senza PR» va ri-accodato (run davvero morta) o parcheggiato subito (abort
 * pulita con verdetto deterministico). Regressione di #1478: il rescue
 * ri-accodava le abort `no-root-cause`/`blocked-*` come se fossero orfane,
 * generando 3 run Claude identiche per issue prima del park. Ora il marker
 * FIX_OUTCOME le distingue e le parcheggia al primo giro.
 */

import { describe, it, expect } from 'vitest';
import { latestFixOutcomeFromComments, NON_RETRYABLE, isAgeOutEligible, isSettlingPromotion } from '../scripts/ci/followup-drainer.mjs';

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
    for (const code of ['no-root-cause', 'blocked-workflows-scope',
      'blocked-admin-settings', 'revenue-tracker-manual', 'already-fixed']) {
      expect(NON_RETRYABLE.has(code)).toBe(true);
    }
  });

  it('include skip-duplicate-diagnosis: la separazione del marker (#5288) non deve riabilitare il re-queue', () => {
    // Prima del #5288 il Mode 2 di check-workflows-scope.mjs emetteva
    // `blocked-workflows-scope`, quindi era NON_RETRYABLE. Il nuovo codice descrive
    // lo stesso verdetto fermo (Mode 2 è deterministico sul titolo: ri-accodare
    // riproduce identico l'esito) e deve restare parkato, altrimenti la sola rinomina
    // avrebbe rimesso in coda issue che bruciano tentativi a vuoto.
    expect(NON_RETRYABLE.has('skip-duplicate-diagnosis')).toBe(true);
  });

  it('ESCLUDE i transienti (ri-tentabili) e il path sano', () => {
    // overlap-skip/pr-already-open: la PR bloccante può mergiare → ri-tentabile.
    // pr-created: sano, non arriva mai al rescue (hasFixPR lo intercetta).
    for (const code of ['overlap-skip', 'pr-already-open', 'pr-created']) {
      expect(NON_RETRYABLE.has(code)).toBe(false);
    }
  });
});

describe('isSettlingPromotion (regressione 2026-07-05: esito ≠ promozione fresca)', () => {
  it('vero SOLO su promozione fresca senza verdetto ancora entro la finestra settle', () => {
    expect(isSettlingPromotion({ outcome: null, ageMin: 1, settleMin: 3 })).toBe(true);
  });

  it('falso se un FIX_OUTCOME esiste già, anche se age è sotto settleMin (run CONCLUSA, non fresca)', () => {
    // #3578: max-turns commentato a 16:35:59 bumpa updatedAt → age~0min, ma la
    // run è già finita — non deve contare come settling (bloccava il drain).
    expect(isSettlingPromotion({ outcome: 'max-turns', ageMin: 0.5, settleMin: 3 })).toBe(false);
    expect(isSettlingPromotion({ outcome: 'no-root-cause', ageMin: 0, settleMin: 3 })).toBe(false);
  });

  it('falso oltre la finestra settle anche senza verdetto (passa al ramo orphan)', () => {
    expect(isSettlingPromotion({ outcome: null, ageMin: 5, settleMin: 3 })).toBe(false);
  });
});

describe('isAgeOutEligible (drain del ratchet follow-up)', () => {
  const DAY = 86_400_000;
  const now = Date.parse('2026-06-09T12:00:00Z');
  const opts = { now, ageOutDays: 21, inactiveDays: 14 };
  const iss = (labels: string[], createdDaysAgo: number, updatedDaysAgo: number) => ({
    labels: labels.map((name) => ({ name })),
    createdAt: new Date(now - createdDaysAgo * DAY).toISOString(),
    updatedAt: new Date(now - updatedDaysAgo * DAY).toISOString(),
  });

  it('chiude un follow-up vecchio + inattivo non in lavorazione (incl. fu-parked)', () => {
    expect(isAgeOutEligible(iss(['follow-up'], 30, 20), opts)).toBe(true);
    expect(isAgeOutEligible(iss(['follow-up', 'fu-parked'], 40, 30), opts)).toBe(true);
  });

  it('NON chiude se in lavorazione o in coda', () => {
    expect(isAgeOutEligible(iss(['follow-up', 'agent:fix'], 60, 60), opts)).toBe(false);
    expect(isAgeOutEligible(iss(['follow-up', 'agent:fix-queued'], 60, 60), opts)).toBe(false);
  });

  it('NON chiude se troppo giovane o con attività recente', () => {
    expect(isAgeOutEligible(iss(['follow-up'], 10, 9), opts)).toBe(false); // troppo giovane
    expect(isAgeOutEligible(iss(['follow-up'], 30, 3), opts)).toBe(false); // attività recente
  });

  it('NON chiude categorie non queue-managed (crawler), date illeggibili, o ageOutDays=0 (disabilitato)', () => {
    // 'parser-broken' → category='crawler' → route='fix' (non queue-managed)
    expect(isAgeOutEligible(iss(['parser-broken'], 60, 60), opts)).toBe(false);
    expect(isAgeOutEligible({ labels: [{ name: 'follow-up' }], createdAt: 'x', updatedAt: 'y' }, opts)).toBe(false);
    expect(isAgeOutEligible(iss(['follow-up'], 60, 60), { ...opts, ageOutDays: 0 })).toBe(false);
  });

  it('NON chiude un\'issue-contatore/tracker permanente (`agent:no-age-out`), anche molto vecchia e ferma (#5615)', () => {
    // Il ledger crawler-transient e il tracker loop-health sono queue-managed
    // (category='other') e sopravvivono SOLO grazie ai commenti dei fallimenti
    // sub-soglia che contano: un periodo sano li lascia vecchi+inattivi come
    // qualunque follow-up morto, azzerando lo streak che contano se chiusi.
    expect(isAgeOutEligible(iss(['agent:no-age-out'], 365, 365), opts)).toBe(false);
    // resta chiudibile senza la label, stessa età/inattività
    expect(isAgeOutEligible(iss([], 365, 365), opts)).toBe(true);
  });
});
