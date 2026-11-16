import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import {
  findStaleFirstAttemptReferences,
  findUploadArtifactStepsWithoutRetry,
  UPLOAD_ARTIFACT_RETRY_ALLOWED,
} from '../scripts/lib/upload-artifact-retry-contract.mjs';

type Step = Record<string, any>;
type Workflow = { jobs: Record<string, { steps?: Step[] }> };

const workflow = YAML.parse(
  readFileSync(new URL('../.github/workflows/deploy-publish.yml', import.meta.url), 'utf8'),
) as Workflow;
const isUpload = (step: Step) => String(step.uses ?? '').startsWith('actions/upload-artifact@');

const originalFirstAttemptNames = [
  'Upload durable R2 OG manifest artifact',
  'Upload IT section group results and ok-markers',
  'Upload shard batch 1 dist for post-deploy validation',
  'Upload shard batch 2 dist for post-deploy validation',
  'Upload shard batch 3 dist for post-deploy validation',
  'Upload shard batch 4 dist for post-deploy validation',
  'Upload shard batch 5 dist for post-deploy validation',
  'Upload shard batch 6 dist for post-deploy validation',
  'Upload IT section content manifest',
  'Upload Pages artifact (compression-level 9)',
  'Upload sitemaps bundle artifact',
  'Upload pre-deploy snapshot for post-deploy validation',
  'Upload dist-size-history + url-first-seen for the history commit',
  'Upload sitemap page manifest for publisher gate',
  'Upload IT publish provenance',
  'Upload shard batch 1 dist for post-deploy validation',
  'Upload shard batch 2 dist for post-deploy validation',
  'Upload shard batch 3 dist for post-deploy validation',
  'Upload shard batch 4 dist for post-deploy validation',
  'Upload shard batch 5 dist for post-deploy validation',
  'Upload shard batch 6 dist for post-deploy validation',
  'Upload non-IT section content manifest',
  'Upload locale shard dist for post-deploy validation',
  'Upload advisory shard push verification report',
  'Upload non-IT locale publish provenance',
];
const originallyNonBlockingUploadNames = [
  'Upload durable R2 OG manifest artifact',
  'Upload shard batch 1 dist for post-deploy validation',
  'Upload shard batch 2 dist for post-deploy validation',
  'Upload shard batch 3 dist for post-deploy validation',
  'Upload shard batch 4 dist for post-deploy validation',
  'Upload shard batch 5 dist for post-deploy validation',
  'Upload shard batch 6 dist for post-deploy validation',
  'Upload dist-size-history + url-first-seen for the history commit',
  'Upload IT publish provenance',
  'Upload shard batch 1 dist for post-deploy validation',
  'Upload shard batch 2 dist for post-deploy validation',
  'Upload shard batch 3 dist for post-deploy validation',
  'Upload shard batch 4 dist for post-deploy validation',
  'Upload shard batch 5 dist for post-deploy validation',
  'Upload shard batch 6 dist for post-deploy validation',
  'Upload locale shard dist for post-deploy validation',
  'Upload advisory shard push verification report',
  'Upload non-IT locale publish provenance',
];
const originallyBlockingUploadNames = [
  'Upload IT section group results and ok-markers',
  'Upload IT section content manifest',
  'Upload Pages artifact (compression-level 9)',
  'Upload sitemaps bundle artifact',
  'Upload pre-deploy snapshot for post-deploy validation',
  'Upload sitemap page manifest for publisher gate',
  'Upload non-IT section content manifest',
];
const originallyNonBlockingUploadNameSet = new Set(originallyNonBlockingUploadNames);
const originallyBlockingUploadNameSet = new Set(originallyBlockingUploadNames);
const expectedRetryNames = new Set(originalFirstAttemptNames.map((name) => `Retry ${name}`));
const sortNames = (names: string[]) => [...names].sort();

describe('deploy-publish.yml artifact upload retry contract', () => {
  it('retries all 25 original uploads without exceptions or stale first-attempt references', () => {
    expect(UPLOAD_ARTIFACT_RETRY_ALLOWED).toEqual([]);
    expect(findUploadArtifactStepsWithoutRetry(workflow, {
      allowed: UPLOAD_ARTIFACT_RETRY_ALLOWED,
    })).toEqual([]);
    expect(findStaleFirstAttemptReferences(workflow)).toEqual([]);

    const uploads = Object.values(workflow.jobs).flatMap((job) => (job.steps ?? []).filter(isUpload));
    const firstAttempts = uploads.filter((step) => !String(step.name ?? '').startsWith('Retry '));
    const retries = Object.values(workflow.jobs)
      .flatMap((job) => job.steps ?? [])
      .filter((step) => expectedRetryNames.has(String(step.name ?? '')));

    expect(uploads).toHaveLength(50);
    expect(firstAttempts).toHaveLength(25);
    expect(retries).toHaveLength(25);
    expect(firstAttempts.map((step) => step.name)).toEqual(originalFirstAttemptNames);

    const retryUploadNames = retries.map((step) => String(step.name).replace(/^Retry /, ''));
    const expectedOriginalNames = [
      ...originallyNonBlockingUploadNames,
      ...originallyBlockingUploadNames,
    ];
    expect(sortNames(expectedOriginalNames)).toEqual(sortNames(originalFirstAttemptNames));
    expect(sortNames(retryUploadNames)).toEqual(sortNames(expectedOriginalNames));

    const nonBlockingRetries = retries.filter((step) =>
      originallyNonBlockingUploadNameSet.has(String(step.name).replace(/^Retry /, '')));
    const blockingRetries = retries.filter((step) =>
      originallyBlockingUploadNameSet.has(String(step.name).replace(/^Retry /, '')));
    expect(nonBlockingRetries).toHaveLength(18);
    expect(nonBlockingRetries.every((step) => step['continue-on-error'] === true)).toBe(true);
    expect(blockingRetries).toHaveLength(7);
    for (const retry of blockingRetries) {
      expect(retry).not.toHaveProperty('continue-on-error');
    }
  });

  it('keeps retry IDs unique per job and retry steps as upload-artifact actions without run blocks', () => {
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      const steps = job.steps ?? [];
      const jobIds = steps.map((step) => step.id).filter((id) => typeof id === 'string');
      expect(new Set(jobIds).size, jobName + ' step ids must be unique').toBe(jobIds.length);

      const firstAttempts = steps.filter((step) => isUpload(step)
        && !String(step.name ?? '').startsWith('Retry '));
      const firstIds = firstAttempts.map((step) => step.id);
      expect(firstIds.every((id) => typeof id === 'string' && id.trim().length > 0), jobName)
        .toBe(true);
      expect(new Set(firstIds).size, jobName + ' first-attempt upload ids must be unique')
        .toBe(firstIds.length);

      const retries = steps.filter((step) => expectedRetryNames.has(String(step.name ?? '')));
      expect(retries.every(isUpload), jobName + ' artifact retry steps must use upload-artifact')
        .toBe(true);
      const retryIds = retries.map((step) => step.id);
      expect(retryIds.every((id) => typeof id === 'string' && id.trim().length > 0), jobName)
        .toBe(true);
      expect(new Set(retryIds).size, jobName + ' retry ids must be unique')
        .toBe(retryIds.length);

      for (const retry of retries) {
        const index = steps.indexOf(retry);
        const firstAttempt = steps[index - 1];
        expect(isUpload(firstAttempt), retry.name + ' must immediately follow its first attempt')
          .toBe(true);
        expect(isUpload(retry), retry.name + ' must use upload-artifact').toBe(true);
        expect(retry.id).toBe(firstAttempt.id + '-retry');
        expect(String(retry.uses)).toMatch(/^actions\/upload-artifact@/);
        expect(retry).not.toHaveProperty('run');

        const originalName = String(retry.name).replace(/^Retry /, '');
        if (originallyNonBlockingUploadNameSet.has(originalName)) {
          expect(retry['continue-on-error']).toBe(true);
        } else {
          expect(originallyBlockingUploadNameSet.has(originalName)).toBe(true);
          expect(retry).not.toHaveProperty('continue-on-error');
        }
      }
    }
  });

  it('keeps every upload retry condition free of mixed expression delimiters', () => {
    const retrySteps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? [])
      .filter((step) => String(step.name ?? '').startsWith('Retry Upload '));
    for (const retry of retrySteps) {
      const retryIf = String(retry.if ?? '');
      expect(retryIf, retry.name + ' must not mix ${{ }} with surrounding if text')
        .not.toContain('${{');
    }
  });

  it('keeps every upload retry condition free of its own step ID', () => {
    const retrySteps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? [])
      .filter((step) => String(step.name ?? '').startsWith('Retry Upload '));
    for (const retry of retrySteps) {
      const retryIf = String(retry.if ?? '');
      if (typeof retry.id === 'string') {
        expect(retryIf, retry.name + ' must not refer to its own step id')
          .not.toContain(`steps.${retry.id}.`);
      }
    }
  });

  it('keeps upload artifact IDs unique across all jobs', () => {
    const allSteps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);
    const uploadIds = allSteps.filter(isUpload).map((step) => step.id);
    expect(uploadIds.every((id) => typeof id === 'string' && id.trim().length > 0)).toBe(true);
    expect(new Set(uploadIds).size).toBe(uploadIds.length);
  });
});
