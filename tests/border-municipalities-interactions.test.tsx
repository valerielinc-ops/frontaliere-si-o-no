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
const cards = () => within(document.getElementById('border-municipality-results')!).getAllByRole('heading', { level: 4 });

describe('border municipality interactions', () => {
 it('keeps every municipality reachable exactly once with a bounded rendered page', () => {
  render(<BorderMunicipalitiesMap />);
  const names: string[] = [];
  while (true) {
   expect(cards().length).toBeLessThanOrEqual(24);
   names.push(...cards().map(card => card.textContent!));
   const next = screen.getByRole('button', { name: 'Successiva' });
   if (next.hasAttribute('disabled')) break;
   fireEvent.click(next);
  }
  expect(names.sort()).toEqual(MUNICIPALITIES.map(m => m.name).sort());
  expect(new Set(names).size).toBe(MUNICIPALITIES.length);
 });

 it('sorts the full corpus and resets to the first page when the province changes', async () => {
  render(<BorderMunicipalitiesMap />);
  fireEvent.click(screen.getByRole('button', { name: 'Nome', exact: true }));
  await waitFor(() => expect(cards()[0].textContent).toBe([...MUNICIPALITIES].sort((a,b) => a.name.localeCompare(b.name, 'it'))[0].name));
  fireEvent.click(screen.getByRole('button', { name: 'Successiva' }));
  expect(screen.getByRole('status')).toHaveTextContent('Pagina 2');
  fireEvent.change(document.getElementById('province-filter-mobile')!, { target: { value: 'VA' } });
  const expected = MUNICIPALITIES.filter(m => m.province === 'VA').sort((a,b) => a.name.localeCompare(b.name, 'it'));
  await waitFor(() => expect(cards().map(card => card.textContent)).toEqual(expected.slice(0,24).map(m => m.name)));
  expect(screen.getByRole('status')).toHaveTextContent('Pagina 1');
 });
});
