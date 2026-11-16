import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import {
  findStaleFirstAttemptReferences,
  findUploadArtifactStepsWithoutRetry,
} from '../scripts/lib/upload-artifact-retry-contract.mjs';

const artifact = (name = 'Upload sample artifact', id = 'upload-sample', withValues = {}) => ({
  name,
  id,
  'continue-on-error': true,
  uses: 'actions/upload-artifact@v7',
  with: { name: 'sample-${{ github.run_id }}', path: 'dist/sample.json', ...withValues },
});

const retry = (id = 'upload-sample', withValues = {}, ifValue = `steps.${id}.outcome == 'failure'`) => ({
  name: 'Retry upload sample artifact',
  id: `${id}-retry`,
  if: ifValue,
  uses: 'actions/upload-artifact@v7',
  with: { name: 'sample-${{ github.run_id }}', path: 'dist/sample.json', ...withValues, overwrite: true },
});

const workflow = (...steps: Array<Record<string, unknown>>) => ({ jobs: { build: { steps } } });

describe('deploy.yml artifact upload retry contract', () => {
  it('covers every upload-artifact step in deploy.yml', () => {
    const doc = YAML.parse(readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8'));
    expect(findUploadArtifactStepsWithoutRetry(doc)).toEqual([]);
    const retries = Object.values(doc.jobs).flatMap((job: any) => job.steps)
      .filter((step: any) => step.name?.startsWith('Retry ') && step.uses?.startsWith('actions/upload-artifact@'));
    const retryIds = retries.map((step: any) => step.id);
    expect(retryIds.every((id: unknown) => typeof id === 'string' && id.trim())).toBe(true);
    expect(new Set(retryIds).size).toBe(retryIds.length);
  });

  it('routes every first-attempt consumer in deploy.yml through its effective retry result', () => {
    const doc = YAML.parse(readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8'));
    expect(findStaleFirstAttemptReferences(doc)).toEqual([]);
  });

  it('reports a direct first-attempt outcome reference outside the retry', () => {
    const consumer = {
      name: 'Read upload result',
      env: { RESULT: '${{ steps.upload-sample-retry.outcome }}; ${{ steps.upload-sample.outcome }}' },
    };
    expect(findStaleFirstAttemptReferences(workflow(artifact(), retry(), consumer))).toMatchObject([
      {
        job: 'build',
        stepName: 'Upload sample artifact',
        expression: '${{ steps.upload-sample.outcome }}',
      },
    ]);
  });

  it('accepts an outcome routed through the retry result', () => {
    const consumer = {
      name: 'Read effective upload result',
      env: {
        RESULT: "${{ steps.upload-sample-retry.outcome == 'success' && 'success' || steps.upload-sample.outcome }}",
      },
    };
    expect(findStaleFirstAttemptReferences(workflow(artifact(), retry(), consumer))).toEqual([]);
  });

  it('accepts a digest selected from the retry before the first attempt', () => {
    const consumer = {
      name: 'Read effective upload digest',
      env: {
        DIGEST: '${{ steps.upload-sample-retry.outputs.artifact-digest || steps.upload-sample.outputs.artifact-digest }}',
      },
    };
    expect(findStaleFirstAttemptReferences(workflow(artifact(), retry(), consumer))).toEqual([]);
  });

  it('does not report the retry condition that checks the first attempt', () => {
    expect(findStaleFirstAttemptReferences(workflow(artifact(), retry()))).toEqual([]);
  });

  it('reports an unrouted first-attempt reference in job outputs', () => {
    const doc = {
      jobs: {
        build: {
          outputs: { result: '${{ steps.upload-sample.outcome }}' },
          steps: [artifact(), retry()],
        },
      },
    };
    expect(findStaleFirstAttemptReferences(doc)).toMatchObject([
      {
        job: 'build',
        stepName: 'Upload sample artifact',
        expression: '${{ steps.upload-sample.outcome }}',
      },
    ]);
  });

  it('routes the sitemap bind gate, digest, and source provenance through the locale-source retry', () => {
    const doc = YAML.parse(readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8'));
    const steps = doc.jobs['build-locale'].steps;
    const retryStep = steps.find(({ id }) => id === 'upload-locale-source-retry');
    const bindStep = steps.find(({ id }) => id === 'bind-sitemap-page-manifest');
    const provenanceStep = steps.find(({ id }) => id === 'write-locale-provenance');

    expect(retryStep).toBeDefined();
    expect(bindStep.if).toContain('steps.upload-locale-source.outcome');
    expect(bindStep.if).toContain(`steps.${retryStep.id}.outcome`);
    expect(bindStep.env.BASE_ARTIFACT_DIGEST).toContain('steps.upload-locale-source.outputs.artifact-digest');
    expect(bindStep.env.BASE_ARTIFACT_DIGEST).toContain(`steps.${retryStep.id}.outputs.artifact-digest`);
    expect(provenanceStep.env.PROVENANCE_SOURCE_ARTIFACT_OUTCOME).toContain('steps.upload-locale-source.outcome');
    expect(provenanceStep.env.PROVENANCE_SOURCE_ARTIFACT_OUTCOME).toContain(`steps.${retryStep.id}.outcome`);
  });

  it('accepts a matching first attempt and retry pair', () => {
    expect(findUploadArtifactStepsWithoutRetry(workflow(artifact(), retry()))).toEqual([]);
  });

  it('reports an upload with no retry step', () => {
    expect(findUploadArtifactStepsWithoutRetry(workflow(artifact()))).toMatchObject([
      { stepName: 'Upload sample artifact', reason: 'no retry step follows' },
    ]);
  });

  it('reports a retry whose path differs', () => {
    expect(findUploadArtifactStepsWithoutRetry(workflow(artifact(), retry('upload-sample', { path: 'dist/other.json' })))[0].reason)
      .toBe('retry with.path differs');
  });

  it('reports a retry without overwrite enabled', () => {
    const retryWithoutOverwrite = {
      ...retry(),
      with: { name: 'sample-${{ github.run_id }}', path: 'dist/sample.json' },
    };
    expect(findUploadArtifactStepsWithoutRetry(workflow(artifact(), retryWithoutOverwrite))[0].reason)
      .toBe('retry lacks overwrite: true');
  });

  it('requires the retry to inherit the first attempt condition', () => {
    const first = { ...artifact(), if: 'always() && X' };
    expect(findUploadArtifactStepsWithoutRetry(workflow(first, retry('upload-sample', {}, "steps.upload-sample.outcome == 'failure'")))[0].reason)
      .toBe('first attempt if not inherited');
  });

  it('accepts the existing unparenthesized always condition form', () => {
    const first = { ...artifact(), if: 'always() && X' };
    const existingForm = retry('upload-sample', {}, "always() && X && steps.upload-sample.outcome == 'failure'");
    expect(findUploadArtifactStepsWithoutRetry(workflow(first, existingForm))).toEqual([]);
  });

  it('accepts a retry condition that wraps the inherited condition in parentheses', () => {
    const first = { ...artifact(), if: 'always() && X' };
    const parenthesizedForm = retry('upload-sample', {}, "( always() && X ) && steps.upload-sample.outcome == 'failure'");
    expect(findUploadArtifactStepsWithoutRetry(workflow(first, parenthesizedForm))).toEqual([]);
  });

  it('allows only exceptions with a nonempty reason', () => {
    const doc = workflow(artifact());
    expect(findUploadArtifactStepsWithoutRetry(doc, {
      allowed: [{ job: 'build', stepName: 'Upload sample artifact', reason: 'intentional owner exception' }],
    })).toEqual([]);
    expect(findUploadArtifactStepsWithoutRetry(doc, {
      allowed: [{ job: 'build', stepName: 'Upload sample artifact', reason: '   ' }],
    })[0].reason).toBe('no retry step follows');
  });

  it('does not let consecutive uploads exchange their retries', () => {
    const first = artifact('Upload first artifact', 'upload-first', { name: 'first', path: 'dist/first.json' });
    const retryForSecond = {
      ...retry('upload-second', { name: 'second', path: 'dist/second.json' }),
      name: 'Retry second artifact',
    };
    const second = artifact('Upload second artifact', 'upload-second', { name: 'second', path: 'dist/second.json' });
    const retryForFirst = {
      ...retry('upload-first', { name: 'first', path: 'dist/first.json' }),
      name: 'Retry first artifact',
    };

    expect(findUploadArtifactStepsWithoutRetry(workflow(first, retryForSecond, second, retryForFirst)).map(({ stepName, reason }) => ({ stepName, reason })))
      .toEqual([
        { stepName: 'Upload first artifact', reason: 'retry if does not reference steps.upload-first.outcome' },
        { stepName: 'Upload second artifact', reason: 'retry if does not reference steps.upload-second.outcome' },
      ]);
  });
});
