import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import FrontierGuide from '@/components/guide/FrontierGuide';
import { MUNICIPALITIES } from '@/data/municipalities';
import { borderMunicipalityPathFor, corridorMunicipalities, isBorderMunicipalityPath } from '@/build-plugins/borderMunicipalityData';

const state = vi.hoisted(() => ({ locale: 'it' }));
vi.mock('@/services/i18n', () => ({
  useTranslation: () => ({ locale: state.locale, t: (key: string) => key }),
}));
vi.mock('@/services/analytics', () => ({ Analytics: {
  trackMunicipalityView: vi.fn(), trackUIInteraction: vi.fn(), trackMapInteraction: vi.fn(),
} }));
// The external map/network/telemetry and translation adapter are replaced.
// Municipality rows, eligibility, paths, filtering, card/detail stay real.
vi.mock('@/components/shared/MapCanvas', () => ({ default: () => null }));

beforeEach(() => {
  localStorage.setItem('frontaliere_guide_banner_dismissed', 'true');
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline fixture')));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const reportedNames = ['Villeneuve', 'Grosotto', 'Casargo', 'Delebio', 'Mazzo di Valtellina', 'Allein'];

async function search(name: string) {
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: name } });
  const results = document.getElementById('municipality-results')!;
  await waitFor(() => expect(within(results).getAllByRole('heading', { name })).toHaveLength(1));
  return results;
}

describe.each(['it', 'en', 'de', 'fr'])('FrontierGuide profile targets (%s)', locale => {
  beforeEach(() => { state.locale = locale; });

  it.each(reportedNames)('keeps %s searchable and selectable without inventing a Ticino profile', async name => {
    expect(MUNICIPALITIES.filter(m => m.name === name)).toHaveLength(1);
    expect(corridorMunicipalities().some(m => m.name === name)).toBe(false);
    render(<FrontierGuide activeSection="municipalities" />);
    const results = await search(name);
    expect(within(results).queryByRole('link', { name: 'guide.municipalities.detail.profileCta' })).toBeNull();
    const card = within(results).getByRole('heading', { name }).closest('[role="button"]')!;
    fireEvent.keyDown(card, { key: 'Enter' });
    // Both responsive detail wrappers exist in JSDOM (CSS hides one in the
    // browser). Exercise both instead of overlooking the desktop sibling.
    await waitFor(() => expect(screen.getAllByRole('heading', { name })).toHaveLength(3));
    expect(screen.getAllByRole('button', { name: 'guide.municipalities.detail.close' })).toHaveLength(2);
    expect(screen.queryByRole('link', { name: 'guide.municipalities.detail.profileCta' })).toBeNull();
    expect(screen.getAllByRole('link', { name: 'guide.municipalities.detail.borderWaitCta' })).toHaveLength(3);
    expect(screen.getAllByRole('button', { name: 'guide.municipalities.detail.ctaCalculator' })).toHaveLength(2);
  });

  it.each(['Como', 'Varese', 'Verbania'])("preserves %s's existing profile on card and detail", async name => {
    const target = borderMunicipalityPathFor('it', name);
    expect(isBorderMunicipalityPath(target)).toBe(true);
    render(<FrontierGuide activeSection="municipalities" />);
    const results = await search(name);
    const card = within(results).getByRole('heading', { name }).closest('[role="button"]')!;
    expect(within(card as HTMLElement).getByRole('link', { name: 'guide.municipalities.detail.profileCta' })).toHaveAttribute('href', target);
    fireEvent.keyDown(card, { key: 'Enter' });
    await waitFor(() => expect(document.querySelectorAll(`a[href="${target}"]`)).toHaveLength(3));
  });
});

it('paginates the entire real catalog and links exactly the native emitted corridor', async () => {
  state.locale = 'it';
  render(<FrontierGuide activeSection="municipalities" />);
  const seen = new Set<string>(), linked = new Set<string>();
  const next = screen.getByRole('button', { name: 'guide.municipalities.pagination.next' });
  for (let page = 0; page < Math.ceil(MUNICIPALITIES.length / 24); page++) {
    const results = document.getElementById('municipality-results')!;
    // The interaction cases above check accessible names. This complete-
    // catalog pass inspects the rendered DOM directly instead of recomputing
    // accessibility trees for every one of the catalog's links.
    const cards = results.querySelectorAll('h3');
    expect(cards.length).toBeLessThanOrEqual(24);
    for (const heading of cards) {
      const name = heading.textContent!;
      expect(seen.has(name)).toBe(false);
      seen.add(name);
      const card = heading.closest('[role="button"]')!;
      const link = card.querySelector('a[href^="/vivere-in-ticino/comuni-di-frontiera/"]');
      if (link) {
        expect(link).toHaveAttribute('href', borderMunicipalityPathFor('it', name));
        expect(isBorderMunicipalityPath(link.getAttribute('href')!)).toBe(true);
        linked.add(name);
      }
    }
    if (page + 1 < Math.ceil(MUNICIPALITIES.length / 24)) {
      fireEvent.click(next);
    }
  }
  expect(seen).toEqual(new Set(MUNICIPALITIES.map(m => m.name)));
  expect(linked).toEqual(new Set(corridorMunicipalities().map(m => m.name)));
});
