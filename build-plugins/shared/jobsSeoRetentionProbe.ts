import { logBuildMem, type BuildMemDetails } from './buildMemLog';

export const JOBS_SEO_RETENTION_PROBE_ENV = 'JOBS_SEO_RETENTION_PROBE';
export const JOBS_SEO_GCFREED_PROBE_ENV = 'JOBS_SEO_GCFREED_PROBE';

export const JOBS_SEO_RETENTION_PROBE_CANDIDATES = [
  'careClusterPartition',
  'locationPartition',
] as const;

export const JOBS_SEO_GCFREED_PROBE_CANDIDATES = [
  'jobsByToken',
  'jobCityTokens',
  'emittedEmployerProfilesBySlug',
  'emittedEmployerHubs',
  'companySlugMap',
] as const;

export type JobsSeoRetentionProbeCandidate = (typeof JOBS_SEO_RETENTION_PROBE_CANDIDATES)[number];
export type JobsSeoGcFreedProbeCandidate = (typeof JOBS_SEO_GCFREED_PROBE_CANDIDATES)[number];

export type GcFreedProbeLogFields = {
  candidate: string;
  gcFreed: number;
};

/**
 * Opt-in selector: empty keeps the default path, a listed name activates
 * exactly one candidate, and comma-separated or unknown values fail loudly.
 */
export function selectGcFreedProbeCandidate<T extends string>(
  value: string | undefined,
  candidates: readonly T[],
  envName = JOBS_SEO_GCFREED_PROBE_ENV,
): T | null {
  const candidate = value?.trim() ?? '';
  if (!candidate) return null;
  if (candidate.includes(',') || !candidates.includes(candidate as T)) {
    throw new Error(
      `${envName} must name exactly one supported candidate `
      + `(${candidates.join(', ')}); received ${JSON.stringify(candidate)}`,
    );
  }
  return candidate as T;
}

/**
 * An empty value preserves the production release plan. A probe run may name
 * exactly one candidate; comma-separated or unknown values fail loudly rather
 * than producing a measurement whose release plan is ambiguous.
 */
export function parseJobsSeoRetentionProbe(value: string | undefined): JobsSeoRetentionProbeCandidate | null {
  return selectGcFreedProbeCandidate(
    value,
    JOBS_SEO_RETENTION_PROBE_CANDIDATES,
    JOBS_SEO_RETENTION_PROBE_ENV,
  );
}

export function parseJobsSeoGcFreedProbe(value: string | undefined): JobsSeoGcFreedProbeCandidate | null {
  return selectGcFreedProbeCandidate(
    value,
    JOBS_SEO_GCFREED_PROBE_CANDIDATES,
    JOBS_SEO_GCFREED_PROBE_ENV,
  );
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

/**
 * Extra retainers are not part of the default corpus-release. Probe mode
 * returns exactly one name so a deploy can attribute gcFreed to that clear.
 */
export function extraGcFreedProbeReleases(
  probe: JobsSeoGcFreedProbeCandidate | null,
): JobsSeoGcFreedProbeCandidate[] {
  return probe === null ? [] : [probe];
}

export function gcFreedProbeLogFields(
  candidate: string | null,
  gcFreed: number,
): GcFreedProbeLogFields {
  return { candidate: candidate ?? 'none', gcFreed };
}

export function logGcFreedProbeCheckpoint(
  candidate: string | null,
  collector?: unknown,
  details?: BuildMemDetails,
  label?: string,
): GcFreedProbeLogFields {
  const checkpointLabel = label ?? (
    candidate === null
      ? 'jobsSeoPages: after corpus-release'
      : `jobsSeoPages: after corpus-release candidate=${candidate}`
  );
  const { gcFreed } = logBuildMem(checkpointLabel, collector, {
    ...details,
    candidate: candidate ?? 'none',
  });
  return gcFreedProbeLogFields(candidate, gcFreed);
}
