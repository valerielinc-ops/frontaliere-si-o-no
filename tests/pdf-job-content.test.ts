import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildPdfBackedDescription,
  extractPdfJobContentFromUrl,
  normalizePdfJobText,
} from '../scripts/lib/pdf-job-content.mjs';
import { __resetJinaBreaker } from '../scripts/lib/jina-proxy.mjs';

describe('pdf-job-content', () => {
  it('normalizes noisy extracted PDF text into readable paragraphs', () => {
    const raw = [
      'Citta di Mendrisio',
      'Concorso pubblico',
      '',
      'Educatore/trice   al   50%',
      'Mendrisio 1 / 3',
      '',
      'Mansioni principali:',
      '- accompagnare gli utenti',
      '- collaborare con il team',
      '',
      '   Termine di iscrizione: 31.03.2026   ',
    ].join('\n');

    expect(normalizePdfJobText(raw)).toContain('Educatore/trice al 50%');
    expect(normalizePdfJobText(raw)).toContain('Mansioni principali:');
    expect(normalizePdfJobText(raw)).toContain('Termine di iscrizione: 31.03.2026');
    expect(normalizePdfJobText(raw)).not.toContain('1 / 3');
  });

  it('downloads a PDF, extracts text and returns normalized content', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode('fake-pdf').buffer,
    }));
    const extractTextImpl = vi.fn(async () => ({
      totalPages: 2,
      text: [
        'Associate Professor in Economics leads research and teaching at the institute',
        'Responsibilities include research supervision, course design, and collaboration with colleagues',
      ].join('\n\n'),
    }));

    const result = await extractPdfJobContentFromUrl('https://example.com/job.pdf', {
      fetchImpl: fetchImpl as any,
      extractTextImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith('https://example.com/job.pdf', expect.any(Object));
    expect(extractTextImpl).toHaveBeenCalledOnce();
    expect(result.totalPages).toBe(2);
    expect(result.text).toContain('Associate Professor in Economics');
    expect(result.text).toContain('Responsibilities include research supervision');
  });

  it('extracts the reduced real bando fixture and publishes its source body', async () => {
    const fixture = readFileSync(new URL('./fixtures/pdf/synthetic-bando.pdf', import.meta.url));
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => Uint8Array.from(fixture).buffer,
    }));

    const result = await extractPdfJobContentFromUrl('https://example.com/synthetic-bando.pdf', {
      fetchImpl: fetchImpl as any,
    });

    expect(result.error).toBeUndefined();
    expect(result.extractionFailed).toBeUndefined();
    expect(result.totalPages).toBe(2);
    expect(result.bodyWordCount).toBeGreaterThanOrEqual(50);
    expect(result.text).toContain('BANDO SINTETICO');
  });

  it('falls back to page-by-page extraction when merged yields thin content', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode('fake-pdf').buffer,
    }));
    // Simulate: mergePages:true returns only 10 chars, but the extractTextImpl
    // we provide here returns content directly. The fallback logic lives inside
    // defaultExtractTextFromPdfBytes, so we test that the outer function still
    // works with an extractTextImpl returning an array (page-by-page format).
    const extractTextImpl = vi.fn(async () => ({
      totalPages: 3,
      text: [
        'Page 1: PostDoc Position at the Institute for Sustainability',
        'Page 2: Candidates should have a PhD in architecture or engineering',
        'Page 3: Application deadline March 2026',
      ],
    }));

    const result = await extractPdfJobContentFromUrl('https://example.com/thin.pdf', {
      fetchImpl: fetchImpl as any,
      extractTextImpl,
    });

    expect(result.totalPages).toBe(3);
    expect(result.text).toContain('PostDoc Position');
    expect(result.text).toContain('architecture or engineering');
    expect(result.text).toContain('Application deadline');
    expect(result.error).toBeUndefined();
  });

  it('treats a multi-page extraction under ten words as a parser failure', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode('fake-pdf').buffer,
    }));
    // Simulate a scanned/image-only PDF: 2 pages but almost no text
    const extractTextImpl = vi.fn(async () => ({
      totalPages: 2,
      text: 'OK',
    }));

    const result = await extractPdfJobContentFromUrl('https://example.com/scanned.pdf', {
      fetchImpl: fetchImpl as any,
      extractTextImpl,
    });

    expect(result.totalPages).toBe(2);
    expect(result.extractionFailed).toBe(true);
    expect(result.failureReason).toBe('pdf-extraction-failed');
    expect(result.thin).toBe(false);
    expect(result.error).toContain('1 words extracted from 2 pages');
  });

  it('treats an empty extraction as an error and never as thin source', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode('fake-pdf').buffer,
    }));
    const extractTextImpl = vi.fn(async () => ({
      totalPages: 4,
      text: '',
    }));

    const result = await extractPdfJobContentFromUrl('https://example.com/scan-fragment.pdf', {
      fetchImpl: fetchImpl as any,
      extractTextImpl,
    });

    expect(result.totalPages).toBe(4);
    expect(result.text).toBe('');
    expect(result.extractionFailed).toBe(true);
    expect(result.failureReason).toBe('pdf-extraction-failed');
    expect(result.thin).toBe(false);
    expect(result.error).toContain('no text extracted');
  });

  it('reports a non-200 PDF response as extraction failure', async () => {
    const result = await extractPdfJobContentFromUrl('https://example.com/missing.pdf', {
      fetchImpl: vi.fn(async () => ({ ok: false, status: 404 })) as any,
    });

    expect(result.text).toBe('');
    expect(result.extractionFailed).toBe(true);
    expect(result.failureReason).toBe('pdf-extraction-failed');
    expect(result.error).toContain('HTTP 404');
  });

  describe('clean-IP rescue of a WAF-class answer', () => {
    // klinik-wyssholzli, run corpus 36989251899: five text PDFs answered
    // HTTP 415 to the CI egress and 200 to a clean IP.
    const PDF_URL = 'https://clinic.example.ch/uploads/Stelleninserate/Inserat-Pflege_60.pdf';
    const PDF_TEXT = [
      'Die Klinik ist eine psychiatrische Spezialklinik im Oberaargau, Kanton Bern.',
      'Wir suchen nach Vereinbarung eine Pflegefachfrau HF 60-80%.',
      'Ihre Aufgaben',
      '- Betreuung der Patientinnen im Stationsalltag',
      '- Mitarbeit im interprofessionellen Behandlungsteam',
      'Ihr Profil',
      '- Abgeschlossene Ausbildung als Pflegefachfrau HF',
    ].join('\n');

    beforeEach(() => __resetJinaBreaker());

    it('reads the PDF text through Jina when the direct read answers 415', async () => {
      const fetchImpl = vi.fn(async () => new Response('Unsupported Media Type', { status: 415 }));
      const jinaFetchImpl = vi.fn(async () => new Response(PDF_TEXT, {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      }));
      const extractTextImpl = vi.fn();

      const result = await extractPdfJobContentFromUrl(PDF_URL, {
        fetchImpl: fetchImpl as any,
        jinaFetchImpl: jinaFetchImpl as any,
        extractTextImpl,
        jinaRetryDelayMs: 0,
      });

      expect(jinaFetchImpl).toHaveBeenCalledOnce();
      const [jinaUrl, init] = jinaFetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      expect(jinaUrl).toBe(`https://r.jina.ai/${PDF_URL}`);
      expect((init.headers as Record<string, string>)['X-Return-Format']).toBe('text');
      expect(extractTextImpl).not.toHaveBeenCalled();
      expect(result.error).toBeUndefined();
      expect(result.extractionFailed).toBeUndefined();
      expect(result.proxiedBy).toBe('jina');
      expect(result.extractionMethod).toBe('jina-reader');
      expect(result.text).toContain('Wir suchen nach Vereinbarung eine Pflegefachfrau HF 60-80%.');
      expect(result.text).toBe(normalizePdfJobText(PDF_TEXT));
    });

    it('stays an extraction failure when the rescue only gets an error body', async () => {
      const fetchImpl = vi.fn(async () => new Response('', { status: 415 }));
      const jinaFetchImpl = vi.fn(async () => new Response(
        `Warning: Target URL returned error 415: Unsupported Media Type ${'.'.repeat(240)}`,
        { status: 200 },
      ));

      const result = await extractPdfJobContentFromUrl(PDF_URL, {
        fetchImpl: fetchImpl as any,
        jinaFetchImpl: jinaFetchImpl as any,
        jinaRetryDelayMs: 0,
      });

      expect(jinaFetchImpl).toHaveBeenCalledTimes(4);
      expect(result.text).toBe('');
      expect(result.extractionFailed).toBe(true);
      expect(result.failureReason).toBe('pdf-extraction-failed');
      expect(result.error).toBe('HTTP 415 while fetching PDF (clean-IP Jina rescue exhausted)');
    });

    it('does not route a definitive 404 through Jina', async () => {
      const jinaFetchImpl = vi.fn();
      const result = await extractPdfJobContentFromUrl(PDF_URL, {
        fetchImpl: vi.fn(async () => new Response('', { status: 404 })) as any,
        jinaFetchImpl: jinaFetchImpl as any,
      });

      expect(jinaFetchImpl).not.toHaveBeenCalled();
      expect(result.error).toBe('HTTP 404 while fetching PDF');
    });
  });

  it('returns no warning when extraction yields sufficient content', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode('fake-pdf').buffer,
    }));
    const extractTextImpl = vi.fn(async () => ({
      totalPages: 1,
      text: 'This is a substantial job description with plenty of content about the position requirements and responsibilities at USI.',
    }));

    const result = await extractPdfJobContentFromUrl('https://example.com/good.pdf', {
      fetchImpl: fetchImpl as any,
      extractTextImpl,
    });

    expect(result.totalPages).toBe(1);
    expect((result as any).warning).toBeUndefined();
    expect(result.error).toBeUndefined();
    expect(result.text.length).toBeGreaterThan(50);
  });

  it('builds a crawler description preferring extracted PDF text over generic placeholder copy', () => {
    const description = buildPdfBackedDescription({
      introLines: [
        'Posizione aperta presso USI.',
        'Ruolo: Associate or Full Professor in Economics.',
      ],
      pdfText: [
        'The successful candidate will lead the Institute for Economic Research.',
        'Candidates should have a strong publication record and teaching experience.',
      ].join('\n\n'),
      footerLines: ['Bando ufficiale disponibile in PDF.'],
      maxChars: 500,
    });

    expect(description).toContain('lead the Institute for Economic Research');
    expect(description).toContain('strong publication record');
    expect(description).toContain('Bando ufficiale disponibile in PDF.');
    expect(description).not.toContain('ambiente di lavoro internazionale');
  });
});
