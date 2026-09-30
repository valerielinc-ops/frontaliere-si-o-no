/**
 * A run that finds no job keeps the stored slice. The text a crawler once
 * wrote into its stored jobs is removed in the merge, so without this cleanup
 * at the zero-job exit it would survive for as long as the source stays empty
 * (#5253, lot L 3). `rewritePreparedStoredJobs` rewrites the slice only when
 * the cleanup changed something, and nothing else.
 *
 * Fixture: minimized stored rows of the main slices (2026-09-29), shared with
 * tests/pdf-backed-description-source-only-runners.test.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { rewritePreparedStoredJobs } from '../scripts/lib/stored-jobs-soft-exit.mjs';
import { dropFabricatedDescriptions } from '../scripts/lib/drop-fabricated-description.mjs';
import { FART_FABRICATED_DESCRIPTION_RE } from '../scripts/lib/fart-job-parser.mjs';

const FIXTURE = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures/crawler-fabricated-descriptions/pdf-backed-runner-crawlers.json'),
  'utf8',
));

function storedFartJob(index = 0) {
  const row = FIXTURE.fart;
  return {
    id: `fart-${index}`,
    slug: `fart-concorso-${index}`,
    url: `https://www.fartiamo.ch/concorsi/${index}/`,
    companyKey: 'fart',
    sourceLang: row.sourceLang,
    postedDate: POSTED,
    description: row.source,
    descriptionByLocale: { [row.sourceLang]: row.source, ...(row.translation || {}) },
  };
}

const POSTED = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10);

const prepare = (jobs: object[]) => dropFabricatedDescriptions(jobs, FART_FABRICATED_DESCRIPTION_RE, 'FART');

describe('rewritePreparedStoredJobs (zero-job soft exit)', () => {
  it('rewrites the slice with the stored jobs cleaned, and nothing else', async () => {
    const write = vi.fn();
    const stored = [storedFartJob()];
    const rewritten = await rewritePreparedStoredJobs({
      prepare, storedJobs: stored, companyKey: 'fart', companyLabel: 'FART', write,
    });
    expect(rewritten).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    const [jobs, options] = write.mock.calls[0];
    expect(jobs).toEqual([]);
    expect(options).toEqual({
      housekeepingProof: [{
        job: expect.objectContaining({
          url: 'https://www.fartiamo.ch/concorsi/0/',
          slug: 'fart-concorso-0',
        }),
        reason: 'thin-source-quarantine',
        definitive: true,
      }],
    });
  });

  it('quarantines a stored job that has no source body even without a fabricated marker', async () => {
    const write = vi.fn();
    const job = { ...storedFartJob(), description: 'CONCORSO PUBBLICO', descriptionByLocale: { it: 'CONCORSO PUBBLICO' } };
    const rewritten = await rewritePreparedStoredJobs({
      prepare, storedJobs: [job], companyKey: 'fart', companyLabel: 'FART', write,
    });
    expect(rewritten).toBe(true);
    expect(write).toHaveBeenCalledWith([], {
      housekeepingProof: [{
        job: expect.objectContaining({ slug: 'fart-concorso-0' }),
        reason: 'thin-source-quarantine',
        definitive: true,
      }],
    });
  });

  it('records a failed PDF separately from thin-source quarantine', async () => {
    const write = vi.fn();
    const job = { ...storedFartJob(), description: '', descriptionByLocale: { it: '' } };
    const rewritten = await rewritePreparedStoredJobs({
      prepare: (jobs) => jobs,
      storedJobs: [job],
      sourceBodyFailureJobs: [{ url: job.url, sourceBodyFailureReason: 'pdf-extraction-failed' }],
      companyKey: 'fart',
      companyLabel: 'FART',
      write,
    });

    expect(rewritten).toBe(true);
    expect(write).toHaveBeenCalledWith([], {
      housekeepingProof: [{
        job: expect.objectContaining({ url: job.url }),
        reason: 'pdf-extraction-failed',
        definitive: true,
      }],
    });
  });

  it('keeps a real source body while removing only a fabricated translation', async () => {
    const write = vi.fn();
    const source = Array(60).fill('source').join(' ');
    const job = {
      ...storedFartJob(),
      description: source,
      descriptionByLocale: {
        it: source,
        en: 'Consultare il bando PDF ufficiale per dettagli completi',
      },
    };
    const rewritten = await rewritePreparedStoredJobs({
      prepare, storedJobs: [job], companyKey: 'fart', companyLabel: 'FART', write,
    });
    expect(rewritten).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0][0]).toMatchObject({
      description: source,
      descriptionByLocale: { it: source },
    });
    expect(write.mock.calls[0][1]).toEqual({});
  });

  it('writes nothing without a cleanup or without stored jobs', async () => {
    const write = vi.fn();
    expect(await rewritePreparedStoredJobs({
      storedJobs: [storedFartJob()], companyKey: 'fart', companyLabel: 'FART', write,
    })).toBe(false);
    expect(await rewritePreparedStoredJobs({
      prepare, storedJobs: [], companyKey: 'fart', companyLabel: 'FART', write,
    })).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it('does not let an all-thin quarantine trip the systemic boilerplate guard', async () => {
    const write = vi.fn();
    const stored = Array.from({ length: 10 }, (_, i) => storedFartJob(i));
    const rewritten = await rewritePreparedStoredJobs({
      prepare, storedJobs: stored, companyKey: 'fart', companyLabel: 'FART', write,
    });
    expect(rewritten).toBe(true);
    expect(write).toHaveBeenCalledWith([], {
      housekeepingProof: expect.arrayContaining([
        expect.objectContaining({
          job: expect.objectContaining({ slug: 'fart-concorso-0' }),
          definitive: true,
        }),
      ]),
    });
  });

  it('stays soft when the write fails', async () => {
    const write = vi.fn(() => { throw new Error('shrink guard'); });
    await expect(rewritePreparedStoredJobs({
      prepare, storedJobs: [storedFartJob()], companyKey: 'fart', companyLabel: 'FART', write,
    })).resolves.toBe(false);
  });
});

// Runners with their own merge: the zero-job exit runs the same cleanup as
// the merge (same pattern) and writes with the runner's slice writer.
describe('own-runner crawlers clean their stored jobs at the zero-job exit', () => {
  const RUNNERS = [
    'update-cerbios-pharma-jobs.mjs',
    'update-citta-di-bellinzona-jobs.mjs',
    'update-citta-di-locarno-jobs.mjs',
    'update-citta-di-lugano-jobs.mjs',
    'update-fart-jobs.mjs',
    'update-mendrisio-jobs.mjs',
    'update-oscam-jobs.mjs',
  ];

  for (const runner of RUNNERS) {
    it(runner, () => {
      const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', runner), 'utf8');
      const mergePattern = source.match(/dropFabricatedDescriptions\(\s*\n\s*[^\n]+\n\s*([A-Z_]+_FABRICATED_DESCRIPTION_RE),/)?.[1];
      expect(mergePattern).toBeTruthy();
      const exit = source.slice(source.indexOf('await rewritePreparedStoredJobs({'));
      expect(exit.length).toBeGreaterThan(0);
      const call = exit.slice(0, exit.indexOf('});') + 3);
      expect(call).toContain(`prepare: (jobs) => dropFabricatedDescriptions(jobs, ${mergePattern},`);
      expect(call).toMatch(/write: \(jobs, options\) => writeJobsCrawlerSliceVerified\([A-Z_]+, jobs, options\)/);
      expect(call).toContain('assemble: () => assembleJobsDataset(),');
      // The call sits in the zero-job exit, before its `return`.
      expect(exit.slice(call.length).trimStart()).toMatch(/^(return;|const _cdResult = logStats)/);
    });
  }

  it('update-convit-jobs.mjs (per-job cleanup of its merge)', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'update-convit-jobs.mjs'), 'utf8');
    expect(source).toContain('targetExisting.filter((job) => dropConvitFabricatedText(job))');
    const exit = source.slice(source.indexOf('await rewritePreparedStoredJobs({'));
    const call = exit.slice(0, exit.indexOf('});') + 3);
    // Returns nothing: the helper keeps the whole stored array, repaired in place.
    expect(call).toContain('prepare: (jobs) => { jobs.forEach(dropConvitFabricatedText); },');
    expect(call).toContain('write: (jobs, options) => writeJobsCrawlerSliceVerified(COMPANY_KEY, jobs, { isTargetJob, ...options }),');
    expect(call).toContain('assemble: () => assembleJobsDataset(),');
    expect(exit.slice(call.length).trimStart()).toMatch(/^return;/);
  });
});

// Runners of lots H and K with their own per-job cleanup in the merge
// (`drop<Name>FabricatedText`): a local `cleanStoredJobsOnSoftExit` runs the
// same cleanup, and every zero-job exit calls it before returning. swisscom,
// ail and usi also have a second exit when the crawl ends with 0 jobs.
describe('lot H/K runners clean their stored jobs at every zero-job exit', () => {
  const RUNNERS: Array<[string, number]> = [
    ['update-afry-jobs.mjs', 1],
    ['update-agie-charmilles-jobs.mjs', 1],
    ['update-ail-jobs.mjs', 2],
    ['update-artificialy-jobs.mjs', 1],
    ['update-baronie-jobs.mjs', 2],
    ['update-bps-suisse-jobs.mjs', 1],
    ['update-casale-jobs.mjs', 1],
    ['update-hoval-jobs.mjs', 1],
    ['update-julius-baer-jobs.mjs', 1],
    ['update-knowledge-lab-jobs.mjs', 2],
    ['update-mtic-jobs.mjs', 2],
    ['update-pkb-private-bank-jobs.mjs', 1],
    ['update-prada-jobs.mjs', 1],
    ['update-relewant-jobs.mjs', 1],
    ['update-sintetica-jobs.mjs', 1],
    ['update-swiss-medical-network-jobs.mjs', 2],
    ['update-swisscom-jobs.mjs', 2],
    ['update-tarchini-group-jobs.mjs', 1],
    ['update-usi-jobs.mjs', 2],
  ];

  for (const [runner, exits] of RUNNERS) {
    it(`${runner} (${exits} exit${exits > 1 ? 's' : ''})`, () => {
      const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', runner), 'utf8');
      // The merge's cleanup: `<stored>.filter((job) => dropXFabricatedText(job))`.
      const mergeDrop = source.match(/\.filter\(\(job\) => (drop[A-Za-z]+FabricatedText)\(job\)\)/)?.[1];
      expect(mergeDrop).toBeTruthy();
      const fnStart = source.indexOf('function cleanStoredJobsOnSoftExit() {');
      expect(fnStart).toBeGreaterThan(-1);
      const fn = source.slice(fnStart, source.indexOf('\n}\n', fnStart));
      expect(fn).toContain(`prepare: (jobs) => { for (const job of jobs) ${mergeDrop}(job); },`);
      expect(fn).toMatch(/storedJobs: readExistingCrawlerJobs\([A-Z_]+, DATA_JOBS\)\.filter\([A-Za-z]+\),/);
      expect(fn).toMatch(/write: \(jobs, options\) => writeJobsCrawlerSlice(?:Verified)?\([A-Z_]+, jobs, options\),/);
      // Each call sits right before the `return` of a zero-job exit.
      const calls = source.match(/await cleanStoredJobsOnSoftExit\(\);\s*return;/g) || [];
      expect(calls).toHaveLength(exits);
      expect(source.split('await cleanStoredJobsOnSoftExit();').length - 1).toBe(exits);
    });
  }
});
