import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const crawler = vi.hoisted(() => ({
  runSharedCrawlerPipeline: vi.fn(),
}));

vi.mock('../scripts/lib/shared-jobs-crawler.mjs', () => crawler);

const root = path.resolve('.');
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

describe('cascade company artifact', () => {
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
      return originalWriteFileSync(file, data, options);
    });
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from).startsWith(`${companySkipStatePath}.`) && String(to) === companySkipStatePath) return;
      return originalRenameSync(from, to);
    });
    vi.spyOn(fs, 'unlinkSync').mockImplementation((file) => {
      if (String(file).startsWith(`${companySkipStatePath}.`)) return;
      return originalUnlinkSync(file);
    });

    crawler.runSharedCrawlerPipeline.mockRejectedValue(new Error('first company failure'));
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
    const artifactPath = path.join(runnerTemp, 'translation-cascade-companies.json');
    expect(fs.existsSync(artifactPath)).toBe(true);
    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    expect(artifact.rows).toEqual([]);
    expect(artifact.cascadeStop).toEqual(expect.any(String));
    expect(artifact.cascadeStop).not.toBe('');
    expect(artifact.companiesQueued).toBe(1);
    expect(artifact.companiesProcessed).toBe(0);
  });
});
