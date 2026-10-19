// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as sections from '../scripts/lib/pharmacySections.mjs';
import * as pages from '../build-plugins/pharmacyDirectoryPagesPlugin';
import { buildPharmacyPath, parsePharmacyPath } from '../services/pharmacies/paths';
import { parsePharmacyRoute } from '../services/pharmacies/routePaths';
import type { Locale } from '../services/i18n';
import worker, { apexLegacyResponse } from '../infra/cloudflare-worker/locale-router.js';

const aliases = [
  ['it', '/farmacie/ticino/castagnola/di-turno/'],
  ['en', '/en/pharmacies/ticino/castagnola/on-duty/'],
  ['de', '/de/apotheken/ticino/castagnola/notdienst/'],
  ['fr', '/fr/pharmacies/ticino/castagnola/de-garde/'],
] as const;
const roots: string[] = [];
beforeEach(() => vi.stubGlobal('fetch', vi.fn(async () => new Response('Unexpected origin read', { status: 404 }))));
afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('attested Castagnola regional duty URL migration', () => {
  it.each(aliases)('redirects only the same regional duty intent in %s', async (locale, from) => {
    const target = buildPharmacyPath({ kind: 'duty-city', locale, citySlug: 'lugano' });
    const canonicalRoute = { kind: 'duty-city', locale, citySlug: 'lugano' };
    expect(parsePharmacyRoute(from)).toEqual(canonicalRoute);
    expect(parsePharmacyPath(from)).toEqual(canonicalRoute);
    for (const method of ['GET', 'HEAD']) {
      const response = await worker.fetch(new Request(`https://frontaliereticino.ch${from}?utm_source=gsc`, { method }), {}, { waitUntil() {} });
      expect(response.status).toBe(301);
      expect(response.headers.get('Location')).toBe(`${target}?utm_source=gsc`);
      expect(await response.text()).toBe('');
      expect(fetch).not.toHaveBeenCalled();
    }
    for (const suffix of ['', '/', '/index.html']) {
      const url = new URL(`https://frontaliereticino.ch${from.slice(0, -1)}${suffix}`);
      expect(apexLegacyResponse(url)?.headers.get('Location')).toBe(target);
    }
    expect(apexLegacyResponse(new URL(`https://frontaliereticino.ch${target}`))).toBeNull();
  });

  it('does not infer directory, pharmacy-detail, weekly or unknown-quarter migrations', () => {
    for (const pathname of ['/farmacie/ticino/castagnola/', '/farmacie/ticino/castagnola/farmacia-sconosciuta/',
      '/farmacie/ticino/castagnola/di-turno/extra/', '/farmacie/ticino/castagnola/di-turno/settimana/',
      '/fr/pharmacies/ticino/castagnola/notdienst/', '/fr/pharmacies/ticino/sconosciuto/de-garde/']) {
      expect(apexLegacyResponse(new URL(`https://frontaliereticino.ch${pathname}`))).toBeNull();
    }
  });

  it('shares all four exact aliases with the native static bridge emitter', () => {
    expect(typeof pages.pharmacyDutyCityAliasDescriptors).toBe('function');
    const descriptors = pages.pharmacyDutyCityAliasDescriptors();
    expect(descriptors).toHaveLength(4);
    expect(Object.fromEntries(descriptors.map(({ from, to }) => [from, to]))).toEqual(sections.PHARMACY_DUTY_CITY_REDIRECTS);
    const wrangler = fs.readFileSync(path.resolve(__dirname, '../infra/cloudflare-worker/wrangler.toml'), 'utf8');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pharmacy-duty-city-'));
    roots.push(root);
    for (const descriptor of descriptors) {
      expect(wrangler).toContain(`pattern = "frontaliereticino.ch${descriptor.from.slice(0, -1)}*"`);
      const target = buildPharmacyPath({ kind: 'duty-city', locale: descriptor.locale as Locale, citySlug: 'lugano' });
      expect(descriptor.to).toBe(target);
      pages.emitPharmacyAliasBridge(root, descriptor);
      for (const relative of [`${descriptor.from}index.html`, `${descriptor.from.slice(0, -1)}.html`]) {
        const html = fs.readFileSync(path.join(root, relative.replace(/^\//, '')), 'utf8');
        expect(html).toContain(`https://frontaliereticino.ch${target}`);
        expect(html).toContain('noindex,follow');
        expect(html).toContain('http-equiv="refresh"');
        expect(html).not.toContain('"@type":"Pharmacy"');
      }
    }
  });

  it('retains the canonical municipal duty pages as noindex navigation, not invented services', () => {
    const descriptor = pages.pharmacyPageDescriptors().find(row => row.kind === 'duty-city' && row.citySlug === 'lugano');
    expect(descriptor).toBeTruthy();
    for (const [locale] of aliases) {
      const page = pages.buildPharmacyDirectoryPage(descriptor!, locale, '');
      expect(page.indexable).toBe(false);
      expect(page.html).toContain('noindex,follow');
      expect(page.html).not.toContain('"@type":"ItemList"');
    }
  });
});
