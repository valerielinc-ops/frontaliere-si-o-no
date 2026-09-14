// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PharmacyDirectory from '../components/pages/PharmacyDirectory';

vi.mock('@/components/pharmacies/PharmacyMap', () => ({ default: () => null }));

const locales = ['it', 'en', 'de', 'fr'] as const;
const provincePaths = {
  it: ['/farmacie/italia/como/', '/farmacie/italia/varese/', '/farmacie/italia/verbano-cusio-ossola/'],
  en: ['/en/pharmacies/italy/como/', '/en/pharmacies/italy/varese/', '/en/pharmacies/italy/verbano-cusio-ossola/'],
  de: ['/de/apotheken/italien/como/', '/de/apotheken/italien/varese/', '/de/apotheken/italien/verbano-cusio-ossola/'],
  fr: ['/fr/pharmacies/italie/como/', '/fr/pharmacies/italie/varese/', '/fr/pharmacies/italie/verbano-cusio-ossola/'],
} as const;

afterEach(cleanup);

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
});
