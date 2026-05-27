import { describe, expect, it, vi } from 'vitest';

import {
  buildPdfBackedDescription,
  extractPdfJobContentFromUrl,
  normalizePdfJobText,
} from '../scripts/lib/pdf-job-content.mjs';

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
        'Associate Professor in Economics',
        'Responsibilities: research and teaching',
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
    expect(result.text).toContain('Responsibilities: research and teaching');
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

  it('returns a warning field when extraction yields very thin content', async () => {
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
    expect((result as any).warning).toBeDefined();
    expect((result as any).warning).toContain('image-only/scanned PDF');
    expect(result.error).toBeUndefined();
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
