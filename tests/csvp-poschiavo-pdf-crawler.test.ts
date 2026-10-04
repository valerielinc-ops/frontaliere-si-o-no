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

import {
  fetchAllCsvpPoschiavoJobs,
  isCsvpPoschiavoAuthoritativeEmptyPage,
} from '@/scripts/lib/csvp-poschiavo-job-parser.mjs';
import { isAuthoritativeEmptySnapshot } from '@/scripts/lib/authoritative-empty-snapshot.mjs';

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

const EMPTY_CATEGORY_HTML = `
  <main>
    <div class="com-content-category-blog blog">
      <div class="page-header"><h2 itemprop="name">Cerchiamo</h2></div>
      <p>Non ci sono articoli in questa categoria. Se si visualizzano le sottocategorie, dovrebbero contenere degli articoli.</p>
    </div>
  </main>`;

const NON_LISTING_MESSAGE_WITH_LIVE_ARTICLE_HTML = `
  <main>
    <div class="notice">
      <p>Non ci sono articoli in questa categoria. Se si visualizzano le sottocategorie, dovrebbero contenere degli articoli.</p>
    </div>
    <div class="com-content-category-blog blog">
      <div class="page-header"><h2 itemprop="name">Cerchiamo</h2></div>
      <article>
        <h1><a href="/it/lavora-con-noi/cerchiamo/906-infermiere">Infermiere</a></h1>
        <p>80% a tempo indeterminato</p>
      </article>
    </div>
  </main>`;

const EMPTY_CATEGORY_WITH_COMPONENT_WRAPPER_HTML = `
  <div id="sp-main-body">
    <div class="sp-column">
      <div class="com-content-category-blog blog">
        <div class="alert alert-info">
          <p>Non ci sono articoli in questa categoria. Se si visualizzano le sottocategorie, dovrebbero contenere degli articoli.</p>
        </div>
      </div>
    </div>
  </div>`;

const EMPTY_CATEGORY_IN_NAVIGATION_MODULE_HTML = `
  <div role="navigation">
    <div class="blog">
      <p>Non ci sono articoli in questa categoria.</p>
    </div>
  </div>`;

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

  it('marks Joomla’s explicit empty category as an authoritative zero', async () => {
    fetchHtml.mockResolvedValue(EMPTY_CATEGORY_HTML);

    const jobs = await fetchAllCsvpPoschiavoJobs();

    expect(isCsvpPoschiavoAuthoritativeEmptyPage(EMPTY_CATEGORY_HTML)).toBe(true);
    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(true);
    expect(jobs).toEqual([]);
    expect(jobs).toHaveProperty('authoritativeEmptyEvidence', expect.stringContaining('empty-category'));
  });

  it('proves the empty category when Joomla omits a semantic main wrapper', () => {
    expect(isCsvpPoschiavoAuthoritativeEmptyPage(EMPTY_CATEGORY_WITH_COMPONENT_WRAPPER_HTML)).toBe(true);
  });

  it('does not prove an identical message in a navigation module', () => {
    expect(isCsvpPoschiavoAuthoritativeEmptyPage(EMPTY_CATEGORY_IN_NAVIGATION_MODULE_HTML)).toBe(false);
  });

  it('keeps an unrecognised zero unproven so selector drift stays fail-closed', async () => {
    fetchHtml.mockResolvedValue('<html><head><title>Temporary error</title></head><body></body></html>');

    const jobs = await fetchAllCsvpPoschiavoJobs();

    expect(isCsvpPoschiavoAuthoritativeEmptyPage('<html><body></body></html>')).toBe(false);
    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(false);
    expect(jobs).toEqual([]);
  });

  it('does not prove empty when the message is outside the listing and an article is live', () => {
    expect(isCsvpPoschiavoAuthoritativeEmptyPage(NON_LISTING_MESSAGE_WITH_LIVE_ARTICLE_HTML)).toBe(false);
  });
});
