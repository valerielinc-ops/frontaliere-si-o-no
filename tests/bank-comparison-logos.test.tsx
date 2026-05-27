/**
 * Regression test for BankComparison.tsx logo rendering.
 *
 * Background: the bank comparison page used to render only a generic
 * `<Building2>` Lucide icon next to each bank name. We migrated it to use
 * `<ProviderLogo>` (the same component used by CurrencyExchange) so each
 * bank gets its actual brand logo via slug → local file → Clearbit → local
 * SVG placeholder fallback chain.
 *
 * This test guarantees that EVERY visible bank card includes an `<img>` with
 * a non-empty `alt` attribute matching the bank name, plus the `width` and
 * `height` attributes required by the project a11y rules.
 */

import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('@/services/i18n', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    locale: 'it' as const,
  }),
  getCantonI18nParams: () => ({} as Record<string, string>),
}));

// PartnerRecommendations transitively pulls a lot of partner data; stub it.
vi.mock('@/components/shared/PartnerRecommendations', () => ({
  default: () => null,
}));

// DataFreshness has its own date logic that's irrelevant here.
vi.mock('@/components/shared/DataFreshness', () => ({
  default: () => null,
}));

// Lazy-loaded components — short-circuit them to keep the test focused.
vi.mock('@/components/shared/RelatedTools', () => ({
  default: () => null,
}));
vi.mock('@/components/shared/LeadMagnetCTA', () => ({
  default: () => null,
}));

import BankComparison from '@/components/comparators/BankComparison';

afterEach(() => {
  cleanup();
});

// The full bank list as declared in BankComparison.tsx getBanks().
// All 12 are `acceptsFrontalieri: true` EXCEPT UBS and Credit Suisse.
// The default filter `showOnlyFrontalieri = true` hides those two.
const FRONTALIERI_BANKS = [
  'PostFinance',
  'Raiffeisen',
  'Revolut',
  'Wise',
  'Intesa Sanpaolo',
  'Fineco',
  'Yuh',
  'Neon',
  'N26',
  'HYPE',
];

describe('BankComparison — provider logos', () => {
  it('renders an <img> with alt = bank name for every visible bank card', () => {
    render(<BankComparison />);

    for (const bankName of FRONTALIERI_BANKS) {
      // Each bank renders exactly one card with a heading and exactly one
      // <ProviderLogo> img with alt={bank.name}. The bank name uniquely
      // identifies both within the page.
      const heading = screen.getByRole('heading', { name: bankName });
      expect(heading, `heading for ${bankName}`).toBeTruthy();

      const img = screen.getByAltText(bankName);
      expect(img.tagName.toLowerCase()).toBe('img');
      // a11y rule from CLAUDE.md: every <img> needs width + height + alt.
      expect(img.getAttribute('width')).toBeTruthy();
      expect(img.getAttribute('height')).toBeTruthy();
      expect(img.getAttribute('alt')).toBe(bankName);
    }
  });

  it('does NOT use Google favicons URLs for any logo src (regression for gray-globe bug)', () => {
    render(<BankComparison />);

    const allImages = document.querySelectorAll('img');
    for (const img of Array.from(allImages)) {
      const src = img.getAttribute('src') ?? '';
      expect(src).not.toContain('google.com/s2/favicons');
    }
  });

  it('uses the Intesa Sanpaolo entry from PROVIDER_LOGOS as the logo source', () => {
    render(<BankComparison />);

    const intesaImg = screen.getByAltText('Intesa Sanpaolo');
    const src = intesaImg.getAttribute('src') ?? '';
    // No local file is committed for Intesa, so initial src must come from
    // Clearbit (resolved from PROVIDER_LOGOS['intesa-sanpaolo'].domain).
    // If Clearbit fails at runtime, the onError handler swaps to the local
    // SVG placeholder — but at initial render we expect the Clearbit URL.
    expect(src).toContain('logo.clearbit.com');
    expect(src).toContain('intesasanpaolo.com');
  });
});
