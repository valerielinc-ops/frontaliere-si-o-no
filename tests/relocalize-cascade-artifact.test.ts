import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const crawler = vi.hoisted(() => ({
  runSharedCrawlerPipeline: vi.fn(),
}));

vi.mock('../scripts/lib/shared-jobs-crawler.mjs', () => crawler);

const root = path.resolve('.');
const dataRoot = path.join(root, 'data');
const dataJobsPath = path.join(root, 'data', 'jobs.json');
const popularityPath = path.join(root, 'data', 'job-popularity.json');
const companySkipStatePath = path.join(root, 'data', 'cascade-company-skip.json');
const byCrawlerPath = path.join(root, 'data', 'jobs', 'by-crawler');

const envKeys = [
  'GITHUB_RUN_ID',
  'GITHUB_RUN_ATTEMPT',
  'JOBS_CASCADE_DEADLINE_MS',
  'RELOCALIZE_ALLOW_NO_TRAFFIC',
  'RELOCALIZE_DRY_RUN',
  'RELOCALIZE_MAX_JOBS',
  'RUNNER_TEMP',
  'TRANSLATION_THINKING_AB',
];

let runnerTemp = '';
let previousEnv: Record<string, string | undefined> = {};
let crawlerCompanyKeys = '';

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of envKeys) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
  previousEnv = {};
  crawlerCompanyKeys = '';
  crawler.runSharedCrawlerPipeline.mockReset();
  if (runnerTemp) fs.rmSync(runnerTemp, { recursive: true, force: true });
  runnerTemp = '';
});

describe('cascade company artifact', () => {
  it('publishes the in-progress phase before the first crawler call', () => {
    const runtime = fs.readFileSync(path.join(root, 'scripts/relocalize-pending-jobs.mjs'), 'utf8');
    const active = runtime.indexOf('phase.stopReason = window.stopReason;');
    const recorded = runtime.indexOf('recordRunPhase(phase);', active);
    const loop = runtime.indexOf('for (let executionGroupIndex', active);
    expect(active).toBeGreaterThan(-1);
    expect(recorded).toBeGreaterThan(active);
    expect(recorded).toBeLessThan(loop);
  });

  it('preserves terminal stop reasons when a later step fails', async () => {
    const { markCascadeFailure } = await import('../scripts/relocalize-pending-jobs.mjs');
    const terminal = { stopReason: 'queue exhausted' };
    const active = { stopReason: 'in progress' };
    const initial = { stopReason: 'nothing to relocalize' };

    markCascadeFailure(terminal);
    markCascadeFailure(active);
    markCascadeFailure(initial);

    expect(terminal.stopReason).toBe('queue exhausted');
    expect(active.stopReason).toBe('failed');
    expect(initial.stopReason).toBe('failed');
  });

  it('clamps exhausted windows and labels an incoherent run clock separately', async () => {
    const { computeCascadeWindow } = await import('../scripts/relocalize-pending-jobs.mjs');

    expect(computeCascadeWindow({ nowMs: 91, runStartMs: 1, deadlineMs: 90 }))
      .toEqual({ startedAtMs: 90, windowMs: 0, stopReason: 'cascade deadline' });
    expect(computeCascadeWindow({ nowMs: 1, runStartMs: 91, deadlineMs: 90 }))
      .toEqual({ startedAtMs: 0, windowMs: 90, stopReason: 'clock incoherent' });
  });

  it('emits empty rows with a stop reason when the first company fails', async () => {
    runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-artifact-'));
    previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    Object.assign(process.env, {
      GITHUB_RUN_ID: 'test-run',
      GITHUB_RUN_ATTEMPT: '1',
      JOBS_CASCADE_DEADLINE_MS: '600000',
      RELOCALIZE_ALLOW_NO_TRAFFIC: '1',
      RELOCALIZE_DRY_RUN: '0',
      RELOCALIZE_MAX_JOBS: '1',
      RUNNER_TEMP: runnerTemp,
      TRANSLATION_THINKING_AB: '1',
    });

    const jobs = [{
      company: 'First Company',
      companyKey: 'first-company',
      slug: 'first-job',
      title: 'Receptionist',
      description: 'x'.repeat(160),
      needsRetranslation: true,
      titleByLocale: {},
      descriptionByLocale: {},
    }];

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
      if (filePath === companySkipStatePath) return '{"run":0,"companies":{}}' as never;
      return originalReadFileSync(file, options) as never;
    });
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
      if (String(file).startsWith(`${companySkipStatePath}.`)) return;
      if (isDataPath(file)) throw new Error(`unexpected data write: ${String(file)}`);
      return originalWriteFileSync(file, data, options);
    });
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from).startsWith(`${companySkipStatePath}.`) && String(to) === companySkipStatePath) return;
      if (isDataPath(from) || isDataPath(to)) throw new Error(`unexpected data rename: ${String(from)} -> ${String(to)}`);
      return originalRenameSync(from, to);
    });
    vi.spyOn(fs, 'unlinkSync').mockImplementation((file) => {
      if (String(file).startsWith(`${companySkipStatePath}.`)) return;
      if (isDataPath(file)) throw new Error(`unexpected data unlink: ${String(file)}`);
      return originalUnlinkSync(file);
    });

    crawler.runSharedCrawlerPipeline.mockImplementation(async () => {
      crawlerCompanyKeys = process.env.JOBS_CRAWLER_COMPANY_KEYS || '';
      throw new Error('first company failure');
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

    expect(crawler.runSharedCrawlerPipeline).toHaveBeenCalledTimes(1);
    expect(crawlerCompanyKeys).toBe('first-company');
    const artifactPath = path.join(runnerTemp, 'translation-cascade-companies.json');
    expect(fs.existsSync(artifactPath)).toBe(true);
    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    expect(artifact.rows).toEqual([]);
    expect(artifact.cascadeStop).toBe('company failure');
    expect(artifact.companiesQueued).toBe(1);
    expect(artifact.companiesProcessed).toBe(0);
  });
});
