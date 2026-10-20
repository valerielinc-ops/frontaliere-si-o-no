import React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import BorderMunicipalitiesMap from '@/components/guide/BorderMunicipalitiesMap';
import { itReady, loadTabTranslations } from '@/services/i18n';
import { MUNICIPALITIES } from '@/data/municipalities';

vi.mock('@/services/exchangeRateService', () => ({ useExchangeRate: () => ({ rate: 1.05 }) }));
vi.mock('@/services/borderWaitCurrentService', () => ({ fetchBorderWaitCurrent: async () => null, effectiveWaitMinutes: () => null }));

beforeAll(async () => { await itReady; await loadTabTranslations('guide'); });
afterEach(cleanup);
const cardNames = (results: HTMLElement) => Array.from(results.querySelectorAll('h4'), card => card.textContent!);

describe('border municipality interactions', () => {
 it('keeps every municipality reachable exactly once with a bounded rendered page', () => {
  render(<BorderMunicipalitiesMap />);
  const results = document.getElementById('border-municipality-results')!;
  const next = screen.getByRole('button', { name: 'Successiva' });
  // Check the semantic heading/control contract once. The traversal below
  // reads each page once instead of repeating computed-style/accessibility
  // walks for every heading and searching the whole map for the same button.
  expect(within(results).getAllByRole('heading', { level: 4 })).toHaveLength(24);
  expect(next).toHaveAttribute('aria-controls', results.id);
  const names: string[] = [];
  const pages = Math.ceil(MUNICIPALITIES.length / 24);
  for (let page = 0; page < pages; page++) {
   const visibleNames = cardNames(results);
   const expectedCount = Math.min(24, MUNICIPALITIES.length - page * 24);
   expect(visibleNames).toHaveLength(expectedCount);
   expect(results.childElementCount).toBe(expectedCount);
   names.push(...visibleNames);
   expect(next).toBeInTheDocument();
   if (page === pages - 1) {
    expect(next).toBeDisabled();
   } else {
    expect(next).toBeEnabled();
    fireEvent.click(next);
   }
  }
  expect(names.sort()).toEqual(MUNICIPALITIES.map(m => m.name).sort());
  expect(new Set(names).size).toBe(MUNICIPALITIES.length);
 });

 it('sorts the full corpus and resets to the first page when the province changes', async () => {
  render(<BorderMunicipalitiesMap />);
  const results = document.getElementById('border-municipality-results')!;
  const next = screen.getByRole('button', { name: 'Successiva' });
  const status = screen.getByRole('status');
  const sortedNames = [...MUNICIPALITIES].sort((a,b) => a.name.localeCompare(b.name, 'it')).map(m => m.name);
  fireEvent.click(screen.getByRole('button', { name: 'Nome', exact: true }));
  await waitFor(() => expect(cardNames(results)).toEqual(sortedNames.slice(0,24)));
  fireEvent.click(next);
  expect(status).toHaveTextContent('Pagina 2');
  expect(cardNames(results)).toEqual(sortedNames.slice(24,48));
  fireEvent.change(document.getElementById('province-filter-mobile')!, { target: { value: 'VA' } });
  const expected = MUNICIPALITIES.filter(m => m.province === 'VA').sort((a,b) => a.name.localeCompare(b.name, 'it'));
  await waitFor(() => expect(cardNames(results)).toEqual(expected.slice(0,24).map(m => m.name)));
  expect(status).toHaveTextContent('Pagina 1');
 });
});
