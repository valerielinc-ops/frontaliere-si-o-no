// Phase 3 (A/B subjects) with REAL Codex (gpt-5.6-luna, effort max, the CI
// broker's function profile, 3 lanes) on the same cohorts and briefings, all
// recorded on 2026-09-29 before the merge:
// - one call per locale × variant, the Theme of #10341 (today's main): the
//   `after` rows of scripts/measurements/newsletter-subject-theme-real-2026-09-29.json;
// - one call per locale for both variants (this change): the `after` rows of
//   scripts/measurements/newsletter-subjects-real-2026-09-29.json.
//
// The trade is explicit: half the requests and input tokens and two arms that
// really differ, for more output (reasoning) tokens and more wall time, since at
// effort max one call for two subjects reasons about three times as long as a
// call for one.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const load = (name: string) => JSON.parse(readFileSync(new URL(`../scripts/measurements/${name}`, import.meta.url), 'utf8'));
const perVariant = load('newsletter-subject-theme-real-2026-09-29.json').rows.filter((r: any) => r.mode === 'after');
const oneCall = load('newsletter-subjects-real-2026-09-29.json').rows.filter((r: any) => r.mode === 'after');
const mean = (rows: any[], key: string) => rows.reduce((n, r) => n + r[key], 0) / rows.length;
const EMOJI = /^\p{Extended_Pictographic}/u;
// Locales whose two arms open with the same emoji, over every run.
const sameOpening = (rows: any[]) => rows.flatMap((r) => ['it', 'en', 'de', 'fr']
  .map((loc) => r.subjects[`${loc}::concreto`].match(EMOJI)?.[0] === r.subjects[`${loc}::curioso`].match(EMOJI)?.[0]));

describe('newsletter subjects — real Codex, one call per variant vs one call per locale', () => {
  it('both designs: an AI subject for every locale and variant, none on the static fallback', () => {
    expect(perVariant.length).toBeGreaterThanOrEqual(2);
    expect(oneCall.length).toBeGreaterThanOrEqual(3);
    for (const r of [...perVariant, ...oneCall]) {
      expect(Object.keys(r.subjects)).toHaveLength(r.locales * r.variants);
      expect(r.onStaticFallback).toEqual([]);
      expect(r.withFixedOpeningWords).toEqual([]);
    }
  });

  it('half the requests and input tokens', () => {
    for (const r of perVariant) expect(r.requests).toBe(r.locales * r.variants);
    for (const r of oneCall) expect(r.requests).toBe(r.locales);
    expect(mean(oneCall, 'inputTokens')).toBeLessThan(mean(perVariant, 'inputTokens') * 0.6);
  });

  it('two arms that differ: separate calls mostly open both arms with the same emoji, one call never does', () => {
    const before = sameOpening(perVariant);
    const after = sameOpening(oneCall);
    expect(before.filter(Boolean).length / before.length).toBeGreaterThanOrEqual(0.5);
    expect(after.filter(Boolean)).toEqual([]);
  });

  it('the cost: more output (reasoning) tokens and more wall time at effort max', () => {
    expect(mean(oneCall, 'outputTokens')).toBeGreaterThan(mean(perVariant, 'outputTokens') * 1.3);
    expect(mean(oneCall, 'wallSeconds')).toBeGreaterThan(mean(perVariant, 'wallSeconds'));
  });
});
