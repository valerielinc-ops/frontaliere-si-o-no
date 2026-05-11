import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DIST = path.resolve(__dirname, '../../dist');

describe('job-detail URLs route per job.canton (Phase 1)', () => {
  it('a Zurich job in jobs.json emits at /cerca-lavoro-zurigo/<slug>/', () => {
    if (!fs.existsSync(DIST)) return;
    const jobsPath = path.resolve(__dirname, '../../data/jobs.json');
    if (!fs.existsSync(jobsPath)) return;
    const jobs = JSON.parse(fs.readFileSync(jobsPath, 'utf8'));
    const zhJob = jobs.find((j: { canton?: string }) => j.canton === 'ZH');
    if (!zhJob) return; // skip if dataset has no ZH job
    const slug = zhJob.slugByLocale?.it || zhJob.slug;
    expect(fs.existsSync(path.join(DIST, 'cerca-lavoro-zurigo', slug, 'index.html'))).toBe(true);
    expect(fs.existsSync(path.join(DIST, 'cerca-lavoro-ticino', slug, 'index.html'))).toBe(false);
  });

  it('a Lugano job stays at /cerca-lavoro-ticino/<slug>/ (TI invariance)', () => {
    if (!fs.existsSync(DIST)) return;
    const jobsPath = path.resolve(__dirname, '../../data/jobs.json');
    if (!fs.existsSync(jobsPath)) return;
    const jobs = JSON.parse(fs.readFileSync(jobsPath, 'utf8'));
    const tiJob = jobs.find(
      (j: { canton?: string; location?: string }) =>
        j.canton === 'TI' || /lugano|mendrisio|bellinzona/i.test(j.location || ''),
    );
    if (!tiJob) return;
    const slug = tiJob.slugByLocale?.it || tiJob.slug;
    expect(fs.existsSync(path.join(DIST, 'cerca-lavoro-ticino', slug, 'index.html'))).toBe(true);
  });
});
