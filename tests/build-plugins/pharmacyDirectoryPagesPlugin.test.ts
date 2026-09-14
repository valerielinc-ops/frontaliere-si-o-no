// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPharmacyAliasBridge, buildPharmacyDirectoryPage, emitPharmacyAliasBridge, pharmacyPageDescriptors } from '../../build-plugins/pharmacyDirectoryPagesPlugin';
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
    const dataset = {
      ...dutiesJson,
      duties: [{ ...sample!, startsAt: '2026-09-14T10:00:00.000Z', endsAt: '2026-09-14T12:00:00.000Z' }],
    } as unknown as PharmacyDutiesDataset;

    const before = buildPharmacyDirectoryPage(descriptor!, 'it', '', dataset, new Date('2026-09-14T11:00:00.000Z'));
    const after = buildPharmacyDirectoryPage(descriptor!, 'it', '', dataset, new Date('2026-09-14T12:00:00.000Z'));
    expect(before.html.toLocaleLowerCase()).not.toContain('nessun turno verificato');
    expect(before.html).toMatch(/<article\b/);
    expect(after.html.toLocaleLowerCase()).toContain('nessun turno verificato');
    expect(after.html).not.toMatch(/<article\b/);
  });

  it('keeps every indexable directory page above the text-html ratio floor', () => {
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
