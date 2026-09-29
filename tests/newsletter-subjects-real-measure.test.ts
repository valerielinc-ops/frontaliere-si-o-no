// Phase 3 (A/B subjects) before and after, with REAL Codex (gpt-5.6-luna,
// effort max, the CI broker's function profile, 3 lanes), 3 repetitions each,
// recorded in scripts/measurements/newsletter-subjects-real-2026-09-29.json on
// the same cohorts and briefings: before = origin/main (one call per locale ×
// variant, Theme with the jobs paragraph's fixed opening), after = one call per
// locale for both variants, Theme without the opening.
//
// At effort max the one call reasons about three times as long as a single
// subject: half the requests and input tokens, but more output tokens and wall
// time. That is why this design was NOT shipped (snapshot only).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const real = JSON.parse(readFileSync(new URL('../scripts/measurements/newsletter-subjects-real-2026-09-29.json', import.meta.url), 'utf8'));
const rows = (mode: string) => real.rows.filter((r: any) => r.mode === mode);
const mean = (mode: string, key: string) => rows(mode).reduce((n: number, r: any) => n + r[key], 0) / rows(mode).length;

describe('newsletter subjects — real Codex run, one call per locale', () => {
  it.each(['before', 'after'])('%s: 3 repetitions, an AI subject for every locale and variant', (mode) => {
    expect(rows(mode)).toHaveLength(3);
    for (const r of rows(mode)) {
      expect(Object.keys(r.subjects)).toHaveLength(r.locales * r.variants);
      expect(r.onStaticFallback).toEqual([]);
    }
  });

  it('half the requests and input tokens', () => {
    for (const r of rows('before')) expect(r.requests).toBe(r.locales * r.variants);
    for (const r of rows('after')) expect(r.requests).toBe(r.locales);
    expect(mean('after', 'inputTokens')).toBeLessThan(mean('before', 'inputTokens') * 0.6);
  });

  it('but more output (reasoning) tokens and more wall time at effort max', () => {
    expect(mean('after', 'outputTokens')).toBeGreaterThan(mean('before', 'outputTokens') * 1.5);
    expect(mean('after', 'wallSeconds')).toBeGreaterThan(mean('before', 'wallSeconds'));
  });

  it('no subject repeats the fixed opening word after', () => {
    expect(rows('before').flatMap((r: any) => r.withFixedOpeningWords).length).toBeGreaterThan(0);
    for (const r of rows('after')) expect(r.withFixedOpeningWords).toEqual([]);
  });
});
