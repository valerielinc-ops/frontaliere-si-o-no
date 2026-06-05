import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error — JS module without types
import { runStandardCrawlerPipeline } from '../scripts/lib/crawler-template.mjs';

/**
 * A transient network failure during fetch must NOT hard-fail the run (that
 * opens a noisy per-run "Crawler Failure" issue while the source is fine minutes
 * later). It should keep the existing slice and return cleanly. Structural
 * errors must still propagate so a genuine bug surfaces.
 */
describe('runStandardCrawlerPipeline transient-fetch handling', () => {
  let root: string;
  const COMPANY_KEY = 'acme-test';
  const existingJob = {
    id: 'acme-test-1',
    slug: 'existing-role-acme',
    company: 'Acme Test',
    companyKey: COMPANY_KEY,
    title: 'Existing Role',
    url: 'https://acme.example/jobs/existing',
    postedDate: '2026-06-01',
  };
  const isCompanyJob = (job: any) => job?.companyKey === COMPANY_KEY;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-tpl-'));
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'data', 'jobs.json'),
      `${JSON.stringify([existingJob], null, 2)}\n`,
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const baseConfig = (fetchJobs: () => Promise<any[]>) => ({
    companyKey: COMPANY_KEY,
    companyLabel: 'Acme Test',
    root,
    fetchJobs,
    isCompanyJob,
  });

  it('keeps the existing slice and does not throw on a transient fetch failure', async () => {
    const fetchJobs = async () => {
      throw new Error('Failed to fetch https://acme.example/search: fetch failed');
    };
    await expect(runStandardCrawlerPipeline(baseConfig(fetchJobs))).resolves.toBeUndefined();
    const after = JSON.parse(fs.readFileSync(path.join(root, 'data', 'jobs.json'), 'utf-8'));
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe('acme-test-1');
  });

  it('re-throws a structural (non-transient) error', async () => {
    const fetchJobs = async () => {
      throw new TypeError("Cannot read properties of undefined (reading 'title')");
    };
    await expect(runStandardCrawlerPipeline(baseConfig(fetchJobs))).rejects.toThrow(
      /Cannot read properties/,
    );
  });
});