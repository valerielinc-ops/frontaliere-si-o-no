// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPharmacyAliasBridge, buildPharmacyDirectoryPage, emitPharmacyAliasBridge, pharmacyPageDescriptors } from '../../build-plugins/pharmacyDirectoryPagesPlugin';
import { renderItalyDutyCoverageSection } from '../../build-plugins/pharmacyItalyDuty';
import { ITALY_BORDER_PHARMACIES, TICINO_CITIES, TICINO_PHARMACIES, pharmacyCitySlug } from '../../services/pharmacies/data';
import { buildDutyCoverageMatrix } from '../../services/pharmacies/dutyCoverageMatrix';
import { buildPharmacyPath } from '../../services/pharmacies/paths';
import { formatDutyDateTime } from '../../services/pharmacies/dutyWeek';
import { buildItalyDutyWeekModel, currentItalyDutyWeekStart } from '../../services/pharmacies/italyDuty';
import { extractVisibleText } from '../../scripts/audit-text-html-ratio.mjs';
import catalogueJson from '../../data/pharmacies-ticino-complete.json';
import dutiesJson from '../../data/pharmacy-duties-ticino.json';
import italyDutiesJson from '../../data/pharmacy-duties-italy.json';
import italyStatusJson from '../../data/pharmacy-duties-italy-status.json';
import type { ItalyDutySnapshot } from '../../services/pharmacies/italyRelease';
import type { PharmacyDutiesDataset } from '../../services/pharmacies/types';

const locales = ['it', 'en', 'de', 'fr'] as const;
const tempRoots: string[] = [];
const EMPTY_DUTY_DATASET = { ...dutiesJson, duties: [] } as unknown as PharmacyDutiesDataset;

afterEach(() => {
  while (tempRoots.length > 0) fs.rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

// Live-data counts: data/pharmacies-*.json are re-synced nightly, so a pinned
// literal (749, 266) turns this gate red on every legitimate refresh. Derive
// the expectation from the same snapshot the plugin reads.
const TOTAL_PHARMACIES = TICINO_PHARMACIES.length + ITALY_BORDER_PHARMACIES.length;
const italyProvinceCount = (code: string) => ITALY_BORDER_PHARMACIES.filter((pharmacy) => pharmacy.province === code).length;

describe('pharmacy directory page matrix', () => {
  it('emits hubs, areas, city pages and one detail descriptor per pharmacy', () => {
    const descriptors = pharmacyPageDescriptors();
    expect(descriptors.filter((descriptor) => descriptor.kind === 'pharmacy')).toHaveLength(TOTAL_PHARMACIES);
    expect(descriptors.some((descriptor) => descriptor.kind === 'country' && descriptor.country === 'IT')).toBe(true);
    // cron-count-ok: le tre province di confine sono la costante ITALY_BORDER_PROVINCES del codice, non una conta del dataset.
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
      expect(page.html).toContain(`"@id":"https://frontaliereticino.ch${buildPharmacyPath({ kind: 'city', locale, citySlug: city.citySlug }, locale)}#faq"`);
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
    const schemas = [...page.html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((match) => JSON.parse(match[1]));
    const pharmacySchema = schemas.find((schema) => schema['@type'] === 'Pharmacy');
    const expectedRegion = descriptor!.pharmacy!.canton || descriptor!.pharmacy!.province || descriptor!.pharmacy!.region;
    expect(pharmacySchema.address.addressRegion).toBe(expectedRegion);
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

    const hubPage = buildPharmacyDirectoryPage(hub!, 'it', '', EMPTY_DUTY_DATASET);
    expect(hubPage.html.toLocaleLowerCase()).toContain('turni non mostrati');
    expect(hubPage.html).toMatch(/data-release-ready=(?:"false"|false)/);
    expect(hubPage.html).not.toContain('"@type":"CollectionPage"');
    expect(hubPage.html).not.toMatch(/<article\b/);

    const cityPage = buildPharmacyDirectoryPage(city!, 'it', '', EMPTY_DUTY_DATASET);
    expect(cityPage.html.toLocaleLowerCase()).toContain('nessun turno verificato');
    expect(cityPage.html).toContain('Verifica sempre telefonicamente con la farmacia prima di recarti sul posto: orari e turni possono cambiare.');
    expect(cityPage.html).not.toMatch(/<article\b/);
  });

  it.each(locales)('keeps the static coverage matrix to five Ticino regions and 25 source-only cantons (%s)', (locale) => {
    const descriptor = pharmacyPageDescriptors().find((candidate) => candidate.kind === 'duty-hub');
    // The matrix evaluates the Ticino release (duties + catalogue) AND the
    // Italian one (duties + status), refreshed by separate crons in either
    // order. A snapshot fetched after `now` is fail-closed as stale, so pinning
    // `now` to the Ticino duties alone turned this red whenever the Italian
    // refresh landed later (2026-09-24: Ticino 09:27, Italy 09:29).
    const snapshotAt = Math.max(...[dutiesJson._fetchedAt, catalogueJson._fetchedAt, italyDutiesJson._fetchedAt, italyStatusJson._fetchedAt]
      .map((fetchedAt) => Date.parse(String(fetchedAt))));
    const now = new Date(snapshotAt + 60_000);
    const page = buildPharmacyDirectoryPage(descriptor!, locale, '', dutiesJson as unknown as PharmacyDutiesDataset, now);
    // Quali province italiane escono pubblicate lo decide lo snapshot che il
    // cron farmacie riscrive (VB e' `best-effort` e puo' tornare disponibile,
    // CO/VA possono perdere copertura): l'attesa si legge dallo stesso modello
    // che il plugin rende, non da una fotografia del dato (#9743).
    const italy = buildDutyCoverageMatrix({ locale, duties: dutiesJson as unknown as PharmacyDutiesDataset, now }).italy;
    const publishedProvinces = italy.provinces.filter((province) => province.publishable);

    expect(page.indexable).toBe(true);
    // cron-count-ok: le cinque regioni ticinesi sono DUTY_WEEK_REGIONS, costante del codice.
    expect(page.html.match(/data-coverage-kind=(?:"ticino-region"|ticino-region)/g) || []).toHaveLength(5);
    // cron-count-ok: i 26 cantoni meno il Ticino (SOURCE_ONLY_CANTONS), costante del codice.
    expect(page.html.match(/data-coverage-kind=(?:"source-only-canton"|source-only-canton)/g) || []).toHaveLength(25);
    // Main may promote a source-only canton to a valid non-unverified state
    // (for example Geneva's fail-closed `degraded` source slice). The matrix
    // contract requires one status attribute per canton, not that every
    // source remains `unverified` forever.
    // cron-count-ok: un attributo di stato per ciascuno dei 25 cantoni solo-fonte, costante del codice.
    expect(page.html.match(/data-source-status=(?:"(?:unverified|degraded|active|blocked|unavailable)"|(?:unverified|degraded|active|blocked|unavailable))/g) || []).toHaveLength(25);
    expect(page.html).toMatch(/data-release-ready=(?:"true"|true)/);
    // cron-count-ok: le tre province ITALY_DUTY_PROVINCES, costante del codice.
    expect(page.html.match(/data-coverage-kind=(?:"italy-province"|italy-province)/g) || []).toHaveLength(3);
    expect(page.html).toMatch(/data-italy-release-ready=(?:"true"|true)/);
    expect(page.html).toMatch(new RegExp(`data-italy-indexable=(?:"${italy.indexable}"|${italy.indexable})`));
    expect(page.html).toMatch(/data-italy-release-state=(?:"fresh"|fresh)/);
    // Una release pronta pubblica almeno le province `required`.
    expect(publishedProvinces.length).toBeGreaterThan(0);
    expect(page.html.match(/data-italy-duty-published/g) || []).toHaveLength(publishedProvinces.length);
    for (const province of italy.provinces.filter((candidate) => !candidate.publishable)) {
      expect(page.html).not.toMatch(new RegExp(`data-province-code=(?:"${province.code}"|${province.code})[^>]*data-italy-duty-published`));
    }
    expect(page.html).toContain('https://apotheken-aargau.ch/notfall/');
    expect(page.html).toContain('https://www.farmacielocarnese.ch/');

    const tampered = { ...dutiesJson, _release: { ...dutiesJson._release, state: 'partial' } } as unknown as PharmacyDutiesDataset;
    const unavailable = buildPharmacyDirectoryPage(descriptor!, locale, '', tampered, now);
    expect(unavailable.indexable).toBe(false);
    expect(unavailable.html).toContain('noindex,follow');
    expect(unavailable.html).toMatch(/data-release-ready=(?:"false"|false)/);
    expect(unavailable.html).not.toContain('"@type":"CollectionPage"');
    expect(unavailable.html).not.toContain('"@type":"ItemList"');
  });

  it('re-evaluates a static duty page when the atomic snapshot becomes fresh', () => {
    const descriptor = pharmacyPageDescriptors().find((candidate) => candidate.kind === 'duty-hub');
    const snapshotAt = Math.max(Date.parse(dutiesJson._fetchedAt), Date.parse(catalogueJson._fetchedAt));
    const afterNow = new Date(snapshotAt + 60_000);
    const sample = dutiesJson.duties.find((duty) => (
      duty.status === 'verified'
      && Date.parse(duty.startsAt) <= afterNow.getTime()
      && Date.parse(duty.endsAt) > afterNow.getTime()
    ));
    expect(descriptor).toBeDefined();
    expect(sample).toBeDefined();
    const before = buildPharmacyDirectoryPage(descriptor!, 'it', '', dutiesJson as unknown as PharmacyDutiesDataset, new Date(snapshotAt - 1));
    const after = buildPharmacyDirectoryPage(descriptor!, 'it', '', dutiesJson as unknown as PharmacyDutiesDataset, afterNow);
    expect(before.indexable).toBe(false);
    expect(before.html).not.toContain(formatDutyDateTime(sample!.startsAt));
    expect(after.indexable).toBe(true);
    expect(after.html).toContain(formatDutyDateTime(sample!.startsAt));
    expect(after.html).toContain(formatDutyDateTime(sample!.endsAt));
    expect(after.html).toMatch(new RegExp(`data-duty-id=(?:"${sample!.id}"|${sample!.id})`));
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
    expect(collection.mainEntity.numberOfItems).toBe(TOTAL_PHARMACIES);
    // cron-count-ok: tetto MAX_COLLECTION_SCHEMA_ITEMS del plugin; il totale del dataset lo verifica numberOfItems qui sopra.
    expect(collection.mainEntity.itemListElement).toHaveLength(10);
  });

  it.each(locales)('keeps Italian country hubs compact and indexable (%s)', (locale) => {
    const country = pharmacyPageDescriptors().find((descriptor) => descriptor.kind === 'country' && descriptor.country === 'IT');
    expect(country).toBeDefined();
    const page = buildPharmacyDirectoryPage(country!, locale, '/tmp/pharmacy-dist');
    const nav = page.html.match(/<nav\b[^>]*>[\s\S]*?<\/nav>/)?.[0] || '';

    expect(page.indexable).toBe(true);
    expect(Buffer.byteLength(page.html, 'utf8')).toBeLessThan(260 * 1024);
    // cron-count-ok: una voce per ciascuna delle tre province ITALY_BORDER_PROVINCES, costante del codice.
    expect(nav.match(/<li\b/g) || []).toHaveLength(3);
    for (const [areaSlug, count] of [['como', italyProvinceCount('CO')], ['varese', italyProvinceCount('VA')], ['verbano-cusio-ossola', italyProvinceCount('VB')]] as const) {
      const areaPath = buildPharmacyPath({ kind: 'area', country: 'IT', areaSlug, locale }, locale);
      expect(nav).toContain(`href="${areaPath}"`);
      expect(nav).toContain(String(count));
    }
    expect(page.html.match(/<article\b/g) || []).toHaveLength(0);
    expect(page.html).toContain(`href="${buildPharmacyPath({ kind: 'duty-hub', country: 'IT', locale }, locale)}"`);
    const schemas = [...page.html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((match) => JSON.parse(match[1]));
    const collection = schemas.find((schema) => schema['@type'] === 'CollectionPage');
    expect(collection.mainEntity.numberOfItems).toBe(3);
    // cron-count-ok: le tre province ITALY_BORDER_PROVINCES, costante del codice.
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
    expect(page.html).toContain(`href="${buildPharmacyPath({ kind: 'duty-hub', country: 'IT', locale }, locale)}"`);
  });

  it('emits a valid weekly duty route as indexable only for a valid P0 release pair', () => {
    const descriptor = pharmacyPageDescriptors().find((candidate) => candidate.kind === 'duty-week');
    expect(descriptor?.weekStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const now = new Date(Math.max(Date.parse(dutiesJson._fetchedAt), Date.parse(catalogueJson._fetchedAt)) + 60_000);
    const nextWeek = new Date(`${descriptor!.weekStart}T00:00:00Z`);
    nextWeek.setUTCDate(nextWeek.getUTCDate() + 7);
    const validDescriptor = { ...descriptor!, weekStart: nextWeek.toISOString().slice(0, 10) };
    const page = buildPharmacyDirectoryPage(validDescriptor, 'it', '/tmp/pharmacy-dist', dutiesJson as unknown as PharmacyDutiesDataset, now);
    expect(page.path).toContain('/farmacie-di-turno/settimana/');
    expect(page.indexable).toBe(true);
    expect(page.html).toMatch(/<meta name=robots content="index, ?follow/);
    expect(page.html).toContain('Mendrisiotto');
    expect(page.html).toContain('Luganese');
    expect(page.html).toContain('Bellinzonese');
    expect(page.html).toContain('Biasca e Valli');
    expect(page.html).toContain('Locarnese');
    expect(page.html).toContain('<table');
    expect(page.html).toMatch(/\d{2}\.\d{2}\.\d{4}/);
    expect(page.html).not.toContain('Non coperto in questa edizione');
    expect(page.html).toContain('"@type":"ItemList"');

    const tampered = {
      ...dutiesJson,
      _release: { ...dutiesJson._release, state: 'partial' },
    } as unknown as PharmacyDutiesDataset;
    const tamperedPage = buildPharmacyDirectoryPage(validDescriptor, 'it', '/tmp/pharmacy-dist', tampered, now);
    expect(tamperedPage.indexable).toBe(false);
    expect(tamperedPage.html).toContain('noindex,follow');
    expect(tamperedPage.html).not.toContain('"@type":"ItemList"');
  });

  it.each(locales)('keeps Italian duty hub and week noindex while exposing only verified provinces (%s)', (locale) => {
    const hub = pharmacyPageDescriptors().find((candidate) => candidate.kind === 'italy-duty-hub');
    const week = pharmacyPageDescriptors().find((candidate) => candidate.kind === 'italy-duty-week');
    const now = new Date(Date.parse(String(italyDutiesJson._fetchedAt)) + 60_000);
    const weekDescriptor = { ...week!, weekStart: currentItalyDutyWeekStart(now) };
    // Il modello che le due pagine rendono. Quante e quali province sono
    // pubblicate, e quindi se la settimana e' indicizzabile, lo decide lo
    // snapshot del cron farmacie (VB e' `best-effort`): l'attesa segue il
    // modello invece di fotografare il dato di oggi (#9743).
    const italyModel = buildItalyDutyWeekModel({ now, weekStart: weekDescriptor.weekStart });
    const expectedRows = italyModel.provinces.flatMap((province) => province.duties).length;
    const publishedProvinces = italyModel.provinces.filter((province) => province.publishable);
    const sourceOnlyProvinces = italyModel.provinces.filter((province) => !province.publishable);
    expect(publishedProvinces.length).toBeGreaterThan(0);

    for (const descriptor of [hub!, weekDescriptor]) {
      const page = buildPharmacyDirectoryPage(descriptor, locale, '/tmp/pharmacy-dist', undefined, now);
      // Fail-closed: una settimana non indicizzabile non diventa mai una pagina indicizzabile.
      if (!italyModel.indexable) {
        expect(page.indexable).toBe(false);
        expect(page.html).toContain('noindex,follow');
        expect(page.html).not.toContain('application/ld+json');
      }
      expect(page.html).toContain(descriptor.kind === 'italy-duty-week' ? 'data-italy-duty-week=true' : 'data-italy-duty-coverage=true');
      expect(page.html).toContain('data-release-ready=true');
      expect(page.html).toContain(`data-week-ready=${italyModel.indexable}`);
      expect(page.html.match(/data-italy-duty-published/g) || []).toHaveLength(publishedProvinces.length);
      expect(page.html.match(/data-duty-country=IT/g) || []).toHaveLength(expectedRows);
      expect(page.html).toMatch(/<time\b/);
      expect(page.html).toContain('data-source-only-status=true');
      for (const province of sourceOnlyProvinces) {
        expect(page.html).not.toMatch(new RegExp(`data-italy-duty-province=${province.code}[^>]*data-italy-duty-published`));
      }
      expect(page.html).toContain('novita_138.html');
      expect(page.html).toContain('Dettaglionews?IDNews=400586');
      expect(page.html).toContain('2968938.pdf');
    }
    expect(buildPharmacyPath({ kind: 'italy-duty-hub', country: 'IT', locale }, locale)).toContain('/');
  });

  it('renders generic Italian duty descriptors with the same canonical static contract', () => {
    const now = new Date(Date.parse(String(italyDutiesJson._fetchedAt)) + 60_000);
    const weekStart = currentItalyDutyWeekStart(now);
    // Indicizzabilita' dal modello, non dallo snapshot di oggi (#9743).
    const italyModel = buildItalyDutyWeekModel({ now, weekStart });
    const descriptors = [
      { kind: 'duty-hub' as const, country: 'IT' as const },
      { kind: 'duty-week' as const, country: 'IT' as const, weekStart },
    ];

    for (const descriptor of descriptors) {
      const page = buildPharmacyDirectoryPage(descriptor, 'it', '/tmp/pharmacy-dist', undefined, now);
      expect(page.path).toContain('/farmacie/italia/di-turno/');
      expect(page.html).toContain(descriptor.kind === 'duty-week' ? 'data-italy-duty-week=true' : 'data-italy-duty-coverage=true');
      if (!italyModel.indexable) {
        expect(page.indexable).toBe(false);
        expect(page.html).toContain('noindex,follow');
        expect(page.html).not.toContain('application/ld+json');
      }
    }
  });

  it('keeps the static Italy coverage renderer fail-closed for a partial release', () => {
    const partialDuties = {
      ...italyDutiesJson,
      _release: { ...italyDutiesJson._release, state: 'partial' },
    } as unknown as ItalyDutySnapshot;
    const partialStatus = {
      ...italyStatusJson,
      _release: { ...italyStatusJson._release, state: 'partial' },
    } as unknown as ItalyDutySnapshot;
    const matrix = buildDutyCoverageMatrix({
      locale: 'it',
      weekStart: '2026-09-14',
      now: new Date('2026-09-15T12:00:00.000Z'),
      italyDuties: partialDuties,
      italyStatus: partialStatus,
    });
    const html = renderItalyDutyCoverageSection('it', matrix);

    expect(matrix.italy.state).toBe('partial');
    // cron-count-ok: le tre province ITALY_DUTY_PROVINCES, costante del codice.
    expect(html.match(/data-coverage-kind="italy-province"/g) || []).toHaveLength(3);
    expect(html).not.toContain('data-italy-duty-published');
    expect(html).not.toMatch(/data-duty-id=/);
    expect(html).not.toMatch(/<time\b/);
    expect(html).toContain('novita_138.html');
    expect(html).toContain('Dettaglionews?IDNews=400586');
    expect(html).toContain('2968938.pdf');
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
