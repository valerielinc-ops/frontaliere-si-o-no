import { describe, expect, it, vi } from 'vitest';

import {
  buildTicinoCatalogueSnapshot,
  fetchTicinoPdfBuffer,
  fetchTicinoPdfDocument,
  fetchTicinoOfctCatalogue,
} from '../scripts/import-pharmacies-border.mjs';
import { detectMissingSecondaryProvenance } from '../scripts/check-pharmacy-data-health.mjs';
import {
  TICINO_PHARMACY_DIRECTORY_URL,
  TICINO_PHARMACY_PDF_MIRROR_URL,
  TICINO_PHARMACY_PDF_URL,
  discoverTicinoPharmacyPdfUrls,
  isTicinoPharmacyPdfUrl,
} from '../scripts/lib/pharmacy-border-parser.mjs';
import { OFCT_REGIONS } from '../scripts/lib/pharmacy-ticino-parser.mjs';

describe('Ticino pharmacy PDF source fallback', () => {
  it('rehydrates availability metadata when carrying forward an older catalogue', () => {
    const previousPharmacies = Array.from({ length: 200 }, (_, index) => ({
      id: `ti-previous-${index}`,
      name: `Farmacia ${index}`,
      address: `Via Roma ${index + 1}`,
      postalCode: '6900',
      city: 'Lugano',
      country: 'CH',
      canton: 'Ticino',
      sourceType: 'official',
      sourceUrl: 'https://www.ofct.ch/luganese/',
      ...(index === 0 ? { phone: '+41 91 000 00 00' } : {}),
    }));
    const fallback = buildTicinoCatalogueSnapshot({
      parsed: { rows: [], warnings: [] },
      previous: { pharmacies: previousPharmacies },
      fetchedAt: '2026-10-27T12:00:00.000Z',
      sourceError: 'Ticino pharmacy catalogue refresh was not published after transient source failure: timeout',
    });
    const pharmacy = fallback.pharmacies[0];

    expect(pharmacy.dataAvailability).toMatchObject({ phone: 'verified' });
    expect(detectMissingSecondaryProvenance([{
      jurisdiction: 'CH-TI',
      sourceKey: 'ticino-complete',
      pharmacy,
    }])).toEqual([]);
  });

  it('uses the official mirror after the primary transport budget is exhausted', async () => {
    const calls: string[] = [];
    const fetchSource = vi.fn(async (url: string) => {
      calls.push(url);
      if (calls.length === 1) {
        throw Object.assign(new Error('primary timeout'), { retryBudgetExhausted: true });
      }
      return Buffer.from('%PDF');
    });

    await expect(fetchTicinoPdfBuffer(fetchSource)).resolves.toEqual(Buffer.from('%PDF'));
    expect(calls).toEqual([TICINO_PHARMACY_PDF_URL, TICINO_PHARMACY_PDF_MIRROR_URL]);
  });

  it('uses the official mirror after a wrapped fetch-failed transport error', async () => {
    const calls: string[] = [];
    const fetchSource = vi.fn(async (url: string) => {
      calls.push(url);
      if (calls.length === 1) {
        throw new Error('Failed to fetch www4 source (timeout): fetch failed', {
          cause: new TypeError('fetch failed'),
        });
      }
      return Buffer.from('%PDF');
    });

    await expect(fetchTicinoPdfDocument(fetchSource)).resolves.toEqual({
      buffer: Buffer.from('%PDF'),
      sourceUrl: TICINO_PHARMACY_PDF_MIRROR_URL,
    });
    expect(calls).toEqual([TICINO_PHARMACY_PDF_URL, TICINO_PHARMACY_PDF_MIRROR_URL]);
  });

  it('does not reinterpret a persistent source error as a mirror fallback', async () => {
    const error = Object.assign(new Error('HTTP 403'), { status: 403 });
    const fetchSource = vi.fn().mockRejectedValue(error);

    await expect(fetchTicinoPdfBuffer(fetchSource)).rejects.toBe(error);
    expect(fetchSource).toHaveBeenCalledOnce();
    expect(fetchSource).toHaveBeenCalledWith(TICINO_PHARMACY_PDF_URL);
  });

  it('returns a retryable aggregate when both official PDF transports and the directory time out', async () => {
    const fetchSource = vi.fn().mockRejectedValue(
      Object.assign(new TypeError('fetch failed'), { retryBudgetExhausted: true }),
    );
    const fetchDirectory = vi.fn().mockRejectedValue(new TypeError('fetch failed'));

    const failure = await fetchTicinoPdfDocument(fetchSource, fetchDirectory).catch((error: unknown) => error as Error & {
      retryBudgetExhausted?: boolean;
      sourceFailures?: Array<{ sourceUrl: string; canTryAnotherSource: boolean }>;
    });

    expect(failure).toMatchObject({ retryBudgetExhausted: true });
    expect(failure.message).toContain('All official Ticino pharmacy sources failed');
    expect(failure.sourceFailures).toHaveLength(3);
    expect(failure.sourceFailures?.map(({ sourceUrl, canTryAnotherSource }) => ({ sourceUrl, canTryAnotherSource }))).toEqual([
      { sourceUrl: TICINO_PHARMACY_PDF_URL, canTryAnotherSource: true },
      { sourceUrl: TICINO_PHARMACY_PDF_MIRROR_URL, canTryAnotherSource: true },
      { sourceUrl: TICINO_PHARMACY_DIRECTORY_URL, canTryAnotherSource: true },
    ]);
  });

  it('preserves source provenance when the official mirror is the source of a fresh catalogue', () => {
    const snapshot = buildTicinoCatalogueSnapshot({
      parsed: { rows: Array.from({ length: 200 }, (_, index) => ({
        id: `row-${index}`,
        name: `Farmacia ${index}`,
        address: `Via Roma ${index + 1}`,
        postalCode: '6900',
        city: 'Lugano',
      })), warnings: [] },
      previous: { pharmacies: [] },
      fetchedAt: '2026-10-29T09:00:00.000Z',
      sourceUrl: TICINO_PHARMACY_PDF_MIRROR_URL,
    });

    expect(snapshot._source).toBe(TICINO_PHARMACY_PDF_MIRROR_URL);
    expect(snapshot._sourceCanonical).toBe(TICINO_PHARMACY_PDF_URL);
  });

  it('accepts the real official nested PDF path for provenance', () => {
    expect(isTicinoPharmacyPdfUrl(TICINO_PHARMACY_PDF_URL)).toBe(TICINO_PHARMACY_PDF_URL);
    expect(isTicinoPharmacyPdfUrl(TICINO_PHARMACY_PDF_MIRROR_URL)).toBe(TICINO_PHARMACY_PDF_MIRROR_URL);
    expect(isTicinoPharmacyPdfUrl('https://www4.ti.ch/fileadmin/DSS/DSP/UFC/PDF/Lista_Farmacie_sito_web_stato_20261026.pdf')).toBe('https://www4.ti.ch/fileadmin/DSS/DSP/UFC/PDF/Lista_Farmacie_sito_web_stato_20261026.pdf');
    expect(isTicinoPharmacyPdfUrl('https://www4.ti.ch/fileadmin/DSS/DSP/UFC/PDF/Elenchi_e_Indirizzi/altro.pdf')).toBeNull();
  });

  it('discovers the dated catalogue PDF only on the official Ticino hosts', () => {
    const html = `
      <a href="https://example.invalid/Lista_Farmacie_sito_web_stato_20261026.pdf">fake</a>
      <a href="https://www4.ti.ch/not-allowlisted/Lista_Farmacie_sito_web_stato_20261026.pdf">wrong path</a>
      <a href="/fileadmin/DSS/DSP/UFC/PDF/Lista_Farmacie_Convenzionate.pdf">convenzionate</a>
      <a href="/fileadmin/DSS/DSP/UFC/PDF/Lista_farmacie_sito_web_stato_20260713.pdf">Farmacie</a>
    `;

    expect(discoverTicinoPharmacyPdfUrls(html, TICINO_PHARMACY_DIRECTORY_URL)).toEqual([
      'https://www4.ti.ch/fileadmin/DSS/DSP/UFC/PDF/Lista_farmacie_sito_web_stato_20260713.pdf',
    ]);
  });

  it('uses the dated PDF linked by the official page after both static transports fail', async () => {
    const discoveredUrl = 'https://www4.ti.ch/fileadmin/DSS/DSP/UFC/PDF/Lista_farmacie_sito_web_stato_20260713.pdf';
    const calls: string[] = [];
    const exhausted = () => Object.assign(new Error('source timeout'), { retryBudgetExhausted: true });
    const fetchSource = vi.fn(async (url: string) => {
      calls.push(url);
      if (url === discoveredUrl) return Buffer.from('%PDF');
      throw exhausted();
    });
    const fetchDirectory = vi.fn(async () => (
      `<a href="/fileadmin/DSS/DSP/UFC/PDF/Lista_farmacie_sito_web_stato_20260713.pdf">Farmacie</a>`
    ));

    await expect(fetchTicinoPdfDocument(fetchSource, fetchDirectory)).resolves.toEqual({
      buffer: Buffer.from('%PDF'),
      sourceUrl: discoveredUrl,
    });
    expect(calls).toEqual([TICINO_PHARMACY_PDF_URL, TICINO_PHARMACY_PDF_MIRROR_URL, discoveredUrl]);
    expect(fetchDirectory).toHaveBeenCalledWith(TICINO_PHARMACY_DIRECTORY_URL, { accept: 'text/html' });
  });

  it('falls back after both legacy URLs return 404 and chooses the newest dated PDF', async () => {
    const olderUrl = 'https://www4.ti.ch/fileadmin/DSS/DSP/UFC/PDF/Lista_farmacie_sito_web_stato_20250101.pdf';
    const newerUrl = 'https://www4.ti.ch/fileadmin/DSS/DSP/UFC/PDF/Lista_farmacie_sito_web_stato_20260713.pdf';
    const calls: string[] = [];
    const fetchSource = vi.fn(async (url: string) => {
      calls.push(url);
      if (url === TICINO_PHARMACY_PDF_URL || url === TICINO_PHARMACY_PDF_MIRROR_URL) {
        throw Object.assign(new Error('HTTP 404'), { status: 404 });
      }
      return Buffer.from('%PDF');
    });
    const fetchDirectory = vi.fn(async () => (
      `<a href="${newerUrl}">current</a><a href="${olderUrl}">old</a>`
    ));

    await expect(fetchTicinoPdfDocument(fetchSource, fetchDirectory)).resolves.toEqual({
      buffer: Buffer.from('%PDF'),
      sourceUrl: newerUrl,
    });
    expect(calls).toEqual([TICINO_PHARMACY_PDF_URL, TICINO_PHARMACY_PDF_MIRROR_URL, newerUrl]);
  });

  it('fetches the four OFCT anagraphic regions sequentially as a secondary source', async () => {
    const calls: string[] = [];
    const fetchRegion = vi.fn(async (url: string) => {
      calls.push(url);
      return `<table id="tabella_lista_farmacie">
        <tr><td>Farmacia</td><td>Indirizzo</td><td>Località</td><td>Telefono</td></tr>
        <tr><td>${url.split('/')[3]}</td><td>Via Roma 1</td><td>6900  Lugano</td><td>+41 91 000 00 00</td></tr>
      </table>`;
    });

    const result = await fetchTicinoOfctCatalogue(fetchRegion, { delayMs: 0 });

    expect(calls).toEqual(OFCT_REGIONS.map((region) => region.url));
    expect(result.rows).toHaveLength(OFCT_REGIONS.length);
    expect(result.sourceRegions).toEqual(OFCT_REGIONS.map((region) => region.key));
    expect(result.rows.every((row) => row.sourceUrl.startsWith('https://www.ofct.ch/'))).toBe(true);
  });

  it('merges OFCT recovery rows without dropping the preserved Locarnese portion', () => {
    const previousPharmacies = Array.from({ length: 200 }, (_, index) => ({
      id: `ti-previous-${index}`,
      name: `Farmacia ${index}`,
      address: `Via Roma ${index + 1}`,
      postalCode: '6900',
      city: 'Lugano',
      slug: `farmacia-${index}-lugano`,
      country: 'CH',
      canton: 'Ticino',
      sourceType: 'official',
      sourceUrl: index === 199 ? 'https://www4.ti.ch/locarnese.pdf' : TICINO_PHARMACY_PDF_URL,
    }));
    const snapshot = buildTicinoCatalogueSnapshot({
      parsed: { rows: [], warnings: [] },
      previous: { pharmacies: previousPharmacies, _fetchedAt: '2026-10-28T12:00:00.000Z' },
      fetchedAt: '2026-10-29T12:00:00.000Z',
      sourceError: 'primary PDF timeout',
      secondaryRows: [{
        name: 'Farmacia 0',
        address: 'Via Roma 1',
        postalCode: '6900',
        city: 'Lugano',
        phone: '+41 91 000 00 00',
        sourceUrl: 'https://www.ofct.ch/luganese/',
      }],
      secondarySourceRegions: ['luganese'],
      secondarySourceUrls: ['https://www.ofct.ch/luganese/'],
    });

    expect(snapshot.pharmacies).toHaveLength(200);
    expect(snapshot.pharmacies.find((pharmacy) => pharmacy.id === 'ti-previous-0')?.sourceUrl)
      .toBe('https://www.ofct.ch/luganese/');
    expect(snapshot.pharmacies.find((pharmacy) => pharmacy.id === 'ti-previous-0')?.phone)
      .toBe('+41 91 000 00 00');
    expect(snapshot.pharmacies.find((pharmacy) => pharmacy.id === 'ti-previous-199')?.sourceUrl)
      .toBe('https://www4.ti.ch/locarnese.pdf');
    expect(snapshot._preserved).toBe(true);
    expect(snapshot._sourceRegions).toEqual(OFCT_REGIONS.map((region) => region.url));
    expect(snapshot._sourceSecondary).toEqual(['https://www.ofct.ch/luganese/']);
    expect(snapshot._fetchedAt).toBe('2026-10-28T12:00:00.000Z');
  });

  it('does not publish OFCT rows that cannot be reconciled to the complete snapshot', () => {
    const previousPharmacies = Array.from({ length: 200 }, (_, index) => ({
      id: `ti-previous-${index}`,
      name: `Farmacia ${index}`,
      address: `Via Roma ${index + 1}`,
      postalCode: '6900',
      city: 'Lugano',
      slug: `farmacia-${index}-lugano`,
      country: 'CH',
      canton: 'Ticino',
      sourceType: 'official',
      sourceUrl: TICINO_PHARMACY_PDF_URL,
    }));

    const snapshot = buildTicinoCatalogueSnapshot({
      parsed: { rows: [], warnings: [] },
      previous: { pharmacies: previousPharmacies, _fetchedAt: '2026-10-28T12:00:00.000Z' },
      fetchedAt: '2026-10-29T12:00:00.000Z',
      sourceError: 'primary PDF timeout',
      secondaryRows: [{
        name: 'Farmacia non riconciliata',
        address: 'Via Nuova 99',
        postalCode: '6900',
        city: 'Lugano',
        sourceUrl: 'https://www.ofct.ch/luganese/',
      }],
      secondarySourceUrls: ['https://www.ofct.ch/luganese/'],
    });

    expect(snapshot.pharmacies).toHaveLength(previousPharmacies.length);
    expect(snapshot.pharmacies.some((pharmacy) => pharmacy.name === 'Farmacia non riconciliata')).toBe(false);
  });
});
