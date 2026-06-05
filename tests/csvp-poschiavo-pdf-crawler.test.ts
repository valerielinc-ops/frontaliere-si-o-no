/**
 * CSVP (Centro Sanitario Valposchiavo) crawler — PDF-backed description.
 *
 * The csvp.ch listing carries only a thin inline intro ("80-100% (m/f) — start
 * date"); the real job content (Compiti / Profilo / Requisiti) lives in a linked
 * PDF. Before the fix the parser only LINKED the PDF, so an IT/admin posting had
 * a boilerplate-only description and tripped the boilerplate guard (1/1 jobs).
 * This test pins that the parser now extracts the PDF text into the description.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const { fetchHtml, extractPdfJobContentFromUrl } = vi.hoisted(() => ({
  fetchHtml: vi.fn(),
  extractPdfJobContentFromUrl: vi.fn(),
}));

vi.mock('@/scripts/lib/hospital-custom-html-helpers.mjs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, fetchHtml };
});
vi.mock('@/scripts/lib/pdf-job-content.mjs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, extractPdfJobContentFromUrl };
});

// @ts-expect-error — JS module without types
import { fetchAllCsvpPoschiavoJobs } from '@/scripts/lib/csvp-poschiavo-job-parser.mjs';

const LISTING_HTML = `
  <article>
    <h1><a href="/it/lavora-con-noi/cerchiamo/905-responsabile-informatica" title="Responsabile informatica">Responsabile informatica e manager di progetti</a></h1>
    <p>80 - 100% (m/f) Inizio in data da convenire</p>
    <a class="pdfLink" href="/images/Posti_di_lavoro_PDF/Responsabile_informatica.pdf">PDF</a>
  </article>`;

const PDF_TEXT = `Il Centro sanitario Valposchiavo cerca un Responsabile informatica e manager di progetti 80-100% (m/f).
Compiti principali: Gestione del software clinico e delle relative interfacce. Supporto di primo livello (1st Level Support).
Collaborazione con i fornitori di servizi IT esterni. Supporto e sviluppo della digitalizzazione interna.
Profilo richiesto: formazione informatica, esperienza nella gestione di progetti, ottime conoscenze di italiano e tedesco.`;

describe('CSVP crawler — PDF-backed description', () => {
  afterEach(() => {
    fetchHtml.mockReset();
    extractPdfJobContentFromUrl.mockReset();
  });

  it('extracts the linked PDF text into the job description (not just a link)', async () => {
    fetchHtml.mockResolvedValue(LISTING_HTML);
    extractPdfJobContentFromUrl.mockResolvedValue({ text: PDF_TEXT, totalPages: 1, rawText: PDF_TEXT });

    const jobs = await fetchAllCsvpPoschiavoJobs();

    expect(jobs).toHaveLength(1);
    expect(extractPdfJobContentFromUrl).toHaveBeenCalledWith(
      expect.stringContaining('/images/Posti_di_lavoro_PDF/Responsabile_informatica.pdf'),
    );
    const desc = jobs[0].descriptionByLocale?.it || jobs[0].description || '';
    expect(desc).toContain('Compiti principali');
    expect(desc).toContain('1st Level Support');
    // Real content → well above the 30-unique-word boilerplate threshold.
    expect(desc.split(/\s+/).filter(Boolean).length).toBeGreaterThan(30);
  });

  it('falls back to the thin intro when PDF extraction fails (no crash)', async () => {
    fetchHtml.mockResolvedValue(LISTING_HTML);
    extractPdfJobContentFromUrl.mockRejectedValue(new Error('fetch failed'));

    const jobs = await fetchAllCsvpPoschiavoJobs();

    expect(jobs).toHaveLength(1);
    const desc = jobs[0].descriptionByLocale?.it || jobs[0].description || '';
    expect(desc).toContain('80 - 100% (m/f)');
  });
});