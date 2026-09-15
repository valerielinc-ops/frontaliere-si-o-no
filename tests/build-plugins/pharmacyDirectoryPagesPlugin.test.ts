// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPharmacyAliasBridge, buildPharmacyDirectoryPage, emitPharmacyAliasBridge, pharmacyPageDescriptors } from '../../build-plugins/pharmacyDirectoryPagesPlugin';
import { ITALY_BORDER_PHARMACIES, TICINO_CITIES, TICINO_PHARMACIES, pharmacyCitySlug } from '../../services/pharmacies/data';
import { buildPharmacyPath } from '../../services/pharmacies/paths';
import { extractVisibleText } from '../../scripts/audit-text-html-ratio.mjs';
import dutiesJson from '../../data/pharmacy-duties-ticino.json';
import type { PharmacyDutiesDataset } from '../../services/pharmacies/types';

const locales = ['it', 'en', 'de', 'fr'] as const;
const tempRoots: string[] = [];
const EMPTY_DUTY_DATASET = { ...dutiesJson, duties: [] } as unknown as PharmacyDutiesDataset;

afterEach(() => {
  while (tempRoots.length > 0) fs.rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

describe('pharmacy directory page matrix', () => {
  it('emits hubs, areas, city pages and one detail descriptor per pharmacy', () => {
    const descriptors = pharmacyPageDescriptors();
    expect(descriptors.filter((descriptor) => descriptor.kind === 'pharmacy')).toHaveLength(749);
    expect(descriptors.some((descriptor) => descriptor.kind === 'country' && descriptor.country === 'IT')).toBe(true);
    expect(descriptors.filter((descriptor) => descriptor.kind === 'area')).toHaveLength(3);
    expect(descriptors.filter((descriptor) => descriptor.kind === 'city' && descriptor.country === 'IT').length).toBeGreaterThan(200);
  });

  it.each(locales)('renders the Ticino canton as a same-build city index (%s)', (locale) => {
    const descriptors = pharmacyPageDescriptors();
    const canton = descriptors.find((descriptor) => descriptor.kind === 'canton');
    const cityDescriptors = descriptors.filter((descriptor) => descriptor.kind === 'city' && descriptor.country === 'CH');
    const expectedCityPaths = TICINO_CITIES.map((city) => buildPharmacyPath({ kind: 'city', locale, citySlug: city.slug }, locale));
    const latest = [...new Set(TICINO_PHARMACIES.map((pharmacy) => pharmacy.lastVerifiedAt))].sort().at(-1)!;
    const latestLabel = new Intl.DateTimeFormat(locale === 'it' ? 'it-CH' : locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Zurich' }).format(new Date(latest));

    expect(canton).toBeDefined();
    expect(TICINO_PHARMACIES.length).toBeGreaterThanOrEqual(119);
    expect(TICINO_CITIES.length).toBeGreaterThanOrEqual(34);
    expect(cityDescriptors).toHaveLength(TICINO_CITIES.length);

    const page = buildPharmacyDirectoryPage(canton!, locale, '');
    const nav = page.html.match(/<nav\b[^>]*>[\s\S]*?<\/nav>/)?.[0] || '';
    const hrefs = [...nav.matchAll(/<a href="([^"]+)"/g)].map((match) => match[1]);
    const schemas = [...page.html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((match) => JSON.parse(match[1]));
    const collection = schemas.find((schema) => schema['@type'] === 'CollectionPage');

    expect(page.path).toBe(buildPharmacyPath({ kind: 'canton', locale }, locale));
    expect(page.indexable).toBe(true);
    expect(page.wordCount).toBeGreaterThanOrEqual(50);
    expect(page.html).not.toMatch(/<article\b/);
    expect(hrefs).toEqual(expectedCityPaths);
    expect(hrefs.every((cityPath) => cityDescriptors.some((descriptor) => buildPharmacyPath({ kind: 'city', locale, citySlug: descriptor.citySlug }, locale) === cityPath))).toBe(true);
    expect(page.html).toContain(TICINO_PHARMACIES[0].sourceUrl);
    expect(page.html).toContain(latestLabel);
    expect(page.html).toContain(locale === 'it' ? 'Verifica' : locale === 'en' ? 'Check' : locale === 'de' ? 'prüfen' : 'Vérifiez');
    expect(collection.mainEntity.numberOfItems).toBe(TICINO_CITIES.length);
    expect(collection.mainEntity.itemListElement.map((item: { url: string }) => item.url)).toEqual(expectedCityPaths.map((cityPath) => `https://frontaliereticino.ch${cityPath}`));
  });

  it.each(locales)('publishes every Ticino pharmacy on its generated city page (%s)', (locale) => {
    const cityDescriptors = pharmacyPageDescriptors().filter((descriptor) => descriptor.kind === 'city' && descriptor.country === 'CH');
    const publishedPaths = new Set<string>();

    for (const city of cityDescriptors) {
      const pharmacies = TICINO_PHARMACIES.filter((pharmacy) => pharmacy.city === city.cityName);
      const page = buildPharmacyDirectoryPage(city, locale, '');
      const hrefs = [...page.html.matchAll(/<a href="([^"]+)"/g)].map((match) => match[1]);

      expect(pharmacies.length, `missing pharmacy records for ${locale} ${city.cityName}`).toBeGreaterThan(0);
      expect(page.indexable).toBe(true);
      expect(page.html).toContain('"@type":"FAQPage"');
      expect(page.html).toMatch(/<details\b/);
      for (const pharmacy of pharmacies) {
        const detailPath = buildPharmacyPath({
          kind: 'pharmacy',
          country: 'CH',
          locale,
          citySlug: city.citySlug,
          pharmacySlug: pharmacy.slug,
        }, locale);
        expect(hrefs, `missing ${detailPath}`).toContain(detailPath);
        expect(page.html).toContain(pharmacy.sourceUrl);
        publishedPaths.add(detailPath);
      }
    }

    expect(publishedPaths.size).toBe(TICINO_PHARMACIES.length);
  });

  it.each(locales)('renders an escaped, indexable detail page with schema and one static main (%s)', (locale) => {
    const descriptor = pharmacyPageDescriptors().find((candidate) => candidate.kind === 'pharmacy' && candidate.country === 'IT');
    expect(descriptor).toBeDefined();
    const page = buildPharmacyDirectoryPage(descriptor!, locale, '');
    expect(page.html).toMatch(/<main\b[^>]*class=(?:"|')?seo-static-content/);
    expect(page.html).not.toMatch(/<main\b[^>]*class=(?:"|')?seo-static-content[\s\S]*<main\b/);
    expect(page.html).toContain('"@type":"Pharmacy"');
    expect(page.html).toContain('"@type":"BreadcrumbList"');
    expect(page.html).toMatch(/<meta name=robots content="index, ?follow/);
    expect(page.path).toContain('/');
  });

  it('keeps the directory H1 distinct from the emitted title', () => {
    const descriptor = pharmacyPageDescriptors().find((candidate) => candidate.kind === 'canton');
    expect(descriptor).toBeDefined();
    const page = buildPharmacyDirectoryPage(descriptor!, 'it', '');
    const title = page.html.match(/<title>([^<]*)<\/title>/)?.[1] || '';
    const h1 = page.html.match(/<h1[^>]*>([^<]*)<\/h1>/)?.[1] || '';
    expect(h1).toContain('(guida frontaliere)');
    expect(h1).not.toBe(title);
  });

  it('keeps same-name detail titles unique and duty-city aliases noindex without collection schema', () => {
    const details = pharmacyPageDescriptors().filter((descriptor) => descriptor.kind === 'pharmacy');
    const titles = details.map((descriptor) => buildPharmacyDirectoryPage(descriptor, 'it', '').html.match(/<title>([^<]*)<\/title>/)?.[1] || '');
    expect(new Set(titles).size).toBe(titles.length);

    const dutyCity = pharmacyPageDescriptors().find((descriptor) => descriptor.kind === 'duty-city');
    const page = buildPharmacyDirectoryPage(dutyCity!, 'it', '');
    expect(page.indexable).toBe(false);
    expect(page.html).toContain('noindex,follow');
    expect(page.html).not.toContain('CollectionPage');
  });

  it('renders an explicit verified-duty fallback and disclaimer when the duty dataset is empty', () => {
    const hub = pharmacyPageDescriptors().find((descriptor) => descriptor.kind === 'duty-hub');
    const city = pharmacyPageDescriptors().find((descriptor) => descriptor.kind === 'duty-city' && descriptor.citySlug === 'lugano');
    expect(hub).toBeDefined();
    expect(city).toBeDefined();

    for (const descriptor of [hub!, city!]) {
      const page = buildPharmacyDirectoryPage(descriptor, 'it', '', EMPTY_DUTY_DATASET);
      expect(page.html.toLocaleLowerCase()).toContain('nessun turno verificato');
      expect(page.html).toContain('Verifica sempre telefonicamente con la farmacia prima di recarti sul posto: orari e turni possono cambiare.');
      expect(page.html).not.toMatch(/<article\b/);
    }
  });

  it('re-evaluates a static duty page at the injected interval boundary', () => {
    const descriptor = pharmacyPageDescriptors().find((candidate) => candidate.kind === 'duty-hub');
    const sample = dutiesJson.duties.find((duty) => duty.status === 'verified');
    expect(descriptor).toBeDefined();
    expect(sample).toBeDefined();
    const before = buildPharmacyDirectoryPage(descriptor!, 'it', '', dutiesJson as unknown as PharmacyDutiesDataset, new Date(Date.parse(sample!.endsAt) - 1));
    const after = buildPharmacyDirectoryPage(descriptor!, 'it', '', dutiesJson as unknown as PharmacyDutiesDataset, new Date(Date.parse(sample!.endsAt)));
    const sampleInterval = `${new Intl.DateTimeFormat('it-CH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Zurich' }).format(new Date(sample!.startsAt))} – ${new Intl.DateTimeFormat('it-CH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Zurich' }).format(new Date(sample!.endsAt))}`;
    expect(before.html).toContain(sampleInterval);
    expect(before.html).toMatch(/<article\b/);
    expect(after.html).not.toContain(sampleInterval);
    expect(after.html).toMatch(/<article\b/);
  });

  it('keeps every indexable directory page above the text-html ratio floor', { timeout: 90000 }, () => {
    for (const locale of locales) {
      for (const descriptor of pharmacyPageDescriptors()) {
        const page = buildPharmacyDirectoryPage(descriptor, locale, '/tmp/pharmacy-dist');
        if (!page.indexable) continue;
        const htmlBytes = Buffer.byteLength(page.html, 'utf8');
        const textBytes = Buffer.byteLength(extractVisibleText(page.html), 'utf8');
        expect((textBytes / htmlBytes) * 100, `${locale} ${page.path}`).toBeGreaterThan(10);
      }
    }
  });

  it('samples large collection schema lists without duplicating the full directory in HTML', () => {
    const hub = pharmacyPageDescriptors().find((descriptor) => descriptor.kind === 'hub');
    const page = buildPharmacyDirectoryPage(hub!, 'it', '/tmp/pharmacy-dist');
    const schemas = [...page.html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((match) => JSON.parse(match[1]));
    const collection = schemas.find((schema) => schema['@type'] === 'CollectionPage');
    expect(collection.mainEntity.numberOfItems).toBe(749);
    expect(collection.mainEntity.itemListElement).toHaveLength(10);
  });

  it.each(locales)('keeps Italian country hubs compact and indexable (%s)', (locale) => {
    const country = pharmacyPageDescriptors().find((descriptor) => descriptor.kind === 'country' && descriptor.country === 'IT');
    expect(country).toBeDefined();
    const page = buildPharmacyDirectoryPage(country!, locale, '/tmp/pharmacy-dist');
    const nav = page.html.match(/<nav\b[^>]*>[\s\S]*?<\/nav>/)?.[0] || '';

    expect(page.indexable).toBe(true);
    expect(Buffer.byteLength(page.html, 'utf8')).toBeLessThan(260 * 1024);
    expect(nav.match(/<li\b/g) || []).toHaveLength(3);
    for (const [areaSlug, count] of [['como', 193], ['varese', 266], ['verbano-cusio-ossola', 83] ] as const) {
      const areaPath = buildPharmacyPath({ kind: 'area', country: 'IT', areaSlug, locale }, locale);
      expect(nav).toContain(`href="${areaPath}"`);
      expect(nav).toContain(String(count));
    }
    expect(page.html.match(/<article\b/g) || []).toHaveLength(0);
    const schemas = [...page.html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((match) => JSON.parse(match[1]));
    const collection = schemas.find((schema) => schema['@type'] === 'CollectionPage');
    expect(collection.mainEntity.numberOfItems).toBe(3);
    expect(collection.mainEntity.itemListElement).toHaveLength(3);
    expect(collection.mainEntity.itemListElement.map((item: { url: string }) => item.url)).toEqual(expect.arrayContaining([
      `https://frontaliereticino.ch${buildPharmacyPath({ kind: 'area', country: 'IT', areaSlug: 'como', locale }, locale)}`,
      `https://frontaliereticino.ch${buildPharmacyPath({ kind: 'area', country: 'IT', areaSlug: 'varese', locale }, locale)}`,
      `https://frontaliereticino.ch${buildPharmacyPath({ kind: 'area', country: 'IT', areaSlug: 'verbano-cusio-ossola', locale }, locale)}`,
    ]));
    expect(page.html).toContain('"@type":"BreadcrumbList"');
  });

  it.each(locales)('keeps Italian province hubs compact while linking every pharmacy (%s)', (locale) => {
    const area = pharmacyPageDescriptors().find((descriptor) => descriptor.kind === 'area' && descriptor.areaSlug === 'varese');
    const pharmacies = ITALY_BORDER_PHARMACIES.filter((pharmacy) => pharmacy.province === 'VA');
    expect(area).toBeDefined();

    const page = buildPharmacyDirectoryPage(area!, locale, '/tmp/pharmacy-dist');
    const hrefs = [...page.html.matchAll(/<a href="([^"]+)"/g)].map((match) => match[1]);

    expect(page.indexable).toBe(true);
    expect(Buffer.byteLength(page.html, 'utf8')).toBeLessThan(260 * 1024);
    expect(page.html).not.toMatch(/<article\b/);
    for (const pharmacy of pharmacies) {
      const detailPath = buildPharmacyPath({
        kind: 'pharmacy',
        country: 'IT',
        locale,
        areaSlug: 'varese',
        citySlug: pharmacyCitySlug(pharmacy.city),
        pharmacySlug: pharmacy.slug,
      }, locale);
      expect(hrefs, 'missing ' + detailPath).toContain(detailPath);
      expect(page.html).toContain(pharmacy.sourceUrl);
    }
  });

  it('emits the current weekly duty route as indexable only for a valid P0 release pair', () => {
    const descriptor = pharmacyPageDescriptors().find((candidate) => candidate.kind === 'duty-week');
    expect(descriptor?.weekStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const now = new Date('2026-09-14T19:00:00.000Z');
    const page = buildPharmacyDirectoryPage(descriptor!, 'it', '/tmp/pharmacy-dist', dutiesJson as unknown as PharmacyDutiesDataset, now);
    expect(page.path).toContain('/farmacie-di-turno/settimana/');
    expect(page.indexable).toBe(true);
    expect(page.html).toMatch(/<meta name=robots content="index, ?follow/);
    expect(page.html).toContain('Mendrisiotto');
    expect(page.html).toContain('Luganese');
    expect(page.html).toContain('Bellinzonese');
    expect(page.html).toContain('Biasca e Valli');
    expect(page.html).toContain('Non coperto in questa edizione');
    expect(page.html).toContain('"@type":"ItemList"');

    const tampered = {
      ...dutiesJson,
      _release: { ...dutiesJson._release, state: 'partial' },
    } as unknown as PharmacyDutiesDataset;
    const tamperedPage = buildPharmacyDirectoryPage(descriptor!, 'it', '/tmp/pharmacy-dist', tampered, now);
    expect(tamperedPage.indexable).toBe(false);
    expect(tamperedPage.html).toContain('noindex,follow');
    expect(tamperedPage.html).not.toContain('"@type":"ItemList"');
  });

  it('emits a noindex canonical bridge for a historical Italian detail path', () => {
    const bridge = buildPharmacyAliasBridge({
      pharmacy: pharmacyPageDescriptors().find((descriptor) => descriptor.kind === 'pharmacy' && descriptor.country === 'IT')!.pharmacy!,
      alias: { country: 'IT', province: 'CO', city: 'Como', slug: 'farmacia-vecchia-como-42' },
      locale: 'it',
      from: '/farmacie/italia/como/como/farmacia-vecchia-como-42/',
      to: '/farmacie/italia/como/como/farmacia-corrente-42/',
    });
    expect(bridge).toContain('noindex,follow');
    expect(bridge).toContain('rel="canonical" href="https://frontaliereticino.ch/farmacie/italia/como/como/farmacia-corrente-42/"');
    expect(bridge).toContain('http-equiv="refresh"');
  });

  it('replaces stale index and flat files for a historical detail path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pharmacy-alias-bridge-'));
    tempRoots.push(root);
    const descriptor = {
      pharmacy: pharmacyPageDescriptors().find((candidate) => candidate.kind === 'pharmacy' && candidate.country === 'IT')!.pharmacy!,
      alias: { country: 'IT' as const, province: 'CO', city: 'Como', slug: 'farmacia-vecchia-como-42' },
      locale: 'it' as const,
      from: '/farmacie/italia/como/como/farmacia-vecchia-como-42/',
      to: '/farmacie/italia/como/como/farmacia-corrente-42/',
    };
    const relativePath = descriptor.from.replace(/^\/+/, '').replace(/\/+$/, '');
    const outDir = path.join(root, relativePath);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'index.html'), 'stale canonical');
    fs.writeFileSync(path.join(root, `${relativePath}.html`), 'stale flat');

    emitPharmacyAliasBridge(root, descriptor);

    expect(fs.readFileSync(path.join(outDir, 'index.html'), 'utf8')).toContain('noindex,follow');
    expect(fs.readFileSync(path.join(root, `${relativePath}.html`), 'utf8')).toContain('noindex,follow');
  });
});
