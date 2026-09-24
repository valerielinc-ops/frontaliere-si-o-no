import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';

const ROOT = resolve(import.meta.dirname, '..');
const DEPLOY_PATH = resolve(ROOT, '.github/workflows/deploy.yml');
const MATRIX_PATH = resolve(ROOT, '.github/workflows/deploy-matrix-experiment.yml');
const DEPLOY_TEXT = readFileSync(DEPLOY_PATH, 'utf8');
const MATRIX_TEXT = readFileSync(MATRIX_PATH, 'utf8');

describe('jobs SEO full-corpus measurement wiring', () => {
  it('runs the fail-closed evidence validator on the production IT leg', () => {
    const workflow = YAML.parse(DEPLOY_TEXT) as any;
    const steps = workflow.jobs['build-locale'].steps as Array<Record<string, any>>;
    const buildIndex = steps.findIndex((step) => step.id === 'build_step');
    const validatorIndex = steps.findIndex((step) => step.name === 'Validate full-corpus jobs SEO evidence');
    const uploadIndex = steps.findIndex((step) => step.name === 'Upload full-corpus jobs SEO markers');
    const validator = steps[validatorIndex];

    expect(validatorIndex).toBeGreaterThan(buildIndex);
    expect(uploadIndex).toBeGreaterThan(validatorIndex);
    expect(validator.if).toBe("always() && matrix.locale == 'it'");
    expect(validator['continue-on-error']).not.toBe(true);
    expect(validator.run).toContain('scripts/ci/report-jobs-seo-build-metrics.mjs');
    expect(validator.run).toContain('--require-full-corpus');
    expect(validator.run).toContain('--markers-out="$JOBS_SEO_MARKERS_OUT"');
    expect(validator.env.JOBS_SEO_BUILD_LOG).toBe('/tmp/build.log');
    expect(validator.env.JOBS_SEO_MARKERS_OUT).toContain('${{ runner.temp }}');
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

  it('keeps the production path free of benchmark-only sample and stop flags', () => {
    const deploy = YAML.parse(DEPLOY_TEXT) as any;
    const env = deploy.jobs['build-locale'].env as Record<string, unknown>;

    expect(DEPLOY_TEXT).not.toContain('JOBS_SEO_SAMPLE');
    expect(DEPLOY_TEXT).not.toContain('BUILD_STOP_AFTER');
    expect(env).not.toHaveProperty('JOBS_SEO_SAMPLE');
    expect(env).not.toHaveProperty('BUILD_STOP_AFTER');
  });
});
