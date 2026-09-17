import { createHash } from 'node:crypto';

import { stableJobId } from './incrementalManifest.mjs';

export const JOBS_SEO_SAMPLE_ENV = 'JOBS_SEO_SAMPLE';
export const BUILD_BENCH_ENV = 'BUILD_BENCH';

const SAMPLE_BUCKETS = 1_000_000;

/** Parse the optional benchmark fraction without changing the unset path. */
export function parseJobsSeoSample(raw: string | null | undefined): number | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;

  const fraction = Number(value);
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
    throw new Error(
      `${JOBS_SEO_SAMPLE_ENV} must be a fraction between 0 and 1; received ${JSON.stringify(value)}`,
    );
  }
  return fraction;
}

export function assertJobsSeoSampleAllowed({
  fraction,
  githubRef,
  buildBench,
}: {
  fraction: number | null;
  githubRef?: string;
  buildBench?: string;
}): void {
  if (
    fraction !== null
    && githubRef === 'refs/heads/main'
    && buildBench !== '1'
  ) {
    throw new Error(
      `[jobs-seo-sample] ${JOBS_SEO_SAMPLE_ENV} is blocked on refs/heads/main `
      + `unless ${BUILD_BENCH_ENV}=1 (benchmark workflow only)`,
    );
  }
}

export function resolveJobsSeoSample(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number | null {
  const fraction = parseJobsSeoSample(env[JOBS_SEO_SAMPLE_ENV]);
  assertJobsSeoSampleAllowed({
    fraction,
    githubRef: env.GITHUB_REF,
    buildBench: env[BUILD_BENCH_ENV],
  });
  return fraction;
}

function sampleBucket(job: Record<string, unknown>): number {
  const digest = createHash('sha256')
    .update(stableJobId(job), 'utf8')
    .digest();
  return digest.readUInt32BE(0) % SAMPLE_BUCKETS;
}

/** Select the same stable job subset for every derived jobs-SEO emitter. */
export function selectJobsSeoSample<T extends Record<string, unknown>>(
  jobs: ReadonlyArray<T>,
  fraction: number,
): T[] {
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
    throw new Error(`jobs SEO sample fraction must be between 0 and 1; received ${fraction}`);
  }
  const cutoff = Math.floor(fraction * SAMPLE_BUCKETS);
  return jobs.filter((job) => sampleBucket(job) < cutoff);
}
