// The sender's cadence pipeline — issue #5415 §3.3, §3.6, §3.8, §3.9.
//
// tests/daily-brief-cadence.test.ts covers the state machine in isolation; this
// covers the part that decides who is in this morning's batch, which is where
// the ordering between the gates matters.
import { describe, expect, it } from 'vitest';

import { applyCadence, cadenceStateOf } from '@/scripts/send-daily-brief.mjs';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-08-08T06:33:00Z');
const TODAY = '2026-08-08';
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString();

const FULL_BRIEF = { counts: { availableBlocks: 4 } };
const THIN_BRIEF = { counts: { availableBlocks: 3 } };

// Since #5679 the consent ceiling clamps every tier, and a document that does
// not carry `consent_max_frequency_days` defaults to weekly. These tests are
// about the batching, so the helper pins the ceiling out of the way; the block
// at the bottom passes `null` to exercise the default.
const recipient = (email: string, nlDoc: Record<string, unknown> | null = {}, jaDoc: Record<string, unknown> | null = null) =>
  ({
    email,
    locale: 'it',
    name: null,
    source: 'newsletter',
    nlDoc: nlDoc === null ? null : { consent_max_frequency_days: 1, ...nlDoc },
    jaDoc,
  });

const run = (recipients: unknown[], brief = FULL_BRIEF, briefClickAtByEmail: Map<string, number> | null = null) =>
  applyCadence(recipients, { brief, todayIso: TODAY, nowMs: NOW, briefClickAtByEmail });

describe('who gets this morning\'s edition', () => {
  it('sends to everyone due and nobody else', () => {
    const { due, stats } = run([
      recipient('due@x.it', { daily_brief_tier: 1, daily_brief_last_sent_at: daysAgo(1) }),
      recipient('early@x.it', { daily_brief_tier: 7, daily_brief_last_sent_at: daysAgo(2) }),
      recipient('new@x.it', { last_click_at: daysAgo(2) }),
    ]);
    expect(due.map((r) => r.email)).toEqual(['due@x.it', 'new@x.it']);
    expect(stats.notDue).toBe(1);
  });

  it('leaves out anyone who turned the channel off', () => {
    const { due, stats } = run([recipient('off@x.it', { daily_brief_frequency_override: 'off' })]);
    expect(due).toEqual([]);
    expect(stats.off).toBe(1);
  });

  // §3.3: the invariant is max one email per recipient per UTC day across every
  // channel. The brief READS the other channels' timestamps and stands down.
  it('stands down when another channel already emailed this person today', () => {
    const { due, stats } = run([
      recipient('nl@x.it', { daily_brief_tier: 1, last_sent_at: `${TODAY}T03:33:00Z` }),
      recipient('ja@x.it', { daily_brief_tier: 1 }, { last_sent_at: `${TODAY}T00:33:00Z` }),
      recipient('drip@x.it', { daily_brief_tier: 1, drip_last_sent_at: `${TODAY}T05:00:00Z` }),
      recipient('clear@x.it', { daily_brief_tier: 1, last_sent_at: '2026-08-07T03:33:00Z' }),
    ]);
    expect(due.map((r) => r.email)).toEqual(['clear@x.it']);
    expect(stats.crossChannel).toBe(3);
    expect(stats.crossChannelBy).toEqual({ newsletter: 1, 'job-alert': 1, drip: 1 });
  });

  // §3.9: a two-block morning is worth an email to the people effectively asking
  // for it daily, and not to someone on a weekly cadence.
  it('sends a thin edition only to the fastest tiers', () => {
    const { due, stats } = run([
      recipient('daily@x.it', { daily_brief_tier: 1, daily_brief_last_sent_at: daysAgo(1) }),
      recipient('weekly@x.it', { daily_brief_tier: 7, daily_brief_last_sent_at: daysAgo(9) }),
    ], THIN_BRIEF);
    expect(due.map((r) => r.email)).toEqual(['daily@x.it']);
    expect(stats.thinEdition).toBe(1);
  });

  // §3.6 + §3.8: the cut used to be `slice(0, cap)` over an alphabetical list,
  // so ~2.500 addresses at the end of the alphabet would never have received a
  // single edition. Sorting by tier means capacity, if it still bites, bites the
  // people who asked for the least.
  it('orders by tier so a capacity cut cannot starve the same tail forever', () => {
    const { due } = run([
      recipient('zulu@x.it', { daily_brief_tier: 1, daily_brief_last_sent_at: daysAgo(1) }),
      recipient('alpha@x.it', { daily_brief_tier: 7, daily_brief_last_sent_at: daysAgo(8) }),
      recipient('bravo@x.it', { daily_brief_tier: 3, daily_brief_last_sent_at: daysAgo(4) }),
    ]);
    expect(due.map((r) => r.email)).toEqual(['zulu@x.it', 'bravo@x.it', 'alpha@x.it']);
  });

  it('reports the tier population and the due split', () => {
    const { stats } = run([
      recipient('a@x.it', { daily_brief_tier: 1, daily_brief_last_sent_at: daysAgo(1) }),
      recipient('b@x.it', { daily_brief_tier: 1, daily_brief_last_sent_at: daysAgo(0) }),
      recipient('c@x.it', { daily_brief_tier: 7, daily_brief_last_sent_at: daysAgo(7) }),
    ]);
    expect(stats.tierPopulation).toEqual({ 1: 2, 7: 1 });
    expect(stats.dueByTier).toEqual({ 1: 1, 7: 1 });
  });
});

describe('engagement attribution', () => {
  it('prefers a brief-attributed click to the subscriber-level one', () => {
    const sub = { daily_brief_tier: 3, daily_brief_last_sent_at: daysAgo(3), last_click_at: daysAgo(1) };
    const withoutAttribution = run([recipient('r@x.it', sub)]);
    expect(withoutAttribution.due[0].engaged).toBe(true);

    // Attribution says that recent click was on the weekly, not the bulletin.
    const attributed = new Map([['r@x.it', Date.parse(daysAgo(9))]]);
    expect(run([recipient('r@x.it', sub)], FULL_BRIEF, attributed).due[0].engaged).toBe(false);
  });

  it('reads the job-alert doc when the person has no newsletter history', () => {
    const state = cadenceStateOf(recipient('ja@x.it', null, { last_click_at: daysAgo(2) }));
    expect(state.last_click_at).toBe(daysAgo(2));
    // …which is what keeps a job-alert-only subscriber off the weekly floor —
    // as an ENGINE estimate. Since #5679 the delivered cadence is still weekly
    // for them, because there is no newsletter document to carry a consent
    // ceiling and the absence is read as weekly.
    const verdict = run([recipient('ja@x.it', null, { last_click_at: daysAgo(2) })]).due[0].cadence;
    expect(verdict).toMatchObject({ tierDays: 7, consentCapped: true });
  });

  it('keeps the daily_brief_* state on the newsletter doc only', () => {
    const state = cadenceStateOf(recipient('x@x.it', { daily_brief_tier: 5 }, { daily_brief_tier: 1 }));
    expect(state.daily_brief_tier).toBe(5);
  });

  // #5674: the pair (`last_click_at`, `last_clicked_url`) is only usable if both
  // halves come from the SAME document. Projecting the timestamp from one and
  // the URL from the other would let a job-alert unsubscribe hide behind a
  // newsletter click, or the reverse.
  it('projects the clicked URL from the same document as the timestamp', () => {
    const nlOnly = cadenceStateOf(recipient('a@x.it',
      { last_click_at: daysAgo(1), last_clicked_url: 'https://frontaliereticino.ch/statistiche' },
      { last_click_at: daysAgo(9), last_clicked_url: 'https://frontaliereticino.ch/?action=unsubscribe&email=a%40example.com' }));
    expect(nlOnly.last_clicked_url).toBe('https://frontaliereticino.ch/statistiche');

    const jaOnly = cadenceStateOf(recipient('b@x.it', {},
      { last_click_at: daysAgo(1), last_clicked_url: 'https://frontaliereticino.ch/?action=unsubscribe&email=b%40example.com' }));
    expect(jaOnly.last_clicked_url).toContain('action=unsubscribe');
  });

  // The whole #5674 chain, end to end through the sender: an unsubscribe click
  // reaches `applyCadence` as the only click on file and must not read as
  // engagement, because engagement promotes immediately.
  it('does not report an unsubscribe click as engagement', () => {
    const sub = {
      daily_brief_tier: 3,
      daily_brief_last_sent_at: daysAgo(3),
      last_click_at: daysAgo(1),
      last_clicked_url: 'https://frontaliereticino.ch/?action=unsubscribe&email=r%40example.com&token=x',
    };
    expect(run([recipient('r@x.it', sub)]).due[0].engaged).toBe(false);
  });

  it('forwards the consent ceiling so the engine can be clamped by it', () => {
    const state = cadenceStateOf(recipient('c@x.it', { consent_max_frequency_days: 7, daily_brief_tier: 1 }));
    expect(state.consent_max_frequency_days).toBe(7);
    const { due, stats } = run([
      recipient('weekly-consent@x.it', { consent_max_frequency_days: 7, daily_brief_tier: 1, daily_brief_last_sent_at: daysAgo(2) }),
    ]);
    expect(due).toEqual([]);
    expect(stats.tierPopulation).toEqual({ 7: 1 });
  });
});

// Resume-log chunking moved to scripts/lib/campaignResumeLog.mjs when the
// weekly newsletter started sharing it — see tests/campaign-resume-log.test.ts.
