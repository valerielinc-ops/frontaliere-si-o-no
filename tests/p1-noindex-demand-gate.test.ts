/**
 * P1 noindex plan (2026-10-24): the shared Search Console demand evidence
 * every P1 family reads.
 *
 * The demand evidence fails SAFE: every branch that cannot trust the 90-day
 * page set returns a dormant gate, because a dormant gate keeps the families
 * indexable while a wrongly-active one de-indexes ~80 k URLs in one deploy.
 */

import { describe, it, expect } from 'vitest';

import {
  buildGscDemandEvidence,
  GSC_DEMAND_MIN_IMPRESSED_PATHS,
} from '../build-plugins/shared/trafficEvidenceFilter';

function pages(n: number, extra: Record<string, number> = {}): Record<string, number> {
  const out: Record<string, number> = { ...extra };
  for (let i = 0; i < n; i++) out[`/filler-${i}/`] = 1;
  return out;
}

describe('buildGscDemandEvidence', () => {
  const FULL = GSC_DEMAND_MIN_IMPRESSED_PATHS;

  it('is active on a complete 90-day page set and matches with or without trailing slash', () => {
    const ev = buildGscDemandEvidence({
      windowDays: 90,
      gsc: { pages: pages(FULL, { '/cerca-lavoro-svizzera/ricerca-x/': 4 }) },
    });
    expect(ev.active).toBe(true);
    expect(ev.hasImpressions(['/cerca-lavoro-svizzera/ricerca-x/'])).toBe(true);
    expect(ev.hasImpressions(['/cerca-lavoro-svizzera/ricerca-x'])).toBe(true);
    expect(ev.hasImpressions(['/nope/', '/cerca-lavoro-svizzera/ricerca-x/'])).toBe(true);
    expect(ev.hasImpressions(['/nope/'])).toBe(false);
  });

  it('a Pass-2 truncation does not disable it (the page set is Pass 3)', () => {
    const ev = buildGscDemandEvidence({
      windowDays: 90,
      gsc: {
        error: 'pass2 (query+page): pagination incomplete: reached 250000 row safety cap',
        pages: pages(FULL),
      },
    });
    expect(ev.active).toBe(true);
  });

  it.each([
    ['missing file', null],
    ['window shorter than 90 days', { windowDays: 28, gsc: { pages: pages(FULL) } }],
    ['window absent', { gsc: { pages: pages(FULL) } }],
    ['window longer than 90 days (no per-path date to cut it)', { windowDays: 120, gsc: { pages: pages(FULL + 1) } }],
    ['Pass-3 error', { windowDays: 90, gsc: { error: 'pass3 (page): HTTP 500', pages: pages(FULL) } }],
    ['truncated page set', { windowDays: 90, gsc: { pages: pages(FULL - 1) } }],
    ['no gsc block', { windowDays: 90 }],
  ])('is dormant on %s and then reports no impressions to nobody', (_label, input) => {
    const ev = buildGscDemandEvidence(input as any);
    expect(ev.active).toBe(false);
    expect(ev.dormantReason).not.toBe('');
    if ((input as any)?.windowDays === 120) expect(ev.dormantReason).toMatch(/120d/);
  });

  it('ignores zero-impression rows', () => {
    const ev = buildGscDemandEvidence({ windowDays: 90, gsc: { pages: pages(FULL, { '/zero/': 0 }) } });
    expect(ev.hasImpressions(['/zero/'])).toBe(false);
  });
});
