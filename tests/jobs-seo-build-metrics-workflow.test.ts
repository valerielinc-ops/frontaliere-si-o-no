import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';

const ROOT = resolve(import.meta.dirname, '..');
const DEPLOY_PATH = resolve(ROOT, '.github/workflows/deploy.yml');
const MATRIX_PATH = resolve(ROOT, '.github/workflows/deploy-matrix-experiment.yml');
const DEPLOY_TEXT = readFileSync(DEPLOY_PATH, 'utf8');
const MATRIX_TEXT = readFileSync(MATRIX_PATH, 'utf8');

const EVIDENCE_ISSUE_TITLE = 'la misura full-corpus del build jobs SEO non è verificabile';

describe('jobs SEO full-corpus measurement wiring', () => {
  // The validator certifies the MEASUREMENT (#9618), not the site. While it was
  // fail-closed (#9754) a wrong invariant failed every production deploy (runs
  // 36065965021 and 36077807468): deploy-publish.yml publishes only a
  // `success` run, so any red here switches production off. It now reports a
  // gap through a dedicated issue and never blocks the publish.
  it('runs the evidence validator on the production IT leg without gating the publish', () => {
    const workflow = YAML.parse(DEPLOY_TEXT) as any;
    const steps = workflow.jobs['build-locale'].steps as Array<Record<string, any>>;
    const buildIndex = steps.findIndex((step) => step.id === 'build_step');
    const validatorIndex = steps.findIndex((step) => step.name === 'Validate full-corpus jobs SEO evidence');
    const uploadIndex = steps.findIndex((step) => step.name === 'Upload full-corpus jobs SEO markers');
    const validator = steps[validatorIndex];

    expect(validatorIndex).toBeGreaterThan(buildIndex);
    expect(uploadIndex).toBeGreaterThan(validatorIndex);
    expect(validator.id).toBe('jobs_seo_evidence');
    expect(validator.if).toBe("always() && matrix.locale == 'it'");
    expect(validator['continue-on-error']).toBe(true);
    expect(validator.run).toContain('scripts/ci/report-jobs-seo-build-metrics.mjs');
    expect(validator.run).toContain('--require-full-corpus');
    expect(validator.run).toContain('--markers-out="$JOBS_SEO_MARKERS_OUT"');
    expect(validator.run).toContain('2> "$JOBS_SEO_EVIDENCE_DIAG"');
    expect(validator.run).toContain('exit "$status"');
    expect(validator.env.JOBS_SEO_BUILD_LOG).toBe('/tmp/build.log');
    expect(validator.env.JOBS_SEO_MARKERS_OUT).toContain('${{ runner.temp }}');
    expect(validator.env.JOBS_SEO_EVIDENCE_DIAG).toBe('${{ runner.temp }}/jobs-seo-evidence-diag.txt');
  });

  it('routes an evidence gap on a green build to a self-resolving issue instead of muting it', () => {
    const workflow = YAML.parse(DEPLOY_TEXT) as any;
    const steps = workflow.jobs['build-locale'].steps as Array<Record<string, any>>;
    const validatorIndex = steps.findIndex((step) => step.id === 'jobs_seo_evidence');
    const evidenceSteps = steps.filter((step) => step.with?.title === EVIDENCE_ISSUE_TITLE);
    const report = evidenceSteps.find((step) => (step.with.mode ?? 'report') === 'report');
    const resolve = evidenceSteps.find((step) => step.with.mode === 'resolve');

    expect(evidenceSteps).toHaveLength(2);
    expect(report.uses).toBe('./.github/actions/report-failure');
    expect(resolve.uses).toBe('./.github/actions/report-failure');
    expect(steps.indexOf(report)).toBeGreaterThan(validatorIndex);
    expect(steps.indexOf(resolve)).toBeGreaterThan(validatorIndex);
    expect(report.with['closed-by']).toBe('sibling-resolve-step');
    expect(resolve.with['closed-by']).toBe('sibling-resolve-step');
    // Only a green build: a red one lacks the markers anyway and is already
    // reported as "CI Failure (build)".
    expect(report.if).toContain("steps.build_step.outcome == 'success'");
    expect(report.if).toContain("steps.jobs_seo_evidence.outcome == 'failure'");
    expect(report.with['diag-file']).toBe(steps[validatorIndex].env.JOBS_SEO_EVIDENCE_DIAG);
    expect(resolve.if).toContain("steps.jobs_seo_evidence.outcome == 'success'");

    // Nothing else may read the validator outcome: a later step gating on it
    // would turn the measurement back into a deploy gate.
    const readers = steps.filter((step) => String(step.if ?? '').includes('steps.jobs_seo_evidence.'));
    expect(readers).toEqual([report, resolve]);
  });

  it('uses the same parser for report-only matrix runs instead of a second awk contract', () => {
    const workflow = YAML.parse(MATRIX_TEXT) as any;
    const steps = workflow.jobs['build-locale'].steps as Array<Record<string, any>>;
    const extract = steps.find((step) => step.name === 'Extract build markers');

    expect(extract).toBeDefined();
    expect(extract.run).toContain('scripts/ci/report-jobs-seo-build-metrics.mjs');
    expect(extract.run).toContain('--report-only');
    expect(extract.run).toContain('--markers-out="$MARKER_FILE"');
    expect(extract.run).not.toContain('strip_ansi()');
    expect(extract.run).not.toContain('profile_seconds()');
  });

  // This is what lets the validator above be non-blocking: a sampled or
  // stopped build cannot reach production BY CONSTRUCTION (JOBS_SEO_SAMPLE
  // also throws on refs/heads/main in build-plugins/shared/jobsSeoSample.ts),
  // so no check of the validator is a publish-safety check.
  it('keeps the production path free of benchmark-only sample and stop flags', () => {
    const deploy = YAML.parse(DEPLOY_TEXT) as any;
    const env = deploy.jobs['build-locale'].env as Record<string, unknown>;

    expect(DEPLOY_TEXT).not.toContain('JOBS_SEO_SAMPLE');
    expect(DEPLOY_TEXT).not.toContain('BUILD_STOP_AFTER');
    expect(env).not.toHaveProperty('JOBS_SEO_SAMPLE');
    expect(env).not.toHaveProperty('BUILD_STOP_AFTER');
  });
});
