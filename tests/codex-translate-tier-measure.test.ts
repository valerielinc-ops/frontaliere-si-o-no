// Before/after measurement of the Codex translation tier (lanes and adaptive
// grouping) on the same texts against a simulated Codex — see
// scripts/measure-codex-translate-tier.mjs for the model and its sources.
// Request and token counts are exact; times come from scaled real timers, so
// they are checked with margins.
import { describe, expect, it } from 'vitest';

import { measureCodexTranslateTier } from '@/scripts/measure-codex-translate-tier.mjs';

const results = await measureCodexTranslateTier();
const byId = Object.fromEntries(results.map((r: any) => [r.scenario, r]));

describe('Codex translation tier — before, lanes only, after', () => {
  it.each(results.map((r: any) => [r.scenario, r]))('%s: every mode translates every text', (_id, r: any) => {
    for (const mode of ['before', 'lanesOnly', 'after']) expect(r[mode].translated).toBe(r.texts);
  });

  it('BEFORE is one request per text', () => {
    for (const r of results) expect(r.before.requests).toBe(r.texts);
  });

  it('30 article fields at once: fewer requests and tokens, and about half the time', () => {
    const r = byId['article-10-fields-x-3-languages'];
    expect(r.after.requests).toBeLessThanOrEqual(10);
    expect(r.after.inputTokens).toBeLessThan(r.before.inputTokens * 0.4);
    expect(r.after.simulatedSeconds).toBeLessThan(r.before.simulatedSeconds * 0.6);
    expect(r.after.simulatedSeconds).toBeLessThan(r.lanesOnly.simulatedSeconds * 1.1);
  });

  it('8 FAQ texts at once: fewer tokens, and no slower than the lanes alone', () => {
    const r = byId['faq-8-texts'];
    expect(r.after.inputTokens).toBeLessThan(r.before.inputTokens * 0.7);
    expect(r.after.simulatedSeconds).toBeLessThan(r.before.simulatedSeconds * 0.6);
    expect(r.after.simulatedSeconds).toBeLessThan(r.lanesOnly.simulatedSeconds * 1.2);
  });

  it('one text at a time: nothing to group, nothing changes', () => {
    const r = byId['one-text-at-a-time-10'];
    expect(r.after.requests).toBe(r.before.requests);
    expect(r.after.inputTokens).toBe(r.before.inputTokens);
  });
});
