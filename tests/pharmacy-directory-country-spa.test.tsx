// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PharmacyDirectory from '../components/pages/PharmacyDirectory';
import { ITALY_BORDER_PHARMACIES, ITALY_BORDER_PROVINCES, TICINO_CITIES } from '../services/pharmacies/data';
import { buildItalyDutyWeekModel, currentItalyDutyWeekStart } from '../services/pharmacies/italyDuty';
import { buildPharmacyPath } from '../services/pharmacies/paths';
import { parsePharmacyRoute } from '../services/pharmacies/routePaths';
import italyDutiesJson from '../data/pharmacy-duties-italy.json';

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

const provinceCounts = ITALY_BORDER_PROVINCES.map(
  (province) => ITALY_BORDER_PHARMACIES.filter((pharmacy) => pharmacy.province === province.code).length,
);

describe('pharmacy country SPA route', () => {
  it.each(locales)('renders only the three province hubs and no 542-card listing (%s)', (locale) => {
    const { container } = render(<PharmacyDirectory page={{ kind: 'country', country: 'IT', locale }} />);
    const provinceList = screen.getByRole('list');
    const links = within(provinceList).getAllByRole('link');

    expect(links).toHaveLength(3);
    expect(links.map((link) => link.getAttribute('href'))).toEqual(provincePaths[locale]);
    for (const [index, count] of provinceCounts.entries()) expect(links[index].textContent || '').toContain(String(count));
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
    // cron-count-ok: le cinque regioni ticinesi sono DUTY_WEEK_REGIONS, costante del codice.
    expect(matrix?.querySelectorAll('[data-coverage-kind="ticino-region"]')).toHaveLength(5);
    expect(matrix?.querySelectorAll('[data-coverage-kind="ticino-region"] [data-duty-id]')).toHaveLength(0);
    expect(matrix?.querySelectorAll('[data-coverage-kind="ticino-region"] time')).toHaveLength(0);
    // cron-count-ok: i 26 cantoni meno il Ticino (SOURCE_ONLY_CANTONS), costante del codice.
    expect(matrix?.querySelectorAll('[data-coverage-kind="source-only-canton"]')).toHaveLength(25);
    expect(container.textContent).toContain('Verifica sempre telefonicamente con la farmacia prima di recarti sul posto: orari e turni possono cambiare.');
  });

  it.each(locales)('keeps the canonical Italian duty hub on the coverage SPA route (%s)', (locale) => {
    const canonicalPath = buildPharmacyPath({ kind: 'duty-hub', country: 'IT', locale }, locale);
    const parsed = parsePharmacyRoute(canonicalPath);

    expect(parsed).toEqual({ kind: 'italy-duty-hub', country: 'IT', locale });
    const { container } = render(<PharmacyDirectory page={parsed!} />);
    expect(container.querySelector('[data-italy-duty-coverage="true"]')).toBeInTheDocument();
    expect(container.querySelector('[data-italy-duty-week="true"]')).toBeNull();
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
    const now = new Date(Date.parse(String(italyDutiesJson._fetchedAt)) + 60_000);
    vi.useFakeTimers({ now });
    const weekStart = currentItalyDutyWeekStart(now);
    const italyModel = buildItalyDutyWeekModel({ now, weekStart });
    const expectedRows = italyModel.provinces.flatMap((province) => province.duties).length;
    const expectedWeekExternalLinks = italyModel.provinces.filter((province) => province.sourceUrl).length + expectedRows;
    // Quali province escono pubblicate, e quindi se la settimana e'
    // indicizzabile, lo decide lo snapshot che il cron farmacie riscrive (VB e'
    // `best-effort`): l'attesa segue il modello, non il dato di oggi (#9743).
    const publishedProvinces = italyModel.provinces.filter((province) => province.publishable);
    const sourceOnlyProvinces = italyModel.provinces.filter((province) => !province.publishable);
    expect(publishedProvinces.length).toBeGreaterThan(0);
    const hub = render(<PharmacyDirectory page={{ kind: 'italy-duty-hub', country: 'IT', locale }} />);
    const hubRoot = hub.container.querySelector('[data-italy-duty-coverage="true"]');
    expect(hubRoot).toHaveAttribute('data-italy-duty-coverage', 'true');
    expect(hubRoot).toHaveAttribute('data-italy-release-state', 'fresh');
    expect(hubRoot).toHaveAttribute('data-italy-publishable', 'true');
    expect(hubRoot).toHaveAttribute('data-italy-indexable', String(italyModel.indexable));
    // cron-count-ok: le tre province ITALY_DUTY_PROVINCES, costante del codice.
    expect(hubRoot?.querySelectorAll('[data-coverage-kind="italy-province"]')).toHaveLength(3);
    expect(hubRoot?.querySelectorAll('[data-duty-country="IT"]')).toHaveLength(expectedRows);
    expect(hubRoot?.querySelectorAll('time').length).toBeGreaterThan(0);
    expect(hubRoot?.querySelectorAll('[data-coverage-kind="italy-province"][data-italy-duty-published]')).toHaveLength(publishedProvinces.length);
    for (const province of sourceOnlyProvinces) {
      expect(hubRoot?.querySelector(`[data-source-only-province="${province.code}"]`)).toBeInTheDocument();
      expect(hubRoot?.querySelectorAll(`[data-source-only-province="${province.code}"] [data-duty-country="IT"]`)).toHaveLength(0);
    }
    expect(hubRoot?.querySelectorAll('a[href^="https://"]')).toHaveLength(expectedRows + italyModel.provinces.filter((province) => !province.publishable && province.sourceUrl).length);

    cleanup();
    const week = render(<PharmacyDirectory page={{ kind: 'italy-duty-week', country: 'IT', locale, weekStart }} />);
    const weekRoot = week.container.querySelector('[data-italy-duty-week="true"]');
    expect(weekRoot).toHaveAttribute('data-italy-release-state', 'fresh');
    expect(weekRoot).toHaveAttribute('data-italy-publishable', 'true');
    expect(weekRoot).toHaveAttribute('data-italy-indexable', String(italyModel.indexable));
    // cron-count-ok: le tre province ITALY_DUTY_PROVINCES, costante del codice.
    expect(weekRoot?.querySelectorAll('[data-italy-duty-province]')).toHaveLength(3);
    expect(weekRoot?.querySelectorAll('[data-duty-country="IT"]')).toHaveLength(expectedRows);
    expect(weekRoot?.querySelectorAll('time').length).toBeGreaterThan(0);
    expect(weekRoot?.querySelectorAll('[data-italy-duty-published]')).toHaveLength(publishedProvinces.length);
    for (const province of sourceOnlyProvinces) {
      expect(weekRoot?.querySelector(`[data-italy-duty-province="${province.code}"][data-italy-duty-published]`)).toBeNull();
    }
    expect(weekRoot?.querySelectorAll('a[href^="https://"]')).toHaveLength(expectedWeekExternalLinks);
  });

  it.each(locales)('routes the generic Italian duty aliases to the standalone coverage matrix (%s)', (locale) => {
    const now = new Date(Date.parse(String(italyDutiesJson._fetchedAt)) + 60_000);
    vi.useFakeTimers({ now });
    const italyModel = buildItalyDutyWeekModel({ now, weekStart: currentItalyDutyWeekStart(now) });
    const expectedRows = italyModel.provinces.flatMap((province) => province.duties).length;
    const { container } = render(<PharmacyDirectory page={{ kind: 'duty-hub', country: 'IT', locale }} />);
    const matrix = container.querySelector('[data-italy-duty-coverage="true"]');

    expect(matrix).toHaveAttribute('data-release-ready', 'true');
    expect(matrix).toHaveAttribute('data-week-ready', String(italyModel.indexable));
    // cron-count-ok: le tre province ITALY_DUTY_PROVINCES, costante del codice.
    expect(matrix?.querySelectorAll('[data-coverage-kind="italy-province"]')).toHaveLength(3);
    expect(matrix?.querySelectorAll('[data-duty-country="IT"]')).toHaveLength(expectedRows);
    for (const province of italyModel.provinces.filter((candidate) => !candidate.publishable)) {
      expect(matrix?.querySelectorAll(`[data-source-only-province="${province.code}"]`)).toHaveLength(1);
      expect(matrix?.querySelectorAll(`[data-source-only-province="${province.code}"] [data-duty-id]`)).toHaveLength(0);
    }
    const weekSegment = locale === 'it' ? 'settimana' : locale === 'en' ? 'week' : locale === 'de' ? 'woche' : 'semaine';
    expect(matrix?.querySelector(`a[href*="/${weekSegment}/"]`)).toHaveAttribute('href', expect.stringContaining(currentItalyDutyWeekStart(now)));
  });
});
