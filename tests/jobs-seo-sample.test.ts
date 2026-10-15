import { describe, expect, it } from 'vitest';
import {
  assertJobsSeoSampleAllowed,
  parseJobsSeoSample,
  resolveJobsSeoSample,
  selectJobsSeoSample,
} from '../build-plugins/shared/jobsSeoSample';

const jobs = Array.from({ length: 64 }, (_, index) => ({
  id: `job-${index + 1}`,
  slug: `job-${index + 1}`,
}));

describe('JOBS_SEO_SAMPLE', () => {
  it('leaves the opt-in unset and rejects values outside 0..1', () => {
    expect(parseJobsSeoSample(undefined)).toBeNull();
    expect(parseJobsSeoSample('')).toBeNull();
    expect(parseJobsSeoSample('0.1')).toBe(0.1);
    expect(() => parseJobsSeoSample('-0.1')).toThrow(/between 0 and 1/);
    expect(() => parseJobsSeoSample('1.1')).toThrow(/between 0 and 1/);
    expect(() => parseJobsSeoSample('not-a-fraction')).toThrow(/between 0 and 1/);
  });

  it('blocks a sample on the production main ref unless the benchmark guard is set', () => {
    expect(() => resolveJobsSeoSample({
      JOBS_SEO_SAMPLE: '0.1',
      GITHUB_REF: 'refs/heads/main',
    })).toThrow(/blocked on refs\/heads\/main/);
    expect(resolveJobsSeoSample({
      JOBS_SEO_SAMPLE: '0.1',
      GITHUB_REF: 'refs/heads/main',
      BUILD_BENCH: '1',
    })).toBe(0.1);
    expect(resolveJobsSeoSample({
      JOBS_SEO_SAMPLE: '0.1',
      GITHUB_REF: 'refs/heads/feature/bench',
    })).toBe(0.1);
  });

  it('enforces the guard at jobsSeoPagesPlugin entry before reading the corpus', async () => {
    const previous = {
      sample: process.env.JOBS_SEO_SAMPLE,
      ref: process.env.GITHUB_REF,
      bench: process.env.BUILD_BENCH,
    };
    process.env.JOBS_SEO_SAMPLE = '0.1';
    process.env.GITHUB_REF = 'refs/heads/main';
    delete process.env.BUILD_BENCH;
    try {
      const { jobsSeoPagesPlugin } = await import('../build-plugins/jobsSeoPagesPlugin');
      const closeBundle = jobsSeoPagesPlugin('/tmp/jobs-seo-sample-guard').closeBundle as () => Promise<unknown>;
      await expect(closeBundle()).rejects.toThrow(/blocked on refs\/heads\/main/);
    } finally {
      if (previous.sample === undefined) delete process.env.JOBS_SEO_SAMPLE;
      else process.env.JOBS_SEO_SAMPLE = previous.sample;
      if (previous.ref === undefined) delete process.env.GITHUB_REF;
      else process.env.GITHUB_REF = previous.ref;
      if (previous.bench === undefined) delete process.env.BUILD_BENCH;
      else process.env.BUILD_BENCH = previous.bench;
    }
  });

  it('uses the same deterministic subset for the same corpus and fraction', () => {
    const first = selectJobsSeoSample(jobs, 0.1).map((job) => job.id);
    const second = selectJobsSeoSample([...jobs].reverse(), 0.1).map((job) => job.id).sort();
    expect(first.slice().sort()).toEqual(second);
  });

  it('selects every active job at fraction 1', () => {
    expect(selectJobsSeoSample(jobs, 1)).toEqual(jobs);
  });

  it('uses the shared selected list and emits the benchmark marker in jobsSeoPagesPlugin', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../build-plugins/jobsSeoPagesPlugin.ts', import.meta.url), 'utf8');
    expect(source).toContain('resolveJobsSeoSample');
    expect(source).toContain('selectJobsSeoSample');
    expect(source).toContain('[jobs-seo-sample] fraction=');
    expect(source).not.toContain('Math.random');
  });

  it('keeps the production guard explicit at the shared resolver boundary', () => {
    expect(() => assertJobsSeoSampleAllowed({
      fraction: 0.1,
      githubRef: 'refs/heads/main',
      buildBench: '0',
    })).toThrow(/BUILD_BENCH=1/);
    expect(() => assertJobsSeoSampleAllowed({
      fraction: 0.1,
      githubRef: 'refs/heads/main',
      buildBench: '1',
    })).not.toThrow();
  });
});
