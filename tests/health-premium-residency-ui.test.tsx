import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import HealthInsurance from '../components/comparators/HealthInsurance';
import type { CheapestPremium } from '../components/comparators/LamalSsnBreakeven';

vi.mock('@/services/i18n', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/services/analytics', () => ({ Analytics: { trackHealthInsurance: vi.fn(), trackExternalLink: vi.fn() } }));
vi.mock('@/services/cdnDataBase', () => ({ cdnDataUrl: (url: string) => url }));
vi.mock('@/services/lazyRetry', () => ({ lazyRetry: () => () => null }));
vi.mock('@/components/shared/ProviderLogo', () => ({ default: () => null }));
vi.mock('@/components/shared/DataFreshness', () => ({ default: () => null }));
vi.mock('@/components/comparators/LamalSsnBreakeven', () => ({
  default: ({ computeCheapestPremium }: { computeCheapestPremium: (franchise: number, age: '26+') => CheapestPremium | null }) =>
    <output data-testid="italy-quote">{JSON.stringify(computeCheapestPremium(300, '26+'))}</output>,
}));

const year = new Date().getUTCFullYear();
const euData = {
  schemaVersion: 1, year, fetchedAt: new Date().toISOString(), residenceBasis: 'country',
  sourceUrl: 'https://www.priminfo.admin.ch/it/versicherungen/eu_efta',
  countries: { IT: { insurers: { italy: {
    id: 'italy', name: 'Italy insurer', website: 'https://example.test/',
    premiums: {
      '26+': { withoutAccident: { ordinary: 279 }, withAccident: { ordinary: 300 } },
      '19-25': { withoutAccident: { ordinary: 251.1 }, withAccident: { ordinary: 270 } },
      '0-18': { withoutAccident: { K1: 64.2 }, withAccident: { K1: 69 } },
    },
  } } } },
};
const chData = {
  year, fetchedAt: new Date().toISOString(), communes: { TI: [{ name: 'Lugano', plz: '6823', bfsNr: 5192, region: 1 }] },
  quotes: {
    TI: { '1': { '8': { ERW: { withoutAccident: { '300': { standard: 999, telmed: 777 }, '2500': { standard: 800, telmed: 666 } } } } } },
    AG: { '0': { '8': { ERW: { withoutAccident: { '300': { standard: 555, praxis: 444 } } } } } },
  },
  insurers: [{ id: '8', name: 'Swiss insurer', website: 'https://example.test/' }],
  premiums: { '6823-Lugano': { insurers: { '8': { standard: 999, telmed: 777 } } } },
  rankings: { cheapest: [], mostExpensive: [] },
};
function mockData(euAvailable = true, domestic: unknown = chData) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
    ok: !url.includes('health-premiums-eu') || euAvailable,
    json: async () => url.includes('health-premiums-eu') ? euData : domestic,
  })));
}
const select = (id: string) => document.getElementById(id) as HTMLSelectElement;
const choices = (id: string) => Array.from(select(id).options).map(option => option.value);
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.location.hash = ''; });

describe('health comparator residence boundary', () => {
  it('rejects malformed domestic quote profiles without crashing or substituting prices', async () => {
    mockData(true, { ...chData, quotes: { TI: { '1': { '8': null } } } });
    render(<HealthInsurance />);
    fireEvent.change(select('hi-residence'), { target: { value: 'CH' } });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(screen.getByText('health.residence.swissUnavailable', { exact: false }).getAttribute('role')).toBe('status');
  });

  it('rejects a legacy domestic snapshot without exact quotes', async () => {
    const { quotes, ...legacy } = chData;
    mockData(true, legacy);
    render(<HealthInsurance />);
    fireEvent.change(select('hi-residence'), { target: { value: 'CH' } });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(screen.getByText('health.residence.swissUnavailable', { exact: false }).getAttribute('role')).toBe('status');
    expect(screen.queryByTestId('italy-quote')).toBeNull();
  });

  it('keeps domestic canton deep links on the Swiss comparison', async () => {
    window.location.hash = '#canton=AG&age=31-45';
    mockData();
    render(<HealthInsurance />);
    await waitFor(() => expect(choices('hi-model')).toContain('praxis'));
    expect(select('hi-residence').value).toBe('CH');
    expect(select('hi-canton').value).toBe('AG');
    expect(select('hi-region').value).toBe('0');
  });
  it('resets domestic options on return to Italy and keeps the SSN quote country-specific', async () => {
    mockData();
    render(<HealthInsurance />);
    await waitFor(() => expect(screen.getByTestId('italy-quote').textContent).toContain('279'));
    expect(screen.queryByText(/CMU francese|tabella Francia|residenti in Francia|SSN gratuito|definitiva/)).toBeNull();
    expect(choices('hi-franchise')).toEqual(['300']);
    expect(choices('hi-model')).toEqual(['standard']);
    fireEvent.change(select('hi-residence'), { target: { value: 'CH' } });
    expect(choices('hi-franchise')).toContain('2500');
    expect(choices('hi-model')).toContain('telmed');
    fireEvent.change(select('hi-franchise'), { target: { value: '2500' } });
    fireEvent.change(select('hi-model'), { target: { value: 'telmed' } });
    expect(screen.queryByTestId('italy-quote')).toBeNull();
    expect(screen.queryByText(/SSN italiano|Scegli SSN|CMU francese/)).toBeNull();
    fireEvent.change(select('hi-residence'), { target: { value: 'IT' } });
    expect(select('hi-franchise').value).toBe('300');
    expect(select('hi-model').value).toBe('standard');
    expect(screen.getByTestId('italy-quote').textContent).toContain('"residenceCountry":"IT"');
  });

  it('does not substitute Swiss premiums when the Italy dataset is unavailable', async () => {
    mockData(false);
    render(<HealthInsurance />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('italy-quote').textContent).toBe('null');
    expect(screen.getByText('health.residence.unavailable', { exact: false }).getAttribute('role')).toBe('status');
    fireEvent.change(select('hi-residence'), { target: { value: 'CH' } });
    expect(screen.queryByTestId('italy-quote')).toBeNull();
  });
});
