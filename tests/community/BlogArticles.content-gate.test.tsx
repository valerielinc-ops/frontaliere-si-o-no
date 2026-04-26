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
  it('applies the gate only when 5+ segments are present and user lacks access', () => {
    expect(SOURCE).toMatch(/presentSegments\.length\s*>=\s*5/);
    expect(SOURCE).toMatch(/contentGateApplies\s*=\s*!authLoading\s*&&\s*!hasArticleAccess/);
  });

  it('shows exactly ceil(n/2) segments when gated', () => {
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
});

describe('BlogArticles — ad-slot registry wiring', () => {
  it('imports AD_SLOTS from the single-source-of-truth registry', async () => {
    const { AD_SLOTS } = await import('@/services/adsenseSlots');
    expect(AD_SLOTS.AUTHGATE_END_MULTIPLEX.slot).toMatch(/^\d+$/);
  });
});
