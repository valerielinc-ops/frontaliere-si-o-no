// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import ticino from '../data/pharmacies-ticino-complete.json';
import dutiesJson from '../data/pharmacy-duties-ticino.json';
import completeTicinoJson from '../data/pharmacies-ticino-complete.json';
import { buildPharmacyPath } from '../services/pharmacies/paths';
import { BORDER_PHARMACIES, pharmacyCitySlug } from '../services/pharmacies/data';
import { buildPharmacyTitle } from '../services/pharmacies/title';
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

function addJsonLd(schema: Record<string, unknown>, dynamic = false): void {
  const script = document.createElement('script');
  script.type = 'application/ld+json';
  if (dynamic) script.setAttribute('data-dynamic-ld', 'true');
  script.textContent = JSON.stringify(schema);
  document.head.appendChild(script);
}

function jsonLdSchemas(): Record<string, any>[] {
  return [...document.querySelectorAll('script[type="application/ld+json"]')]
    .map((script) => JSON.parse(script.textContent || '{}'));
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

    expect(document.title).toBe(buildPharmacyTitle(pharmacy, BORDER_PHARMACIES));
    expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('index,follow');
    expect(document.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(`https://frontaliereticino.ch${path}`);

    const hreflangs = [...document.querySelectorAll('link[hreflang]')].map((link) => link.getAttribute('hreflang'));
    expect(hreflangs).toEqual(expect.arrayContaining(['it', 'en', 'de', 'fr', 'x-default']));
    expect(document.querySelector('link[hreflang="en"]')?.getAttribute('href')).toContain('/en/pharmacies/ticino/');
    expect(document.querySelector('meta[name="description"]')?.getAttribute('content')).toContain(pharmacy.name);
  });

  it('replaces stale pharmacy JSON-LD with the valid route Pharmacy and Breadcrumb schemas', async () => {
    const pharmacy = ticino.pharmacies[0] as unknown as Pharmacy;
    const route = {
      kind: 'pharmacy' as const,
      locale: 'it' as const,
      country: 'CH' as const,
      citySlug: pharmacyCitySlug(pharmacy.city),
      pharmacySlug: pharmacy.slug,
    };
    const path = buildPharmacyPath(route);
    addJsonLd({ '@context': 'https://schema.org', '@type': 'Pharmacy', name: 'Stale pharmacy', url: `https://frontaliereticino.ch${path}` });
    addJsonLd({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [{ item: `https://frontaliereticino.ch${path}` }] });
    addJsonLd({ '@context': 'https://schema.org', '@type': 'Pharmacy', name: 'Stale dynamic pharmacy' }, true);
    window.history.replaceState({}, '', path);

    await seo.updateMetaTags('pharmacy');

    const schemas = jsonLdSchemas();
    const pharmacySchemas = schemas.filter((schema) => schema['@type'] === 'Pharmacy');
    const breadcrumb = schemas.find((schema) => schema['@type'] === 'BreadcrumbList');
    expect(pharmacySchemas).toHaveLength(1);
    expect(pharmacySchemas[0].name).toBe(pharmacy.name);
    expect(pharmacySchemas[0].url).toBe(`https://frontaliereticino.ch${path}`);
    expect(breadcrumb?.itemListElement.at(-1)?.item).toBe(`https://frontaliereticino.ch${path}`);
    expect(JSON.stringify(schemas)).not.toContain('Stale pharmacy');
  });

  it('injects CollectionPage and route-aware Breadcrumb JSON-LD for a valid collection route', async () => {
    window.history.replaceState({}, '', '/farmacie/');

    await seo.updateMetaTags('pharmacy');

    const schemas = jsonLdSchemas();
    const collection = schemas.find((schema) => schema['@type'] === 'CollectionPage');
    const breadcrumb = schemas.find((schema) => schema['@type'] === 'BreadcrumbList');
    expect(collection?.url).toBe('https://frontaliereticino.ch/farmacie/');
    expect(collection?.mainEntity?.numberOfItems).toBe(BORDER_PHARMACIES.length);
    expect(breadcrumb?.itemListElement.some((item: { item?: string }) => item.item?.endsWith('/farmacie/'))).toBe(true);
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
    expect(document.title).toBe(buildPharmacyTitle(pharmacy, BORDER_PHARMACIES));
    expect(document.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(`https://frontaliereticino.ch${path}`);
  });

  it('uses the static generator discriminator for duplicate Sun Store Lugano titles', () => {
    const duplicates = BORDER_PHARMACIES.filter((pharmacy) => pharmacy.name === 'Farmacia Sun Store' && pharmacy.city === 'Lugano');
    expect(duplicates.length).toBeGreaterThan(1);
    for (const pharmacy of duplicates) {
      const metadata = pharmacySeoRuntime.resolvePharmacySeoMetadata({
        kind: 'pharmacy',
        locale: 'it',
        country: 'CH',
        citySlug: pharmacyCitySlug(pharmacy.city),
        pharmacySlug: pharmacy.slug,
      });
      expect(metadata.title).toBe(buildPharmacyTitle(pharmacy, BORDER_PHARMACIES));
      expect(metadata.ogTitle).toBe(metadata.title);
    }
  });

  it('keeps a stale weekly route noindex during the actual metadata update', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-16T12:00:00.000Z') });
    window.history.replaceState({}, '', weeklyPath());

    await seo.updateMetaTags('pharmacy-duty-week');

    expect(document.title).toContain('Farmacie di turno in Ticino');
    expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('noindex,follow');
    expect(document.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(`https://frontaliereticino.ch${weeklyPath()}`);
  });

  it('removes stale pharmacy schemas on normal and malformed weekly routes', async () => {
    addJsonLd({ '@context': 'https://schema.org', '@type': 'Pharmacy', name: 'Stale pharmacy' });
    addJsonLd({ '@context': 'https://schema.org', '@type': 'CollectionPage', url: 'https://frontaliereticino.ch/farmacie/' });
    addJsonLd({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [{ item: 'https://frontaliereticino.ch/farmacie/' }] });
    addJsonLd({ '@context': 'https://schema.org', '@type': 'Pharmacy', name: 'Stale dynamic pharmacy' }, true);
    window.history.replaceState({}, '', '/');
    await seo.updateMetaTags('calculator');
    expect(JSON.stringify(jsonLdSchemas())).not.toContain('/farmacie/');
    expect(jsonLdSchemas().some((schema) => schema['@type'] === 'Pharmacy')).toBe(false);

    addJsonLd({ '@context': 'https://schema.org', '@type': 'Pharmacy', name: 'Stale weekly pharmacy' });
    addJsonLd({ '@context': 'https://schema.org', '@type': 'CollectionPage', url: 'https://frontaliereticino.ch/farmacie/di-turno/settimana/2026-09-15/' });
    window.history.replaceState({}, '', '/farmacie/di-turno/settimana/2026-09-15/');
    await seo.updateMetaTags('pharmacy-duty-week');
    expect(JSON.stringify(jsonLdSchemas())).not.toContain('/farmacie/');
    expect(jsonLdSchemas().some((schema) => ['Pharmacy', 'CollectionPage'].includes(schema['@type']))).toBe(false);
  });
});
