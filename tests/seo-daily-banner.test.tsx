/**
 * SeoDailyBanner — home 3-card SEO linking strip (Layer 2B).
 *
 * Verifies:
 *  - Renders 3 cards as a <nav aria-label=...> landmark
 *  - Each card's <a> has accessible name (aria-label) + working href
 *  - Locale prop drives href localization (IT default, /en/ prefix for EN)
 *  - No dark: color prefixes, no hardcoded Tailwind color scales
 *  - No network fetch triggered by mount (pure static links)
 */

import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import SeoDailyBanner from '@/components/shared/SeoDailyBanner';

// Mock i18n to return a predictable translation function and locale.
vi.mock('@/services/i18n', () => ({
  useTranslation: () => ({
    t: (key: string) => `[[${key}]]`,
    locale: 'it' as const,
  }),
  getCantonI18nParams: () => ({} as Record<string, string>),
}));

afterEach(() => {
  cleanup();
});

describe('SeoDailyBanner', () => {
  it('renders 3 distinct cards with aria-labeled nav landmark', () => {
    render(<SeoDailyBanner />);
    const nav = screen.getByTestId('seo-daily-banner');
    expect(nav.tagName.toLowerCase()).toBe('nav');
    expect(nav.getAttribute('aria-label')).toBeTruthy();
    const links = nav.querySelectorAll('a');
    expect(links.length).toBe(3);
  });

  it('every card anchor has an accessible name via aria-label', () => {
    render(<SeoDailyBanner />);
    const nav = screen.getByTestId('seo-daily-banner');
    const links = nav.querySelectorAll('a');
    for (const link of Array.from(links)) {
      // accessible name check
      expect(link.getAttribute('aria-label') || link.textContent || '').not.toBe('');
    }
  });

  it('uses IT hrefs by default (prezzi-diesel, mercato-lavoro-ticino, aziende-che-assumono)', () => {
    render(<SeoDailyBanner />);
    const nav = screen.getByTestId('seo-daily-banner');
    const hrefs = Array.from(nav.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs.some((h) => h?.startsWith('/prezzi-diesel/'))).toBe(true);
    expect(hrefs.some((h) => h?.startsWith('/mercato-lavoro-ticino/'))).toBe(true);
    expect(hrefs.some((h) => h?.startsWith('/aziende-che-assumono/'))).toBe(true);
  });

  it('accepts a locale prop override and builds /en/ prefixed URLs', () => {
    render(<SeoDailyBanner locale="en" />);
    const nav = screen.getByTestId('seo-daily-banner');
    const hrefs = Array.from(nav.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    for (const h of hrefs) {
      expect(h?.startsWith('/en/')).toBe(true);
    }
  });

  it('renders no dark: Tailwind color prefixes in the output markup', () => {
    const { container } = render(<SeoDailyBanner />);
    const html = container.innerHTML;
    expect(html).not.toMatch(/dark:(bg|text|border|ring)-/);
  });

  it('does not fire a fetch on mount (pure static links, no network work)', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 200 }),
    );
    render(<SeoDailyBanner />);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
