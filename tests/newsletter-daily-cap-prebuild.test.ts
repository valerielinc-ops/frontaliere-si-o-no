// The daily cap must trim the audience BEFORE the AI briefings are built.
//
// Run 35075707530 (2026-09-16) built briefings for 7126 subscribers / 3441
// cohorts (Phase 2 = 85 min) and then sent 3833: the other 3293 were rebuilt,
// with fresh AI calls, by the next daily run of the same weekly campaign.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { capSubscribersToDailyLimit } from '@/scripts/send-newsletter.mjs';

const subs = (n: number) => Array.from({ length: n }, (_, i) => ({ email: `s${i}@x.it` }));

describe('capSubscribersToDailyLimit', () => {
  it('keeps the same prefix the post-assembly cap used to send', () => {
    const list = subs(10);
    const { kept, deferred } = capSubscribersToDailyLimit(list, 4);
    // The old cap was emails.slice(0, limit) on a subscriber-ordered list.
    expect(kept).toEqual(list.slice(0, 4));
    expect(deferred).toBe(6);
  });

  it('is a no-op at or below the limit', () => {
    const list = subs(3);
    expect(capSubscribersToDailyLimit(list, 3)).toEqual({ kept: list, deferred: 0 });
    expect(capSubscribersToDailyLimit(list, 5)).toEqual({ kept: list, deferred: 0 });
  });

  it('does not drop anyone when the limit is not a usable number', () => {
    const list = subs(3);
    expect(capSubscribersToDailyLimit(list, Number.NaN).kept).toBe(list);
    expect(capSubscribersToDailyLimit(list, Infinity).kept).toBe(list);
  });

  it('keeps each surviving cohort\'s representative (its first member)', () => {
    const list = [
      { email: 'a@x.it', k: 'it:1' }, { email: 'b@x.it', k: 'it:2' },
      { email: 'c@x.it', k: 'it:1' }, { email: 'd@x.it', k: 'de:1' },
    ];
    const firstOf = (xs: typeof list) => {
      const m = new Map<string, string>();
      for (const x of xs) if (!m.has(x.k)) m.set(x.k, x.email);
      return m;
    };
    const full = firstOf(list);
    const capped = firstOf(capSubscribersToDailyLimit(list, 3).kept);
    for (const [k, rep] of capped) expect(rep).toBe(full.get(k));
  });
});

describe('send pipeline order', () => {
  it('applies the daily cap before Phase 1 (job matching) and Phase 2 (AI briefings)', () => {
    const src = readFileSync(resolve(__dirname, '../scripts/send-newsletter.mjs'), 'utf8');
    const main = src.slice(src.indexOf('async function main()'));
    const cap = main.indexOf('capSubscribersToDailyLimit(subscribers, DAILY_SEND_LIMIT)');
    const phase1 = main.indexOf('Phase 1: Job matching');
    const phase2 = main.indexOf('Phase 2: AI briefings');
    expect(cap).toBeGreaterThan(-1);
    expect(cap).toBeLessThan(phase1);
    expect(cap).toBeLessThan(phase2);
  });
});
