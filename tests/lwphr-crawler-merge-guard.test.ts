import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchHtml: vi.fn(),
  extractPdfJobContentFromUrl: vi.fn(),
  writeJsonAtomic: vi.fn(),
  readExistingCrawlerJobs: vi.fn(),
  writeJobsCrawlerSlice: vi.fn(),
  writeSummaryCrawlerSlice: vi.fn(),
  assembleJobsDataset: vi.fn(),
  registerCrawlerSummaryGuard: vi.fn(),
}));

vi.mock('../scripts/lib/crawler-template.mjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../scripts/lib/crawler-template.mjs')>()),
  fetchHtml: mocks.fetchHtml,
}));
vi.mock('../scripts/lib/pdf-job-content.mjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../scripts/lib/pdf-job-content.mjs')>()),
  extractPdfJobContentFromUrl: mocks.extractPdfJobContentFromUrl,
}));
vi.mock('../scripts/lib/atomic-write-json.mjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../scripts/lib/atomic-write-json.mjs')>()),
  writeJsonAtomic: mocks.writeJsonAtomic,
}));
vi.mock('../scripts/assemble-jobs-dataset.mjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../scripts/assemble-jobs-dataset.mjs')>()),
  assembleJobsDataset: mocks.assembleJobsDataset,
  readExistingCrawlerJobs: mocks.readExistingCrawlerJobs,
  writeJobsCrawlerSlice: mocks.writeJobsCrawlerSlice,
  writeSummaryCrawlerSlice: mocks.writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard: mocks.registerCrawlerSummaryGuard,
}));

import { isMissingLwphrPdf, main } from '../scripts/update-lwphr-jobs.mjs';

const LISTING_HTML = `
<section class="opportunities">
  <h2>Posizioni aperte</h2>
  <div class="open-list">
    <a href="/uploads/existing-role.pdf">Existing role</a>
    <a href="/uploads/valid-role.pdf">Valid role</a>
  </div>
  <h2>Posizioni archiviate</h2>
  <div class="archive-list">
    <a href="/uploads/archived-role.pdf">Archived role</a>
  </div>
</section>`;

const VALID_PDF_TEXT = `Valid role

Sede di lavoro: Lugano

La posizione richiede esperienza professionale, autonomia operativa e collaborazione con il team.
`;

const EXISTING_URL = 'https://www.lwphr.ch/uploads/existing-role.pdf';
const VALID_URL = 'https://www.lwphr.ch/uploads/valid-role.pdf';
const STORED_BODY = [
  'Il nostro cliente, una società attiva nel Luganese, cerca un profilo con esperienza pluriennale',
  'nella gestione di progetti, nel coordinamento di team interdisciplinari e nei rapporti con i clienti.',
  'Si richiedono formazione superiore, ottima conoscenza dell\'italiano e del tedesco, autonomia,',
  'capacità organizzative e orientamento al risultato. Offriamo un ambiente dinamico e condizioni interessanti.',
].join(' ');

/** The already published posting, as an earlier full read stored it. */
const STORED_EXISTING_ROLE = {
  title: 'Existing role',
  slug: 'existing-role-lugano',
  company: 'LWP Ledermann Wieting & Partners',
  companyKey: 'lwphr',
  url: EXISTING_URL,
  location: 'Lugano',
  addressLocality: 'Lugano',
  canton: 'TI',
  sourceLang: 'it',
  description: STORED_BODY,
  descriptionByLocale: { it: STORED_BODY, en: `${STORED_BODY} (en)` },
};

/**
 * The second JSON write is the merged slice (the first is the adapter seeds).
 * Stop there, before URL validation and locale fill reach the network.
 */
function stopAtMergedSlice() {
  mocks.writeJsonAtomic
    .mockImplementationOnce(() => {})
    .mockImplementationOnce(() => {
      throw new Error('sentinel: merged slice written');
    });
}

describe('LWPHR crawler snapshot guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchHtml.mockResolvedValue(LISTING_HTML);
    mocks.extractPdfJobContentFromUrl.mockImplementation(async (url: string) => (
      url.includes('existing-role.pdf')
        ? { error: 'timeout' }
        : { text: VALID_PDF_TEXT }
    ));
    mocks.readExistingCrawlerJobs.mockReturnValue([STORED_EXISTING_ROLE]);
  });

  // The guard protects an already published posting from being removed by a
  // run that could not read its PDF (timeout, 5xx, no text layer). It used to
  // abort the whole crawler; the posting now keeps its stored record.
  it('keeps an already published posting with its stored body when its PDF read fails', async () => {
    stopAtMergedSlice();

    await expect(main()).rejects.toThrow(/sentinel: merged slice written/);

    expect(mocks.extractPdfJobContentFromUrl).toHaveBeenCalledTimes(2);
    expect(mocks.writeJsonAtomic.mock.calls[0][1].seedUrls).toEqual([EXISTING_URL, VALID_URL]);
    const merged = mocks.writeJsonAtomic.mock.calls[1][1];
    const existing = merged.find((job: any) => job.url === EXISTING_URL);
    expect(existing).toMatchObject({
      title: 'Existing role',
      slug: 'existing-role-lugano',
      location: 'Lugano',
      sourceLang: 'it',
      description: STORED_BODY,
    });
    expect(existing.descriptionByLocale.en).toBe(`${STORED_BODY} (en)`);
    expect(existing.sourceBodyFailureReason).toBeUndefined();
    expect(merged.map((job: any) => job.url)).toContain(VALID_URL);
    expect(mocks.registerCrawlerSummaryGuard.mock.calls[0][2].sourceBodyFailures).toEqual([
      { title: 'Existing role', url: EXISTING_URL, reason: 'pdf-extraction-failed', message: 'timeout' },
    ]);
  });

  it('reports a PDF without a text layer like a failed read, keeping the stored posting', async () => {
    const warning = 'PDF has 1 page(s) but only 7 chars extracted (possible image-only/scanned PDF)';
    mocks.extractPdfJobContentFromUrl.mockImplementation(async (url: string) => (
      url.includes('existing-role.pdf')
        ? { text: '', rawText: 'Pagina 1', thin: true, totalPages: 1, warning }
        : { text: VALID_PDF_TEXT }
    ));
    stopAtMergedSlice();

    await expect(main()).rejects.toThrow(/sentinel: merged slice written/);

    const merged = mocks.writeJsonAtomic.mock.calls[1][1];
    expect(merged.find((job: any) => job.url === EXISTING_URL)).toMatchObject({ description: STORED_BODY });
    expect(mocks.registerCrawlerSummaryGuard.mock.calls[0][2].sourceBodyFailures).toEqual([
      { title: 'Existing role', url: EXISTING_URL, reason: 'pdf-extraction-failed', message: warning },
    ]);
  });

  it('leaves out, and reports, an unreadable posting that has no stored body', async () => {
    mocks.readExistingCrawlerJobs.mockReturnValue([]);
    stopAtMergedSlice();

    await expect(main()).rejects.toThrow(/sentinel: merged slice written/);

    expect(mocks.writeJsonAtomic.mock.calls[1][1].map((job: any) => job.url)).toEqual([VALID_URL]);
    expect(mocks.registerCrawlerSummaryGuard.mock.calls[0][2].sourceBodyFailures)
      .toEqual([expect.objectContaining({ url: EXISTING_URL, message: 'timeout' })]);
  });

  it('fails when no posting is publishable, before seeds or merge', async () => {
    mocks.extractPdfJobContentFromUrl.mockResolvedValue({ error: 'HTTP 503 while fetching PDF' });
    mocks.readExistingCrawlerJobs.mockReturnValue([]);

    await expect(main()).rejects.toThrow(
      /LWPHR has no publishable posting: 2 listed, 0 gone \(404\/410\), 2 with an unusable PDF and no stored source body/,
    );
    expect(mocks.writeJsonAtomic).not.toHaveBeenCalled();
    expect(mocks.writeJobsCrawlerSlice).not.toHaveBeenCalled();
    expect(mocks.writeSummaryCrawlerSlice).not.toHaveBeenCalled();
    expect(mocks.assembleJobsDataset).not.toHaveBeenCalled();
  });

  it('classifies only a definitive 404/410 as a missing official PDF', () => {
    expect(isMissingLwphrPdf({ error: 'HTTP 404 while fetching PDF' })).toBe(true);
    expect(isMissingLwphrPdf({ error: 'HTTP 410 while fetching PDF' })).toBe(true);
    expect(isMissingLwphrPdf({ error: 'HTTP 503 while fetching PDF' })).toBe(false);
    expect(isMissingLwphrPdf({ error: 'timeout' })).toBe(false);
    expect(isMissingLwphrPdf({ text: VALID_PDF_TEXT })).toBe(false);
  });

  it('skips a posting whose official PDF answers 404 instead of aborting the snapshot', async () => {
    mocks.extractPdfJobContentFromUrl.mockImplementation(async (url: string) => (
      url.includes('existing-role.pdf')
        ? { error: 'HTTP 404 while fetching PDF' }
        : { text: VALID_PDF_TEXT }
    ));

    // The adapter seeds are the first write after the completeness gate: stop
    // there, so reaching it proves the 404 posting no longer aborts the crawl
    // without running the merge, URL validation or locale fill.
    mocks.writeJsonAtomic.mockImplementationOnce(() => {
      throw new Error('sentinel: past the completeness gate');
    });

    await expect(main()).rejects.toThrow(/sentinel: past the completeness gate/);
    expect(mocks.extractPdfJobContentFromUrl).toHaveBeenCalledTimes(2);
    expect(mocks.readExistingCrawlerJobs).not.toHaveBeenCalled();
  });
});
