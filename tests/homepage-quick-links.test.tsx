/**
 * QuickLinksGrid — homepage internal-linking section that promotes the
 * highest-traffic border-wait + fuel hubs to depth 2.
 *
 * Verifies:
 *  - Renders a <nav> landmark with expected aria-label + data-testid
 *  - Contains the traffico-dogane hub anchor + top-5 crossing anchors
 *  - Contains the fuel-today anchor
 *  - Every anchor has an accessible name (aria-label or text)
 *  - Locale prop drives href localization (IT default, /en/ prefix for EN)
 *  - No dark: color prefixes
 *  - No fetch on mount (pure static links)
 *  - Regression: every href resolves to a known router route / static HTML path
 */

import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import QuickLinksGrid from '@/components/shared/QuickLinksGrid';
import {
  BORDER_WAIT_ROUTES,
} from '@/build-plugins/borderWaitData';

// Predictable translation + locale. Kill switches default to false (links shown).
vi.mock('@/services/i18n', () => ({
  useTranslation: () => ({
    t: (key: string) => `[[${key}]]`,
    locale: 'it' as const,
  }),
}));

vi.mock('@/hooks/useKillSwitches', () => ({
  useKillSwitches: () => ({
    fuelDaily: false,
    healthPremiums: false,
    jobMarket: false,
    weeklyEmployers: false,
    orphanLandings: false,
  }),
}));

afterEach(() => {
  cleanup();
});

describe('QuickLinksGrid — homepage depth-2 SEO grid', () => {
  it('renders as a <nav> landmark with aria-label and stable test id', () => {
    render(<QuickLinksGrid />);
    const nav = screen.getByTestId('home-quick-links');
    expect(nav.tagName.toLowerCase()).toBe('nav');
    expect(nav.getAttribute('aria-label')).toBeTruthy();
  });

  it('links to the traffico-dogane hub (IT default)', () => {
    render(<QuickLinksGrid />);
    const nav = screen.getByTestId('home-quick-links');
    const hrefs = Array.from(nav.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/traffico-dogane/');
  });

  it('links to the prezzi-diesel today hub (IT default)', () => {
    render(<QuickLinksGrid />);
    const nav = screen.getByTestId('home-quick-links');
    const hrefs = Array.from(nav.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    const fuelHref = hrefs.find((h) => h?.startsWith('/prezzi-diesel/'));
    expect(fuelHref).toBeTruthy();
    expect(fuelHref).toMatch(/\/oggi\/$/);
  });

  it('contains direct anchors to the top-5 Semrush-priority crossings', () => {
    render(<QuickLinksGrid />);
    const nav = screen.getByTestId('home-quick-links');
    const hrefs = new Set(Array.from(nav.querySelectorAll('a')).map((a) => a.getAttribute('href') ?? ''));
    expect(hrefs.has('/traffico-dogane/chiasso-brogeda/oggi/')).toBe(true);
    expect(hrefs.has('/traffico-dogane/gaggiolo/oggi/')).toBe(true);
    expect(hrefs.has('/traffico-dogane/ponte-tresa/oggi/')).toBe(true);
    expect(hrefs.has('/traffico-dogane/ronago-novazzano/oggi/')).toBe(true);
    expect(hrefs.has('/traffico-dogane/chiasso-strada/oggi/')).toBe(true);
  });

  it('renders 7 anchors total (1 hub + 1 fuel + 5 crossings)', () => {
    render(<QuickLinksGrid />);
    const nav = screen.getByTestId('home-quick-links');
    const links = nav.querySelectorAll('a');
    expect(links.length).toBe(7);
  });

  it('every anchor has an accessible name (aria-label or text)', () => {
    render(<QuickLinksGrid />);
    const nav = screen.getByTestId('home-quick-links');
    const links = Array.from(nav.querySelectorAll('a'));
    for (const link of links) {
      const accessibleName = (link.getAttribute('aria-label') || link.textContent || '').trim();
      expect(accessibleName.length).toBeGreaterThan(0);
    }
  });

  it('applies /en/ locale prefix when locale=en', () => {
    render(<QuickLinksGrid locale="en" />);
    const nav = screen.getByTestId('home-quick-links');
    const hrefs = Array.from(nav.querySelectorAll('a')).map((a) => a.getAttribute('href') ?? '');
    for (const href of hrefs) {
      expect(href.startsWith('/en/')).toBe(true);
    }
  });

  it('emits no dark: color prefixes in the rendered markup', () => {
    const { container } = render(<QuickLinksGrid />);
    expect(container.innerHTML).not.toMatch(/dark:(bg|text|border|ring)-/);
  });

  it('does not fire a network request on mount', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 200 }),
    );
    render(<QuickLinksGrid />);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('regression — every crossing URL is a known canonical border-wait route', () => {
    render(<QuickLinksGrid />);
    const nav = screen.getByTestId('home-quick-links');
    const hrefs = Array.from(nav.querySelectorAll('a'))
      .map((a) => a.getAttribute('href') ?? '')
      .filter((h) => h.includes('/traffico-dogane/') && h.endsWith('/oggi/'));
    expect(hrefs.length).toBe(5);
    for (const href of hrefs) {
      expect(BORDER_WAIT_ROUTES).toContain(href);
    }
  });
});
