/**
 * followup-drainer — pin fuori dal ciclo di fix (#7648).
 *
 * `keep-open` è descritta come «tracker su causa esterna: resta aperta, niente
 * auto-close del reconcile», e faceva esattamente metà di quello che dice:
 * `reconcile-followups.mjs` la onora come veto alla CHIUSURA, ma nessuno strato
 * la leggeva come veto alla PROMOZIONE. #7648 — due review esterne (App Review
 * Meta, audit TikTok) che nessun turn-budget può far arrivare — nasce
 * dichiarando nel proprio body «senza `agent:fix-queued`/`agent:fix`», e ha
 * comunque attraversato triage → coda → `agent:fix` → un run del fixer.
 *
 * È la stessa asimmetria che #5544 aveva già trovato per `agent:no-age-out` e
 * chiuso a metà: l'esclusione dalla promozione esisteva solo nel pool del
 * PARKED-RETRY, cioè per chi era già stato parcheggiato, non alla porta.
 *
 * Il fix vive in `classifyIssue` (`route='none'` → `isQueueManaged` false), e
 * questi test coprono il punto dove quel cambiamento NON basta da solo: il
 * rescue crawler, che seleziona per COMPLEMENTO di `isQueueManaged` e quindi
 * eredita i pinnati insieme ai crawler.
 */

import { describe, it, expect } from 'vitest';
import {
  isCrawlerRescueCandidate,
  isQueueManaged,
  isReparkableCandidate,
  isAgeOutCandidate,
} from '../scripts/ci/followup-drainer.mjs';

const L = (...names: string[]) => names.map((name) => ({ name }));

const PINNED = { number: 7648, title: 'Instagram/TikTok publishing: attivare i poster', labels: L('follow-up', 'funnel-seo', 'keep-open') };
const CRAWLER = { number: 900, title: '[crawler-health] Coop Ticino broken', labels: L('parser-broken') };
const FOLLOWUP = { number: 901, title: 'follow-up(#900): due item', labels: L('follow-up') };

describe('pin keep-open — nessuno stadio del drainer lo instrada', () => {
  it('non è queue-managed: fuori da DRAIN, rescue orfani, verdict-exit e age-out', () => {
    expect(isQueueManaged(FOLLOWUP)).toBe(true);
    expect(isQueueManaged(PINNED)).toBe(false);
  });

  it('NON entra nel rescue crawler, che seleziona per complemento di isQueueManaged', () => {
    // Il difetto che questo test fissa: `!isQueueManaged` significava «crawler»
    // finché le route erano solo fix/queue. Col pin il complemento diventa
    // «crawler + pinnati», e il rescue ri-armerebbe con `agent:fix` proprio le
    // issue che il pin toglie dal ciclo.
    expect(isCrawlerRescueCandidate(CRAWLER)).toBe(true);
    expect(isCrawlerRescueCandidate(PINNED)).toBe(false);
  });

  it('un crawler pinnato a mano è escluso dal rescue quanto una follow-up pinnata', () => {
    expect(isCrawlerRescueCandidate({ ...CRAWLER, labels: L('parser-broken', 'keep-open') })).toBe(false);
    expect(isCrawlerRescueCandidate({ ...CRAWLER, labels: L('parser-broken', 'agent:no-age-out') })).toBe(false);
  });

  it('non entra nel pool del parked-retry né in quello dell’age-out close', () => {
    expect(isReparkableCandidate({ ...PINNED, labels: L('follow-up', 'keep-open', 'fu-parked') })).toBe(false);
    // Un tracker su causa esterna non si chiude per inattività: è aperto apposta.
    const old = { ...PINNED, createdAt: new Date(Date.now() - 400 * 86_400_000).toISOString() };
    expect(isAgeOutCandidate(old, { now: Date.now(), ageOutDays: 60 })).toBe(false);
  });

  it('il rescue crawler resta invariato per tutto il resto (nessuna regressione #5514)', () => {
    expect(isCrawlerRescueCandidate({ ...CRAWLER, labels: L('parser-broken', 'agent:fix-queued') })).toBe(false);
    expect(isCrawlerRescueCandidate({ ...CRAWLER, labels: L('parser-broken', 'fu-parked') })).toBe(false);
    expect(isCrawlerRescueCandidate({ ...CRAWLER, labels: L('parser-broken', 'needs-human') })).toBe(false);
    expect(isCrawlerRescueCandidate(FOLLOWUP)).toBe(false); // queue-managed → è di `stuckFix`
  });
});
