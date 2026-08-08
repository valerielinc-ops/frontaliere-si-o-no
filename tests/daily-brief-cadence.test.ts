// Adaptive send cadence for the daily brief — issue #5415 §3.
//
// Everything here is the pure module: no Firestore, no clock. The point of the
// design is that "does this person get an edition today?" is a function of
// their stored fields and the day, so a rerun, a second cron slot and a dry-run
// all compute the same answer.
import { describe, expect, it } from 'vitest';

import {
  DAILY_BRIEF_TIERS,
  DEMOTION_STREAK,
  blockedByAnotherChannelToday,
  engagedSinceLastSend,
  estimateDailyVolume,
  isDueToday,
  nextCadenceState,
  normalizeTier,
  openedSinceLastSend,
  passesBlockGate,
  resolveTier,
  seedTier,
} from '@/scripts/lib/dailyBriefCadence.mjs';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-08-08T06:33:00Z');
const TODAY = '2026-08-08';
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString();

describe('seeding from the history the webhooks already wrote', () => {
  it('puts a recent clicker on the daily tier', () => {
    expect(seedTier({ last_click_at: daysAgo(3) }, NOW).tierDays).toBe(1);
  });

  it('puts an opener with no click in the middle', () => {
    expect(seedTier({ last_open_at: daysAgo(5) }, NOW).tierDays).toBe(3);
  });

  it('puts silence on weekly', () => {
    expect(seedTier({}, NOW).tierDays).toBe(7);
    expect(seedTier({ last_click_at: daysAgo(45), last_open_at: daysAgo(60) }, NOW).tierDays).toBe(7);
  });

  // §3.2d: Cloudflare has no webhook, so its recipients have no signal because
  // nothing could ever record one. Weekly would be punishing our blind spot.
  it('does not read a blind provider\'s silence as disengagement', () => {
    const verdict = seedTier({ daily_brief_last_send_provider: 'cloudflare' }, NOW);
    expect(verdict.tierDays).toBe(3);
    expect(verdict.reason).toContain('blind provider');
  });
});

describe('resolveTier', () => {
  it('prefers the stored engine tier over a fresh seed', () => {
    const verdict = resolveTier({ daily_brief_tier: 5, last_click_at: daysAgo(1) }, NOW);
    expect(verdict).toMatchObject({ tierDays: 5, source: 'state' });
  });

  // §3.7: the user's explicit choice beats the algorithm, verbatim — the same
  // precedent as the job-alert frequencyOverride.
  it('lets a pinned frequency beat the engine', () => {
    const sub = { daily_brief_tier: 1, daily_brief_frequency_override: 'weekly', last_click_at: daysAgo(0) };
    expect(resolveTier(sub, NOW)).toMatchObject({ tierDays: 7, source: 'override' });
  });

  it('treats "off" as no cadence at all, not as weekly', () => {
    expect(resolveTier({ daily_brief_frequency_override: 'off' }, NOW).tierDays).toBeNull();
  });

  it('snaps a stored value that is not a tier onto one', () => {
    expect(normalizeTier(4)).toBe(3);
    expect(normalizeTier(6)).toBe(5);
    expect(normalizeTier(99)).toBe(7);
    expect(normalizeTier(0)).toBe(1);
    expect(normalizeTier('nonsense')).toBeNull();
  });
});

describe('isDueToday', () => {
  it('sends to someone who has never received one', () => {
    expect(isDueToday({ last_click_at: daysAgo(2) }, TODAY, NOW)).toMatchObject({ due: true, tierDays: 1 });
  });

  it('holds a weekly recipient until the seventh day', () => {
    const sub = { daily_brief_tier: 7, daily_brief_last_sent_at: daysAgo(3) };
    expect(isDueToday(sub, TODAY, NOW)).toMatchObject({ due: false, waitDays: 4 });
    expect(isDueToday({ ...sub, daily_brief_last_sent_at: daysAgo(7) }, TODAY, NOW).due).toBe(true);
  });

  it('never sends to someone who turned the channel off', () => {
    const sub = { daily_brief_frequency_override: 'off', daily_brief_last_sent_at: daysAgo(30) };
    expect(isDueToday(sub, TODAY, NOW).due).toBe(false);
  });

  // The rerun gate, and the two-slot gate: same stored state + same TODAY_ISO
  // must give the same answer, so 06:33 and 09:33 agree and a same-day rerun
  // adds nobody (§3.8, §3.12e).
  it('is stable across reruns and cron slots on the same day', () => {
    const sub = { daily_brief_tier: 1, daily_brief_last_sent_at: daysAgo(1) };
    const morning = isDueToday(sub, TODAY, Date.parse('2026-08-08T06:33:00Z'));
    const midMorning = isDueToday(sub, TODAY, Date.parse('2026-08-08T09:33:00Z'));
    expect(morning).toEqual(midMorning);

    // After the first slot served them, the second slot must not send again.
    const served = { ...sub, daily_brief_last_sent_at: '2026-08-08T06:40:00Z' };
    expect(isDueToday(served, TODAY, Date.parse('2026-08-08T09:33:00Z')).due).toBe(false);
  });

  it('counts calendar days, not 24h windows, so a 05:00 send does not block the next morning', () => {
    const sub = { daily_brief_tier: 1, daily_brief_last_sent_at: '2026-08-07T23:50:00Z' };
    expect(isDueToday(sub, TODAY, NOW).due).toBe(true);
  });
});

describe('promotion and demotion', () => {
  const sentAtIso = '2026-08-08T06:33:00Z';

  it('promotes a tier on any engagement, immediately', () => {
    const state = nextCadenceState({
      sub: { daily_brief_tier: 5, daily_brief_last_sent_at: daysAgo(5), daily_brief_sends_since_engagement: 2 },
      engaged: true, sentAtIso, provider: 'mailgun',
    });
    expect(state.daily_brief_tier).toBe(3);
    expect(state.daily_brief_sends_since_engagement).toBe(0);
    expect(state.daily_brief_tier_updated_at).toBe(sentAtIso);
  });

  it('takes three engagement-free sends to demote one tier', () => {
    let sub: Record<string, unknown> = { daily_brief_tier: 1, daily_brief_last_sent_at: daysAgo(1), daily_brief_sends_since_engagement: 0 };
    for (let i = 1; i < DEMOTION_STREAK; i++) {
      sub = { ...sub, ...nextCadenceState({ sub, engaged: false, sentAtIso, provider: 'mailgun' }) };
      expect(sub.daily_brief_tier, `after ${i} silent sends`).toBe(1);
    }
    sub = { ...sub, ...nextCadenceState({ sub, engaged: false, sentAtIso, provider: 'mailgun' }) };
    expect(sub.daily_brief_tier).toBe(2);
    expect(sub.daily_brief_sends_since_engagement).toBe(0);
  });

  it('never demotes past weekly', () => {
    let sub: Record<string, unknown> = { daily_brief_tier: 7, daily_brief_last_sent_at: daysAgo(7), daily_brief_sends_since_engagement: 0 };
    for (let i = 0; i < 12; i++) {
      sub = { ...sub, ...nextCadenceState({ sub, engaged: false, sentAtIso, provider: 'mailgun' }) };
    }
    expect(sub.daily_brief_tier).toBe(DAILY_BRIEF_TIERS[DAILY_BRIEF_TIERS.length - 1]);
  });

  // The hysteresis, stated as one test: two silent sends then a click leaves the
  // recipient BETTER off than they started, and the counter reset means the next
  // silence starts from zero rather than tipping them over immediately.
  it('resets the demotion counter on any re-engagement', () => {
    let sub: Record<string, unknown> = { daily_brief_tier: 3, daily_brief_last_sent_at: daysAgo(3), daily_brief_sends_since_engagement: 0 };
    sub = { ...sub, ...nextCadenceState({ sub, engaged: false, sentAtIso, provider: 'mailgun' }) };
    sub = { ...sub, ...nextCadenceState({ sub, engaged: false, sentAtIso, provider: 'mailgun' }) };
    expect(sub.daily_brief_sends_since_engagement).toBe(2);

    sub = { ...sub, ...nextCadenceState({ sub, engaged: true, sentAtIso, provider: 'mailgun' }) };
    expect(sub.daily_brief_tier).toBe(2);
    expect(sub.daily_brief_sends_since_engagement).toBe(0);
  });

  // §3.2b: Apple Mail Privacy Protection prefetches inflate opens, so an open
  // is only strong enough to stop the clock, never to promote.
  it('lets an open hold the tier without promoting it', () => {
    const state = nextCadenceState({
      sub: { daily_brief_tier: 3, daily_brief_last_sent_at: daysAgo(3), daily_brief_sends_since_engagement: 2 },
      engaged: false, opened: true, sentAtIso, provider: 'mailgun',
    });
    expect(state.daily_brief_tier).toBe(3);
    expect(state.daily_brief_sends_since_engagement).toBe(0);
  });

  // §3.2d: a send nobody could have reported on is not evidence of anything.
  it('excludes blind-provider sends from the demotion denominator', () => {
    let sub: Record<string, unknown> = {
      daily_brief_tier: 1, daily_brief_last_sent_at: daysAgo(1),
      daily_brief_sends_since_engagement: 0, daily_brief_last_send_provider: 'cloudflare',
    };
    for (let i = 0; i < 5; i++) {
      sub = { ...sub, ...nextCadenceState({ sub, engaged: false, sentAtIso, provider: 'cloudflare' }) };
    }
    expect(sub.daily_brief_tier).toBe(1);
    expect(sub.daily_brief_sends_since_engagement).toBe(0);
  });

  it('does not count the very first send as a silent one', () => {
    const state = nextCadenceState({ sub: { daily_brief_tier: 1 }, engaged: false, sentAtIso, provider: 'mailgun' });
    expect(state.daily_brief_sends_since_engagement).toBe(0);
  });

  it('keeps tracking the engine tier underneath a user override', () => {
    const sub = {
      daily_brief_tier: 3, daily_brief_frequency_override: 'daily',
      daily_brief_last_sent_at: daysAgo(1), daily_brief_sends_since_engagement: 0,
    };
    expect(nextCadenceState({ sub, engaged: true, sentAtIso, provider: 'mailgun' }).daily_brief_tier).toBe(2);
  });
});

describe('engagement signals', () => {
  it('only counts engagement that happened after the last send', () => {
    const sub = { daily_brief_last_sent_at: daysAgo(2), last_click_at: daysAgo(1) };
    expect(engagedSinceLastSend({ sub })).toBe(true);
    expect(engagedSinceLastSend({ sub: { ...sub, last_click_at: daysAgo(3) } })).toBe(false);
    expect(openedSinceLastSend({ daily_brief_last_sent_at: daysAgo(2), last_open_at: daysAgo(1) })).toBe(true);
  });

  it('prefers a brief-attributed click over the subscriber-level one', () => {
    const sub = { daily_brief_last_sent_at: daysAgo(2), last_click_at: daysAgo(1) };
    // Attribution says the recent click was on the weekly, not the brief.
    expect(engagedSinceLastSend({ sub, briefClickAtMs: Date.parse(daysAgo(5)) })).toBe(false);
  });

  it('reports nothing before the first send', () => {
    expect(engagedSinceLastSend({ sub: { last_click_at: daysAgo(1) } })).toBe(false);
  });
});

describe('the "no news, no email" gate', () => {
  it('refuses every tier below two blocks', () => {
    for (const tier of DAILY_BRIEF_TIERS) expect(passesBlockGate(1, tier)).toBe(false);
    expect(passesBlockGate(undefined, 1)).toBe(false);
  });

  it('sends a thin edition only to the people effectively asking daily', () => {
    expect(passesBlockGate(2, 1)).toBe(true);
    expect(passesBlockGate(3, 2)).toBe(true);
    expect(passesBlockGate(3, 3)).toBe(false);
    expect(passesBlockGate(3, 7)).toBe(false);
  });

  it('sends a full edition to everyone due', () => {
    for (const tier of DAILY_BRIEF_TIERS) expect(passesBlockGate(4, tier)).toBe(true);
  });
});

describe('cross-channel invariant: max one email per day', () => {
  it('stands down when the newsletter or a job alert already went out today', () => {
    expect(blockedByAnotherChannelToday({ nlDoc: { last_sent_at: `${TODAY}T03:33:00Z` }, jaDoc: null, todayIso: TODAY }))
      .toEqual({ blocked: true, channel: 'newsletter' });
    expect(blockedByAnotherChannelToday({ nlDoc: null, jaDoc: { last_sent_at: `${TODAY}T00:33:00Z` }, todayIso: TODAY }))
      .toEqual({ blocked: true, channel: 'job-alert' });
    expect(blockedByAnotherChannelToday({ nlDoc: { drip_last_sent_at: `${TODAY}T05:00:00Z` }, jaDoc: null, todayIso: TODAY }))
      .toEqual({ blocked: true, channel: 'drip' });
  });

  it('lets yesterday go', () => {
    expect(blockedByAnotherChannelToday({
      nlDoc: { last_sent_at: '2026-08-07T23:59:00Z' },
      jaDoc: { last_sent_at: '2026-08-07T00:33:00Z' },
      todayIso: TODAY,
    })).toEqual({ blocked: false, channel: null });
  });
});

describe('volume estimation', () => {
  // The measured seed distribution from §3.5/§3.6, against the measured cap.
  it('keeps the seeded population under the cascade cap', () => {
    const volume = estimateDailyVolume({ 1: 3242, 3: 1400, 7: 2351 });
    expect(volume).toBeLessThan(4506);
    expect(volume).toBeGreaterThan(3500);
  });

  it('ignores an off/zero tier bucket', () => {
    expect(estimateDailyVolume({ 1: 10, 0: 999 })).toBe(10);
  });
});
