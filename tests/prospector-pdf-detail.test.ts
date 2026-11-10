import { beforeEach, describe, expect, it, vi } from 'vitest';

const { extractPdfJobContentFromUrl } = vi.hoisted(() => ({
  extractPdfJobContentFromUrl: vi.fn(),
}));
vi.mock('../scripts/lib/pdf-job-content.mjs', () => ({ extractPdfJobContentFromUrl }));

import {
  fetchRuntimePage,
  loadSpec,
  observeSpecInProduction,
  templateToRegex,
} from '../scripts/lib/prospector/spec-crawler.mjs';
import { extractRuntimeDetailFields } from '../scripts/lib/prospector/detail-extract.mjs';
import { gradeVacancy } from '../scripts/lib/prospector/validate.mjs';
import { createSpecUrlPolicy } from '../scripts/lib/prospector/public-fetch-policy.mjs';

const SPEC = loadSpec('locarno-film-festival');
const PDF_URL = 'https://www.locarnofestival.ch/it/dam/jcr:7f0ffc2a-4fcb-4c1d-ae58-af1f09b3acc0/LFF80%20%20-%20%20AdF%20Project%20Manager.pdf';
const FORM_URL = 'https://form.locarnofestival.ch/forms/5dc3eb78-901b-4a95-b29a-9f2413612d6e';
const PDF_BYTES = Buffer.from('%PDF-1.7\nfixture bytes');
const PDF_TEXT = [
  'Il Locarno Film Festival è alla ricerca di un/una Atelier du Futur Project Manager Impiego',
  'Atelier du Futur Project Manager',
  'Impiego: contratto a tempo determinato, dal 1° febbraio al 30 settembre 2027.',
  'Luogo di lavoro: Locarno',
  'Mansioni e responsabilità: assicurare la gestione complessiva e la realizzazione del progetto.',
  'Requisiti: esperienza comprovata nella gestione e realizzazione di progetti culturali.',
].join('\n\n');
const LISTING_HTML = `<html><body><main>
  <h1>Lavora con noi</h1><h2>Posti vacanti</h2><h3>Impieghi stagionali</h3>
  <p><a href="${PDF_URL}">Scarica il bando completo</a></p>
</main></body></html>`;

function asArrayBuffer(bytes: Buffer) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function response(url: string, status: number, body: string, bytes = Buffer.from(body)) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: {
      get: (name: string) => name.toLowerCase() === 'content-type'
        ? (bytes.subarray(0, 5).toString('latin1') === '%PDF-' ? 'application/pdf' : 'text/plain')
        : null,
    },
    text: async () => body,
    arrayBuffer: async () => asArrayBuffer(bytes),
  } as any;
}

describe('crawler detail in PDF format', () => {
  beforeEach(() => extractPdfJobContentFromUrl.mockReset());

  it('matches Locarno’s official PDF route and extracts source text through politeFetch', async () => {
    expect(SPEC.detailFormat).toBe('pdf');
    expect(templateToRegex(SPEC.detailTemplate).test(new URL(PDF_URL).pathname)).toBe(true);

    let capturedPdfBytes: Buffer | undefined;
    let pdfFetch: ((url: string, init: Record<string, unknown>) => Promise<any>) | undefined;
    extractPdfJobContentFromUrl.mockImplementation(async (_url: string, options: any) => {
      pdfFetch = options?.fetchImpl;
      return { text: PDF_TEXT, links: [FORM_URL] };
    });

    const fetchImpl = vi.fn(async (url: string) => (
      url.endsWith('/robots.txt')
        ? response(url, 200, 'User-agent: *\nAllow: /')
        : response(url, 200, '', PDF_BYTES)
    ));
    const policy = createSpecUrlPolicy({ seedUrls: [SPEC.seedUrls[0]] }, {
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    });

    try {
      const page = await fetchRuntimePage(PDF_URL, policy, {
        fetchImpl,
        retries: 0,
        hostDelayMs: 0,
        sleepImpl: async () => {},
      }, {
        readPdf: true,
        detailLocationLabel: SPEC.detailLocationLabel,
        detailTitleLeadIn: SPEC.detailTitleLeadIn,
        detailTitleEndLabel: SPEC.detailTitleEndLabel,
        detailApplyUrlHost: SPEC.detailApplyUrlHost,
        detailApplyUrlPathPrefix: SPEC.detailApplyUrlPathPrefix,
      });

      expect(extractPdfJobContentFromUrl).toHaveBeenCalledOnce();
      expect(extractPdfJobContentFromUrl.mock.calls[0][1]).toMatchObject({ proxyRescue: false });
      const fetched = await pdfFetch?.(PDF_URL, {});
      capturedPdfBytes = Buffer.from(await fetched.arrayBuffer());
      expect(capturedPdfBytes).toEqual(PDF_BYTES);
      const detail = extractRuntimeDetailFields(SPEC, page.body, page.url, {
        recordUrl: PDF_URL,
        recordTitle: 'Scarica il bando completo',
      });
      expect(detail.title).toBe('Atelier du Futur Project Manager');
      expect(detail.applyUrl).toBe(FORM_URL);
      expect(detail.description).toContain('realizzazione del progetto');
      expect(detail.locationCandidates).toContainEqual(expect.objectContaining({ location: 'Locarno' }));

      const graded = await gradeVacancy({
        title: 'Atelier du Futur Project Manager',
        url: PDF_URL,
        location: 'Locarno',
        description: detail.description,
      }, {
        spec: SPEC,
        urlPolicy: policy,
        fetchImpl,
        sleepImpl: async () => {},
      });
      expect(graded.reachable).toBe(true);
      expect(graded.titleMatch).toBe(1);
      expect(graded.contentful).toBe(true);
      expect(graded.sourceBackedLocation).toBe(true);
    } finally {
      await policy.dispatcher.close();
    }
  });

  it('preserves the approved application URL when Jina rescues a blocked PDF', async () => {
    const fetchImpl = vi.fn(async (url: string) => (
      url.endsWith('/robots.txt')
        ? response(url, 200, 'User-agent: *\nAllow: /')
        : response(url, 403, 'Just a moment…')
    ));
    const jinaFetchImpl = vi.fn(async (url: string) => response(
      url,
      200,
      `<html><body><a href="${FORM_URL}">Candidatura</a><p>${PDF_TEXT}</p></body></html>`,
    ));
    const policy = createSpecUrlPolicy({ seedUrls: [SPEC.seedUrls[0]] }, {
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    });

    try {
      const page = await fetchRuntimePage(PDF_URL, policy, {
        fetchImpl,
        jinaFetchImpl,
        retries: 0,
        jinaRetries: 0,
        hostDelayMs: 0,
        sleepImpl: async () => {},
      }, {
        readPdf: true,
        detailLocationLabel: SPEC.detailLocationLabel,
        detailTitleLeadIn: SPEC.detailTitleLeadIn,
        detailTitleEndLabel: SPEC.detailTitleEndLabel,
        detailApplyUrlHost: SPEC.detailApplyUrlHost,
        detailApplyUrlPathPrefix: SPEC.detailApplyUrlPathPrefix,
      });

      expect(page.proxiedBy).toBe('jina');
      const detail = extractRuntimeDetailFields(SPEC, page.body, page.url, {
        recordUrl: PDF_URL,
        recordTitle: 'Scarica il bando completo',
      });
      expect(detail.applyUrl).toBe(FORM_URL);
    } finally {
      await policy.dispatcher.close();
    }
  });

  it('preserves a verified row application URL when browser rescue has no link', async () => {
    const fetchImpl = vi.fn(async (url: string) => (
      url.endsWith('/robots.txt')
        ? response(url, 200, 'User-agent: *\nAllow: /')
        : response(url, 403, 'Just a moment…')
    ));
    const browserFetchImpl = vi.fn(async () => `<html><body><p>${PDF_TEXT}</p></body></html>`);
    const policy = createSpecUrlPolicy({ seedUrls: [SPEC.seedUrls[0]] }, {
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    });

    try {
      const page = await fetchRuntimePage(PDF_URL, policy, {
        fetchImpl,
        browserFetchImpl,
        disableWafProxy: true,
        retries: 0,
        hostDelayMs: 0,
        sleepImpl: async () => {},
      }, {
        readPdf: true,
        detailLocationLabel: SPEC.detailLocationLabel,
        detailTitleLeadIn: SPEC.detailTitleLeadIn,
        detailTitleEndLabel: SPEC.detailTitleEndLabel,
        detailApplyUrlHost: SPEC.detailApplyUrlHost,
        detailApplyUrlPathPrefix: SPEC.detailApplyUrlPathPrefix,
        detailApplyUrl: FORM_URL,
      });

      expect(page.proxiedBy).toBe('browser');
      const detail = extractRuntimeDetailFields(SPEC, page.body, page.url, {
        recordUrl: PDF_URL,
        recordTitle: 'Scarica il bando completo',
      });
      expect(detail.applyUrl).toBe(FORM_URL);
    } finally {
      await policy.dispatcher.close();
    }
  });

  it('uses the browser fallback for the blocked listing, then publishes the PDF title and workplace', async () => {
    extractPdfJobContentFromUrl.mockResolvedValue({ text: PDF_TEXT, links: [FORM_URL] });
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/robots.txt')) return response(url, 200, 'User-agent: *\nAllow: /');
      if (url.endsWith('.pdf')) return response(url, 200, '', PDF_BYTES);
      return response(url, 403, 'Just a moment…');
    });
    const browserFetchImpl = vi.fn(async () => LISTING_HTML);

    const observed = await observeSpecInProduction(SPEC, {
      fetchImpl,
      browserFetchImpl,
      disableWafProxy: true,
      retries: 0,
      hostDelayMs: 0,
      sleepImpl: async () => {},
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    });

    expect(browserFetchImpl).toHaveBeenCalledWith(SPEC.seedUrls[0], expect.any(Object));
    expect(observed.vacancies).toHaveLength(1);
    expect(observed.vacancies[0]).toMatchObject({
      title: 'Atelier du Futur Project Manager',
      location: 'Locarno',
      applyUrl: FORM_URL,
    });
  });
});
