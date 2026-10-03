import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchHtml, fetchJson } = vi.hoisted(() => ({ fetchHtml: vi.fn(), fetchJson: vi.fn() }));
vi.mock('@/scripts/lib/crawler-template.mjs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, fetchHtml, fetchJson };
});

import { fetchAllMabetexJobs } from '../scripts/lib/mabetex-job-parser.mjs';
import { fetchAllChiccoDoroJobs } from '../scripts/lib/chicco-doro-job-parser.mjs';
import { fetchAllFaulhaberJobs } from '../scripts/lib/faulhaber-job-parser.mjs';
import { fetchAllFranklinUniversityJobs } from '../scripts/lib/franklin-university-job-parser.mjs';
import { fetchAllImerysJobs } from '../scripts/lib/imerys-job-parser.mjs';
import { fetchAllMoncuccoJobs } from '../scripts/lib/moncucco-job-parser.mjs';
import { fetchAllNovelisJobs } from '../scripts/lib/novelis-job-parser.mjs';
import { fetchJobs as fetchBpsJobs } from '../scripts/update-bps-suisse-jobs.mjs';

const EMPTY_PAGE = '<html><body><p>No open positions</p></body></html>';

describe('crawler listing fetch failures stay distinct from valid empty responses', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['Mabetex', fetchAllMabetexJobs],
    ['Faulhaber', fetchAllFaulhaberJobs],
    ['Franklin University', fetchAllFranklinUniversityJobs],
    ['Moncucco', fetchAllMoncuccoJobs],
    ['Novelis', fetchAllNovelisJobs],
  ])('%s propagates a listing-page network failure', async (_name, fetchJobs) => {
    fetchHtml.mockRejectedValueOnce(new Error('network unavailable'));
    await expect(fetchJobs()).rejects.toThrow(/failed to fetch.*network unavailable/i);
  });

  it('BPS Suisse propagates a listing-page network failure instead of returning an empty feed', async () => {
    fetchHtml.mockRejectedValueOnce(new Error('network unavailable'));
    await expect(fetchBpsJobs()).rejects.toThrow(/network unavailable/i);
  });

  it.each([
    ['Mabetex', fetchAllMabetexJobs],
    ['Franklin University', fetchAllFranklinUniversityJobs],
    ['Moncucco', fetchAllMoncuccoJobs],
    ['Novelis', fetchAllNovelisJobs],
  ])('%s preserves a reachable empty page as a genuine empty result', async (_name, fetchJobs) => {
    fetchHtml.mockResolvedValueOnce(EMPTY_PAGE);
    await expect(fetchJobs()).resolves.toEqual([]);
  });

  it('Faulhaber rejects a reachable response that is not its authoritative listing-data envelope', async () => {
    fetchHtml.mockResolvedValueOnce(EMPTY_PAGE);
    await expect(fetchAllFaulhaberJobs()).rejects.toThrow(/listing-data response is not valid JSON/i);
  });

  it("Chicco d'Oro propagates failure when every alternative page is unreachable", async () => {
    fetchHtml.mockRejectedValue(new Error('network unavailable'));
    await expect(fetchAllChiccoDoroJobs()).rejects.toThrow(/all career listing pages failed/i);
  });

  it("Chicco d'Oro preserves one reachable empty page despite failed alternatives", async () => {
    fetchHtml
      .mockRejectedValueOnce(new Error('first alternative unavailable'))
      .mockResolvedValueOnce(EMPTY_PAGE)
      .mockRejectedValueOnce(new Error('third alternative unavailable'));
    await expect(fetchAllChiccoDoroJobs()).resolves.toEqual([]);
  });

  it("Chicco d'Oro propagates parser failures without trying another URL", async () => {
    fetchHtml.mockResolvedValueOnce({
      toString() { throw new Error('parser exploded'); },
    });
    await expect(fetchAllChiccoDoroJobs()).rejects.toThrow(/parser exploded/i);
    expect(fetchHtml).toHaveBeenCalledTimes(1);
  });

  // Imerys reads its Workday tenant (the old SmartRecruiters / HTML chain is
  // gone): a site the tenant no longer serves must fail the run, never read
  // as an empty Swiss board.
  it('Imerys propagates a Workday site failure instead of reading it as empty', async () => {
    const fetchMock = vi.fn(async () => new Response(
      '{"errorCode":"S21","httpStatus":404,"message":"not found: Job_Posting_Site_ID=IMERYS-Careers"}',
      { status: 404 },
    ));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(fetchAllImerysJobs()).rejects.toThrow(/Workday API error HTTP 404/);
      expect(fetchJson).not.toHaveBeenCalled();
      expect(fetchHtml).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
