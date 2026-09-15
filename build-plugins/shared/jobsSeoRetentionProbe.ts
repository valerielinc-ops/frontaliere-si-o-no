export const JOBS_SEO_RETENTION_PROBE_ENV = 'JOBS_SEO_RETENTION_PROBE';

export const JOBS_SEO_RETENTION_PROBE_CANDIDATES = [
  'careClusterPartition',
  'locationPartition',
] as const;

export type JobsSeoRetentionProbeCandidate = (typeof JOBS_SEO_RETENTION_PROBE_CANDIDATES)[number];

/**
 * An empty value preserves the production release plan. A probe run may name
 * exactly one candidate; comma-separated or unknown values fail loudly rather
 * than producing a measurement whose release plan is ambiguous.
 */
export function parseJobsSeoRetentionProbe(value: string | undefined): JobsSeoRetentionProbeCandidate | null {
  const candidate = value?.trim() ?? '';
  if (!candidate) return null;
  if (!JOBS_SEO_RETENTION_PROBE_CANDIDATES.includes(candidate as JobsSeoRetentionProbeCandidate)) {
    throw new Error(
      `${JOBS_SEO_RETENTION_PROBE_ENV} must name exactly one supported candidate `
      + `(${JOBS_SEO_RETENTION_PROBE_CANDIDATES.join(', ')}); received ${JSON.stringify(candidate)}`,
    );
  }
  return candidate as JobsSeoRetentionProbeCandidate;
}

/**
 * In the default build every confirmed candidate is released. In probe mode,
 * release only the selected candidate so its incremental gcFreed is visible.
 */
export function shouldReleaseJobsSeoRetentionCandidate(
  probe: JobsSeoRetentionProbeCandidate | null,
  candidate: JobsSeoRetentionProbeCandidate,
): boolean {
  return probe === null || probe === candidate;
}

/**
 * Materialize the release plan once so a probe can never accidentally release
 * two candidates. The empty/default plan deliberately contains both entries.
 */
export function jobsSeoRetentionReleasePlan(
  probe: JobsSeoRetentionProbeCandidate | null,
): JobsSeoRetentionProbeCandidate[] {
  return JOBS_SEO_RETENTION_PROBE_CANDIDATES.filter((candidate) =>
    shouldReleaseJobsSeoRetentionCandidate(probe, candidate));
}
