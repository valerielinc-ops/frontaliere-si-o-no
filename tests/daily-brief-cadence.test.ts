// Adaptive send cadence for the daily brief — issue #5415 §3.
//
// Everything here is the pure module: no Firestore, no clock. The point of the
// design is that "does this person get an edition today?" is a function of
// their stored fields and the day, so a rerun, a second cron slot and a dry-run
// all compute the same answer.
import { describe, expect, it } from 'vitest';

import {
  CONSENT_DEFAULT_MAX_FREQUENCY_DAYS,
  DAILY_BRIEF_TIERS,
  DEMOTION_STREAK,
  EMAIL_SCANNER_IP_RANGES,
  SCAN_BURST_MIN_TARGETS,
  blockedByAnotherChannelToday,
  classifyClickEvents,
  consentCeilingDays,
  consentMaxFrequencyDays,
  engagedSinceLastSend,
  estimateDailyVolume,
  ipInCidr,
  isDueToday,
  isOptOutLink,
  lastHumanClickAtMs,
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

// Since #5679 no cadence question has an answer without a consent ceiling:
// `resolveTier` clamps to it, and a document that does not carry the field
// defaults to weekly. The fixtures below are about the cadence MECHANICS, so
// they pin the ceiling out of the way; the ceiling itself has its own block.
const CONSENT_DAILY = { consent_max_frequency_days: 1 };

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
    const verdict = resolveTier({ ...CONSENT_DAILY, daily_brief_tier: 5, last_click_at: daysAgo(1) }, NOW);
    expect(verdict).toMatchObject({ tierDays: 5, source: 'state' });
  });

  // §3.7: the user's explicit choice beats the algorithm, verbatim — the same
  // precedent as the job-alert frequencyOverride.
  it('lets a pinned frequency beat the engine', () => {
    const sub = { ...CONSENT_DAILY, daily_brief_tier: 1, daily_brief_frequency_override: 'weekly', last_click_at: daysAgo(0) };
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
    expect(isDueToday({ ...CONSENT_DAILY, last_click_at: daysAgo(2) }, TODAY, NOW)).toMatchObject({ due: true, tierDays: 1 });
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
    const sub = { ...CONSENT_DAILY, daily_brief_tier: 1, daily_brief_last_sent_at: daysAgo(1) };
    const morning = isDueToday(sub, TODAY, Date.parse('2026-08-08T06:33:00Z'));
    const midMorning = isDueToday(sub, TODAY, Date.parse('2026-08-08T09:33:00Z'));
    expect(morning).toEqual(midMorning);

    // After the first slot served them, the second slot must not send again.
    const served = { ...sub, daily_brief_last_sent_at: '2026-08-08T06:40:00Z' };
    expect(isDueToday(served, TODAY, Date.parse('2026-08-08T09:33:00Z')).due).toBe(false);
  });

  it('counts calendar days, not 24h windows, so a 05:00 send does not block the next morning', () => {
    const sub = { ...CONSENT_DAILY, daily_brief_tier: 1, daily_brief_last_sent_at: '2026-08-07T23:50:00Z' };
    expect(isDueToday(sub, TODAY, NOW).due).toBe(true);
  });

  // #5870 locks in TODAY's answer on purpose, without changing it: an unreadable
  // `daily_brief_last_sent_at` is indistinguishable here from "never sent" (both
  // collapse through `toMillis`/`utcDayOf` to null), and flipping that to
  // fail-closed is a product decision the issue says needs a production count of
  // how many `newsletter_subscribers` actually carry a stamp like this — not
  // available in this environment. This test exists so a future change to the
  // branch below is a deliberate diff against a documented baseline, not a
  // silent one.
  it('#5870: reads an unreadable last-send stamp as "never sent" (deliberately unchanged)', () => {
    const sub = { ...CONSENT_DAILY, daily_brief_tier: 1, daily_brief_last_sent_at: 'not-a-timestamp' };
    const verdict = isDueToday(sub, TODAY, NOW);
    expect(verdict.due).toBe(true);
    expect(verdict.reason).toContain('never sent');
  });

  // #5870: a message the cascade accepted for LATER delivery today must not
  // read as "sent" to the second cron slot just because it left this run's
  // hands — this is the gap the issue found: the 06:33 slot hands a message to
  // the ESP with a future `scheduledAt`, and without this guard the 09:33 slot
  // (or 06:33 tomorrow, before the ESP actually delivers) has no way to tell
  // that apart from an edition nobody is waiting on.
  describe('#5870: the scheduled-but-not-sent guard', () => {
    it('holds off both cron slots while a scheduled send has not left yet', () => {
      const scheduledFor = '2026-08-08T11:00:00Z'; // later today, after both 06:33 and 09:33
      const sub = { ...CONSENT_DAILY, daily_brief_tier: 1, daily_brief_scheduled_for: scheduledFor };
      const morning = isDueToday(sub, TODAY, Date.parse('2026-08-08T06:33:00Z'));
      const midMorning = isDueToday(sub, TODAY, Date.parse('2026-08-08T09:33:00Z'));
      expect(morning).toMatchObject({ due: false, waitDays: 0 });
      expect(morning.reason).toContain('has not left yet');
      expect(midMorning).toMatchObject({ due: false, waitDays: 0 });
    });

    it('stops blocking once the scheduled instant is in the past', () => {
      const sub = { ...CONSENT_DAILY, daily_brief_tier: 1, daily_brief_scheduled_for: daysAgo(3), daily_brief_last_sent_at: daysAgo(3) };
      expect(isDueToday(sub, TODAY, NOW).due).toBe(true);
    });

    it('treats an unreadable scheduled stamp as a send in flight, fail-closed', () => {
      const sub = { ...CONSENT_DAILY, daily_brief_tier: 1, daily_brief_scheduled_for: 'whenever' };
      const verdict = isDueToday(sub, TODAY, NOW);
      expect(verdict.due).toBe(false);
      expect(verdict.reason).toContain('unreadable scheduled stamp');
    });

    it('does not block on a null scheduled_for (the shape every send now writes)', () => {
      const sub = { ...CONSENT_DAILY, daily_brief_tier: 1, daily_brief_scheduled_for: null, daily_brief_last_sent_at: daysAgo(2) };
      expect(isDueToday(sub, TODAY, NOW).due).toBe(true);
    });
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

  // #5870: written on EVERY call, null included — a stale future stamp left
  // over from a prior scheduled send must not survive into the new state and
  // gag a recipient who is otherwise due.
  it('#5870: writes daily_brief_scheduled_for verbatim, and explicit null when omitted', () => {
    const withSchedule = nextCadenceState({
      sub: { daily_brief_tier: 1 }, engaged: false, sentAtIso, provider: 'mailgun',
      scheduledFor: '2026-08-08T09:00:00Z',
    });
    expect(withSchedule.daily_brief_scheduled_for).toBe('2026-08-08T09:00:00Z');

    const stale = { daily_brief_tier: 1, daily_brief_scheduled_for: '2026-08-09T09:00:00Z' };
    const cleared = nextCadenceState({ sub: stale, engaged: false, sentAtIso, provider: 'mailgun' });
    expect(cleared.daily_brief_scheduled_for).toBeNull();
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

// ─────────────────────────────────────────────────────────────────────────────
// #5674 — a click is not proof a human read anything.
//
// The case in the issue, measured on 2026-08-12: an Exchange Online recipient
// with ATP on, click_count 35, engagement_score 100, level `hot`, whose entire
// history is Safe Links opening every URL of every message at delivery — the
// unsubscribe link included — from 74.242.242.134. `seedTier` read that as an
// enthusiastic reader and put them on the daily edition. The LPD letter arrived
// the next day.
// ─────────────────────────────────────────────────────────────────────────────
describe('telling a scanner from a reader', () => {
  const at = (iso: string) => Date.parse(iso);

  it('never counts a click on the way out as engagement', () => {
    expect(isOptOutLink('https://frontaliereticino.ch/?action=unsubscribe&email=a%40example.com&token=x')).toBe(true);
    expect(isOptOutLink('https://frontaliereticino.ch/de/abmelden?token=x')).toBe(true);
    // …and does not fire on an article that merely talks about unsubscribing.
    expect(isOptOutLink('https://frontaliereticino.ch/blog/come-disiscriversi-dalle-newsletter')).toBe(false);

    const verdict = classifyClickEvents([
      { at: at('2026-08-10T09:00:00Z'), url: 'https://frontaliereticino.ch/?action=unsubscribe&email=a%40example.com' },
    ]);
    expect(verdict.byReason).toEqual({ 'opt-out-link': 1 });
    expect(verdict.lastHumanClickAtMs).toBeNull();
  });

  // The rule with the best value/risk ratio of the lot, and the one that needs
  // no extra Firestore read: `last_clicked_url` is written beside
  // `last_click_at` by every webhook. On 2026-08-12 that URL was the opt-out
  // link for 68 of the 433 recipients sitting on the daily tier.
  it('does not seed to daily on a lone unsubscribe click', () => {
    const sub = {
      last_click_at: daysAgo(2),
      last_clicked_url: 'https://frontaliereticino.ch/?action=unsubscribe&email=a%40example.com&token=x',
      last_open_at: daysAgo(5),
    };
    expect(lastHumanClickAtMs(sub)).toBeNull();
    expect(seedTier(sub, NOW).tierDays).toBe(3); // the open still counts
    expect(engagedSinceLastSend({ sub: { ...sub, daily_brief_last_sent_at: daysAgo(3) } })).toBe(false);
  });

  it('still reads an ordinary click as a click', () => {
    const sub = { last_click_at: daysAgo(2), last_clicked_url: 'https://frontaliereticino.ch/cerca-lavoro-ticino' };
    expect(seedTier(sub, NOW).tierDays).toBe(1);
  });

  // The 74.242.242.134 burst from the issue, shortened: every link of the
  // message inside one second, unsubscribe and social included.
  it('reads a same-second sweep of every link as a scan, not a read', () => {
    const burst = ['/de/statistiken', '/de/jobs-im-tessin', '/de/service-vergleich/chf-eur', '/de/jobs-im-tessin/volg', '/de/jobs-im-tessin/lidl', '/de/jobs-im-tessin/hilti']
      .map((path, i) => ({ at: at('2026-07-06T06:03:57Z') + (i * 120), url: `https://frontaliereticino.ch${path}`, metadata: { ip: '74.242.242.134' } }));
    const verdict = classifyClickEvents(burst);
    expect(verdict.humanCount).toBe(0);
    expect(verdict.lastHumanClickAtMs).toBeNull();
    // The IP range answers first here, but the burst rule would have caught it
    // alone — which is the point of having both.
    expect(classifyClickEvents(burst.map((e) => ({ ...e, metadata: { ip: '203.0.113.9' } }))).humanCount).toBe(0);
  });

  // The calibration, stated as a test: five distinct targets in three seconds is
  // a scan; four is not, and neither is a person opening links about one a
  // second. The measured population sits either side of that line — 381 of 433
  // never exceed one target per second, the scanners do 9 or 10 inside one.
  it('leaves a fast reader alone and takes the rate above them', () => {
    const targets = (n: number, spacingMs: number) => Array.from({ length: n }, (_, i) => ({
      at: at('2026-06-01T10:00:00Z') + (i * spacingMs),
      url: `https://frontaliereticino.ch/cerca-lavoro-ticino/annuncio-${i}`,
    }));
    // Seven links at about one a second: a person opening tabs.
    expect(classifyClickEvents(targets(7, 1100)).humanCount).toBe(7);
    // One under the threshold, packed into a single second: still left alone.
    expect(classifyClickEvents(targets(SCAN_BURST_MIN_TARGETS - 1, 50)).humanCount).toBe(SCAN_BURST_MIN_TARGETS - 1);
    // At the threshold, the whole window goes.
    expect(classifyClickEvents(targets(SCAN_BURST_MIN_TARGETS, 50)).humanCount).toBe(0);
  });

  // The signal that does not depend on any list: nobody unsubscribes, opens the
  // preferences centre and follows us on LinkedIn in the same three seconds.
  it('reads mutually exclusive links in one window as a scan', () => {
    const t = at('2026-07-04T08:33:52Z');
    const verdict = classifyClickEvents([
      { at: t, url: 'https://frontaliereticino.ch/?action=unsubscribe&email=a%40example.com' },
      { at: t + 300, url: 'https://frontaliereticino.ch/preferenze?token=x' },
      { at: t + 600, url: 'https://www.linkedin.com/company/frontaliere-ticino' },
    ]);
    expect(verdict.humanCount).toBe(0);
    expect(verdict.byReason['scan-burst']).toBe(2);
  });

  it('does not manufacture a burst out of our own duplicate writes', () => {
    // Four of the five providers write the same click twice. Same instant, same
    // target: one click, and the window rule must not see four targets.
    const t = at('2026-07-20T07:18:01.755Z');
    const dupes = Array.from({ length: 6 }, () => ({ at: t, url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/annuncio' }));
    expect(classifyClickEvents(dupes).humanCount).toBe(6);
  });

  it('drops a library user-agent and the providers own bot flag', () => {
    const events = [
      { at: at('2026-07-20T10:37:55Z'), url: 'https://frontaliereticino.ch/en', metadata: { user_agent: 'python-requests/2.32.3' } },
      { at: at('2026-07-20T10:38:55Z'), url: 'https://frontaliereticino.ch/en', metadata: { client_info: { 'client-type': 'library', 'user-agent': 'x' } } },
      { at: at('2026-07-20T10:39:55Z'), url: 'https://frontaliereticino.ch/en', metadata: { user_agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) Safari/604.1' } },
    ];
    const verdict = classifyClickEvents(events);
    expect(verdict.byReason['automation-agent']).toBe(2);
    expect(verdict.humanCount).toBe(1);
  });

  it('matches the scanner ranges as data, and answers false outside them', () => {
    expect(EMAIL_SCANNER_IP_RANGES.length).toBeGreaterThan(0);
    for (const range of EMAIL_SCANNER_IP_RANGES) {
      expect(range, `every range carries its whois provenance: ${range.cidr}`).toMatchObject({
        cidr: expect.stringMatching(/^\d+\.\d+\.\d+\.\d+\/\d+$/),
        org: expect.any(String),
        verified: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      });
    }
    expect(ipInCidr('74.242.242.134', '74.240.0.0/14')).toBe(true);
    expect(ipInCidr('74.242.242.142', '74.240.0.0/14')).toBe(true);
    expect(ipInCidr('93.71.103.4', '74.240.0.0/14')).toBe(false);
    // IPv6 is answered false rather than guessed — the burst rule covers it.
    expect(ipInCidr('2a02:1210:3021:a00:c92b:8dee:b55c:3669', '74.240.0.0/14')).toBe(false);
    expect(ipInCidr('not-an-ip', '74.240.0.0/14')).toBe(false);
  });

  // The self-feeding loop from the issue: one synthetic click per send walks a
  // recipient up the ladder, because promotion is immediate by design.
  it('stops a scanner from promoting a recipient one send at a time', () => {
    let sub: Record<string, unknown> = {
      ...CONSENT_DAILY, daily_brief_tier: 7, daily_brief_last_sent_at: daysAgo(8),
      last_click_at: daysAgo(1),
      last_clicked_url: 'https://frontaliereticino.ch/?action=unsubscribe&email=a%40example.com',
    };
    for (let i = 0; i < 4; i++) {
      const engaged = engagedSinceLastSend({ sub });
      sub = { ...sub, ...nextCadenceState({ sub, engaged, sentAtIso: daysAgo(0), provider: 'mailgun' }) };
    }
    expect(sub.daily_brief_tier).toBe(7);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #5679 — the accepted formula is a ceiling, not a suggestion.
// ─────────────────────────────────────────────────────────────────────────────
describe('the ceiling the accepted consent sets', () => {
  const WEEKLY_FORMULA = 'Accetto di ricevere la newsletter settimanale con aggiornamenti su cambio CHF/EUR, '
    + 'traffico di frontiera e novità fiscali per frontalieri. Posso disiscrivermi in qualsiasi momento.';

  it('reads the periodicity out of the formula, in the four locales', () => {
    expect(consentMaxFrequencyDays(WEEKLY_FORMULA)).toBe(7);
    expect(consentMaxFrequencyDays('I accept the weekly newsletter.')).toBe(7);
    expect(consentMaxFrequencyDays('Ich akzeptiere den wöchentlichen Newsletter.')).toBe(7);
    expect(consentMaxFrequencyDays('J’accepte la newsletter hebdomadaire.')).toBe(7);
    expect(consentMaxFrequencyDays('Accetto di ricevere il bollettino quotidiano.')).toBe(1);
  });

  // The eight formulas on file that name no periodicity ("accetto di ricevere
  // la newsletter per frontalieri") must not have one invented for them.
  it('returns null rather than guessing when the text names no periodicity', () => {
    expect(consentMaxFrequencyDays('Accedendo per salvare un annuncio, accetto di ricevere la newsletter per frontalieri.')).toBeNull();
    expect(consentMaxFrequencyDays('')).toBeNull();
    expect(consentMaxFrequencyDays(null)).toBeNull();
  });

  it('reads an ambiguous formula against the sender', () => {
    expect(consentMaxFrequencyDays('newsletter settimanale, con un riepilogo quotidiano')).toBe(7);
  });

  // The explicit instruction in #5679: the ceiling is computed once and stored,
  // never re-derived from prose at send time — the formula will change, and a
  // regex scattered across the send path is the next silent defect.
  it('reads the STORED ceiling and never the consent text', () => {
    expect(consentCeilingDays({ consent_max_frequency_days: 7 })).toBe(7);
    expect(consentCeilingDays({ consent_max_frequency_days: 1 })).toBe(1);
    // A document whose text says "quotidiano" but whose ceiling was never
    // computed gets the prudent default, not a fresh parse.
    expect(consentCeilingDays({ consent_text: 'bollettino quotidiano' })).toBe(CONSENT_DEFAULT_MAX_FREQUENCY_DAYS);
  });

  // The 8.517 documents with no consent_text at all (#5678). Treating the
  // absence as weekly is the value of the formula we know we showed.
  it('treats a missing ceiling as weekly', () => {
    expect(consentCeilingDays({})).toBe(7);
    expect(consentCeilingDays(null)).toBe(7);
    expect(consentCeilingDays({ consent_max_frequency_days: 0 })).toBe(7);
    expect(resolveTier({ daily_brief_tier: 1, last_click_at: daysAgo(1) }, NOW))
      .toMatchObject({ tierDays: 7, source: 'state', consentCapped: true });
  });

  // The 21 recipients of #5679: a weekly consent and a daily cadence.
  it('holds an engine tier of 1 down to the consented weekly', () => {
    const sub = { consent_max_frequency_days: 7, daily_brief_tier: 1, daily_brief_last_sent_at: daysAgo(3) };
    expect(resolveTier(sub, NOW)).toMatchObject({ tierDays: 7, consentMaxDays: 7, consentCapped: true });
    expect(isDueToday(sub, TODAY, NOW).due).toBe(false);
    expect(isDueToday({ ...sub, daily_brief_last_sent_at: daysAgo(7) }, TODAY, NOW).due).toBe(true);
  });

  it('caps a fresh seed the same way it caps a stored tier', () => {
    const sub = { consent_max_frequency_days: 7, last_click_at: daysAgo(1), last_clicked_url: 'https://frontaliereticino.ch/statistiche' };
    expect(seedTier(sub, NOW).tierDays).toBe(1); // the engine's own estimate is untouched…
    expect(resolveTier(sub, NOW)).toMatchObject({ tierDays: 7, source: 'seed', consentCapped: true });
  });

  it('lets the engine move BELOW the ceiling, just never above it', () => {
    const sub = { consent_max_frequency_days: 1, daily_brief_tier: 5 };
    expect(resolveTier(sub, NOW)).toMatchObject({ tierDays: 5, consentCapped: false });
  });

  // The reader is the party the consent protects: when they ask for the daily
  // edition, the asking IS the consent. Engagement never gets that privilege.
  it('lets the reader lift the ceiling and never lets engagement do it', () => {
    const consented = { consent_max_frequency_days: 7 };
    expect(resolveTier({ ...consented, daily_brief_frequency_override: 'daily', daily_brief_tier: 7 }, NOW))
      .toMatchObject({ tierDays: 1, source: 'override' });
    // …while a hundred clicks cannot.
    expect(resolveTier({ ...consented, daily_brief_tier: 1, last_click_at: daysAgo(0) }, NOW).tierDays).toBe(7);
  });

  it('leaves an opted-out channel off rather than capping it to weekly', () => {
    expect(resolveTier({ consent_max_frequency_days: 7, daily_brief_frequency_override: 'off' }, NOW).tierDays).toBeNull();
  });

  // A monthly consent is below the tier ladder; the ceiling is used raw so the
  // engine cannot round it back up to the coarsest tier it happens to know.
  it('honours a ceiling coarser than the coarsest tier', () => {
    const sub = { consent_max_frequency_days: 30, daily_brief_tier: 7, daily_brief_last_sent_at: daysAgo(10) };
    expect(resolveTier(sub, NOW).tierDays).toBe(30);
    expect(isDueToday(sub, TODAY, NOW).due).toBe(false);
  });

  // The engine tier underneath stays uncapped on purpose: the ceiling is a
  // read-time policy, so a corrected consent changes what people receive
  // without a data migration.
  it('does not write the ceiling into the engine tier', () => {
    const sub = { consent_max_frequency_days: 7, daily_brief_tier: 3, daily_brief_last_sent_at: daysAgo(3), daily_brief_sends_since_engagement: 0 };
    const state = nextCadenceState({ sub, engaged: true, sentAtIso: daysAgo(0), provider: 'mailgun' });
    expect(state.daily_brief_tier).toBe(2);
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
