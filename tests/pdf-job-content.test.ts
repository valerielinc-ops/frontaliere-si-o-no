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
