import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchHtml: vi.fn(),
  extractPdfJobContentFromUrl: vi.fn(),
  writeJsonAtomic: vi.fn(),
  readExistingCrawlerJobs: vi.fn(),
  writeJobsCrawlerSlice: vi.fn(),
  writeSummaryCrawlerSlice: vi.fn(),
  assembleJobsDataset: vi.fn(),
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

describe('LWPHR crawler snapshot guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchHtml.mockResolvedValue(LISTING_HTML);
    mocks.extractPdfJobContentFromUrl.mockImplementation(async (url: string) => (
      url.includes('existing-role.pdf')
        ? { error: 'timeout' }
        : { text: VALID_PDF_TEXT }
    ));
    mocks.readExistingCrawlerJobs.mockReturnValue([{
      title: 'Existing role',
      companyKey: 'lwphr',
      url: 'https://www.lwphr.ch/uploads/existing-role.pdf',
    }]);
  });

  it('aborts before seeds or merge can remove an already published PDF job', async () => {
    await expect(main()).rejects.toThrow(
      /unusable PDF content.*refusing to update adapter seeds or merge jobs/i,
    );

    expect(mocks.extractPdfJobContentFromUrl).toHaveBeenCalledTimes(2);
    expect(mocks.writeJsonAtomic).not.toHaveBeenCalled();
    expect(mocks.readExistingCrawlerJobs).not.toHaveBeenCalled();
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
