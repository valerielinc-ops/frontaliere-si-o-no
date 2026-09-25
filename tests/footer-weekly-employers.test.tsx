/**
 * WeeklyEmployersTeaser — footer section that closes the 4.5k orphan
 * sitemap entries for /aziende-che-assumono/{city}/{company}/settimana-corrente/.
 *
 * Verifies:
 *  - Renders as a <nav> landmark with aria-label + data-testid
 *  - Emits exactly 10 anchors
 *  - Every anchor has an accessible name
 *  - Every href matches the weekly-employers current-week URL shape
 *  - Each anchor target is consistent with the pure path builder
 *  - Hidden when KILL_WEEKLY_EMPLOYERS_LINKS is true
 *  - Locale prop drives href localization
 *  - No dark: color prefixes
 *  - No fetch on mount
 */

import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import WeeklyEmployersTeaser from '@/components/shared/WeeklyEmployersTeaser';
import {
  buildCompanyCityCurrentPath,
  canonicalCompanySlug,
  WEEKLY_EMPLOYERS_COMPANY_CITY_LIST,
  type WeeklyEmployersCompanyCity,
  type WeeklyEmployersLocale,
} from '@/build-plugins/weeklyEmployersData';

vi.mock('@/services/i18n', () => ({
  useTranslation: () => ({
    t: (key: string) => `[[${key}]]`,
    locale: 'it' as const,
  }),
  getCantonI18nParams: () => ({} as Record<string, string>),
}));

// Default: kill switch off → teaser rendered.
const killState = {
  fuelDaily: false,
  healthPremiums: false,
  jobMarket: false,
  weeklyEmployers: false,
  orphanLandings: false,
};
vi.mock('@/hooks/useKillSwitches', () => ({
  useKillSwitches: () => killState,
}));

afterEach(() => {
  cleanup();
  killState.weeklyEmployers = false;
});

describe('WeeklyEmployersTeaser — footer orphan-sitemap closer', () => {
  it('renders as a <nav> landmark with aria-label and stable test id', () => {
    render(<WeeklyEmployersTeaser />);
    const nav = screen.getByTestId('footer-weekly-employers-teaser');
    expect(nav.tagName.toLowerCase()).toBe('nav');
    expect(nav.getAttribute('aria-label')).toBeTruthy();
  });

  it('emits exactly 10 anchors', () => {
    render(<WeeklyEmployersTeaser />);
    const nav = screen.getByTestId('footer-weekly-employers-teaser');
    const links = nav.querySelectorAll('a');
    expect(links.length).toBe(10);
  });

  it('every anchor has an accessible name (aria-label or text)', () => {
    render(<WeeklyEmployersTeaser />);
    const nav = screen.getByTestId('footer-weekly-employers-teaser');
    const links = Array.from(nav.querySelectorAll('a'));
    for (const link of links) {
      const accessibleName = (link.getAttribute('aria-label') || link.textContent || '').trim();
      expect(accessibleName.length).toBeGreaterThan(0);
    }
  });

  it('every href matches the weekly-employers current-week URL shape', () => {
    render(<WeeklyEmployersTeaser />);
    const nav = screen.getByTestId('footer-weekly-employers-teaser');
    const hrefs = Array.from(nav.querySelectorAll('a')).map((a) => a.getAttribute('href') ?? '');
    for (const href of hrefs) {
      expect(href).toMatch(/^\/aziende-che-assumono\/[a-z-]+\/[a-z0-9-]+\/settimana-corrente\/$/);
    }
  });

  it('regression — every URL is reproducible via the canonical path builder', () => {
    render(<WeeklyEmployersTeaser />);
    const nav = screen.getByTestId('footer-weekly-employers-teaser');
    const hrefs = Array.from(nav.querySelectorAll('a')).map((a) => a.getAttribute('href') ?? '');

    const cities = new Set<string>(WEEKLY_EMPLOYERS_COMPANY_CITY_LIST);
    for (const href of hrefs) {
      const parts = href.split('/').filter(Boolean);
      // shape: ['aziende-che-assumono', city, companySlug, 'settimana-corrente']
      expect(parts.length).toBe(4);
      const [, city, companySlug] = parts;
      expect(cities.has(city)).toBe(true);
      // Rebuild and compare byte-for-byte.
      const rebuilt = buildCompanyCityCurrentPath(
        'it' as WeeklyEmployersLocale,
        city as WeeklyEmployersCompanyCity,
        companySlug,
      );
      expect(rebuilt).toBe(href);
      // companySlug must pass through canonicalCompanySlug idempotently.
      expect(canonicalCompanySlug(companySlug)).toBe(companySlug);
    }
  });

  it('hides itself when KILL_WEEKLY_EMPLOYERS_LINKS is true', () => {
    killState.weeklyEmployers = true;
    const { container } = render(<WeeklyEmployersTeaser />);
    expect(container.querySelector('[data-testid="footer-weekly-employers-teaser"]')).toBeNull();
  });

  it('applies /en/ locale prefix when locale=en', () => {
    render(<WeeklyEmployersTeaser locale="en" />);
    const nav = screen.getByTestId('footer-weekly-employers-teaser');
    const hrefs = Array.from(nav.querySelectorAll('a')).map((a) => a.getAttribute('href') ?? '');
    for (const href of hrefs) {
      expect(href.startsWith('/en/companies-hiring/')).toBe(true);
      expect(href.endsWith('/current-week/')).toBe(true);
    }
  });

  it('emits no dark: color prefixes in the rendered markup', () => {
    const { container } = render(<WeeklyEmployersTeaser />);
    expect(container.innerHTML).not.toMatch(/dark:(bg|text|border|ring)-/);
  });

  it('does not fire a network request on mount', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 200 }),
    );
    render(<WeeklyEmployersTeaser />);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
