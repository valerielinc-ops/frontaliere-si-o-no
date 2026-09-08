import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const crawler = vi.hoisted(() => ({
  runSharedCrawlerPipeline: vi.fn(),
}));

vi.mock('../scripts/lib/shared-jobs-crawler.mjs', () => crawler);

const root = path.resolve('.');
const dataRoot = path.join(root, 'data');
const dataJobsPath = path.join(dataRoot, 'jobs.json');
const companySkipStatePath = path.join(dataRoot, 'cascade-company-skip.json');
const byCrawlerPath = path.join(dataRoot, 'jobs', 'by-crawler');

const envKeys = [
  'JOBS_CASCADE_DEADLINE_MS',
  'RELOCALIZE_ALLOW_NO_TRAFFIC',
  'RELOCALIZE_DRY_RUN',
  'RELOCALIZE_MAX_JOBS',
  'TRANSLATION_THINKING_AB',
];

let previousEnv: Record<string, string | undefined> = {};

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
});

describe('relocalize company invocation batching', () => {
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
        return { localizationAttemptedCompanyKeys: ['served-company'] };
      })
      .mockImplementationOnce(async () => {
        crawlerCompanyKeys = process.env.JOBS_CRAWLER_COMPANY_KEYS || '';
        return { localizationAttemptedCompanyKeys: [] };
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

    // A singleton with no crawler coverage is also unserved: cardinality alone
    // must never advance its ledger entry.
    jobs = [jobs[1]];
    await runRelocalization(makePhase());

    expect(crawler.runSharedCrawlerPipeline).toHaveBeenCalledTimes(2);
    expect(crawlerCompanyKeys).toBe('unserved-company');
    expect(ledger.companies['unserved-company']).toEqual({ sterile: 1 });
  });
});
