// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import ticino from '../data/pharmacies-ticino-complete.json';
import dutiesJson from '../data/pharmacy-duties-ticino.json';
import completeTicinoJson from '../data/pharmacies-ticino-complete.json';
import { buildPharmacyPath } from '../services/pharmacies/paths';
import { pharmacyCitySlug } from '../services/pharmacies/data';
import { setLocale } from '../services/i18n';
import type { Pharmacy, PharmacyCatalogueDataset, PharmacyDutiesDataset } from '../services/pharmacies/types';

vi.doUnmock('@/services/seoService');
vi.doUnmock('../services/seoService');

let seo: typeof import('../services/seoService');
let pharmacySeoRuntime: typeof import('../services/pharmacies/runtimeSeo');

const duties = dutiesJson as PharmacyDutiesDataset;
const catalogue = completeTicinoJson as unknown as PharmacyCatalogueDataset;

beforeAll(async () => {
  [seo, pharmacySeoRuntime] = await Promise.all([
    import('../services/seoService'),
    import('../services/pharmacies/runtimeSeo'),
  ]);
});

beforeEach(() => {
  setLocale('it');
  document.documentElement.lang = 'it';
  document.head.innerHTML = '<title>Simulatore Fiscale</title><meta name="robots" content="index,follow"><link rel="alternate" hreflang="it" href="https://frontaliereticino.ch/">';
});

afterEach(() => {
  vi.useRealTimers();
  window.history.replaceState({}, '', '/');
});

function weeklyPath(): string {
  return buildPharmacyPath({ kind: 'duty-week', locale: 'it', weekStart: '2026-09-14' });
}

describe('pharmacy SEO after SPA navigation', () => {
  it('keeps stale, tampered and unsupported weekly models noindex', () => {
    const stale = pharmacySeoRuntime.resolvePharmacySeoMetadata(
      { kind: 'duty-week', locale: 'it', weekStart: '2026-09-14' },
      { now: new Date('2026-09-16T12:00:00.000Z'), duties, catalogue },
    );
    const tamperedDuties = {
      ...duties,
      _release: { ...duties._release, state: 'partial' as const },
    } as PharmacyDutiesDataset;
    const tampered = pharmacySeoRuntime.resolvePharmacySeoMetadata(
      { kind: 'duty-week', locale: 'it', weekStart: '2026-09-14' },
      { now: new Date('2026-09-14T12:00:00.000Z'), duties: tamperedDuties, catalogue },
    );
    const unsupported = pharmacySeoRuntime.resolvePharmacySeoMetadata(
      { kind: 'duty-week', locale: 'it', weekStart: '2026-09-15' },
      { now: new Date('2026-09-14T12:00:00.000Z'), duties, catalogue },
    );

    expect(stale.robots).toBe('noindex,follow');
    expect(tampered.robots).toBe('noindex,follow');
    expect(unsupported.robots).toBe('noindex,follow');
  });

  it('updates pharmacy title, canonical, robots and all locale alternates', async () => {
    const pharmacy = ticino.pharmacies[0] as unknown as Pharmacy;
    const route = {
      kind: 'pharmacy' as const,
      locale: 'it' as const,
      country: 'CH' as const,
      citySlug: pharmacyCitySlug(pharmacy.city),
      pharmacySlug: pharmacy.slug,
    };
    const path = buildPharmacyPath(route);
    window.history.replaceState({}, '', path);

    await seo.updateMetaTags('pharmacy');

    expect(document.title).toBe(`${pharmacy.name} — ${pharmacy.city}`);
    expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('index,follow');
    expect(document.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(`https://frontaliereticino.ch${path}`);

    const hreflangs = [...document.querySelectorAll('link[hreflang]')].map((link) => link.getAttribute('hreflang'));
    expect(hreflangs).toEqual(expect.arrayContaining(['it', 'en', 'de', 'fr', 'x-default']));
    expect(document.querySelector('link[hreflang="en"]')?.getAttribute('href')).toContain('/en/pharmacies/ticino/');
    expect(document.querySelector('meta[name="description"]')?.getAttribute('content')).toContain(pharmacy.name);
  });

  it('does not defer a non-Italian pharmacy head behind the locale chunk', async () => {
    const pharmacy = ticino.pharmacies[0] as unknown as Pharmacy;
    const route = {
      kind: 'pharmacy' as const,
      locale: 'en' as const,
      country: 'CH' as const,
      citySlug: pharmacyCitySlug(pharmacy.city),
      pharmacySlug: pharmacy.slug,
    };
    const path = buildPharmacyPath(route);
    setLocale('en');
    window.history.replaceState({}, '', path);

    await seo.updateMetaTags('pharmacy');

    expect(document.documentElement.lang).toBe('en');
    expect(document.title).toBe(`${pharmacy.name} — ${pharmacy.city}`);
    expect(document.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(`https://frontaliereticino.ch${path}`);
  });

  it('keeps a stale weekly route noindex during the actual metadata update', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-16T12:00:00.000Z') });
    window.history.replaceState({}, '', weeklyPath());

    await seo.updateMetaTags('pharmacy-duty-week');

    expect(document.title).toContain('Farmacie di turno in Ticino');
    expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('noindex,follow');
    expect(document.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(`https://frontaliereticino.ch${weeklyPath()}`);
  });
});
