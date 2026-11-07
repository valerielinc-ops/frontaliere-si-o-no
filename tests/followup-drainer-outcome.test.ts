/**
 * followup-drainer — la logica che decide se un follow-up «agent:fix vecchio
 * senza PR» va ri-accodato (run davvero morta) o parcheggiato subito (abort
 * pulita con verdetto deterministico). Regressione di #1478: il rescue
 * ri-accodava le abort `no-root-cause`/`blocked-*` come se fossero orfane,
 * generando 3 run Claude identiche per issue prima del park. Ora il marker
 * FIX_OUTCOME le distingue e le parcheggia al primo giro.
 */

import { describe, it, expect } from 'vitest';
import {
  dailyBucketOutcomeTransition,
  dailyOutcomeItemId,
  latestFixOutcomeFromComments,
  latestFixRunOutcomeEntryFromComments,
  NON_RETRYABLE,
  isAgeOutEligible,
  isPinnedOutsideDrainerQueue,
  isSettlingPromotion,
  selectMergedDailyItemPr,
} from '../scripts/ci/followup-drainer.mjs';

type Comment = { body?: string; createdAt?: string };
const at = (n: number) => new Date(2026, 0, n).toISOString();

const DAILY_DAY = '2026-11-07';
const DAILY_REPO = 'valerielinc-ops/frontaliere-si-o-no';
const dailyBody = (states: string[]) => [
  `- Daily key: ${DAILY_DAY}`,
  '- State: sealed',
  `- Target repository: ${DAILY_REPO}`,
  '',
  ...states.map((state, index) => [
    `### FU-${DAILY_DAY}-${String(index + 1).padStart(3, '0')} — item ${index + 1}`,
    `- State: ${state}`,
    `- Target repository: ${DAILY_REPO}`,
  ].join('\n')),
].join('\n\n');
const dailyIssue = (states: string[]) => ({
  number: 17515,
  title: `follow-up(daily:${DAILY_DAY}): ${states.length} items — ${DAILY_REPO}`,
  body: dailyBody(states),
});
const itemId = (n: number) => `FU-${DAILY_DAY}-${String(n).padStart(3, '0')}`;
const outcomeMarker = (n: number) => `<!-- FOLLOWUP_ITEM: ${itemId(n)} -->`;

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

describe('latestFixRunOutcomeEntryFromComments', () => {
  it('un backstop generico piu\' recente invalida il verdetto storico', () => {
    const c: Comment[] = [
      { body: '<!-- FIX_OUTCOME: max-turns -->', createdAt: at(1) },
      { body: '<!-- FIX_OUTCOME: no-pr-unspecified -->\n_Outcome rilevato dal post-step deterministico._', createdAt: at(2) },
    ];
    expect(latestFixRunOutcomeEntryFromComments(c)).toEqual({ outcome: null, at: Date.parse(at(2)) });
  });

  it('conserva un backstop pr-created piu\' recente come consegna osservabile', () => {
    const c: Comment[] = [
      { body: '<!-- FIX_OUTCOME: max-turns -->', createdAt: at(1) },
      { body: '<!-- FIX_OUTCOME: pr-created -->\n_Outcome rilevato dal post-step deterministico._', createdAt: at(2) },
    ];
    expect(latestFixRunOutcomeEntryFromComments(c)).toEqual({ outcome: 'pr-created', at: Date.parse(at(2)) });
  });

  it('non scavalca un verdetto autentico piu\' recente del backstop', () => {
    const c: Comment[] = [
      { body: '<!-- FIX_OUTCOME: no-pr-unspecified -->\npost-step deterministico', createdAt: at(2) },
      { body: '<!-- FIX_OUTCOME: no-root-cause -->', createdAt: at(3) },
    ];
    expect(latestFixRunOutcomeEntryFromComments(c)).toEqual({ outcome: 'no-root-cause', at: Date.parse(at(3)) });
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

describe('daily bucket outcome — lease per item e transizione idempotente', () => {
  it('richiede un solo FU stabile e instrada al primo item open successivo', () => {
    expect(dailyOutcomeItemId(`${outcomeMarker(1)}\ncommento fixer`)).toBe(itemId(1));
    expect(dailyOutcomeItemId(`${outcomeMarker(1)}\n\n${outcomeMarker(2)}`)).toBeNull();

    const transition = dailyBucketOutcomeTransition(
      dailyIssue(['open', 'open']),
      'no-root-cause',
      outcomeMarker(1),
    );
    expect(transition).toMatchObject({ action: 'requeue', itemId: itemId(1), state: 'blocked' });
    expect(transition.nextItem?.id).toBe(itemId(2));
    expect(transition.body).toContain(`### ${itemId(1)} — item 1\n- State: blocked`);
  });

  it('non applica un esito transient a un item diverso da quello attualmente open', () => {
    const transition = dailyBucketOutcomeTransition(
      dailyIssue(['blocked', 'open']),
      'overlap-skip',
      outcomeMarker(1),
    );
    expect(transition).toMatchObject({ action: 'stale-attribution', itemId: itemId(1) });
  });

  it('pr-created richiede la prova di merge della stessa item, mentre already-fixed chiude solo quell item', () => {
    const issue = dailyIssue(['open', 'open']);
    expect(dailyBucketOutcomeTransition(issue, 'pr-created', outcomeMarker(1)))
      .toMatchObject({ action: 'awaiting-merged-pr', itemId: itemId(1) });

    const delivered = dailyBucketOutcomeTransition(issue, 'pr-created', outcomeMarker(1), {
      verifiedMergedItemId: itemId(1),
    });
    expect(delivered).toMatchObject({ action: 'requeue', itemId: itemId(1), state: 'done' });
    expect(delivered.nextItem?.id).toBe(itemId(2));
  });

  it('non rimuove un esito già consumato e calcola il routing dal body attuale', () => {
    const transition = dailyBucketOutcomeTransition(
      dailyIssue(['done', 'open']),
      'already-fixed',
      outcomeMarker(1),
    );
    expect(transition).toMatchObject({
      action: 'outcome-consumed',
      itemId: itemId(1),
      reconcileAction: 'requeue',
      nextItem: { id: itemId(2) },
    });
    expect(transition.body).toBeUndefined();
  });
});

describe('selectMergedDailyItemPr — prova di consegna per item', () => {
  const cutoff = Date.parse('2026-11-07T00:00:00Z');

  it('accetta una sola marker FU dopo il verdetto e rifiuta marker duplicati o item diversa', () => {
    expect(selectMergedDailyItemPr([
      { number: 1, mergedAt: '2026-11-07T00:01:00Z', body: `Follow-up item: ${itemId(1)}` },
      { number: 2, mergedAt: '2026-11-07T00:02:00Z', body: `Follow-up item: ${itemId(1)}\nFollow-up item: ${itemId(1)}` },
      { number: 3, mergedAt: '2026-11-07T00:03:00Z', body: `Follow-up item: ${itemId(2)}` },
      { number: 4, mergedAt: '2026-11-07T00:04:00Z', body: `Follow-up item: ${itemId(1)}` },
    ], itemId(1), cutoff)).toMatchObject({ number: 4, itemId: itemId(1) });
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
    title: 'follow-up(#test): bounded age-out candidate',
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

describe('isPinnedOutsideDrainerQueue (route L11 bounded)', () => {
  const issue = (labels: string[]) => ({ labels: labels.map((name) => ({ name })) });

  it('lascia passare solo il route L11 per errore provato', () => {
    expect(isPinnedOutsideDrainerQueue(issue([
      'operations-audit', 'agent:fix-queued', 'agent:no-age-out',
    ]))).toBe(false);
  });

  it('mantiene il veto su warning-only anche se resta una vecchia queue label', () => {
    expect(isPinnedOutsideDrainerQueue(issue([
      'operations-audit', 'operations-audit-review', 'agent:fix-queued', 'agent:no-age-out',
    ]))).toBe(true);
  });

  it('mantiene il veto esplicito keep-open', () => {
    expect(isPinnedOutsideDrainerQueue(issue([
      'operations-audit', 'agent:fix-queued', 'agent:no-age-out', 'keep-open',
    ]))).toBe(true);
  });

  it('mantiene il veto per un tracker permanente non L11', () => {
    expect(isPinnedOutsideDrainerQueue(issue(['agent:no-age-out', 'agent:fix-queued']))).toBe(true);
  });
});
