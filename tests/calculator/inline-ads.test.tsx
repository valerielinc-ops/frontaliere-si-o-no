/**
 * Source-level regression tests for calculator/comparator inline ad placements
 * (docs/revenue-optimization-remaining.md §3b).
 *
 * These ad placements are easy to delete during refactors because they are
 * single-line JSX drops inside long components. Guarding at source level keeps
 * the assertions tight without requiring a full render tree.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (rel: string) => readFileSync(resolve(__dirname, '..', '..', rel), 'utf8');

describe('Calculator inline ads — ARTICLE_INLINE_MOBILE wiring', () => {
  it.each([
    ['components/calculator/PayslipSimulator.tsx'],
    ['components/calculator/RalComparator.tsx'],
    ['components/calculator/WhatIfSimulator.tsx'],
    ['components/comparators/CurrencyExchange.tsx'],
  ])('%s renders an ARTICLE_INLINE_MOBILE slot', (path) => {
    const source = read(path);
    expect(source).toMatch(/AD_SLOTS\.ARTICLE_INLINE_MOBILE\b/);
    expect(source).toMatch(/<AdSenseBanner\b/);
  });
});

describe('Confronti tab — homepage mid-display slot', () => {
  it('ConfrontiTabContent renders the HOMEPAGE_MID_DISPLAY slot', () => {
    const source = read('components/tabs/ConfrontiTabContent.tsx');
    expect(source).toMatch(/AD_SLOTS\.HOMEPAGE_MID_DISPLAY\b/);
    expect(source).toMatch(/<AdSenseBanner\b/);
  });
});

describe('Inline-ad registry invariants', () => {
  it('ARTICLE_INLINE_MOBILE uses the fluid in-article layout', async () => {
    const { AD_SLOTS } = await import('@/services/adsenseSlots');
    expect(AD_SLOTS.ARTICLE_INLINE_MOBILE.format).toBe('fluid');
    expect((AD_SLOTS.ARTICLE_INLINE_MOBILE as { layout?: string }).layout).toBe('in-article');
  });

  it('HOMEPAGE_MID_DISPLAY is present and non-empty', async () => {
    const { AD_SLOTS } = await import('@/services/adsenseSlots');
    expect(AD_SLOTS.HOMEPAGE_MID_DISPLAY.slot).toMatch(/^\d+$/);
  });
});
