/**
 * Source-level regression tests for the BlogArticles content gate
 * (docs/revenue-optimization-remaining.md §3a).
 *
 * The gate logic is inlined inside a ~2400-line component, so we validate it at
 * the source level: this is robust across refactors that would otherwise crash
 * a full-tree render, and it catches the exact regressions the plan calls out
 * (missing crawler bypass, wrong segment threshold, lost email fallback).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SOURCE = readFileSync(
  resolve(__dirname, '../../components/community/BlogArticles.tsx'),
  'utf8',
);

describe('BlogArticles — content gate invariants', () => {
  it('applies the gate only when body has 300+ words and user lacks access', () => {
    // Threshold migrated 2026-05-12: from `presentSegments.length >= 5`
    // (gated only ~0.24% of corpus — 6/2488 articles) to `bodyWordCount >= 300`
    // which gates 99.6% (2478/2488) and excludes only thin pages <100w.
    expect(SOURCE).toMatch(/paywallable\s*=\s*bodyWordCount\s*>=\s*300/);
    expect(SOURCE).toMatch(/contentGateApplies\s*=\s*!authLoading\s*&&\s*!hasArticleAccess\s*&&\s*paywallable/);
  });

  it('cuts at ceil(n/2) segments when paywallable', () => {
    expect(SOURCE).toMatch(/Math\.ceil\(presentSegments\.length\s*\/\s*2\)/);
  });

  it('bypasses the gate for crawler user agents (SEO requirement)', () => {
    expect(SOURCE).toMatch(/bot\|crawler\|spider/);
    expect(SOURCE).toMatch(/googlebot/i);
    expect(SOURCE).toMatch(/bingbot/i);
    expect(SOURCE).toMatch(/hasArticleAccess\s*=\s*isLoggedIn\s*\|\|\s*hasEmailAccess\s*\|\|\s*isCrawlerVisitor/);
  });

  it('treats ft_job_email localStorage as a valid access token', () => {
    expect(SOURCE).toMatch(/localStorage\.getItem\(['"]ft_job_email['"]\)/);
  });

  it('persists ft_job_email on email form submission', () => {
    expect(SOURCE).toMatch(/localStorage\.setItem\(['"]ft_job_email['"]/);
  });

  it('renders the auth-gate end-multiplex when gated (rails pruned 2026-04-26)', () => {
    expect(SOURCE).toMatch(/AUTHGATE_END_MULTIPLEX/);
    expect(SOURCE).not.toMatch(/AUTHGATE_RAIL_LEFT/);
    expect(SOURCE).not.toMatch(/AUTHGATE_RAIL_RIGHT/);
  });

  it('emits Google Flexible Sampling schema (isAccessibleForFree + hasPart) when paywallable', () => {
    // Anti-cloaking: paywalled URLs must declare `isAccessibleForFree:false`
    // and point hasPart.cssSelector at the hidden DOM section. Without this,
    // serving full content to Googlebot via UA detection is technically cloaking
    // per Google Search Central Flexible Sampling guidelines.
    expect(SOURCE).toMatch(/isAccessibleForFree:\s*!articlePaywallable/);
    expect(SOURCE).toMatch(/cssSelector:\s*['"]\.paywall-hidden-content['"]/);
  });

  it('keeps paywalled tail segments in the DOM (hidden via CSS) instead of slicing them out', () => {
    // SEO requirement: the gated tail must remain in the DOM under the
    // .paywall-hidden-content marker class so crawlers index the full article.
    // Only the Tailwind `hidden` utility removes it for the current visitor.
    expect(SOURCE).toMatch(/paywall-hidden-content hidden/);
    expect(SOURCE).toMatch(/presentSegments\.map\(/);
    // The pre-2026-05-12 slice approach must be gone — slicing physically
    // removed the tail, which broke the anti-cloaking guarantee.
    expect(SOURCE).not.toMatch(/visibleSegments\.map/);
    expect(SOURCE).not.toMatch(/presentSegments\.slice\(\s*0\s*,\s*visibleSegmentCount\s*\)/);
  });
});

describe('BlogArticles — ad-slot registry wiring', () => {
  it('imports AD_SLOTS from the single-source-of-truth registry', async () => {
    const { AD_SLOTS } = await import('@/services/adsenseSlots');
    expect(AD_SLOTS.AUTHGATE_END_MULTIPLEX.slot).toMatch(/^\d+$/);
  });
});
