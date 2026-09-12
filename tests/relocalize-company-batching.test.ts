import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const crawler = vi.hoisted(() => ({
  runSharedCrawlerPipeline: vi.fn(),
}));

vi.mock('../scripts/lib/shared-jobs-crawler.mjs', () => crawler);

const root = path.resolve('.');
const dataRoot = path.join(root, 'data');
const dataJobsPath = path.join(dataRoot, 'jobs.json');
const popularityPath = path.join(dataRoot, 'job-popularity.json');
const companySkipStatePath = path.join(dataRoot, 'cascade-company-skip.json');
const byCrawlerPath = path.join(dataRoot, 'jobs', 'by-crawler');

const envKeys = [
  'JOBS_CASCADE_DEADLINE_MS',
  'RELOCALIZE_ALLOW_NO_TRAFFIC',
  'RELOCALIZE_DRY_RUN',
  'RELOCALIZE_MAX_JOBS',
  'RUNNER_TEMP',
  'TRANSLATION_THINKING_AB',
];

let previousEnv: Record<string, string | undefined> = {};
let runnerTemp = '';

beforeEach(() => {
  previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    JOBS_CASCADE_DEADLINE_MS: '600000',
    RELOCALIZE_ALLOW_NO_TRAFFIC: '1',
    RELOCALIZE_DRY_RUN: '0',
    RELOCALIZE_MAX_JOBS: '2',
    TRANSLATION_THINKING_AB: '0',
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of envKeys) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
  previousEnv = {};
  crawler.runSharedCrawlerPipeline.mockReset();
  if (runnerTemp) fs.rmSync(runnerTemp, { recursive: true, force: true });
  runnerTemp = '';
});

describe('relocalize company invocation batching', () => {
  it('separates historical truncated keys by the full company name before batching', async () => {
    const { canonicalCompanyKeyForJob } = await import('../scripts/relocalize-pending-jobs.mjs');
    const firstName = `${'x'.repeat(63)} one`;
    const secondName = `${'x'.repeat(63)} two`;
    const historicalKey = 'x'.repeat(63) + '-';
    const normalizedHistoricalKey = 'x'.repeat(63);

    expect(canonicalCompanyKeyForJob({ company: firstName, companyKey: historicalKey }))
      .not.toBe(canonicalCompanyKeyForJob({ company: secondName, companyKey: historicalKey }));
    expect(canonicalCompanyKeyForJob({ company: firstName, companyKey: normalizedHistoricalKey }))
      .toBe(canonicalCompanyKeyForJob({ company: firstName, companyKey: historicalKey }));
    expect(canonicalCompanyKeyForJob({ company: firstName, companyKey: historicalKey }))
      .toBe((await import('../scripts/lib/company-key.mjs')).normalizeCompanyKey(firstName));
  });

  it('batches short companies, keeps large companies separate, and preserves company rows', async () => {
    const { buildCompanyExecutionGroups, SMALL_COMPANY_JOB_LIMIT } = await import('../scripts/relocalize-pending-jobs.mjs');
    const orderedCompanyKeys = ['short-first', 'large', 'short-later', 'large-later'];
    const companyJobCounts = new Map([
      ['short-first', SMALL_COMPANY_JOB_LIMIT],
      ['large', SMALL_COMPANY_JOB_LIMIT + 1],
      ['short-later', 1],
      ['large-later', 9],
    ]);

    const invocations = buildCompanyExecutionGroups(orderedCompanyKeys, companyJobCounts);

    expect(invocations).toEqual([
      ['short-first', 'short-later'],
      ['large'],
      ['large-later'],
    ]);

    const diagnosticRows = invocations.flatMap((companyKeys) => companyKeys.map((companyKey) => ({
      companyKey,
      jobs: companyJobCounts.get(companyKey),
      invocationCompanyKeys: companyKeys,
    })));
    expect(diagnosticRows).toEqual([
      {
        companyKey: 'short-first',
        jobs: 4,
        invocationCompanyKeys: ['short-first', 'short-later'],
      },
      {
        companyKey: 'short-later',
        jobs: 1,
        invocationCompanyKeys: ['short-first', 'short-later'],
      },
      {
        companyKey: 'large',
        jobs: 5,
        invocationCompanyKeys: ['large'],
      },
      {
        companyKey: 'large-later',
        jobs: 9,
        invocationCompanyKeys: ['large-later'],
      },
    ]);
  });

  it('advances only companies actually consumed by a batch, including sterile work', async () => {
    runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'company-batching-artifact-'));
    process.env.RUNNER_TEMP = runnerTemp;
    process.env.TRANSLATION_THINKING_AB = '1';

    let jobs = [
      {
        company: 'Served Company',
        companyKey: 'served-company',
        slug: 'served-job',
        title: 'Receptionist',
        description: 'x'.repeat(160),
        needsRetranslation: true,
        titleByLocale: {},
        descriptionByLocale: {},
      },
      {
        company: 'Unserved Company',
        companyKey: 'unserved-company',
        slug: 'unserved-job',
        title: 'Accountant',
        description: 'y'.repeat(160),
        needsRetranslation: true,
        titleByLocale: {},
        descriptionByLocale: {},
      },
    ];
    let ledger = {
      run: 0,
      companies: {
        'unserved-company': { sterile: 1 },
      },
    };
    let tempLedgerBytes = '';
    let crawlerCompanyKeys = '';

    const originalExistsSync = fs.existsSync.bind(fs);
    const originalReadFileSync = fs.readFileSync.bind(fs);
    const originalWriteFileSync = fs.writeFileSync.bind(fs);
    const originalRenameSync = fs.renameSync.bind(fs);
    const originalUnlinkSync = fs.unlinkSync.bind(fs);
    const isDataPath = (file: fs.PathLike) => {
      const filePath = path.resolve(String(file));
      return filePath === dataRoot || filePath.startsWith(`${dataRoot}${path.sep}`);
    };

    vi.spyOn(fs, 'existsSync').mockImplementation((file) => {
      const filePath = String(file);
      if (filePath === dataJobsPath) return true;
      if (filePath === byCrawlerPath) return false;
      return originalExistsSync(file);
    });
    vi.spyOn(fs, 'readFileSync').mockImplementation((file, options) => {
      const filePath = String(file);
      if (filePath === dataJobsPath) return JSON.stringify(jobs) as never;
      if (filePath === companySkipStatePath) return JSON.stringify(ledger) as never;
      return originalReadFileSync(file, options) as never;
    });
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
      const filePath = String(file);
      if (filePath.startsWith(`${companySkipStatePath}.`)) {
        tempLedgerBytes = String(data);
        return;
      }
      if (isDataPath(file)) throw new Error(`unexpected data write: ${filePath}`);
      return originalWriteFileSync(file, data, options);
    });
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from).startsWith(`${companySkipStatePath}.`) && String(to) === companySkipStatePath) {
        ledger = JSON.parse(tempLedgerBytes);
        return;
      }
      if (isDataPath(from) || isDataPath(to)) {
        throw new Error(`unexpected data rename: ${String(from)} -> ${String(to)}`);
      }
      return originalRenameSync(from, to);
    });
    vi.spyOn(fs, 'unlinkSync').mockImplementation((file) => {
      if (String(file).startsWith(`${companySkipStatePath}.`)) return;
      if (isDataPath(file)) throw new Error(`unexpected data unlink: ${String(file)}`);
      return originalUnlinkSync(file);
    });

    crawler.runSharedCrawlerPipeline
      .mockImplementationOnce(async () => {
        crawlerCompanyKeys = process.env.JOBS_CRAWLER_COMPANY_KEYS || '';
        return {
          localizationSterileCompanyKeys: ['served-company'],
          localizationAttemptedCompanyKeys: ['unserved-company'],
        };
      })
      .mockImplementationOnce(async () => {
        crawlerCompanyKeys = process.env.JOBS_CRAWLER_COMPANY_KEYS || '';
        return {
          localizationSterileCompanyKeys: [],
          localizationAttemptedCompanyKeys: [],
        };
      });

    vi.resetModules();
    const { runRelocalization } = await import('../scripts/relocalize-pending-jobs.mjs');
    const makePhase = () => ({
      name: 'cascade',
      startedAtMs: null,
      endedAtMs: null,
      deadlineMs: 600000,
      windowMs: null,
      jobsCleared: 0,
      companiesQueued: 0,
      stopReason: 'nothing to relocalize',
    });

    await runRelocalization(makePhase());

    expect(crawler.runSharedCrawlerPipeline).toHaveBeenCalledTimes(1);
    expect(crawlerCompanyKeys).toBe('served-company,unserved-company');
    expect(ledger.companies['served-company'].sterile).toBe(1);
    expect(ledger.companies['unserved-company']).toEqual({ sterile: 1 });

    const artifact = JSON.parse(
      fs.readFileSync(path.join(runnerTemp, 'translation-thinking-ab.json'), 'utf8'),
    );
    const rowsByCompany = Object.fromEntries(
      artifact.rows.map((row: { companyKey: string }) => [row.companyKey, row]),
    );
    expect(Object.keys(rowsByCompany['served-company']).sort()).toEqual([
      'arm',
      'attempted',
      'cleared',
      'companyKey',
      'companyServed',
      'elapsedMs',
      'invocationCompanyKeys',
      'jobCount',
    ].sort());
    expect(rowsByCompany['served-company'].companyServed).toBe(true);
    expect(rowsByCompany['served-company'].cleared).toBe(0);
    // Effective work is visible in the artifact, but it must not advance the
    // sterile ledger when no flags were cleared.
    expect(rowsByCompany['unserved-company'].companyServed).toBe(true);

    // A singleton with no crawler coverage is also unserved: cardinality alone
    // must never advance its ledger entry.
    jobs = [jobs[1]];
    await runRelocalization(makePhase());

    expect(crawler.runSharedCrawlerPipeline).toHaveBeenCalledTimes(2);
    expect(crawlerCompanyKeys).toBe('unserved-company');
    expect(ledger.companies['unserved-company']).toEqual({ sterile: 1 });
  });

  it('il retry non riprende un azienda saltata e usa i conteggi completi', async () => {
    process.env.RELOCALIZE_MAX_JOBS = '8';
    const pendingJob = (companyKey: string, index: number) => ({
      company: companyKey,
      companyKey,
      slug: `${companyKey}-${index}`,
      title: `Pending job ${index}`,
      description: `Source description ${'source '.repeat(40)}`,
      sourceLang: 'it',
      firstSeenAt: '2026-09-01T00:00:00.000Z',
      needsRetranslation: true,
      titleByLocale: {},
      descriptionByLocale: {},
    });
    const jobs = [
      pendingJob('success-company', 0),
      ...Array.from({ length: 5 }, (_, index) => pendingJob('large-company', index)),
      pendingJob('short-company', 0),
      pendingJob('skipped-company', 0),
    ];
    let ledger: Record<string, unknown> = {
      run: 0,
      companies: {
        'skipped-company': { sterile: 0, skipUntilRun: 5 },
      },
    };
    const crawlerCalls: string[] = [];
    let tempJobsBytes = '';
    let tempLedgerBytes = '';

    const completeJobs = (companyKey: string, limit: number) => {
      const titleByLocale = {
        it: 'Titolo del lavoro',
        en: 'Job title',
        de: 'Arbeitstitel',
        fr: 'Titre du poste',
      };
      const descriptionByLocale = {
        it: `Descrizione italiana ${'contenuto '.repeat(40)}`,
        en: `English description ${'content '.repeat(40)}`,
        de: `Deutsche Beschreibung ${'Inhalt '.repeat(40)}`,
        fr: `Description française ${'contenu '.repeat(40)}`,
      };
      let completed = 0;
      for (const job of jobs) {
        if (job.companyKey !== companyKey || !job.needsRetranslation || completed >= limit) continue;
        job.titleByLocale = { ...titleByLocale };
        job.descriptionByLocale = { ...descriptionByLocale };
        completed += 1;
      }
    };

    const originalExistsSync = fs.existsSync.bind(fs);
    const originalReadFileSync = fs.readFileSync.bind(fs);
    const originalWriteFileSync = fs.writeFileSync.bind(fs);
    const originalRenameSync = fs.renameSync.bind(fs);
    const originalUnlinkSync = fs.unlinkSync.bind(fs);
    const isDataPath = (file: fs.PathLike) => {
      const filePath = path.resolve(String(file));
      return filePath === dataRoot || filePath.startsWith(`${dataRoot}${path.sep}`);
    };

    vi.spyOn(fs, 'existsSync').mockImplementation((file) => {
      const filePath = String(file);
      if (filePath === dataJobsPath) return true;
      if (filePath === byCrawlerPath) return false;
      return originalExistsSync(file);
    });
    vi.spyOn(fs, 'readFileSync').mockImplementation((file, options) => {
      const filePath = String(file);
      if (filePath === dataJobsPath) return JSON.stringify(jobs) as never;
      if (filePath === popularityPath) return '{}' as never;
      if (filePath === companySkipStatePath) return JSON.stringify(ledger) as never;
      return originalReadFileSync(file, options) as never;
    });
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
      const filePath = String(file);
      if (filePath.startsWith(`${dataJobsPath}.`)) {
        tempJobsBytes = String(data);
        return;
      }
      if (filePath.startsWith(`${companySkipStatePath}.`)) {
        tempLedgerBytes = String(data);
        return;
      }
      if (isDataPath(file)) throw new Error(`unexpected data write: ${filePath}`);
      return originalWriteFileSync(file, data, options);
    });
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      const fromPath = String(from);
      const toPath = String(to);
      if (fromPath.startsWith(`${dataJobsPath}.`) && toPath === dataJobsPath) {
        const nextJobs = JSON.parse(tempJobsBytes);
        jobs.splice(0, jobs.length, ...nextJobs);
        return;
      }
      if (fromPath.startsWith(`${companySkipStatePath}.`) && toPath === companySkipStatePath) {
        ledger = JSON.parse(tempLedgerBytes);
        return;
      }
      if (isDataPath(from) || isDataPath(to)) {
        throw new Error(`unexpected data rename: ${fromPath} -> ${toPath}`);
      }
      return originalRenameSync(from, to);
    });
    vi.spyOn(fs, 'unlinkSync').mockImplementation((file) => {
      const filePath = String(file);
      if (filePath.startsWith(`${dataJobsPath}.`) || filePath.startsWith(`${companySkipStatePath}.`)) return;
      if (isDataPath(file)) throw new Error(`unexpected data unlink: ${filePath}`);
      return originalUnlinkSync(file);
    });

    crawler.runSharedCrawlerPipeline.mockImplementation(async () => {
      const keys = (process.env.JOBS_CRAWLER_COMPANY_KEYS || '').split(',').filter(Boolean);
      crawlerCalls.push(keys.join(','));
      if (crawlerCalls.length === 1) completeJobs('success-company', 1);
      if (crawlerCalls.length === 2) completeJobs('large-company', 4);
      return { localizationCoveredCompanyKeys: keys };
    });

    vi.resetModules();
    const { runRelocalization } = await import('../scripts/relocalize-pending-jobs.mjs');
    const phase = {
      name: 'cascade',
      startedAtMs: null,
      endedAtMs: null,
      deadlineMs: 600000,
      windowMs: null,
      jobsCleared: 0,
      companiesQueued: 0,
      stopReason: 'nothing to relocalize',
    };

    await runRelocalization(phase);

    expect(crawlerCalls).toEqual([
      'success-company,short-company',
      'large-company',
      'large-company',
      'short-company',
    ]);
    expect(crawlerCalls.join('|')).not.toContain('skipped-company');
    expect(ledger.companies['skipped-company']).toEqual({ sterile: 0, skipUntilRun: 5 });
  });
});
