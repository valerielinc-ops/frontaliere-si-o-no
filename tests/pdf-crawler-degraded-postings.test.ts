/**
 * Berit Klinik and Clinique Le Noirmont: a posting whose PDF cannot be read
 * (timeout, 5xx, no text layer) is a degraded source, as in Klinik
 * Wysshölzli and LWPHR. It republishes its stored record, is reported in
 * sourceBodyFailures, and the crawler fails only when nothing is publishable.
 * Both runners used to abort on the first unreadable PDF.
 */
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

import { main as beritMain } from '../scripts/update-berit-klinik-jobs.mjs';
import { main as noirmontMain } from '../scripts/update-clinique-le-noirmont-jobs.mjs';

const words = (lead: string) => `${lead} ${Array(60).fill('Betreuung').join(' ')}`;
const STORED_IT = 'Traduzione salvata da una lettura precedente dello stesso PDF.';

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

const TIMEOUT = { text: '', extractionFailed: true, error: 'timeout' };

const CASES = [
  {
    name: 'Berit Klinik',
    main: beritMain,
    companyKey: 'berit-klinik',
    // Sanitized listing shape: CMS media links with placeholder file names.
    listing: [
      'https://cms-berit-klinik.deployco.de/api/media/file/Stelleninserat-Pflegefachperson-HF.pdf',
      'https://cms-berit-klinik.deployco.de/api/media/file/Stelleninserat-Physiotherapeutin.pdf',
    ],
    html: (urls: string[]) => urls.map((url) => `<a href="${url}">PDF</a>`).join('\n'),
    storedLocation: 'Speicher',
  },
  {
    name: 'Clinique Le Noirmont',
    main: noirmontMain,
    companyKey: 'clinique-le-noirmont',
    listing: [
      'https://www.cliniquelenoirmont.ch/File/101/offre-infirmier-diplome.pdf',
      'https://www.cliniquelenoirmont.ch/File/102/offre-physiotherapeute.pdf',
    ],
    html: (urls: string[]) => urls
      .map((url, i) => `<a href="${new URL(url).pathname}" title="Offre ${i + 1} Le Noirmont">PDF</a>`)
      .join('\n'),
    storedLocation: 'Le Noirmont',
  },
];

describe.each(CASES)('$name crawler: degraded PDF postings', ({ main, companyKey, listing, html, storedLocation }) => {
  const [FAILED_URL, FRESH_URL] = listing;
  const stored = {
    title: 'Titel aus einem früheren Lesen',
    slug: `titel-aus-einem-frueheren-lesen-${companyKey}`,
    company: companyKey,
    companyKey,
    url: FAILED_URL,
    location: storedLocation,
    sourceLang: 'de',
    description: words('Gespeicherter Quelltext.'),
    descriptionByLocale: { de: words('Gespeicherter Quelltext.'), it: STORED_IT },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchHtml.mockResolvedValue(html(listing));
    mocks.extractPdfJobContentFromUrl.mockImplementation(async (url: string) => (
      url === FAILED_URL ? TIMEOUT : { text: words('Frischer Quelltext.'), totalPages: 1 }
    ));
    mocks.readExistingCrawlerJobs.mockReturnValue([stored]);
  });

  it('keeps an already published posting whole when its PDF read fails, and reports it', async () => {
    stopAtMergedSlice();

    await expect(main()).rejects.toThrow(/sentinel: merged slice written/);

    const merged = mocks.writeJsonAtomic.mock.calls[1][1];
    const kept = merged.find((job: any) => job.url === FAILED_URL);
    expect(kept).toMatchObject({
      title: stored.title,
      slug: stored.slug,
      location: storedLocation,
      description: stored.description,
    });
    expect(kept.descriptionByLocale.it).toBe(STORED_IT);
    expect(kept.sourceBodyFailureReason).toBeUndefined();
    expect(merged.map((job: any) => job.url)).toContain(FRESH_URL);
    expect(mocks.registerCrawlerSummaryGuard.mock.calls[0][2].sourceBodyFailures).toEqual([
      expect.objectContaining({ url: FAILED_URL, reason: 'pdf-extraction-failed', message: 'timeout' }),
    ]);
  });

  it('leaves out an unreadable posting without a stored body, still reporting it', async () => {
    mocks.readExistingCrawlerJobs.mockReturnValue([]);
    stopAtMergedSlice();

    await expect(main()).rejects.toThrow(/sentinel: merged slice written/);

    expect(mocks.writeJsonAtomic.mock.calls[1][1].map((job: any) => job.url)).toEqual([FRESH_URL]);
    expect(mocks.registerCrawlerSummaryGuard.mock.calls[0][2].sourceBodyFailures)
      .toEqual([expect.objectContaining({ url: FAILED_URL })]);
  });

  it('reports a PDF without a text layer like a failed read, keeping the stored posting', async () => {
    const warning = 'PDF has 1 page(s) but only 7 chars extracted (possible image-only/scanned PDF)';
    mocks.extractPdfJobContentFromUrl.mockImplementation(async (url: string) => (
      url === FAILED_URL
        ? { text: '', rawText: 'Seite 1', thin: true, totalPages: 1, warning }
        : { text: words('Frischer Quelltext.'), totalPages: 1 }
    ));
    stopAtMergedSlice();

    await expect(main()).rejects.toThrow(/sentinel: merged slice written/);

    const merged = mocks.writeJsonAtomic.mock.calls[1][1];
    expect(merged.find((job: any) => job.url === FAILED_URL)).toMatchObject({ description: stored.description });
    expect(mocks.registerCrawlerSummaryGuard.mock.calls[0][2].sourceBodyFailures).toEqual([
      expect.objectContaining({ url: FAILED_URL, reason: 'pdf-extraction-failed', message: warning }),
    ]);
  });

  it('fails when no posting is publishable, before writing anything', async () => {
    mocks.extractPdfJobContentFromUrl.mockResolvedValue({ text: '', extractionFailed: true, error: 'HTTP 503 while fetching PDF' });
    mocks.readExistingCrawlerJobs.mockReturnValue([]);

    await expect(main()).rejects.toThrow(/has no publishable posting: 2 listed, 2 with an unusable PDF and no stored source body/);
    expect(mocks.writeJsonAtomic).not.toHaveBeenCalled();
    expect(mocks.writeJobsCrawlerSlice).not.toHaveBeenCalled();
  });
});
