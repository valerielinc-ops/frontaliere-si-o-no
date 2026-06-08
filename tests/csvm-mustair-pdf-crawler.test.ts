/**
 * CSVM (Center da Sanda Val Müstair) crawler — PDF-backed description.
 *
 * The csvm.ch EasyBlog detail page body is a placeholder ("Gib deinen Text hier
 * ein …"); the real job content lives in a PDF attached to the same post
 * (/images/easyblog_articles/{id}/*.pdf), exposed in the listing. Before the fix
 * the parser built a boilerplate-only description (~20 words < 30) and the
 * workflow papered over it with SKIP_BOILERPLATE_GUARD. This test pins that the
 * parser now extracts the attached PDF text into the description (mirror of the
 * CSVP #1468 fix, #1480).
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
import { fetchAllCsvmMustairJobs, parseCsvmListing } from '@/scripts/lib/csvm-mustair-job-parser.mjs';

// Two EasyBlog posts: a real job (with attached PDF) and an archive item that
// must be filtered out by the negative-slug heuristic.
const LISTING_HTML = `
  <div class="eb-posts">
    <div itemprop="blogPosts" itemscope itemtype="http://schema.org/BlogPosting" class="eb-post" data-id="319">
      <div class="eb-post-content">
        <h2 class="eb-post-title"><a href="/de/aktuelles/pflegehelfer-in-srk-80-100.html" class="text-inherit">Pflegehelfer(in) SRK 80-100%</a></h2>
        <div class="eb-post-body type-standard">
          <div class="ebd-block" data-type="pdf"><div class="eb-pdf-viewer">
            <object data="/images/easyblog_articles/319/Pflegehelferin-80-100_Mai-2026_d.pdf" type="application/pdf">
              <a href="/images/easyblog_articles/319/Pflegehelferin-80-100_Mai-2026_d.pdf">PDF Datei herunterladen</a>
            </object>
          </div></div>
          Gib deinen Text hier ein ...
        </div>
        <a href="/de/aktuelles/pflegehelfer-in-srk-80-100.html">Weiterlesen</a>
      </div>
    </div>
    <div itemprop="blogPosts" itemscope itemtype="http://schema.org/BlogPosting" class="eb-post" data-id="200">
      <div class="eb-post-content">
        <h2 class="eb-post-title"><a href="/de/aktuelles/archiv-aktuelles.html">Archiv Aktuelles</a></h2>
      </div>
    </div>
  </div>`;

const PDF_TEXT = `Center da Sanda Val Müstair sucht eine Pflegehelferin SRK 80-100%.
Ihre Aufgaben: Pflege und Betreuung unserer Bewohnerinnen und Bewohner im Pflegeheim. Mithilfe bei der Grundpflege.
Unterstützung des Pflegefachpersonals im Stationsalltag. Begleitung der Bewohner bei Aktivitäten.
Ihr Profil: abgeschlossene Ausbildung als Pflegehelfer(in) SRK, Freude am Kontakt mit Menschen, Teamgeist und Zuverlässigkeit.`;

describe('CSVM crawler — PDF-backed description', () => {
  afterEach(() => {
    fetchHtml.mockReset();
    extractPdfJobContentFromUrl.mockReset();
  });

  it('pairs each job with the PDF attached to its own EasyBlog post', () => {
    const items = parseCsvmListing(LISTING_HTML);
    expect(items).toHaveLength(1); // archive item filtered out
    expect(items[0].slug).toBe('pflegehelfer-in-srk-80-100');
    expect(items[0].pdfUrl).toBe(
      'https://www.csvm.ch/images/easyblog_articles/319/Pflegehelferin-80-100_Mai-2026_d.pdf',
    );
  });

  it('extracts the attached PDF text into the job description (not just a link)', async () => {
    fetchHtml.mockResolvedValue(LISTING_HTML);
    extractPdfJobContentFromUrl.mockResolvedValue({ text: PDF_TEXT, totalPages: 1, rawText: PDF_TEXT });

    const jobs = await fetchAllCsvmMustairJobs();

    expect(jobs).toHaveLength(1);
    expect(extractPdfJobContentFromUrl).toHaveBeenCalledWith(
      expect.stringContaining('/images/easyblog_articles/319/Pflegehelferin-80-100_Mai-2026_d.pdf'),
    );
    const desc = jobs[0].descriptionByLocale?.de || jobs[0].description || '';
    expect(desc).toContain('Ihre Aufgaben');
    expect(desc).toContain('Teamgeist');
    // Real content → well above the 30-unique-word boilerplate threshold.
    expect(desc.split(/\s+/).filter(Boolean).length).toBeGreaterThan(30);
  });

  it('falls back to the listing boilerplate when PDF extraction fails (no crash)', async () => {
    fetchHtml.mockResolvedValue(LISTING_HTML);
    extractPdfJobContentFromUrl.mockRejectedValue(new Error('fetch failed'));

    const jobs = await fetchAllCsvmMustairJobs();

    expect(jobs).toHaveLength(1);
    const desc = jobs[0].descriptionByLocale?.de || jobs[0].description || '';
    expect(desc).toContain('Dettagli completi sul PDF');
  });
});
