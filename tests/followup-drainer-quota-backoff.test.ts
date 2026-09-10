/**
 * followup-drainer — il recupero di una run morta su QUOTA (429) non deve
 * consumare un tentativo né parcheggiare la issue.
 *
 * Regressione dello stato assorbente misurato il 2026-08-05 (gemello lato fixer
 * di quello del grafo di recupero PR chiuso in #5099):
 *
 *   429 (Claude non gira: 0 turni, $0)
 *     → nessun marker granulare → `latestFixOutcome()` null
 *     → il rescue lo scambia per «run morta ri-tentabile» → `fu-attempt`++
 *     → ri-promossa contro la stessa quota ancora esaurita → altri due 429
 *     → `fu-attempt:3` → `fu-parked`
 *     → parked + inattiva ≥7gg + vecchia ≥10gg → AGE-OUT close «not planned»
 *
 * Osservato su #5008 #5004 #5001 #4974: issue mai lette da nessun agent, uscite
 * dal loop autonomo per esaurimento di una quota che non le riguardava.
 */

import { describe, it, expect } from 'vitest';
import {
  latestFixOutcomeFromComments,
  NON_RETRYABLE,
  ZERO_WORK,
  isAgeOutEligible,
} from '../scripts/ci/followup-drainer.mjs';
import { formatRateLimitComment, maxQuotaResetsAt } from '../scripts/ci/claude-rate-limit.mjs';
import { beaconCandidates, quotaFallbackDecision } from '../scripts/ci/check-quota-backoff.mjs';

type Comment = { body?: string; createdAt?: string; author?: { login?: string } };
const bot = { login: 'github-actions' };
const nowSec = () => Math.floor(Date.now() / 1000);
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const DAY = 86_400_000;

describe('ZERO_WORK vs NON_RETRYABLE — sono classi diverse', () => {
  it('`rate-limited` è zero-work, NON un verdetto fermo da parcheggiare', () => {
    expect(ZERO_WORK.has('rate-limited')).toBe(true);
    // Cruciale: se finisse in NON_RETRYABLE il drainer la parcheggerebbe SUBITO,
    // che è il male opposto ma altrettanto grave — la issue uscirebbe dalla coda
    // per una condizione ambientale transitoria.
    expect(NON_RETRYABLE.has('rate-limited')).toBe(false);
  });

  it('gli esiti diagnostici fermi restano non-ri-tentabili (nessuna regressione)', () => {
    for (const code of ['no-root-cause', 'blocked-workflows-scope', 'already-fixed']) {
      expect(NON_RETRYABLE.has(code)).toBe(true);
      expect(ZERO_WORK.has(code)).toBe(false);
    }
  });

  it('`max-turns` NON è zero-work: il budget di turni è stato davvero speso', () => {
    expect(ZERO_WORK.has('max-turns')).toBe(false);
  });
});

describe('il commento del fixer resta leggibile dal drainer', () => {
  it('il marker `rate-limited` è estratto come verdetto autentico, non come backstop', () => {
    const comments: Comment[] = [
      { body: formatRateLimitComment({ resetsAt: nowSec() + 7200, rateLimitType: 'seven_day' }), createdAt: iso(60_000) },
    ];
    // Prima del fix qui arrivava solo il backstop `no-pr-unspecified`, che il
    // drainer scarta di proposito → outcome null → rescue con tentativo bruciato.
    expect(latestFixOutcomeFromComments(comments)).toBe('rate-limited');
  });

  it('il backstop generico non sovrascrive il verdetto granulare di quota', () => {
    const comments: Comment[] = [
      { body: formatRateLimitComment({ resetsAt: nowSec() + 7200 }), createdAt: iso(120_000) },
      { body: '<!-- FIX_OUTCOME: no-pr-unspecified -->\npost-step deterministico', createdAt: iso(60_000) },
    ];
    expect(latestFixOutcomeFromComments(comments)).toBe('rate-limited');
  });
});

describe('maxQuotaResetsAt (beacon di backoff, helper condiviso gate↔drainer)', () => {
  it('estrae la scadenza dal commento del fixer', () => {
    const resets = nowSec() + 3600;
    expect(maxQuotaResetsAt([{ body: formatRateLimitComment({ resetsAt: resets }), author: bot }])).toBe(resets);
  });

  it('beacon senza esito successivo → resta attivo', () => {
    const resets = nowSec() + 3600;
    const comments: Comment[] = [
      { body: formatRateLimitComment({ resetsAt: resets }), createdAt: iso(120_000), author: bot },
    ];
    expect(maxQuotaResetsAt(comments)).toBe(resets);
  });

  it('un altro `rate-limited` successivo non supera il beacon precedente', () => {
    const earlierReset = nowSec() + 7200;
    const laterReset = nowSec() + 3600;
    const comments: Comment[] = [
      { body: formatRateLimitComment({ resetsAt: earlierReset }), createdAt: iso(120_000), author: bot },
      { body: formatRateLimitComment({ resetsAt: laterReset }), createdAt: iso(60_000), author: bot },
    ];
    expect(maxQuotaResetsAt(comments)).toBe(earlierReset);
  });

  it('con più beacon vince quello che si chiude per ULTIMO', () => {
    const a = nowSec() + 3600;
    const b = nowSec() + 9000;
    const comments: Comment[] = [
      { body: `<!-- FIX_OUTCOME: rate-limited -->\n<!-- QUOTA_RESETS_AT: ${b} -->`, createdAt: iso(600_000), author: bot },
      { body: `<!-- FIX_OUTCOME: rate-limited -->\n<!-- QUOTA_RESETS_AT: ${a} -->`, createdAt: iso(60_000), author: bot },
    ];
    // Non «il più recente»: riaprire il drain prima del reset reale
    // riprodurrebbe esattamente la cascata che il backoff esiste per fermare.
    expect(maxQuotaResetsAt(comments)).toBe(b);
  });

  it('nessun beacon → null (il drain procede normalmente)', () => {
    expect(maxQuotaResetsAt([{ body: '<!-- FIX_OUTCOME: no-root-cause -->' }])).toBeNull();
    expect(maxQuotaResetsAt([])).toBeNull();
    expect(maxQuotaResetsAt(undefined as unknown as Comment[])).toBeNull();
  });

  it('beacon malformato → null (il gate procede)', () => {
    expect(maxQuotaResetsAt([
      { body: '<!-- QUOTA_RESETS_AT: non-un-epoch -->', createdAt: iso(60_000) },
    ])).toBeNull();
  });

  it('beacon seguito da un esito non-rate-limited → superato', () => {
    const resets = nowSec() + 3600;
    const comments: Comment[] = [
      { body: formatRateLimitComment({ resetsAt: resets }), createdAt: iso(120_000), author: bot },
      { body: '<!-- FIX_OUTCOME: already-fixed -->', createdAt: iso(60_000), author: bot },
    ];
    expect(maxQuotaResetsAt(comments)).toBeNull();
  });
});

describe('age-out: la coda di uscita che rendeva la perdita definitiva', () => {
  const opts = { now: Date.now(), ageOutDays: 10, inactiveDays: 7 };
  const parked = {
    title: 'Strategia per apparire su Google News',
    labels: [{ name: 'agent:triaged' }, { name: 'fu-prio:low' }, { name: 'fu-parked' }, { name: 'fu-attempt:3' }],
    createdAt: iso(20 * DAY),
    updatedAt: iso(9 * DAY),
  };

  it('una issue parcheggiata e ferma È eleggibile alla chiusura automatica', () => {
    // Questo è il motivo per cui il park indebito non è recuperabile a mano più
    // tardi: dopo 10 giorni la issue viene chiusa «not planned».
    expect(isAgeOutEligible(parked, opts)).toBe(true);
  });

  it('finché resta in coda non è chiudibile — per questo il re-queue senza park è la cura', () => {
    const requeued = { ...parked, labels: [{ name: 'agent:fix-queued' }] };
    expect(isAgeOutEligible(requeued, opts)).toBe(false);
  });
});

describe('beaconCandidates — la ricerca del beacon resta bounded', () => {
  const now = Date.now();
  const iss = (number: number, hAgo: number) => ({ number, updatedAt: new Date(now - hAgo * 3_600_000).toISOString() });

  it('scarta le issue più vecchie della finestra di lookback (un beacon è fresco per definizione)', () => {
    const out = beaconCandidates([[iss(1, 1), iss(2, 48)]], { now, lookbackH: 24, max: 10 });
    expect(out).toEqual([1]);
  });

  it('dedupa fra le due liste (agent:fix e agent:fix-queued possono sovrapporsi) e ordina dalla più recente', () => {
    const out = beaconCandidates([[iss(7, 5), iss(9, 1)], [iss(9, 1), iss(8, 3)]], { now, lookbackH: 24, max: 10 });
    expect(out).toEqual([9, 8, 7]);
  });

  it('rispetta il cap: una coda lunga non trasforma il guard in un costo lineare sul backlog', () => {
    const many = Array.from({ length: 40 }, (_, i) => iss(i + 1, i * 0.1));
    expect(beaconCandidates([many], { now, lookbackH: 24, max: 5 })).toHaveLength(5);
  });

  it('date illeggibili → issue ignorata, mai un crash del gate', () => {
    const out = beaconCandidates([[{ number: 1, updatedAt: 'non-una-data' }, iss(2, 1)]], { now, lookbackH: 24, max: 5 });
    expect(out).toEqual([2]);
  });
});

describe('quota preflight projection — Codex fallback is opt-in and non-mutating', () => {
  const nowSec = 1_800_000_000;

  it('keeps the historical blocking output when Codex mode is off', () => {
    expect(quotaFallbackDecision({
      resetsAt: nowSec + 600,
      nowSec,
      codexFallbackMode: false,
    })).toEqual({ active: true, quotaBlocked: true, codexFallback: false });
  });

  it('projects an active beacon to one Codex fallback without blocking', () => {
    expect(quotaFallbackDecision({
      resetsAt: nowSec + 600,
      nowSec,
      codexFallbackMode: true,
    })).toEqual({ active: true, quotaBlocked: false, codexFallback: true });
  });

  it('does not trigger fallback after reset or for an absent beacon', () => {
    expect(quotaFallbackDecision({ resetsAt: nowSec - 1, nowSec, codexFallbackMode: true }))
      .toEqual({ active: false, quotaBlocked: false, codexFallback: false });
    expect(quotaFallbackDecision({ resetsAt: null, nowSec, codexFallbackMode: true }))
      .toEqual({ active: false, quotaBlocked: false, codexFallback: false });
  });
});
