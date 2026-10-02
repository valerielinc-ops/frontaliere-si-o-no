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

import { main } from '../scripts/update-klinik-wyssholzli-jobs.mjs';

// Sanitized shape of https://www.wysshoelzli.ch/jobs-karriere: postings are
// direct links to /uploads/Stelleninserate/*.pdf (placeholder file names).
const PDF_A = 'https://www.wysshoelzli.ch/uploads/Stelleninserate/Inserat-Pflegefachfrau_2026_60-80.pdf';
const PDF_B = 'https://www.wysshoelzli.ch/uploads/Stelleninserate/Inserat-Psychologin_2026_60.pdf';
const LISTING_HTML = `
<main>
  <h2>Offene Stellen</h2>
  <ul>
    <li><a href="${PDF_A}">Pflegefachfrau HF 60-80%</a></li>
    <li><a href="${PDF_B}">Psychologin 60%</a></li>
  </ul>
</main>`;

const body = (role: string) => [
  `Die Klinik ist eine psychiatrische und psychotherapeutische Spezialklinik für Frauen im Kanton Bern.`,
  `Wir suchen nach Vereinbarung eine ${role}.`,
  'Ihre Aufgaben: Betreuung der Patientinnen im Stationsalltag, Mitarbeit im interprofessionellen Behandlungsteam,',
  'Gestaltung therapeutischer Gruppenangebote und Dokumentation des Behandlungsverlaufs.',
  'Ihr Profil: abgeschlossene Ausbildung, Freude an der Arbeit mit Menschen, Teamfähigkeit und Eigeninitiative.',
  'Wir bieten eine abwechslungsreiche Tätigkeit, gute Anstellungsbedingungen und einen kostenlosen Parkplatz.',
].join('\n');

const WAF_FAILURE = {
  text: '',
  rawText: '',
  thin: false,
  totalPages: 0,
  extractionFailed: true,
  failureReason: 'pdf-extraction-failed',
  httpStatus: 415,
  error: 'HTTP 415 while fetching PDF (clean-IP Jina rescue exhausted)',
};

function storedJob(url: string, role: string) {
  const description = body(role);
  return {
    title: role,
    company: 'Klinik Wysshölzli',
    companyKey: 'klinik-wyssholzli',
    url,
    sourceLang: 'de',
    description,
    descriptionByLocale: { de: description, it: `${description} (it)` },
    titleByLocale: { de: role },
  };
}

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

const summaryCounts = () => mocks.registerCrawlerSummaryGuard.mock.calls[0][2];
const seedUrls = () => mocks.writeJsonAtomic.mock.calls[0][1].seedUrls;
const mergedJobs = () => mocks.writeJsonAtomic.mock.calls[1][1];

describe('Klinik Wysshölzli crawler: degraded PDF postings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchHtml.mockResolvedValue(LISTING_HTML);
    mocks.readExistingCrawlerJobs.mockReturnValue([]);
  });

  it('keeps publishing the stored body when every PDF read fails (CI egress answered 415)', async () => {
    mocks.extractPdfJobContentFromUrl.mockResolvedValue(WAF_FAILURE);
    mocks.readExistingCrawlerJobs.mockReturnValue([
      storedJob(PDF_A, 'Pflegefachfrau HF 60-80%'),
      storedJob(PDF_B, 'Psychologin 60%'),
    ]);
    stopAtMergedSlice();

    await expect(main()).rejects.toThrow(/sentinel: merged slice written/);

    expect(seedUrls()).toEqual([PDF_A, PDF_B]);
    const jobs = mergedJobs();
    expect(jobs.map((job: any) => job.url)).toEqual([PDF_A, PDF_B]);
    expect(jobs[0].description).toBe(body('Pflegefachfrau HF 60-80%'));
    expect(jobs[0].descriptionByLocale.it).toBe(`${body('Pflegefachfrau HF 60-80%')} (it)`);
    for (const job of jobs) expect(job.sourceBodyFailureReason).toBeUndefined();
    expect(summaryCounts().sourceBodyFailures).toEqual([
      expect.objectContaining({ url: PDF_A, reason: 'pdf-extraction-failed', message: WAF_FAILURE.error }),
      expect.objectContaining({ url: PDF_B, reason: 'pdf-extraction-failed', message: WAF_FAILURE.error }),
    ]);
  });

  it('leaves out only the unreadable posting without a stored body and reports it', async () => {
    mocks.extractPdfJobContentFromUrl.mockImplementation(async (url: string) => (
      url === PDF_A ? { text: body('Pflegefachfrau HF 60-80%'), totalPages: 1 } : WAF_FAILURE
    ));
    stopAtMergedSlice();

    await expect(main()).rejects.toThrow(/sentinel: merged slice written/);

    expect(seedUrls()).toEqual([PDF_A, PDF_B]);
    expect(mergedJobs().map((job: any) => job.url)).toEqual([PDF_A]);
    expect(summaryCounts().sourceBodyFailures).toEqual([
      expect.objectContaining({ url: PDF_B, reason: 'pdf-extraction-failed' }),
    ]);
  });

  // A thin read (pages but under 50 chars, e.g. an image-only PDF) is a thin
  // source, not an extraction failure (scripts/lib/source-body-failure.mjs):
  // the stored body still wins over the empty fresh one, keyed on the floor.
  const THIN_READ = {
    text: '',
    rawText: 'Seite 1',
    thin: true,
    totalPages: 1,
    warning: 'PDF has 1 page(s) but only 7 chars extracted (possible image-only/scanned PDF)',
  };

  it('keeps the stored body for a thin PDF read instead of publishing it empty', async () => {
    mocks.extractPdfJobContentFromUrl.mockImplementation(async (url: string) => (
      url === PDF_A ? THIN_READ : { text: body('Psychologin 60%'), totalPages: 1 }
    ));
    mocks.readExistingCrawlerJobs.mockReturnValue([storedJob(PDF_A, 'Pflegefachfrau HF 60-80%')]);
    stopAtMergedSlice();

    await expect(main()).rejects.toThrow(/sentinel: merged slice written/);

    const jobs = mergedJobs();
    expect(jobs.map((job: any) => job.url)).toEqual([PDF_A, PDF_B]);
    expect(jobs[0].description).toBe(body('Pflegefachfrau HF 60-80%'));
    expect(jobs[0].descriptionByLocale.de).toBe(body('Pflegefachfrau HF 60-80%'));
    expect(summaryCounts().sourceBodyFailures).toEqual([]);
  });

  it('leaves out a thin PDF read without a publishable stored body rather than publishing it empty', async () => {
    mocks.extractPdfJobContentFromUrl.mockImplementation(async (url: string) => (
      url === PDF_A ? THIN_READ : { text: body('Psychologin 60%'), totalPages: 1 }
    ));
    // The stored row is itself under the floor: the merge must not re-add it.
    mocks.readExistingCrawlerJobs.mockReturnValue([
      { ...storedJob(PDF_A, 'Pflegefachfrau HF 60-80%'), description: '', descriptionByLocale: { de: '' } },
    ]);
    stopAtMergedSlice();

    await expect(main()).rejects.toThrow(/sentinel: merged slice written/);

    expect(mergedJobs().map((job: any) => job.url)).toEqual([PDF_B]);
  });


  it('drops a stored row under the floor when the PDF read fails, instead of republishing it empty', async () => {
    mocks.extractPdfJobContentFromUrl.mockImplementation(async (url: string) => (
      url === PDF_A ? WAF_FAILURE : { text: body('Psychologin 60%'), totalPages: 1 }
    ));
    mocks.readExistingCrawlerJobs.mockReturnValue([
      { ...storedJob(PDF_A, 'Pflegefachfrau HF 60-80%'), description: '', descriptionByLocale: { de: '' } },
    ]);
    stopAtMergedSlice();

    await expect(main()).rejects.toThrow(/sentinel: merged slice written/);

    expect(mergedJobs().map((job: any) => job.url)).toEqual([PDF_B]);
    expect(summaryCounts().sourceBodyFailures).toEqual([
      expect.objectContaining({ url: PDF_A, reason: 'pdf-extraction-failed' }),
    ]);
  });

  it('fails when no posting has a publishable body, before writing anything', async () => {
    mocks.extractPdfJobContentFromUrl.mockResolvedValue(WAF_FAILURE);

    await expect(main()).rejects.toThrow(
      /no publishable posting: 2 listed, 2 PDF read failure\(s\), no stored source body to keep/,
    );
    expect(mocks.writeJsonAtomic).not.toHaveBeenCalled();
    expect(mocks.writeJobsCrawlerSlice).not.toHaveBeenCalled();
  });
});
