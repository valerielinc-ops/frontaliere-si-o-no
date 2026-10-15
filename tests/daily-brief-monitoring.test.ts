// The cadence's own measurements — issue #5415 §3.5 (seed) and §3.10 (monitoring).
import { describe, expect, it } from 'vitest';

import { planSeed } from '@/scripts/seed-daily-brief-tiers.mjs';
import { summarize } from '@/scripts/report-daily-brief-cadence.mjs';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-08-08T06:33:00Z');
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString();

describe('seeding the population', () => {
  // §3.5 option B, against the measured population: 3.242 of 8.311 subscribers
  // clicked in the last 30 days. Option A ("everyone daily") would have sent ~7k
  // a day to ~5k people who had not.
  it('splits the population by the history the webhooks already wrote', () => {
    const rows = [
      { email: 'clicker@x.it', doc: { status: 'confirmed', last_click_at: daysAgo(3) } },
      { email: 'opener@x.it', doc: { status: 'confirmed', last_open_at: daysAgo(4) } },
      { email: 'silent@x.it', doc: { status: 'confirmed' } },
    ];
    const { writes } = planSeed(rows, NOW);
    expect(writes.map((w) => w.tier)).toEqual([1, 3, 7]);
  });

  // Idempotence is the whole point: a partial run must be resumable and a full
  // rerun must be a no-op.
  it('never overwrites a tier the engine moved or the reader pinned', () => {
    const rows = [
      { email: 'moved@x.it', doc: { status: 'confirmed', daily_brief_tier: 5 } },
      { email: 'pinned@x.it', doc: { status: 'confirmed', daily_brief_frequency_override: 'weekly' } },
      { email: 'fresh@x.it', doc: { status: 'confirmed', last_click_at: daysAgo(1) } },
    ];
    const { writes, skipped } = planSeed(rows, NOW);
    expect(writes.map((w) => w.email)).toEqual(['fresh@x.it']);
    expect(skipped).toMatchObject({ alreadySeeded: 1, pinned: 1 });
  });

  // #5674: the seed is the step that put 433 people on the daily tier, and 73
  // of them got there on clicks that were all synthetic. The classifier runs on
  // whatever evidence the row carries — the one click the document remembers,
  // or the whole history when a caller has read it.
  it('does not seed to daily on a click no human made', () => {
    const optOutUrl = 'https://frontaliereticino.ch/?action=unsubscribe&email=a%40example.com&token=x';
    const rows = [
      { email: 'unsub@x.it', doc: { status: 'confirmed', last_click_at: daysAgo(2), last_clicked_url: optOutUrl } },
      { email: 'reader@x.it', doc: { status: 'confirmed', last_click_at: daysAgo(2), last_clicked_url: 'https://frontaliereticino.ch/statistiche' } },
      {
        email: 'scanned@x.it',
        doc: { status: 'confirmed', last_click_at: daysAgo(2), last_open_at: daysAgo(2) },
        // A Safe Links sweep: every link of the message inside one second.
        clickEvents: Array.from({ length: 6 }, (_, i) => ({
          at: NOW - (2 * DAY) + (i * 120),
          url: `https://frontaliereticino.ch/de/jobs-im-tessin/annuncio-${i}`,
          metadata: { ip: '74.242.242.134' },
        })),
      },
    ];
    const { writes } = planSeed(rows, NOW);
    expect(writes.map((w) => `${w.email}:${w.tier}`)).toEqual(['unsub@x.it:7', 'reader@x.it:1', 'scanned@x.it:3']);
  });

  it('leaves out unsubscribed and suppressed addresses', () => {
    const rows = [
      { email: 'gone@x.it', doc: { status: 'unsubscribed', last_click_at: daysAgo(1) } },
      { email: 'bounced@x.it', doc: { status: 'bounced' } },
      { email: 'ok@x.it', doc: { status: 'confirmed', last_click_at: daysAgo(1) } },
    ];
    const { writes, skipped } = planSeed(rows, NOW);
    expect(writes.map((w) => w.email)).toEqual(['ok@x.it']);
    expect(skipped.excluded).toBe(2);
  });
});

describe('the cadence report', () => {
  const subscribers = [
    { email: 'a@x.it', doc: { status: 'confirmed', daily_brief_tier: 1 } },
    { email: 'b@x.it', doc: { status: 'confirmed', daily_brief_tier: 7 } },
    { email: 'c@x.it', doc: { status: 'confirmed', daily_brief_frequency_override: 'off' } },
    { email: 'd@x.it', doc: { status: 'complained', daily_brief_tier: 7 } },
  ];

  it('reports the tier population, the pins and the volume they imply', () => {
    const report = summarize(subscribers, []);
    expect(report.tierPopulation).toEqual({ 1: 1, 7: 2 });
    expect(report.overrides).toEqual({ off: 1 });
    expect(report.estimatedDailyVolume).toBe(1); // 1/1 + 2/7 ≈ 1.29
    expect(report.complaintRate).toBeCloseTo(0.25, 5);
  });

  // The number that says whether the tiers mean anything: if the daily tier does
  // not out-click the weekly one, the classifier is not classifying.
  it('reports CTR per tier from brief deliveries only', () => {
    const report = summarize(subscribers, [
      { email: 'a@x.it', campaign_id: 'daily-brief-2026-08-08', sent_at: '2026-08-08T06:00:00Z', clicked_at: '2026-08-08T07:00:00Z' },
      { email: 'b@x.it', campaign_id: 'daily-brief-2026-08-08', sent_at: '2026-08-08T06:00:00Z', clicked_at: null },
      // The weekly's delivery must not count toward the brief's CTR.
      { email: 'b@x.it', campaign_id: 'newsletter-2026-W32', sent_at: '2026-08-07T03:00:00Z', clicked_at: '2026-08-07T04:00:00Z' },
    ]);
    expect(report.briefSent).toBe(2);
    expect(report.ctrByTier).toEqual({ 1: 1, 7: 0 });
  });

  // §3.3, measured after the fact rather than trusted: the delivery docs carry
  // campaign_id + sent_at for every channel, so "nobody got two in a day" is a scan.
  it('counts recipients who got more than one email in a UTC day, across channels', () => {
    const report = summarize(subscribers, [
      { email: 'a@x.it', campaign_id: 'daily-brief-2026-08-08', sent_at: '2026-08-08T06:00:00Z' },
      { email: 'a@x.it', campaign_id: 'newsletter-2026-W32', sent_at: '2026-08-08T09:00:00Z' },
      { email: 'b@x.it', campaign_id: 'daily-brief-2026-08-08', sent_at: '2026-08-08T06:00:00Z' },
      { email: 'b@x.it', campaign_id: 'job-alerts-2026-08-07', sent_at: '2026-08-07T00:33:00Z' },
    ]);
    expect(report.doubleSendDays).toBe(1);
    expect(report.doubleSendSamples[0]).toEqual({ key: 'a@x.it|2026-08-08', emails: 2 });
  });

  it('reports a clean run as clean', () => {
    const report = summarize(subscribers, [
      { email: 'a@x.it', campaign_id: 'daily-brief-2026-08-08', sent_at: '2026-08-08T06:00:00Z' },
      { email: 'b@x.it', campaign_id: 'newsletter-2026-W32', sent_at: '2026-08-07T09:00:00Z' },
    ]);
    expect(report.doubleSendDays).toBe(0);
  });
});
