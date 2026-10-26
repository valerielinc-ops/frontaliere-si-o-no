import { describe, expect, it, vi } from 'vitest';

import {
  fetchTicinoPdfBuffer,
  fetchTicinoPdfDocument,
} from '../scripts/import-pharmacies-border.mjs';
import {
  TICINO_PHARMACY_DIRECTORY_URL,
  TICINO_PHARMACY_PDF_MIRROR_URL,
  TICINO_PHARMACY_PDF_URL,
  discoverTicinoPharmacyPdfUrls,
} from '../scripts/lib/pharmacy-border-parser.mjs';

describe('Ticino pharmacy PDF source fallback', () => {
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

  it('does not reinterpret a persistent source error as a mirror fallback', async () => {
    const error = Object.assign(new Error('HTTP 404'), { status: 404 });
    const fetchSource = vi.fn().mockRejectedValue(error);

    await expect(fetchTicinoPdfBuffer(fetchSource)).rejects.toBe(error);
    expect(fetchSource).toHaveBeenCalledOnce();
    expect(fetchSource).toHaveBeenCalledWith(TICINO_PHARMACY_PDF_URL);
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
});
