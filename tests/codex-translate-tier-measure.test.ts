// Before/after measurement of the Codex translation tier (lanes and adaptive
// grouping) on the same texts against a simulated Codex — see
// scripts/measure-codex-translate-tier.mjs for the model and its sources.
// Request and token counts are exact; times come from scaled real timers, so
// they are checked with margins.
import { readFileSync } from 'node:fs';
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

// The same three scenarios with REAL Codex (gpt-5.6-luna, effort max, the CI
// broker's function profile), recorded before the merge in
// scripts/measurements/codex-translate-tier-real-2026-09-29.json: before and
// after for every scenario, every text translated in both, and the same
// direction as the simulation.
describe('Codex translation tier — real Codex run, before and after', () => {
  const real = JSON.parse(readFileSync(new URL('../scripts/measurements/codex-translate-tier-real-2026-09-29.json', import.meta.url), 'utf8'));
  const row = (scenario: string, mode: string) => real.rows.find((r: any) => r.scenario === scenario && r.mode === mode);

  it.each(['article-10-fields-x-3-languages', 'faq-8-texts', 'one-text-at-a-time-10'])('%s: before and after, every text translated', (scenario) => {
    for (const mode of ['before', 'after']) {
      const r = row(scenario, mode);
      expect(r, `${scenario}/${mode}`).toBeTruthy();
      expect(r.translated).toBe(r.texts);
      expect(r.requests).toBeGreaterThan(0);
      expect(r.wallSeconds).toBeGreaterThan(0);
      expect(r.inputTokens).toBeGreaterThan(0);
    }
  });

  it('texts sent together: fewer requests, less wall time and fewer input tokens', () => {
    for (const scenario of ['article-10-fields-x-3-languages', 'faq-8-texts']) {
      const before = row(scenario, 'before');
      const after = row(scenario, 'after');
      expect(after.requests).toBeLessThan(before.requests);
      expect(after.wallSeconds).toBeLessThan(before.wallSeconds);
      expect(after.inputTokens).toBeLessThan(before.inputTokens);
    }
  });

  it('one text at a time: the same requests', () => {
    expect(row('one-text-at-a-time-10', 'after').requests).toBe(row('one-text-at-a-time-10', 'before').requests);
  });
});
