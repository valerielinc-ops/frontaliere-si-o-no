// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PharmacyDirectory from '../components/pages/PharmacyDirectory';
import { TICINO_CITIES } from '../services/pharmacies/data';

vi.mock('@/components/pharmacies/PharmacyMap', () => ({ default: () => null }));

const locales = ['it', 'en', 'de', 'fr'] as const;
const provincePaths = {
  it: ['/farmacie/italia/como/', '/farmacie/italia/varese/', '/farmacie/italia/verbano-cusio-ossola/'],
  en: ['/en/pharmacies/italy/como/', '/en/pharmacies/italy/varese/', '/en/pharmacies/italy/verbano-cusio-ossola/'],
  de: ['/de/apotheken/italien/como/', '/de/apotheken/italien/varese/', '/de/apotheken/italien/verbano-cusio-ossola/'],
  fr: ['/fr/pharmacies/italie/como/', '/fr/pharmacies/italie/varese/', '/fr/pharmacies/italie/verbano-cusio-ossola/'],
} as const;

afterEach(cleanup);
afterEach(() => vi.useRealTimers());

describe('pharmacy country SPA route', () => {
  it.each(locales)('renders only the three province hubs and no 542-card listing (%s)', (locale) => {
    const { container } = render(<PharmacyDirectory page={{ kind: 'country', country: 'IT', locale }} />);
    const provinceList = screen.getByRole('list');
    const links = within(provinceList).getAllByRole('link');

    expect(links).toHaveLength(3);
    expect(links.map((link) => link.getAttribute('href'))).toEqual(provincePaths[locale]);
    for (const [index, count] of ['193', '266', '83'].entries()) expect(links[index].textContent || '').toContain(count);
    expect(container.querySelectorAll('article')).toHaveLength(0);
    expect(container.querySelector('#pharmacy-search')).toBeNull();
    expect(container.querySelector('#pharmacy-map-heading')).toBeNull();
  });

  it('shows the fail-closed coverage matrix when the dataset has no active interval', () => {
    vi.useFakeTimers({ now: new Date('2030-01-01T00:00:00.000Z') });
    const { container } = render(<PharmacyDirectory page={{ kind: 'duty-hub', locale: 'it' }} />);
    const matrix = container.querySelector('[data-coverage-matrix="true"]');

    expect(matrix).toHaveAttribute('data-release-ready', 'false');
    expect(screen.getByText(/Turni non mostrati:/)).toBeInTheDocument();
    expect(matrix?.querySelectorAll('[data-coverage-kind="ticino-region"]')).toHaveLength(5);
    expect(matrix?.querySelectorAll('[data-coverage-kind="ticino-region"] [data-duty-id]')).toHaveLength(0);
    expect(matrix?.querySelectorAll('[data-coverage-kind="ticino-region"] time')).toHaveLength(0);
    expect(matrix?.querySelectorAll('[data-coverage-kind="source-only-canton"]')).toHaveLength(25);
    expect(container.textContent).toContain('Verifica sempre telefonicamente con la farmacia prima di recarti sul posto: orari e turni possono cambiare.');
  });

  it('keeps duty-city pages city-scoped with the legacy card fallback', () => {
    vi.useFakeTimers({ now: new Date('2030-01-01T00:00:00.000Z') });
    const city = TICINO_CITIES[0];
    const { container } = render(<PharmacyDirectory page={{ kind: 'duty-city', locale: 'it', citySlug: city.slug }} />);

    expect(screen.getByText('Nessun turno verificato per questa città o area nel dataset corrente.')).toBeInTheDocument();
    expect(container.querySelector('[data-coverage-matrix="true"]')).toBeNull();
    expect(container.querySelectorAll('article')).toHaveLength(0);
    expect(container.textContent).toContain('Verifica sempre telefonicamente con la farmacia prima di recarti sul posto: orari e turni possono cambiare.');
  });

  it.each(locales)('routes the Italian duty hub and week to a fail-closed country UI (%s)', (locale) => {
    vi.useFakeTimers({ now: new Date('2026-09-20T12:00:00.000Z') });
    const hub = render(<PharmacyDirectory page={{ kind: 'italy-duty-hub', country: 'IT', locale }} />);
    const hubRoot = hub.container.querySelector('[data-italy-duty-week="true"]');
    expect(hubRoot).toHaveAttribute('data-italy-release-state', 'fresh');
    expect(hubRoot).toHaveAttribute('data-italy-publishable', 'true');
    expect(hubRoot).toHaveAttribute('data-italy-indexable', 'false');
    expect(hubRoot?.querySelectorAll('[data-italy-duty-province]')).toHaveLength(3);
    expect(hubRoot?.querySelectorAll('[data-duty-country="IT"]')).toHaveLength(5);
    expect(hubRoot?.querySelectorAll('time').length).toBeGreaterThan(0);
    expect(hubRoot?.querySelectorAll('[data-italy-duty-published]')).toHaveLength(2);
    expect(hubRoot?.querySelector('[data-italy-duty-province="VB"][data-italy-duty-published]')).toBeNull();
    expect(hubRoot?.querySelectorAll('[data-italy-duty-province="VB"] [data-duty-country="IT"]')).toHaveLength(0);
    expect(hubRoot?.querySelectorAll('a[href^="https://"]')).toHaveLength(8);

    cleanup();
    const week = render(<PharmacyDirectory page={{ kind: 'italy-duty-week', country: 'IT', locale, weekStart: '2026-09-14' }} />);
    const weekRoot = week.container.querySelector('[data-italy-duty-week="true"]');
    expect(weekRoot).toHaveAttribute('data-italy-release-state', 'fresh');
    expect(weekRoot).toHaveAttribute('data-italy-publishable', 'true');
    expect(weekRoot).toHaveAttribute('data-italy-indexable', 'false');
    expect(weekRoot?.querySelectorAll('[data-italy-duty-province]')).toHaveLength(3);
    expect(weekRoot?.querySelectorAll('[data-duty-country="IT"]')).toHaveLength(5);
    expect(weekRoot?.querySelectorAll('time').length).toBeGreaterThan(0);
    expect(weekRoot?.querySelectorAll('[data-italy-duty-published]')).toHaveLength(2);
    expect(weekRoot?.querySelector('[data-italy-duty-province="VB"][data-italy-duty-published]')).toBeNull();
    expect(weekRoot?.querySelectorAll('a[href^="https://"]')).toHaveLength(8);
  });
});
