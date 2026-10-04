import fs from 'node:fs';
import path from 'node:path';
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
import { fetchAllBentelerJobs } from '../scripts/lib/benteler-job-parser.mjs';
import { fetchAllConstelliumJobs } from '../scripts/lib/constellium-job-parser.mjs';
import { fetchAllHolcimJobs } from '../scripts/lib/holcim-job-parser.mjs';
import { fetchJobs as fetchBpsJobs } from '../scripts/update-bps-suisse-jobs.mjs';
import { fetchAllAbraxasJobs } from '../scripts/lib/abraxas-job-parser.mjs';
import { fetchAllCantonValaisJobs } from '../scripts/lib/canton-valais-job-parser.mjs';
import { fetchAllGlobusJobs } from '../scripts/lib/globus-job-parser.mjs';
import { fetchAllZermattBergbahnenJobs } from '../scripts/lib/zermatt-bergbahnen-job-parser.mjs';
import {
  fetchAllCroixRougeFribourgeoiseJobs,
  isJobCloudListingProvenEmpty,
  isJobupProfileProvenEmpty,
} from '../scripts/lib/croix-rouge-fribourgeoise-job-parser.mjs';
import { isAuthoritativeEmptySnapshot } from '../scripts/lib/authoritative-empty-snapshot.mjs';

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

  it.each([
    ['Benteler', fetchAllBentelerJobs],
    ['Constellium', fetchAllConstelliumJobs],
    ['Holcim', fetchAllHolcimJobs],
  ])('%s propagates a Jobs2Web listing failure instead of returning an empty feed', async (_name, fetchJobs) => {
    fetchHtml.mockRejectedValueOnce(new Error('network unavailable'));
    await expect(fetchJobs()).rejects.toThrow(/network unavailable/i);
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

  it.each([
    ['Benteler', fetchAllBentelerJobs],
    ['Constellium', fetchAllConstelliumJobs],
    ['Holcim', fetchAllHolcimJobs],
  ])('%s preserves a reachable empty Jobs2Web page as a genuine empty result', async (_name, fetchJobs) => {
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

describe('parsers whose listing catch used to return [] now propagate the fetch failure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['Abraxas', fetchAllAbraxasJobs],
    ['Canton du Valais', fetchAllCantonValaisJobs],
    ['Globus', fetchAllGlobusJobs],
    ['Zermatt Bergbahnen', fetchAllZermattBergbahnenJobs],
  ])('%s propagates a listing-page network failure instead of returning an empty feed', async (_name, fetchJobs) => {
    fetchHtml.mockRejectedValueOnce(new Error('network unavailable'));
    await expect(fetchJobs()).rejects.toThrow(/network unavailable/i);
  });
});

// Issue 11077: the Croix-Rouge fribourgeoise runs aborted as `no-jobs-parsed`
// with no cause, because both the JobCloud listing and the Jobup fallback
// swallowed their fetch errors. A fetch failure must surface, a zero is only
// proven when both sources render their own "no open positions" state, and
// any other zero stays the fail-closed unstamped [].
describe('Croix-Rouge fribourgeoise keeps fetch failure, proven empty and unreadable zero apart', () => {
  const JOBCLOUD_URL_RE = /company\.jobcloud\.ch\/fr\/job-list\//;
  const JOBUP_URL_RE = /www\.jobup\.ch\/fr\/societes\//;
  const JOBCLOUD_EMPTY = '<html><body><script>self.__next_f.push([1,"{\\"initialJobs\\":[],\\"categories\\":[]}"])</script>'
    + '<div><p class="text-lg">Aucun poste ouvert actuellement</p></div></body></html>';
  const JOBCLOUD_DRIFTED = '<html><body><div id="app"></div></body></html>';
  const JOBUP_EMPTY = '<html><body><div data-cy="company-no-vacancies"><h2>De nouveaux emplois</h2></div></body></html>';
  const JOBCLOUD_ONE_JOB = '<html><body><a href="/fr/jobs/11111111-2222-3333-4444-555555555555">Job</a></body></html>';

  function routeFetch(routes: Array<[RegExp, string | Error]>) {
    fetchHtml.mockImplementation(async (url: string) => {
      for (const [re, value] of routes) {
        if (re.test(String(url))) {
          if (value instanceof Error) throw value;
          return value;
        }
      }
      throw new Error(`unexpected fetch ${url}`);
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    fetchHtml.mockReset();
  });

  it('propagates the Jobup failure when JobCloud also failed', async () => {
    routeFetch([[JOBCLOUD_URL_RE, new Error('jobcloud down')], [JOBUP_URL_RE, new Error('jobup down')]]);
    await expect(fetchAllCroixRougeFribourgeoiseJobs()).rejects.toThrow(/jobup down/);
  });

  it('propagates the Jobup fallback failure even when JobCloud states it is empty', async () => {
    routeFetch([[JOBCLOUD_URL_RE, JOBCLOUD_EMPTY], [JOBUP_URL_RE, new Error('jobup down')]]);
    await expect(fetchAllCroixRougeFribourgeoiseJobs()).rejects.toThrow(/jobup down/);
  });

  it('propagates the JobCloud failure when only the fallback answered with no jobs', async () => {
    routeFetch([[JOBCLOUD_URL_RE, new Error('jobcloud down')], [JOBUP_URL_RE, JOBUP_EMPTY]]);
    await expect(fetchAllCroixRougeFribourgeoiseJobs()).rejects.toThrow(/jobcloud down/);
  });

  it('stamps an authoritative empty snapshot when both sources state there is no opening', async () => {
    routeFetch([[JOBCLOUD_URL_RE, JOBCLOUD_EMPTY], [JOBUP_URL_RE, JOBUP_EMPTY]]);
    const jobs = await fetchAllCroixRougeFribourgeoiseJobs();
    expect(jobs).toEqual([]);
    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(true);
  });

  it('keeps an unreadable JobCloud page as the fail-closed unstamped zero', async () => {
    routeFetch([[JOBCLOUD_URL_RE, JOBCLOUD_DRIFTED], [JOBUP_URL_RE, JOBUP_EMPTY]]);
    const jobs = await fetchAllCroixRougeFribourgeoiseJobs();
    expect(jobs).toEqual([]);
    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(false);
  });

  it('propagates a detail failure when every listed detail is unreachable', async () => {
    routeFetch([
      [JOBCLOUD_URL_RE, JOBCLOUD_ONE_JOB],
      [/\/fr\/jobs\//, new Error('detail down')],
    ]);
    await expect(fetchAllCroixRougeFribourgeoiseJobs()).rejects.toThrow(/detail down/);
  });

  it('recognises each source empty state only with its own marker', () => {
    expect(isJobCloudListingProvenEmpty(JOBCLOUD_EMPTY)).toBe(true);
    expect(isJobCloudListingProvenEmpty(JOBCLOUD_DRIFTED)).toBe(false);
    expect(isJobCloudListingProvenEmpty(JOBCLOUD_EMPTY.replace('Aucun poste ouvert actuellement', ''))).toBe(false);
    expect(isJobCloudListingProvenEmpty(
      JOBCLOUD_EMPTY.replace('\\"categories', '\\"x\\":0,\\"initialJobs\\":[{\\"id\\":1}],\\"categories'),
    )).toBe(false);
    expect(isJobupProfileProvenEmpty(JOBUP_EMPTY)).toBe(true);
    expect(isJobupProfileProvenEmpty('<html><body></body></html>')).toBe(false);
    expect(isJobupProfileProvenEmpty(
      `${JOBUP_EMPTY}<div data-cy="company-jobs-list"><a href="/fr/emplois/detail/x/">x</a></div>`,
    )).toBe(false);
  });
});

// Static observer for the whole class: a `try` that fetches (any `fetch*(`
// call) followed by a `catch` that returns `[]` without rethrowing turns a
// fetch failure into a cause-less "no jobs" result. Every such site in the
// crawler sources must either propagate the error or carry, inside the catch,
// `// fetch-failure-empty-ok: <reason>` explaining why an empty batch is the
// right answer there.
describe('crawler sources never read a swallowed fetch failure as an empty listing', () => {
  const ROOT = path.resolve(__dirname, '..');
  const MARKER = 'fetch-failure-empty-ok:';

  function crawlerSourceFiles(): string[] {
    const files: string[] = [];
    const add = (dir: string, keep: (name: string) => boolean) => {
      for (const name of fs.readdirSync(path.join(ROOT, dir))) {
        if (keep(name)) files.push(`${dir}/${name}`);
      }
    };
    add('scripts/lib', (name) => name.endsWith('.mjs'));
    add('scripts/lib/ats-clients', (name) => name.endsWith('.mjs'));
    add('scripts', (name) => /^update-.*-jobs\.mjs$/.test(name));
    return files.sort();
  }

  function closeBrace(src: string, openIndex: number): number {
    let depth = 1;
    let i = openIndex + 1;
    while (i < src.length && depth) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') depth -= 1;
      i += 1;
    }
    return i;
  }

  function swallowedFetchCatches(src: string): Array<{ line: number; catchBody: string }> {
    const out: Array<{ line: number; catchBody: string }> = [];
    const tryRe = /\btry\s*\{/g;
    let match: RegExpExecArray | null;
    while ((match = tryRe.exec(src)) !== null) {
      const tryEnd = closeBrace(src, match.index + match[0].length - 1);
      const tryBody = src.slice(match.index + match[0].length, tryEnd - 1);
      const header = src.slice(tryEnd).match(/^\s*catch\s*(?:\(\s*\w+\s*\))?\s*\{/);
      if (!header) continue;
      const catchOpen = tryEnd + header[0].length - 1;
      const catchBody = src.slice(catchOpen + 1, closeBrace(src, catchOpen) - 1);
      if (!/\bfetch\w*\s*\(/.test(tryBody)) continue;
      if (!/\breturn\s*\[\s*\]/.test(catchBody) || /\bthrow\b/.test(catchBody)) continue;
      out.push({ line: src.slice(0, match.index).split('\n').length, catchBody });
    }
    return out;
  }

  it('scans a non-trivial set of crawler sources', () => {
    const files = crawlerSourceFiles();
    expect(files.some((file) => file.endsWith('-job-parser.mjs'))).toBe(true);
    expect(files).toContain('scripts/lib/croix-rouge-fribourgeoise-job-parser.mjs');
  });

  it('detects the construct it is meant to forbid', () => {
    const sample = [
      'async function a() {',
      '  try { html = await fetchHtml(URL); } catch (err) { console.warn(err); return []; }',
      '}',
      'async function b() {',
      '  try { html = await fetchHtml(URL); } catch (err) { throw err; }',
      '}',
    ].join('\n');
    expect(swallowedFetchCatches(sample).map((hit) => hit.line)).toEqual([2]);
  });

  it('has no unmotivated catch that turns a fetch failure into []', () => {
    const offenders: string[] = [];
    for (const file of crawlerSourceFiles()) {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
      for (const hit of swallowedFetchCatches(src)) {
        if (!hit.catchBody.includes(MARKER)) offenders.push(`${file}:${hit.line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('gives every allowlisted catch a concrete reason', () => {
    const thin: string[] = [];
    for (const file of crawlerSourceFiles()) {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
      for (const hit of swallowedFetchCatches(src)) {
        const reason = hit.catchBody.split(MARKER)[1]?.split('\n')[0]?.trim() ?? '';
        if (hit.catchBody.includes(MARKER) && reason.length < 40) thin.push(`${file}:${hit.line}`);
      }
    }
    expect(thin).toEqual([]);
  });
});
