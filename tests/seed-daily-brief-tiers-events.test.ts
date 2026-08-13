// #5716 item 2 — `planSeed`/`seedTier` already knew how to classify a full
// click history via `row.clickEvents` (the seam from PR #5697), but nothing
// in `scripts/seed-daily-brief-tiers.mjs` ever READ the `events` subcollection
// to populate it, so every seed ran on the single-event fallback
// (`last_click_at` + `last_clicked_url`). `attachClickEvents()` closes that:
// it reads each row's `events` subcollection (via the row's own Firestore
// doc ref) before `planSeed` runs.
//
// The scenario below is the one `seedTier`'s own comment measures: a
// subscriber's MOST RECENT click is the unsubscribe link, but an EARLIER
// click in their full history was a real article — a person who read
// something, then later left. The single-click fallback can only see the
// opt-out click (synthetic, `humanCount: 0`) and drops the subscriber to
// tier 7 ("never opened or clicked"). The full history correctly finds the
// earlier human click and seeds tier 1. That is the retroactive-removal gap
// this item closes: without `attachClickEvents`, `row.clickEvents` stays
// `undefined`, `seedTier` falls back to the single event, and the earlier
// human click is invisible.
import { describe, expect, it } from 'vitest';

import { attachClickEvents, planSeed } from '@/scripts/seed-daily-brief-tiers.mjs';

const NOW_MS = Date.parse('2026-08-13T06:00:00Z');
const DAY_MS = 86_400_000;
const OPT_OUT_URL = 'https://frontaliereticino.ch/newsletter/disiscriviti?e=x';
const ARTICLE_URL = 'https://frontaliereticino.ch/blog/qualche-articolo';

/** A fake Firestore doc ref exposing only what attachClickEvents() calls. */
function fakeRef(events: Array<Record<string, unknown>>) {
  return {
    collection(name: string) {
      if (name !== 'events') throw new Error(`unexpected subcollection: ${name}`);
      return { async get() { return { docs: events.map((e) => ({ data: () => e })) }; } };
    },
  };
}

describe('attachClickEvents reads the events subcollection into row.clickEvents', () => {
  it('populates clickEvents from the row ref, in bounded-concurrency order-independent fashion', async () => {
    const events = [{ at: NOW_MS - DAY_MS, url: ARTICLE_URL }];
    const rows = [
      { email: 'a@example.test', doc: {}, ref: fakeRef(events) },
      { email: 'b@example.test', doc: {}, ref: fakeRef([]) },
    ];
    await attachClickEvents(rows as any);
    expect(rows[0].clickEvents).toEqual(events);
    expect(rows[1].clickEvents).toEqual([]);
  });

  it('a row with no ref gets clickEvents: null instead of throwing', async () => {
    const rows = [{ email: 'c@example.test', doc: {} }];
    await attachClickEvents(rows as any);
    expect((rows[0] as any).clickEvents).toBeNull();
  });
});

describe('retroactive synthetic-click removal actually reaches the seed now (#5716 item 2)', () => {
  const docWithLaterOptOut = {
    status: 'confirmed',
    last_click_at: NOW_MS - DAY_MS, // the single field the old fallback reads
    last_clicked_url: OPT_OUT_URL,   // …is the opt-out link
  };
  const fullHistory = [
    { at: NOW_MS - 2 * DAY_MS, url: ARTICLE_URL }, // earlier: a real read
    { at: NOW_MS - DAY_MS, url: OPT_OUT_URL },       // later: the opt-out click
  ];

  it('REGRESSION GUARD — without clickEvents, the earlier human click is invisible and the seed is tier 7', () => {
    const { writes } = planSeed([{ email: 'a@example.test', doc: docWithLaterOptOut }], NOW_MS);
    expect(writes[0].tier).toBe(7);
    expect(writes[0].reason).toMatch(/never opened or clicked/);
  });

  it('WITH clickEvents handed to planSeed directly, the earlier human click seeds tier 1', () => {
    const { writes } = planSeed(
      [{ email: 'a@example.test', doc: docWithLaterOptOut, clickEvents: fullHistory }],
      NOW_MS,
    );
    expect(writes[0].tier).toBe(1);
    expect(writes[0].reason).toMatch(/^clicked/);
  });

  it('END TO END — attachClickEvents() + planSeed() together correct the pre-fix seed, from a fake Firestore ref', async () => {
    const rows = [{ email: 'a@example.test', doc: docWithLaterOptOut, ref: fakeRef(fullHistory) }];
    await attachClickEvents(rows as any);
    const { writes } = planSeed(rows as any, NOW_MS);
    expect(writes[0].tier).toBe(1);
  });

  it('a subscriber whose FULL history is only synthetic still correctly drops out (no false promotion)', async () => {
    const onlySynthetic = [
      { at: NOW_MS - 3 * DAY_MS, url: OPT_OUT_URL },
      { at: NOW_MS - DAY_MS, url: OPT_OUT_URL },
    ];
    const rows = [{ email: 'd@example.test', doc: docWithLaterOptOut, ref: fakeRef(onlySynthetic) }];
    await attachClickEvents(rows as any);
    const { writes } = planSeed(rows as any, NOW_MS);
    expect(writes[0].tier).toBe(7);
  });
});
