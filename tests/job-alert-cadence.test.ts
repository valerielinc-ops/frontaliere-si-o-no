// Job-alert cadence engine — issue #5705.
//
// The question these fixtures are built around is not "does the test pass" but
// "which shape of document has this test never seen" (#5764). The last three
// defects on this channel all survived a green suite because every fixture was
// the same shape as the one that worked: #5733 lived through three issues
// written to close it because every fixture used `status: 'unsubscribed'` and
// the broken branch took the other road, and `action=unsubscribe_all` survived
// a month because every opt-out URL in the suite was typed by hand.
//
// So: URLs come from the real builders, never from a string literal; and the
// list below is the list of shapes, each with its expected verdict written down.
//
//  1. `frequencyOverride: true`               → escapes the ceiling
//  2. an alert that has just decayed          → receives nothing, stays active
//  3. the seventh send and the eighth          → the boundary, not the middle
//  4. camelCase stamps (458 production docs)   → read exactly like snake_case
//  5. no send ledger at all                    → fail-closed
//  6. clicks that are all synthetic            → never the fast tier
//  7. a backfilled alert vs one a person made  → same ceiling, different decay
//  8. re-entry from `decayed`                  → impossible without a person
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  JOB_ALERT_CADENCE_CEILING_DAYS,
  JOB_ALERT_CADENCE_STATES,
  JOB_ALERT_CADENCE_TIERS,
  JOB_ALERT_DECAY_AFTER_SLOW_SENDS,
  JOB_ALERT_DEMOTION_STREAK,
  JOB_ALERT_REACTIVATION_BLOCKS,
  alreadyServedToday,
  cadenceStateOf,
  decayStampAfterSend,
  engagedSinceLastJobAlertSend,
  isBackfilledAlert,
  isCadenceSendable,
  isDecayed,
  isJobAlertDueToday,
  nextJobAlertCadenceState,
  normalizeCadenceTier,
  openedSinceLastJobAlertSend,
  reactivationAfterReturnVisit,
  recipientsWithAllAlertsDecayed,
  resolveJobAlertCadence,
  seedJobAlertTier,
} from '../scripts/lib/jobAlertCadence.mjs';
import { RETURN_VISIT_VERDICTS } from '../functions/src/lib/returnVisit.js';
import { JOB_ALERT_ENGAGEMENT_TIERS } from '../scripts/lib/jobAlertEngagementTier.mjs';
import {
  makeAlertUnsubscribeUrl,
  makeAllAlertsUnsubscribeUrl,
} from '../scripts/lib/job-alert-unsub-urls.mjs';
import { classifyJobAlertSunset } from '../scripts/lib/jobAlertSunset.mjs';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-08-13T04:33:00Z'); // a real dispatch time: cron 00:33 + the median 240min delay
const TODAY = '2026-08-13';
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString();
const daysAgoMs = (n: number) => NOW - n * DAY;

const JOB_AD_URL = 'https://frontaliereticino.ch/cerca-lavoro-ticino/annuncio-1';
const EMAIL = 'reader@example.test';

// FILE-WIDE. Without the secret both unsubscribe builders return the unsigned
// fallback — a job-search page — so an opt-out fixture silently becomes a
// CONTENT click and asserts the opposite of what it reads. The guard test in
// the last block is what keeps that from happening quietly again.
let previousSecret: string | undefined;
beforeAll(() => {
  previousSecret = process.env.NEWSLETTER_SECRET;
  process.env.NEWSLETTER_SECRET = 'test-secret-#5705';
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.NEWSLETTER_SECRET;
  else process.env.NEWSLETTER_SECRET = previousSecret;
});

/** The alert subdocument as the backfill wrote it: no keywords, no locations. */
function backfilledAlert(overrides: Record<string, unknown> = {}) {
  return {
    id: 'backfill-newsletter',
    email: EMAIL,
    active: true,
    frequency: 'daily',
    frequencyOverride: false,
    keywords: [],
    locations: [],
    backfilled_from: 'newsletter_subscribers:job_gate',
    ...overrides,
  };
}

/** The alert a person actually created from the site. */
function personAlert(overrides: Record<string, unknown> = {}) {
  return {
    id: 'a7Kq2ZfLmN',
    email: EMAIL,
    active: true,
    frequency: 'daily',
    frequencyOverride: false,
    keywords: ['infermiere'],
    locations: ['Lugano'],
    ...overrides,
  };
}

function sub(overrides: Record<string, unknown> = {}) {
  return { ...overrides };
}

const clickedAJob = (n: number) => ({ last_click_at: daysAgo(n), last_clicked_url: JOB_AD_URL });

// ─────────────────────────────────────────────────────────────────────────────
describe('the scale and the ceiling', () => {
  it('runs on the owner table [1, 3, 7], in days', () => {
    expect(JOB_ALERT_CADENCE_TIERS).toEqual([1, 3, 7]);
  });

  it('snaps a stored tier onto the scale, floor 1', () => {
    expect(normalizeCadenceTier(1)).toBe(1);
    expect(normalizeCadenceTier(2)).toBe(1);
    expect(normalizeCadenceTier(5)).toBe(3);
    expect(normalizeCadenceTier(30)).toBe(7);
    expect(normalizeCadenceTier(0)).toBe(1);
    expect(normalizeCadenceTier(undefined)).toBe(null);
  });

  // The ceiling was 7 for one day (owner, 2026-08-13) and is OFF since
  // 2026-08-14: the owner disagreed once it was spelled out that a ceiling of 7
  // collapses the whole table, i.e. nobody gets the cadence the table describes.
  // Both directions stay covered here, because the lever is one value and the
  // day it goes back up this file must already know what to expect.
  it('runs the owner table by default, because the ceiling is off', () => {
    expect(JOB_ALERT_CADENCE_CEILING_DAYS).toBe(null);
    expect(resolveJobAlertCadence(backfilledAlert(), sub(clickedAJob(1)), NOW).intervalDays).toBe(1);
    expect(resolveJobAlertCadence(backfilledAlert(), sub({ last_open_at: daysAgo(2) }), NOW).intervalDays).toBe(3);
    expect(resolveJobAlertCadence(backfilledAlert(), sub(), NOW).intervalDays).toBe(7);
  });

  it('collapses every engine tier onto the ceiling when one is set', () => {
    for (const profile of [clickedAJob(1), { last_open_at: daysAgo(2) }, {}]) {
      const decision = resolveJobAlertCadence(backfilledAlert(), sub(profile), NOW, { ceilingDays: 7 });
      expect(decision.intervalDays).toBe(7);
      // `ceilingApplied` dice se il soffitto ha MORSO, non se era impostato:
      // per chi sta gia' sulla fascia da 7 giorni il tetto non cambia nulla e
      // resta false. E' la distinzione che rende il flag utile a contare
      // quanti destinatari il soffitto sta effettivamente rallentando.
      expect(decision.ceilingApplied).toBe(decision.tierDays < 7);
    }
  });

  it('keeps the engine tier underneath the ceiling, so moving the lever needs no migration', () => {
    // Ceiling off: tier and effective interval coincide, nothing is applied.
    const clicker = resolveJobAlertCadence(backfilledAlert(), sub(clickedAJob(1)), NOW);
    expect(clicker.tierDays).toBe(1);
    expect(clicker.intervalDays).toBe(1);
    expect(clicker.ceilingApplied).toBe(false);
    // Drop the lever back and the same stored state collapses again, with the
    // tier untouched underneath — which is why raising or lowering it is a
    // value and never a data migration.
    const capped = resolveJobAlertCadence(backfilledAlert(), sub(clickedAJob(1)), NOW, { ceilingDays: 7 });
    expect(capped.tierDays).toBe(1);
    expect(capped.intervalDays).toBe(7);
    expect(capped.ceilingApplied).toBe(true);
  });

  it('never speeds anybody up: the effective interval is max(tier, ceiling)', () => {
    // Every tier on the scale, against every ceiling worth trying.
    for (const ceilingDays of [null, 1, 3, 7]) {
      for (const profile of [clickedAJob(1), { last_open_at: daysAgo(2) }, {}]) {
        const decision = resolveJobAlertCadence(backfilledAlert(), sub(profile), NOW, { ceilingDays });
        expect(decision.intervalDays).toBe(Math.max(decision.tierDays, ceilingDays ?? 0));
      }
    }
  });

  // SHAPE 7 — the ceiling is a channel rule, not a backfill rule.
  it('treats a backfilled alert and one a person created identically, ceiling or no ceiling', () => {
    const profile = sub(clickedAJob(1));
    // Ceiling off: both run on the tier.
    expect(resolveJobAlertCadence(backfilledAlert(), profile, NOW).intervalDays).toBe(1);
    expect(resolveJobAlertCadence(personAlert(), profile, NOW).intervalDays).toBe(1);
    // Ceiling on: both collapse onto it. The rule is a channel rule, not a
    // backfill rule — that is what this shape exists to pin, and it holds
    // whichever way the lever points.
    expect(resolveJobAlertCadence(backfilledAlert(), profile, NOW, { ceilingDays: 7 }).intervalDays).toBe(7);
    expect(resolveJobAlertCadence(personAlert(), profile, NOW, { ceilingDays: 7 }).intervalDays).toBe(7);
    expect(isBackfilledAlert(backfilledAlert())).toBe(true);
    expect(isBackfilledAlert(personAlert())).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SHAPE 1 — the one exemption.
describe('frequencyOverride: true escapes the ceiling', () => {
  it('serves a pinned daily alert every day, ceiling or no ceiling', () => {
    const decision = resolveJobAlertCadence(backfilledAlert({ frequencyOverride: true, frequency: 'daily' }), sub(), NOW);
    expect(decision.manual).toBe(true);
    expect(decision.intervalDays).toBe(1);
    expect(decision.ceilingApplied).toBe(false);
  });

  it('serves a pinned weekly alert every 7 days', () => {
    const decision = resolveJobAlertCadence(backfilledAlert({ frequencyOverride: true, frequency: 'weekly' }), sub(), NOW);
    expect(decision.intervalDays).toBe(7);
  });

  it('lets a pinned daily alert through on consecutive days, while the engine alert waits', () => {
    const profile = sub({ ja_cadence_last_sent_at: daysAgo(1) });
    const pinned = backfilledAlert({ frequencyOverride: true, frequency: 'daily', lastMatchedAt: daysAgo(1) });
    const engine = backfilledAlert({ lastMatchedAt: daysAgo(1) });
    expect(isJobAlertDueToday({ alert: pinned, sub: profile, todayIso: TODAY, nowMs: NOW }).due).toBe(true);
    expect(isJobAlertDueToday({ alert: engine, sub: profile, todayIso: TODAY, nowMs: NOW }).due).toBe(false);
  });

  it('never decays a pinned alert: the pin is the only act of the person about frequency', () => {
    const state = { ja_cadence_weekly_sends: JOB_ALERT_DECAY_AFTER_SLOW_SENDS + 5 };
    expect(decayStampAfterSend({
      alert: backfilledAlert({ frequencyOverride: true }),
      nextState: state,
      sentAtIso: daysAgo(0),
    })).toBe(null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('is this alert due today — calendar days, not 24h windows', () => {
  it('is due when nothing was ever sent on either clock', () => {
    const decision = isJobAlertDueToday({ alert: backfilledAlert(), sub: sub(), todayIso: TODAY, nowMs: NOW });
    expect(decision.due).toBe(true);
    expect(decision.reason).toContain('never sent');
  });

  it('is due exactly on the 7th day and not on the 6th', () => {
    const at = (n: number) => isJobAlertDueToday({
      alert: backfilledAlert({ lastMatchedAt: daysAgo(n) }),
      sub: sub({ ja_cadence_last_sent_at: daysAgo(n) }),
      todayIso: TODAY,
      nowMs: NOW,
    }).due;
    expect(at(6)).toBe(false);
    expect(at(7)).toBe(true);
    expect(at(8)).toBe(true);
  });

  it('counts calendar days, so the hour of the previous dispatch does not move the answer', () => {
    // The measured spread of this cron: 00:33 nominal, median +240min, max +590.
    const sameDueSet = ['2026-08-06T00:33:00Z', '2026-08-06T04:33:00Z', '2026-08-06T10:23:00Z', '2026-08-06T23:59:59Z']
      .map((stamp) => isJobAlertDueToday({
        alert: backfilledAlert({ lastMatchedAt: stamp }),
        sub: sub(),
        todayIso: TODAY,
        nowMs: NOW,
      }).due);
    expect(sameDueSet).toEqual([true, true, true, true]);
    // 7 calendar days is 7 calendar days even when only 6d 0h 34m of wall clock
    // have passed — which is the point: a millisecond gate would say "not yet"
    // and skip a whole week.
  });

  it('is a pure function of the day, so a rerun in the same run window is a no-op', () => {
    const args = { alert: backfilledAlert({ lastMatchedAt: daysAgo(3) }), sub: sub(), todayIso: TODAY };
    const morning = isJobAlertDueToday({ ...args, nowMs: Date.parse('2026-08-13T00:33:00Z') });
    const afternoon = isJobAlertDueToday({ ...args, nowMs: Date.parse('2026-08-13T14:12:00Z') });
    expect(morning.due).toBe(afternoon.due);
    expect(morning.intervalDays).toBe(afternoon.intervalDays);
  });

  // SHAPE 5 — no send ledger at all.
  it('is due when the alert has no lastMatchedAt, and still respects the recipient clock', () => {
    // 203 active alerts carry no lastMatchedAt in production: they have never
    // been sent, so there is no interval to respect — unless the PERSON was
    // mailed recently through another alert.
    expect(isJobAlertDueToday({ alert: backfilledAlert(), sub: sub(), todayIso: TODAY, nowMs: NOW }).due).toBe(true);
    expect(isJobAlertDueToday({
      alert: backfilledAlert(),
      sub: sub({ ja_cadence_last_sent_at: daysAgo(2) }),
      todayIso: TODAY,
      nowMs: NOW,
    }).due).toBe(false);
  });

  it('stops one person receiving three emails because they hold three alerts', () => {
    const profile = sub({ ja_cadence_last_sent_at: daysAgo(2) });
    const three = [backfilledAlert({ id: 'backfill-newsletter' }), personAlert({ id: 'x1' }), personAlert({ id: 'x2' })];
    for (const alert of three) {
      expect(isJobAlertDueToday({ alert, sub: profile, todayIso: TODAY, nowMs: NOW }).due).toBe(false);
    }
  });

  it('falls back to last_sent_at on the very first run, instead of treating everybody as never-mailed', () => {
    // `ja_cadence_last_sent_at` does not exist yet on any production document.
    // The per-ALERT clock is what carries the history on day one, and it does.
    const decision = isJobAlertDueToday({
      alert: backfilledAlert({ lastMatchedAt: daysAgo(1) }),
      sub: sub({ last_sent_at: daysAgo(1) }),
      todayIso: TODAY,
      nowMs: NOW,
    });
    expect(decision.due).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SHAPE 4 — the camelCase family, which produced #5733 and #5741.
describe('camelCase stamps read exactly like snake_case ones', () => {
  it('seeds the same tier from lastClickAt/lastClickedUrl as from last_click_at/last_clicked_url', () => {
    const snake = seedJobAlertTier(sub({ last_click_at: daysAgo(1), last_clicked_url: JOB_AD_URL }), NOW);
    const camel = seedJobAlertTier(sub({ lastClickAt: daysAgo(1), lastClickedUrl: JOB_AD_URL }), NOW);
    expect(camel.tierDays).toBe(1);
    expect(camel.tierDays).toBe(snake.tierDays);
  });

  it('sees an open written as lastOpenAt', () => {
    expect(seedJobAlertTier(sub({ lastOpenAt: daysAgo(2) }), NOW).tierDays).toBe(3);
  });

  it('demotes a camelCase opt-out click the same way', () => {
    const camel = sub({
      lastClickAt: daysAgo(1),
      lastClickedUrl: makeAlertUnsubscribeUrl('backfill-newsletter', EMAIL),
      lastOpenAt: daysAgo(1),
    });
    expect(seedJobAlertTier(camel, NOW).tierDays).toBe(7);
  });

  it('counts a camelCase clickCount toward the fail-closed rule', () => {
    // clickCount > 0 with nothing readable: the fast tier must be unreachable.
    expect(seedJobAlertTier(sub({ clickCount: 4, lastOpenAt: daysAgo(1) }), NOW).tierDays).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SHAPES 5 and 6 — a click we cannot read, and clicks that are all machines.
describe('the fast tier is unreachable without proof of a person', () => {
  it('never seeds tier 1 from a bare click_count with no event and no url', () => {
    expect(seedJobAlertTier(sub({ click_count: 12 }), NOW).tierDays).toBe(7);
    expect(seedJobAlertTier(sub({ click_count: 12, last_open_at: daysAgo(1) }), NOW).tierDays).toBe(3);
  });

  it('never seeds tier 1 when the events log carries no readable instant', () => {
    const events = [{ url: JOB_AD_URL }, { url: JOB_AD_URL }];
    expect(seedJobAlertTier(sub({ click_count: 2 }), NOW, { clickEvents: events }).tierDays).toBe(7);
  });

  it('never seeds tier 1 when every click was one scanner burst', () => {
    // Eight distinct targets inside a second: the #5674 signature.
    const burst = Array.from({ length: 8 }, (_, i) => ({
      at: daysAgoMs(1) + i * 100,
      url: `https://frontaliereticino.ch/cerca-lavoro-ticino/annuncio-${i}`,
    }));
    expect(seedJobAlertTier(sub({ click_count: 8 }), NOW, { clickEvents: burst }).tierDays).toBe(7);
    // …and an open of its own still only earns tier 3, never 1.
    expect(seedJobAlertTier(sub({ click_count: 8, last_open_at: daysAgo(1) }), NOW, { clickEvents: burst }).tierDays).toBe(3);
  });

  it('reads the ip Resend nests under metadata.data.click, where a flat lookup finds nothing', () => {
    // 74.242.242.134 is the address emailScannerRanges.js records as actually
    // seen in our own click log (`seenAs`), so this fixture is a real scanner
    // and not an invented one. The first draft used an address that is in no
    // range at all: the test went green on tier 1 and would have "proved" a
    // rule that never fired.
    const scanner = [{
      occurred_at: daysAgo(1),
      metadata: { data: { click: { link: JOB_AD_URL, ipAddress: '74.242.242.134', userAgent: 'Mozilla/5.0' } } },
    }];
    expect(seedJobAlertTier(sub({ click_count: 1 }), NOW, { clickEvents: scanner }).tierDays).toBe(7);
    // Same event with the address one level up, where four of the five
    // providers do not write it: the rule must still be reachable there.
    const flat = [{ occurred_at: daysAgo(1), url: JOB_AD_URL, metadata: { ip: '74.242.242.134' } }];
    expect(seedJobAlertTier(sub({ click_count: 1 }), NOW, { clickEvents: flat }).tierDays).toBe(7);
  });

  it('does not treat a click on the way out as engagement — from the real builders', () => {
    for (const url of [makeAlertUnsubscribeUrl('backfill-newsletter', EMAIL), makeAllAlertsUnsubscribeUrl(EMAIL)]) {
      const leaving = sub({ last_click_at: daysAgo(1), last_clicked_url: url, last_open_at: daysAgo(1) });
      expect(seedJobAlertTier(leaving, NOW).tierDays).toBe(7);
      expect(engagedSinceLastJobAlertSend({ ...leaving, ja_cadence_last_sent_at: daysAgo(2) })).toBe(false);
    }
  });

  it('guards against a vacuous suite: the builders really produce the opt-out route', () => {
    expect(makeAlertUnsubscribeUrl('backfill-newsletter', EMAIL)).toContain('/disiscrivi-alert/');
    expect(makeAllAlertsUnsubscribeUrl(EMAIL)).toContain('action=unsubscribe_all');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('promotion is immediate, demotion is slow', () => {
  const sentAtIso = new Date(NOW).toISOString();

  it('sends a human click straight to tier 1 and clears both counters', () => {
    const next = nextJobAlertCadenceState({
      sub: sub({ ja_cadence_tier: 7, ja_cadence_sends_since_engagement: 2, ja_cadence_weekly_sends: 5, ja_cadence_last_sent_at: daysAgo(7) }),
      engaged: true,
      sentAtIso,
      provider: 'resend',
    });
    expect(next.ja_cadence_tier).toBe(1);
    expect(next.ja_cadence_sends_since_engagement).toBe(0);
    expect(next.ja_cadence_weekly_sends).toBe(0);
    expect(next.ja_cadence_tier_updated_at).toBe(sentAtIso);
  });

  it('lets an open promote 7 → 3 but never to 1 — Apple prefetches opens', () => {
    const fromWeekly = nextJobAlertCadenceState({
      sub: sub({ ja_cadence_tier: 7, ja_cadence_last_sent_at: daysAgo(7) }),
      engaged: false,
      opened: true,
      sentAtIso,
      provider: 'resend',
    });
    expect(fromWeekly.ja_cadence_tier).toBe(3);
    const fromThree = nextJobAlertCadenceState({
      sub: sub({ ja_cadence_tier: 3, ja_cadence_last_sent_at: daysAgo(3) }),
      engaged: false,
      opened: true,
      sentAtIso,
      provider: 'resend',
    });
    expect(fromThree.ja_cadence_tier).toBe(3); // held, not promoted
    const fromOne = nextJobAlertCadenceState({
      sub: sub({ ja_cadence_tier: 1, ja_cadence_last_sent_at: daysAgo(1) }),
      engaged: false,
      opened: true,
      sentAtIso,
      provider: 'resend',
    });
    expect(fromOne.ja_cadence_tier).toBe(1); // held too — an open never demotes either
  });

  it(`demotes one tier after exactly ${JOB_ALERT_DEMOTION_STREAK} silent sends, and never below 7`, () => {
    let state: Record<string, unknown> = { ja_cadence_tier: 1, ja_cadence_last_sent_at: daysAgo(20) };
    const tiers: number[] = [];
    for (let i = 0; i < 12; i++) {
      state = { ...state, ...nextJobAlertCadenceState({ sub: state, engaged: false, sentAtIso, provider: 'resend' }) };
      tiers.push(state.ja_cadence_tier as number);
    }
    expect(tiers.slice(0, 3)).toEqual([1, 1, 3]);
    expect(tiers.slice(3, 6)).toEqual([3, 3, 7]);
    expect(tiers.slice(6)).toEqual([7, 7, 7, 7, 7, 7]); // floor, forever
  });

  it('never lets any sequence of silence push a live document below 7 or any single open reach 1', () => {
    let state: Record<string, unknown> = { ja_cadence_tier: 7, ja_cadence_last_sent_at: daysAgo(30) };
    for (const opened of [false, false, true, false, false, false, true, false]) {
      state = { ...state, ...nextJobAlertCadenceState({ sub: state, engaged: false, opened, sentAtIso, provider: 'resend' }) };
      expect(JOB_ALERT_CADENCE_TIERS).toContain(state.ja_cadence_tier);
      expect(state.ja_cadence_tier).not.toBe(1);
    }
  });

  it('does not count the very first send as silence', () => {
    const first = nextJobAlertCadenceState({ sub: sub(), engaged: false, sentAtIso, provider: 'resend' });
    expect(first.ja_cadence_sends_since_engagement).toBe(0);
    expect(first.ja_cadence_weekly_sends).toBe(0);
  });

  // SHAPE 12 of the plan — our blind spot must not be charged to the reader.
  it('neither promotes nor demotes nor counts a send the previous provider could not report', () => {
    const before = sub({
      ja_cadence_tier: 7,
      ja_cadence_sends_since_engagement: 2,
      ja_cadence_weekly_sends: 7,
      ja_cadence_last_sent_at: daysAgo(7),
      ja_cadence_last_send_provider: 'cloudflare',
    });
    const next = nextJobAlertCadenceState({ sub: before, engaged: false, sentAtIso, provider: 'cloudflare' });
    expect(next.ja_cadence_tier).toBe(7);
    expect(next.ja_cadence_sends_since_engagement).toBe(2);
    expect(next.ja_cadence_weekly_sends).toBe(7); // NOT 8 — no decay off a blind send
    expect(decayStampAfterSend({ alert: backfilledAlert(), nextState: next, sentAtIso })).toBe(null);
  });

  it('reads engagement against the previous send, not against this one', () => {
    const reacted = sub({ ja_cadence_last_sent_at: daysAgo(3), ...clickedAJob(1) });
    expect(engagedSinceLastJobAlertSend(reacted)).toBe(true);
    const stale = sub({ ja_cadence_last_sent_at: daysAgo(1), ...clickedAJob(3) });
    expect(engagedSinceLastJobAlertSend(stale)).toBe(false);
    expect(openedSinceLastJobAlertSend(sub({ ja_cadence_last_sent_at: daysAgo(3), last_open_at: daysAgo(1) }))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SHAPES 2, 3, 7 and 8 — the terminal state.
describe('decay: terminal, preserved, and counted in sends', () => {
  const sentAtIso = new Date(NOW).toISOString();

  /** Walk a never-engaged recipient through n silent sends on the slowest tier. */
  function afterSilentSends(n: number) {
    let state: Record<string, unknown> = { ja_cadence_tier: 7, ja_cadence_last_sent_at: daysAgo(7 * (n + 1)) };
    for (let i = 0; i < n; i++) {
      state = { ...state, ...nextJobAlertCadenceState({ sub: state, engaged: false, sentAtIso, provider: 'resend' }) };
    }
    return state;
  }

  it(`does not decay on the ${JOB_ALERT_DECAY_AFTER_SLOW_SENDS - 1}th send`, () => {
    const state = afterSilentSends(JOB_ALERT_DECAY_AFTER_SLOW_SENDS - 1);
    expect(state.ja_cadence_weekly_sends).toBe(JOB_ALERT_DECAY_AFTER_SLOW_SENDS - 1);
    expect(decayStampAfterSend({ alert: backfilledAlert(), nextState: state, sentAtIso })).toBe(null);
  });

  it(`decays on the ${JOB_ALERT_DECAY_AFTER_SLOW_SENDS}th, and records what it decayed on`, () => {
    const state = afterSilentSends(JOB_ALERT_DECAY_AFTER_SLOW_SENDS);
    const stamp = decayStampAfterSend({ alert: backfilledAlert(), nextState: state, sentAtIso });
    expect(stamp).not.toBe(null);
    expect(stamp.cadence_state).toBe(JOB_ALERT_CADENCE_STATES.DECAYED);
    expect(stamp.cadence_sends_at_decay).toBe(JOB_ALERT_DECAY_AFTER_SLOW_SENDS);
    expect(stamp.cadence_decayed_at).toBe(sentAtIso);
    expect(stamp.cadence_decay_reason).toContain(String(JOB_ALERT_DECAY_AFTER_SLOW_SENDS));
  });

  it('writes NOTHING but cadence_* — `active` is not in the stamp at all', () => {
    const stamp = decayStampAfterSend({
      alert: backfilledAlert(),
      nextState: afterSilentSends(JOB_ALERT_DECAY_AFTER_SLOW_SENDS),
      sentAtIso,
    });
    // A decayed alert must stay indistinguishable from a live one on every
    // field the person controls: flipping `active` would make our decision look
    // like theirs, and that is the evidence the terminal state exists to keep.
    expect(Object.keys(stamp).every((k) => k.startsWith('cadence_'))).toBe(true);
    expect(stamp).not.toHaveProperty('active');
    expect(stamp).not.toHaveProperty('paused');
    expect(stamp).not.toHaveProperty('status');
    expect(stamp).not.toHaveProperty('keywords');
  });

  it('counts SENDS, not weeks: a recipient we never mailed cannot decay', () => {
    // 56 days of calendar with no send at all — quota exhausted, newsletter
    // cooldown, whatever. The counter is still zero and nothing decays.
    const never = sub({ ja_cadence_tier: 7, ja_cadence_weekly_sends: 0 });
    expect(decayStampAfterSend({ alert: backfilledAlert(), nextState: never, sentAtIso })).toBe(null);
  });

  it('advances the counter only on the slowest tier, so the trip through 3 is not charged to N', () => {
    const onThree = nextJobAlertCadenceState({
      sub: sub({ ja_cadence_tier: 3, ja_cadence_weekly_sends: 0, ja_cadence_last_sent_at: daysAgo(3) }),
      engaged: false,
      sentAtIso,
      provider: 'resend',
    });
    expect(onThree.ja_cadence_weekly_sends).toBe(0);
  });

  it('resets the counter on an open, so decay only reaches those who never react', () => {
    const woken = nextJobAlertCadenceState({
      sub: sub({ ja_cadence_tier: 7, ja_cadence_weekly_sends: JOB_ALERT_DECAY_AFTER_SLOW_SENDS - 1, ja_cadence_last_sent_at: daysAgo(7) }),
      engaged: false,
      opened: true,
      sentAtIso,
      provider: 'resend',
    });
    expect(woken.ja_cadence_weekly_sends).toBe(0);
    expect(decayStampAfterSend({ alert: backfilledAlert(), nextState: woken, sentAtIso })).toBe(null);
  });

  // SHAPE 7, REVERSED BY THE OWNER ON 2026-08-14. Until that day this test read
  // "decays a backfilled alert and leaves an identically silent person-made one
  // alone" — the D6 asymmetry. The owner extended decay to every alert, so the
  // assertion that used to prove the exemption now proves it is gone. The shape
  // is the one that mattered: an alert a PERSON created, silent for eight weekly
  // sends, which the previous code path returned null for.
  it('decays a person-made alert too, not only a backfilled one (owner, 2026-08-14)', () => {
    const state = afterSilentSends(JOB_ALERT_DECAY_AFTER_SLOW_SENDS);
    expect(decayStampAfterSend({ alert: backfilledAlert(), nextState: state, sentAtIso })).not.toBe(null);
    const made = decayStampAfterSend({ alert: personAlert(), nextState: state, sentAtIso });
    expect(made).not.toBe(null);
    expect(made.cadence_state).toBe(JOB_ALERT_CADENCE_STATES.DECAYED);
    // …and it is still not an opt-out: `active` is not in the stamp for either.
    expect(made).not.toHaveProperty('active');
  });

  it('still never decays a pinned alert, whichever population it belongs to', () => {
    // The one exemption survives the D6 change: `frequencyOverride: true` is an
    // explicit act of the person about their own frequency (254 alerts, 239 of
    // them with no `backfilled_from` at all), and extending decay to everybody
    // must not quietly swallow it.
    const state = afterSilentSends(JOB_ALERT_DECAY_AFTER_SLOW_SENDS);
    for (const alert of [
      backfilledAlert({ frequencyOverride: true }),
      personAlert({ frequencyOverride: true }),
    ]) {
      expect(decayStampAfterSend({ alert, nextState: state, sentAtIso })).toBe(null);
    }
    // `frequencyOverride: false` is a choice too — to be governed by the engine
    // — so it decays like anybody else. 178 production alerts carry it.
    expect(decayStampAfterSend({ alert: personAlert({ frequencyOverride: false }), nextState: state, sentAtIso })).not.toBe(null);
  });

  it('recognises the backfill by the field as well as by the document id', () => {
    // The batch writes the fixed id; the trigger payload carries the field.
    // Either alone is enough, because production has both.
    const byField = personAlert({ backfilled_from: 'newsletter_subscribers:auth_google' });
    const state = afterSilentSends(JOB_ALERT_DECAY_AFTER_SLOW_SENDS);
    expect(decayStampAfterSend({ alert: byField, nextState: state, sentAtIso })).not.toBe(null);
  });

  // SHAPE 2 — just decayed.
  it('stops selecting a decayed alert while it stays active:true', () => {
    const decayed = backfilledAlert({ cadence_state: 'decayed', cadence_decayed_at: daysAgo(1), lastMatchedAt: daysAgo(1) });
    expect(decayed.active).toBe(true);
    expect(isDecayed(decayed)).toBe(true);
    expect(isCadenceSendable(decayed)).toBe(false);
    const decision = isJobAlertDueToday({ alert: decayed, sub: sub(), todayIso: TODAY, nowMs: NOW });
    expect(decision.due).toBe(false);
    expect(decision.decayed).toBe(true);
  });

  // SHAPE 8 — re-entry.
  it('does not let a decayed alert come back on its own, however much time passes or engagement arrives', () => {
    const decayed = backfilledAlert({ cadence_state: 'decayed', cadence_decayed_at: daysAgo(400) });
    const profiles = [sub(), sub(clickedAJob(0)), sub({ last_open_at: daysAgo(0) }), sub({ ja_cadence_tier: 1 })];
    for (const profile of profiles) {
      expect(isJobAlertDueToday({ alert: decayed, sub: profile, todayIso: TODAY, nowMs: NOW }).due).toBe(false);
    }
    // And a second pass never re-stamps it, so cadence_decayed_at keeps
    // pointing at the moment we actually stopped.
    expect(decayStampAfterSend({
      alert: decayed,
      nextState: { ja_cadence_weekly_sends: JOB_ALERT_DECAY_AFTER_SLOW_SENDS + 4 },
      sentAtIso,
    })).toBe(null);
  });

  it('treats an unreadable cadence_state as "do not send", not as "send"', () => {
    // 'DECAYED ' still decays — trimmed and lowercased, it IS the state. The
    // others are not, and on a channel nobody asked for the answer to "I do not
    // know what this field means" is silence.
    expect(cadenceStateOf(backfilledAlert({ cadence_state: 'DECAYED ' }))).toBe(JOB_ALERT_CADENCE_STATES.DECAYED);
    for (const raw of ['paused', 'true', 'expired', '  ', 'activ', '1']) {
      const alert = backfilledAlert({ cadence_state: raw });
      expect(cadenceStateOf(alert), raw).toBe('unknown');
      const decision = isJobAlertDueToday({ alert, sub: sub(), todayIso: TODAY, nowMs: NOW });
      expect(decision.due, raw).toBe(false);
      expect(decision.decayed, raw).toBe(false); // unknown is not decayed: do not claim we retired them
    }
    // Absent and literally-empty are the same thing: a document written before
    // this engine existed, which must keep receiving whatever it received.
    expect(cadenceStateOf(backfilledAlert())).toBe(JOB_ALERT_CADENCE_STATES.ACTIVE);
    expect(cadenceStateOf(backfilledAlert({ cadence_state: '' }))).toBe(JOB_ALERT_CADENCE_STATES.ACTIVE);
    expect(cadenceStateOf(backfilledAlert({ cadence_state: null }))).toBe(JOB_ALERT_CADENCE_STATES.ACTIVE);
    expect(cadenceStateOf(backfilledAlert({ cadence_state: 'active' }))).toBe(JOB_ALERT_CADENCE_STATES.ACTIVE);
  });

  it('calls a recipient decayed only when EVERY alert they hold is', () => {
    const decayed = (email: string) => backfilledAlert({ email, cadence_state: 'decayed' });
    const live = (email: string) => personAlert({ email });
    const set = recipientsWithAllAlertsDecayed([
      decayed('all@example.test'),
      decayed('all@example.test'),
      decayed('mixed@example.test'),
      live('mixed@example.test'), // one alert they created themselves is still running
      live('none@example.test'),
    ]);
    expect([...set]).toEqual(['all@example.test']);
    expect(recipientsWithAllAlertsDecayed([])).toEqual(new Set());
    // Order must not matter: the live alert can come first or last.
    expect(recipientsWithAllAlertsDecayed([live('m@x.test'), decayed('m@x.test')]).size).toBe(0);
    expect(recipientsWithAllAlertsDecayed([decayed('m@x.test'), live('m@x.test')]).size).toBe(0);
  });

  it('withholds the sunset re-probe from a decayed subscriber — the quieter mechanism wins', () => {
    const longSilent = {
      status: 'inactive',
      open_count: 0,
      click_count: 0,
      inactive_at: daysAgo(400),
      delivered_count: 30,
      createdAt: daysAgo(500),
    };
    expect(classifyJobAlertSunset(longSilent, NOW).action).toBe('reprobe');
    expect(classifyJobAlertSunset(longSilent, NOW, { cadenceDecayed: true }).action).toBe('none');
    expect(classifyJobAlertSunset(longSilent, NOW, { cadenceDecayed: true }).reason).toContain('cadence decayed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TWO SEND SLOTS A DAY (owner, 2026-08-14) — and one email.
//
// The protection is in the STATE, never in the spacing of the two crons: this
// repo's 00:33 slot has a measured dispatch delay of median 240 minutes and max
// 590, so two slots that look comfortably apart overlap on a bad morning. The
// shapes below are the ones a "they are far enough apart" design never sees.
describe('a second slot on the same day sends nothing twice', () => {
  const MORNING = Date.parse('2026-08-13T04:33:00Z'); // slot 1, after the median slip
  const AFTERNOON = Date.parse('2026-08-13T16:41:00Z'); // slot 2, after its own slip

  it('refuses an alert the first slot already served today, on the alert clock', () => {
    const alert = backfilledAlert({ lastMatchedAt: new Date(MORNING).toISOString() });
    expect(alreadyServedToday({ alert, sub: sub(), todayIso: TODAY, nowMs: AFTERNOON }).served).toBe(true);
    expect(isJobAlertDueToday({ alert, sub: sub(), todayIso: TODAY, nowMs: AFTERNOON }).due).toBe(false);
  });

  it('refuses on the recipient clock too, so a second alert of theirs is not the second email', () => {
    const profile = sub({ ja_cadence_last_sent_at: new Date(MORNING).toISOString() });
    // A different alert of the same person, never sent itself.
    expect(isJobAlertDueToday({ alert: personAlert({ id: 'x9' }), sub: profile, todayIso: TODAY, nowMs: AFTERNOON }).due).toBe(false);
  });

  // THE CASE THE OWNER NAMED: scheduled, and not gone yet.
  it('treats a send that is scheduled and has not left yet as already due', () => {
    // computeScheduledSendAt aimed this at the recipient's preferred hour
    // TOMORROW, because the hour had already passed when slot 1 ran. Nothing has
    // been delivered; a second slot that only looked at "was it sent" would
    // stack another message on top of it.
    const alert = backfilledAlert({
      lastMatchedAt: daysAgo(1),
      cadence_scheduled_for: '2026-08-14T02:12:00Z',
    });
    const verdict = alreadyServedToday({ alert, sub: sub(), todayIso: TODAY, nowMs: AFTERNOON });
    expect(verdict.served).toBe(true);
    expect(verdict.reason).toContain('has not left yet');
    expect(isJobAlertDueToday({ alert, sub: sub(), todayIso: TODAY, nowMs: AFTERNOON, ceilingDays: null }).due).toBe(false);
  });

  it('also refuses when the scheduled instant has already passed but fell on today', () => {
    // Slot 1 ran at 00:40 and aimed at 02:12 today; slot 2 runs at 16:41. The
    // message is gone, and it is today's.
    const alert = backfilledAlert({ lastMatchedAt: daysAgo(1), cadence_scheduled_for: '2026-08-13T02:12:00Z' });
    expect(alreadyServedToday({ alert, sub: sub(), todayIso: TODAY, nowMs: AFTERNOON }).served).toBe(true);
  });

  it('does NOT refuse on a schedule stamp from a previous run days ago', () => {
    // The fail-closed field must not become a permanent gag: an old stamp is
    // spent, and the interval gate takes over from there.
    const alert = backfilledAlert({ lastMatchedAt: daysAgo(7), cadence_scheduled_for: daysAgo(7) });
    expect(alreadyServedToday({ alert, sub: sub(), todayIso: TODAY, nowMs: AFTERNOON }).served).toBe(false);
    expect(isJobAlertDueToday({ alert, sub: sub(), todayIso: TODAY, nowMs: AFTERNOON }).due).toBe(true);
  });

  it('treats an unreadable schedule stamp as a send in flight, not as no send', () => {
    const alert = backfilledAlert({ lastMatchedAt: daysAgo(7), cadence_scheduled_for: 'whenever' });
    const verdict = alreadyServedToday({ alert, sub: sub(), todayIso: TODAY, nowMs: AFTERNOON });
    expect(verdict.served).toBe(true);
    expect(verdict.reason).toContain('unreadable');
  });

  it('protects a manually pinned daily alert too, through its own alert clock', () => {
    // The RECIPIENT clock is deliberately skipped for a pin — the two live on
    // separate clocks — so if the guard depended on it a pinned alert would be
    // the one shape two slots could double-send.
    const pinned = backfilledAlert({
      frequencyOverride: true,
      frequency: 'daily',
      lastMatchedAt: new Date(MORNING).toISOString(),
    });
    expect(isJobAlertDueToday({ alert: pinned, sub: sub(), todayIso: TODAY, nowMs: AFTERNOON }).due).toBe(false);
    // …and it is still due the NEXT day, which is what a pin means.
    expect(isJobAlertDueToday({ alert: pinned, sub: sub(), todayIso: '2026-08-14', nowMs: AFTERNOON + 86400000 }).due).toBe(true);
  });

  it('reads the camelCase spelling of the recipient clock, where a miss means a SECOND email', () => {
    // 458 production documents on this channel carry only camelCase stamps
    // (#5673). Everywhere else a missed spelling reads as "no signal"; here it
    // reads as "never sent today", which is the fail-OPEN direction and the one
    // that mails somebody twice.
    const camel = sub({ jaCadenceLastSentAt: new Date(MORNING).toISOString() });
    expect(alreadyServedToday({ alert: personAlert(), sub: camel, todayIso: TODAY, nowMs: AFTERNOON }).served).toBe(true);
    const camelSchedule = sub({ jaCadenceScheduledFor: '2026-08-14T02:12:00Z' });
    expect(alreadyServedToday({ alert: personAlert(), sub: camelSchedule, todayIso: TODAY, nowMs: AFTERNOON }).served).toBe(true);
  });

  it('records the scheduled instant on every send, null included, so no stamp is ever stale', () => {
    const scheduled = nextJobAlertCadenceState({
      sub: sub({ ja_cadence_last_sent_at: daysAgo(7) }),
      engaged: false,
      sentAtIso: new Date(MORNING).toISOString(),
      provider: 'resend',
      scheduledFor: '2026-08-14T02:12:00Z',
    });
    expect(scheduled.ja_cadence_scheduled_for).toBe('2026-08-14T02:12:00Z');
    const immediate = nextJobAlertCadenceState({
      sub: sub({ ja_cadence_last_sent_at: daysAgo(7), ja_cadence_scheduled_for: '2026-08-14T02:12:00Z' }),
      engaged: false,
      sentAtIso: new Date(MORNING).toISOString(),
      provider: 'resend',
    });
    // Explicitly null, NOT absent: a merge that omitted the field would leave
    // yesterday's future instant in place and hold the recipient silent until
    // it passed.
    expect(immediate).toHaveProperty('ja_cadence_scheduled_for', null);
  });

  it('gives the same due set for both slots of the same day, whatever the state', () => {
    for (const { name, alert, sub: profile } of [
      { name: 'never sent', alert: backfilledAlert(), sub: sub() },
      { name: 'sent this morning', alert: backfilledAlert({ lastMatchedAt: new Date(MORNING).toISOString() }), sub: sub() },
      { name: 'sent a week ago', alert: backfilledAlert({ lastMatchedAt: daysAgo(7) }), sub: sub() },
      { name: 'scheduled for tomorrow', alert: backfilledAlert({ lastMatchedAt: daysAgo(7), cadence_scheduled_for: '2026-08-14T02:12:00Z' }), sub: sub() },
    ]) {
      const slotOne = isJobAlertDueToday({ alert, sub: profile, todayIso: TODAY, nowMs: MORNING });
      const slotTwo = isJobAlertDueToday({ alert, sub: profile, todayIso: TODAY, nowMs: AFTERNOON });
      // Same answer both times — which is what makes running the gate twice in
      // one day safe. The one that matters is "sent this morning": in the real
      // run slot 2 reads the stamp slot 1 wrote, and must then say no.
      expect(slotOne.due, name).toBe(slotTwo.due);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// COMING BACK (owner, 2026-08-14). A decayed alert returns to life on its own
// when the person returns to the site — with the seven refusals he approved.
describe('a decayed alert comes back when the person does', () => {
  const NOW_ISO = new Date(NOW).toISOString();
  const UID = 'firebase-uid-9f2c';
  const READER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

  /** A backfilled alert we retired ten days ago, still active:true. */
  function decayed(overrides: Record<string, unknown> = {}) {
    return backfilledAlert({
      userId: UID,
      lastMatchedAt: daysAgo(10),
      cadence_state: JOB_ALERT_CADENCE_STATES.DECAYED,
      cadence_decayed_at: daysAgo(10),
      cadence_decay_reason: `no human signal in ${JOB_ALERT_DECAY_AFTER_SLOW_SENDS} weekly sends`,
      cadence_sends_at_decay: JOB_ALERT_DECAY_AFTER_SLOW_SENDS,
      ...overrides,
    });
  }

  /** The root document with a visit stamp that passes every filter. */
  function visited(overrides: Record<string, unknown> = {}) {
    return sub({
      userId: UID,
      status: 'active',
      ja_cadence_tier: 7,
      ja_cadence_weekly_sends: JOB_ALERT_DECAY_AFTER_SLOW_SENDS,
      ja_cadence_last_sent_at: daysAgo(10),
      last_site_visit_at: daysAgo(1),
      last_site_visit_uid: UID,
      last_site_visit_ua: READER_UA,
      last_site_visit_entry: JOB_AD_URL,
      last_site_visit_visible: true,
      last_site_visit_prerender: false,
      ...overrides,
    });
  }

  const decide = (alert: unknown, profile: unknown, newsletter: unknown = null) =>
    reactivationAfterReturnVisit({ alert, sub: profile, newsletter, nowIso: NOW_ISO });

  it('brings it back, and keeps the record of why we had stopped', () => {
    const verdict = decide(decayed(), visited());
    expect(verdict.reactivate).toBe(true);
    expect(verdict.alertFields.cadence_state).toBe(JOB_ALERT_CADENCE_STATES.ACTIVE);
    expect(verdict.alertFields.cadence_reactivated_at).toBe(NOW_ISO);
    // The evidence of what WE did is not erased by what THEY did: the decay
    // stamp is the record we would show an authority, and a reactivation is one
    // more fact on top of it, not a rewrite of it.
    expect(verdict.alertFields).not.toHaveProperty('cadence_decayed_at');
    expect(verdict.alertFields).not.toHaveProperty('cadence_decay_reason');
    // And it never touches the flags the person controls.
    expect(verdict.alertFields).not.toHaveProperty('active');
    expect(verdict.alertFields).not.toHaveProperty('paused');
  });

  it('is not theatre: the reactivated alert survives the next send instead of re-decaying at once', () => {
    // The decay counter is at N by construction. Without the reset the very next
    // send would re-stamp the terminal state and the person would get exactly
    // one email for having come back.
    const verdict = decide(decayed(), visited());
    const alert = { ...decayed(), ...verdict.alertFields };
    const profile = { ...visited(), ...verdict.subFields };
    expect(isJobAlertDueToday({ alert, sub: profile, todayIso: TODAY, nowMs: NOW }).due).toBe(true);
    const next = nextJobAlertCadenceState({ sub: profile, engaged: false, sentAtIso: NOW_ISO, provider: 'resend' });
    expect(next.ja_cadence_weekly_sends).toBe(1);
    expect(decayStampAfterSend({ alert, nextState: next, sentAtIso: NOW_ISO })).toBe(null);
  });

  it('does not promote them: a page view is not a click', () => {
    // "Engagement is a measurement, and a measurement is never permission."
    // Coming back resets the counters and leaves the TIER exactly where the
    // person's own signal put it — which also keeps this write free of side
    // effects on their other alerts, since these fields are per recipient.
    const verdict = decide(decayed(), visited());
    expect(verdict.subFields).not.toHaveProperty('ja_cadence_tier');
    expect(verdict.subFields.ja_cadence_weekly_sends).toBe(0);
    expect(verdict.subFields.ja_cadence_sends_since_engagement).toBe(0);
  });

  // ── the seven refusals ───────────────────────────────────────────────────

  it('refuses an anonymous visit — there is nobody to reactivate', () => {
    const verdict = decide(decayed(), visited({ last_site_visit_uid: null }));
    expect(verdict.reactivate).toBe(false);
    expect(verdict.verdict).toBe(RETURN_VISIT_VERDICTS.ANONYMOUS);
  });

  it('refuses a session that started on the unsubscribe link — from the real builder', () => {
    for (const url of [makeAlertUnsubscribeUrl('backfill-newsletter', EMAIL), makeAllAlertsUnsubscribeUrl(EMAIL)]) {
      const verdict = decide(decayed(), visited({ last_site_visit_entry: url }));
      expect(verdict.reactivate, url).toBe(false);
      expect(verdict.verdict, url).toBe(RETURN_VISIT_VERDICTS.OPT_OUT_ENTRY);
    }
  });

  it('refuses a crawler and an automation client', () => {
    expect(decide(decayed(), visited({ last_site_visit_ua: 'Mozilla/5.0 (compatible; Googlebot/2.1)' })).verdict)
      .toBe(RETURN_VISIT_VERDICTS.CRAWLER_AGENT);
    expect(decide(decayed(), visited({ last_site_visit_ua: 'python-requests/2.31.0' })).verdict)
      .toBe(RETURN_VISIT_VERDICTS.AUTOMATION_AGENT);
  });

  it('refuses a prefetch', () => {
    expect(decide(decayed(), visited({ last_site_visit_prerender: true })).verdict).toBe(RETURN_VISIT_VERDICTS.PREFETCH);
    expect(decide(decayed(), visited({ last_site_visit_visible: false })).verdict).toBe(RETURN_VISIT_VERDICTS.PREFETCH);
  });

  it('NEVER brings back an alert the person switched off, however perfect the visit', () => {
    // This is the whole reason decay does not touch `active`. If it did, these
    // two documents would be one shape and this branch could not exist.
    for (const alert of [decayed({ active: false }), decayed({ paused: true })]) {
      const verdict = decide(alert, visited());
      expect(verdict.reactivate).toBe(false);
      expect(verdict.verdict).toBe(JOB_ALERT_REACTIVATION_BLOCKS.SWITCHED_OFF);
    }
  });

  it('refuses a suppressed address, on either document', () => {
    for (const status of ['bounced', 'complained', 'suppressed', 'inactive']) {
      const verdict = decide(decayed(), visited({ status }));
      expect(verdict.verdict, status).toBe(JOB_ALERT_REACTIVATION_BLOCKS.SUPPRESSED);
    }
  });

  it('refuses when the NEWSLETTER document records an opt-out — the #5688 shape', () => {
    // A person who clicked "disiscriviti" leaves no trace at all on the
    // job-alert document: 127 of 127 addresses suppressed after an LPD
    // complaint still had active alerts. Both recorded forms are tried, because
    // an opt-out is a status OR an append-only stamp.
    for (const newsletter of [{ status: 'unsubscribed' }, { status: 'active', unsubscribed_at: daysAgo(3) }, { status: 'bounced' }]) {
      const verdict = decide(decayed(), visited(), newsletter);
      expect(verdict.reactivate, JSON.stringify(newsletter)).toBe(false);
      expect(verdict.verdict, JSON.stringify(newsletter)).toBe(JOB_ALERT_REACTIVATION_BLOCKS.CHANNEL_OPT_OUT);
    }
    // …and a later, explicit re-opt-in is not an opt-out.
    expect(decide(decayed(), visited(), { status: 'active', unsubscribed_at: daysAgo(9), resubscribed_at: daysAgo(2) }).reactivate).toBe(true);
  });

  // ── the identity binding, which is what makes the stamp a fact ───────────

  it('refuses a visit whose identity does not match the owner of the alert', () => {
    expect(decide(decayed(), visited({ last_site_visit_uid: 'somebody-else' })).verdict)
      .toBe(JOB_ALERT_REACTIVATION_BLOCKS.UNIDENTIFIED);
    // A backfilled alert whose subscriber never signed in carries userId: null.
    // It can never be reactivated this way — the fail-closed answer to "we do
    // not know who this is" — and keeps the preference-centre exit like anyone.
    expect(decide(decayed({ userId: null }), visited({ userId: null })).verdict)
      .toBe(JOB_ALERT_REACTIVATION_BLOCKS.UNIDENTIFIED);
  });

  it('accepts the identity from the root document when the alert has none', () => {
    expect(decide(decayed({ userId: null }), visited()).reactivate).toBe(true);
  });

  // ── fail-closed, and idempotent across the two slots of the day ──────────

  it('refuses a document with no visit stamp at all', () => {
    const verdict = decide(decayed(), sub({ userId: UID, status: 'active' }));
    expect(verdict.reactivate).toBe(false);
    expect(verdict.verdict).toBe(RETURN_VISIT_VERDICTS.NO_VISIT);
  });

  it('refuses a visit that predates the decay — otherwise the first run would undo it', () => {
    // The stamp was already on the document when we retired the alert. Reading
    // it as a return would make the terminal state impossible to reach.
    expect(decide(decayed(), visited({ last_site_visit_at: daysAgo(11) })).verdict)
      .toBe(JOB_ALERT_REACTIVATION_BLOCKS.STALE_VISIT);
    expect(decide(decayed({ cadence_decayed_at: null }), visited()).verdict)
      .toBe(JOB_ALERT_REACTIVATION_BLOCKS.STALE_VISIT);
  });

  it('acts on a visit exactly once, so the second slot of the day is a no-op', () => {
    const first = decide(decayed(), visited());
    expect(first.reactivate).toBe(true);
    // Slot 2 reads what slot 1 wrote. Without the consumed stamp it would write
    // the same reactivation again — and, worse, reset the decay counter a
    // second time off a visit that is days old.
    const afterSlotOne = { ...visited(), ...first.subFields };
    const alertAfter = { ...decayed(), ...first.alertFields };
    expect(decide(alertAfter, afterSlotOne).verdict).toBe(JOB_ALERT_REACTIVATION_BLOCKS.NOT_DECAYED);
    // …and even if the alert somehow decays again later, the SAME visit cannot
    // resurrect it a second time.
    const decayedAgain = { ...alertAfter, cadence_state: JOB_ALERT_CADENCE_STATES.DECAYED, cadence_decayed_at: daysAgo(2) };
    expect(decide(decayedAgain, afterSlotOne).verdict).toBe(JOB_ALERT_REACTIVATION_BLOCKS.ALREADY_CONSUMED);
  });

  it('does nothing at all to an alert that is not decayed, or whose state it cannot read', () => {
    expect(decide(backfilledAlert(), visited()).verdict).toBe(JOB_ALERT_REACTIVATION_BLOCKS.NOT_DECAYED);
    expect(decide(backfilledAlert(), visited()).alertFields).toBe(null);
    // An unreadable state is NOT repaired into `active` by a visit: we do not
    // know what it means, and guessing would be a fail-open write.
    const unknown = decide(backfilledAlert({ cadence_state: 'wat' }), visited());
    expect(unknown.reactivate).toBe(false);
    expect(unknown.verdict).toBe(JOB_ALERT_REACTIVATION_BLOCKS.NOT_DECAYED);
  });

  it('reads the whole visit stamp in camelCase too', () => {
    const camel = sub({
      userId: UID,
      status: 'active',
      ja_cadence_weekly_sends: JOB_ALERT_DECAY_AFTER_SLOW_SENDS,
      lastSiteVisitAt: daysAgo(1),
      lastSiteVisitUid: UID,
      lastSiteVisitUa: READER_UA,
      lastSiteVisitEntry: JOB_AD_URL,
      lastSiteVisitVisible: true,
      lastSiteVisitPrerender: false,
    });
    expect(decide(decayed(), camel).reactivate).toBe(true);
    // and the consumed stamp is honoured in camelCase as well, or the second
    // slot would act on the same visit again.
    expect(decide(decayed(), { ...camel, jaCadenceReturnVisitConsumedAt: daysAgo(0) }).verdict)
      .toBe(JOB_ALERT_REACTIVATION_BLOCKS.ALREADY_CONSUMED);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the sender actually consumes the engine', () => {
  // Read as TEXT, never imported: send-job-alerts.mjs pulls ~12 files under
  // data/ and public/ at module scope, so importing it here would be red in a
  // sparse worktree and green in CI. This is also the only guard that catches
  // the failure mode of #5767 — a module that is correct, tested, and simply
  // never called. `jobAlertEngagementTier.mjs` sat unconsumed for weeks with a
  // green suite because nothing asserted the import existed.
  const senderSource = fs.readFileSync(
    path.resolve(__dirname, '../scripts/send-job-alerts.mjs'),
    'utf-8',
  );

  it('imports the cadence engine and calls the gate', () => {
    expect(senderSource).toContain("from './lib/jobAlertCadence.mjs'");
    expect(senderSource).toContain('isJobAlertDueToday(');
    expect(senderSource).toContain('nextJobAlertCadenceState(');
    expect(senderSource).toContain('decayStampAfterSend(');
  });

  it('calls the reactivation rule, and calls it BEFORE the cadence gate', () => {
    // A module that is correct, tested and never called is exactly how
    // jobAlertEngagementTier.mjs sat unconsumed for weeks under a green suite
    // (#5767). And the ORDER is load-bearing: an alert reactivated after the
    // gate has run would come back and then wait a whole interval before its
    // first send, which is not "torna attivo quando la persona torna".
    expect(senderSource).toContain('reactivationAfterReturnVisit(');
    expect(senderSource.indexOf('reactivationAfterReturnVisit('))
      .toBeLessThan(senderSource.indexOf('isJobAlertDueToday('));
  });

  it('records the scheduled instant on both clocks, which is what makes two slots safe', () => {
    // Without these two writes the guard in alreadyServedToday has nothing to
    // read, and a second daily slot stacks a message on top of one that has not
    // left yet — the case the owner named.
    expect(senderSource).toContain('cadence_scheduled_for:');
    expect(senderSource).toContain('scheduledFor: scheduleOutcomes.get(email)?.scheduledFor');
  });

  it('no longer carries the millisecond intervals the calendar gate replaced', () => {
    expect(senderSource).not.toContain('WEEKLY_INTERVAL_MS');
    expect(senderSource).not.toContain('ENGAGEMENT_TIER_EVERY_OTHER_DAY_INTERVAL_MS');
  });

  it('never writes `active` on an alert document', () => {
    // The decay must be indistinguishable from nothing on every field the
    // person controls. This is a grep, and a grep is a blunt instrument — but
    // the alternative here is a Firestore mock of the whole send path, and the
    // property being protected is exactly the kind a mock stops noticing.
    expect(senderSource).not.toMatch(/\bactive:\s*(true|false)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('invariants the whole population has to satisfy', () => {
  // Every shape above, in one bag, plus the awkward ones.
  const population = [
    { name: 'backfilled, never engaged', alert: backfilledAlert(), sub: sub() },
    { name: 'backfilled, clicked a job', alert: backfilledAlert(), sub: sub(clickedAJob(1)) },
    { name: 'backfilled, only opened', alert: backfilledAlert(), sub: sub({ last_open_at: daysAgo(2) }) },
    { name: 'backfilled, clicked the way out', alert: backfilledAlert(), sub: sub({ last_click_at: daysAgo(1), last_clicked_url: makeAllAlertsUnsubscribeUrl(EMAIL) }) },
    { name: 'backfilled, unreadable click', alert: backfilledAlert(), sub: sub({ click_count: 9 }) },
    { name: 'backfilled, camelCase', alert: backfilledAlert(), sub: sub({ lastOpenAt: daysAgo(1), clickCount: 2 }) },
    { name: 'backfilled, pinned daily', alert: backfilledAlert({ frequencyOverride: true, frequency: 'daily' }), sub: sub() },
    { name: 'backfilled, pinned weekly', alert: backfilledAlert({ frequencyOverride: true, frequency: 'weekly' }), sub: sub() },
    { name: 'backfilled, decayed', alert: backfilledAlert({ cadence_state: 'decayed' }), sub: sub() },
    { name: 'backfilled, unreadable state', alert: backfilledAlert({ cadence_state: 'wat' }), sub: sub() },
    { name: 'person-made, clicked a job', alert: personAlert(), sub: sub(clickedAJob(1)) },
    { name: 'person-made, never engaged', alert: personAlert(), sub: sub() },
    { name: 'person-made, blind provider only', alert: personAlert(), sub: sub({ ja_cadence_last_send_provider: 'cloudflare' }) },
    { name: 'empty document', alert: backfilledAlert(), sub: {} },
  ];

  it('partitions every alert into exactly one of: decayed, unsendable, or an interval on the scale', () => {
    for (const { name, alert, sub: profile } of population) {
      const decision = isJobAlertDueToday({ alert, sub: profile, todayIso: TODAY, nowMs: NOW });
      const sendable = isCadenceSendable(alert);
      const buckets = [
        decision.decayed,
        !sendable && !decision.decayed,
        sendable && JOB_ALERT_CADENCE_TIERS.includes(decision.intervalDays),
      ].filter(Boolean);
      expect(buckets.length, name).toBe(1);
    }
  });

  it('never serves anybody more often than they are served today', () => {
    // Today's gate, per engine tier: none on daily (1 calendar day), 36h on the
    // open tier (every other day with one cron slot), 7 days on weekly.
    const todayInterval: Record<string, number> = {
      [JOB_ALERT_ENGAGEMENT_TIERS.DAILY]: 1,
      [JOB_ALERT_ENGAGEMENT_TIERS.OPEN_EVERY_OTHER_DAY]: 2,
      [JOB_ALERT_ENGAGEMENT_TIERS.WEEKLY]: 7,
    };
    for (const { name, alert, sub: profile } of population) {
      const decision = resolveJobAlertCadence(alert, profile, NOW);
      if (decision.manual) continue; // pinned: unchanged by construction
      expect(decision.intervalDays, name).toBeGreaterThanOrEqual(todayInterval[decision.tier]);
    }
  });

  it('gives the same answer twice for the same day, whatever hour it is asked', () => {
    for (const { name, alert, sub: profile } of population) {
      const early = isJobAlertDueToday({ alert, sub: profile, todayIso: TODAY, nowMs: Date.parse(`${TODAY}T00:33:00Z`) });
      const late = isJobAlertDueToday({ alert, sub: profile, todayIso: TODAY, nowMs: Date.parse(`${TODAY}T10:23:00Z`) });
      expect(early.due, name).toBe(late.due);
    }
  });
});
