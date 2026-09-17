import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';
import {
  ALLOWED_ENV_KEYS,
  buildMatrix,
  parseVariants,
} from '../scripts/ci/matrix-experiment-variants.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW_PATH = resolve(ROOT, '.github/workflows/deploy-matrix-experiment.yml');
const WORKFLOW_TEXT = readFileSync(WORKFLOW_PATH, 'utf8');
const WORKFLOW = YAML.parse(WORKFLOW_TEXT) as any;

describe('deploy-matrix-experiment.yml — variant matrix contract', () => {
  it('keeps the explicit build-flag allowlist', () => {
    expect([...ALLOWED_ENV_KEYS].sort()).toEqual([
      'BUILD_PROFILE',
      'FAST_BUILD',
      'INCREMENTAL_MANIFEST',
      'INCREMENTAL_MANIFEST_VERIFY',
      'JOBS_SEO_MEM_GC',
      'JOBS_SEO_REUSE',
      'JOBS_SEO_REUSE_VERIFY',
      'POST_WALK_INCREMENTAL',
      'POST_WALK_INCREMENTAL_VERIFY',
      'RELATED_SEARCH_CLUSTERS_NO_CACHE',
      'SEQUENTIAL_PROFILE',
    ]);
  });

  it('declares variants as a multiline string input and keeps monolith comparison opt-in', () => {
    const inputs = WORKFLOW.on.workflow_dispatch.inputs;
    expect(inputs.variants).toMatchObject({ type: 'string', default: 'base=' });
    expect(inputs.compare_monolith).toMatchObject({ type: 'boolean', default: false });
  });

  it('does not save caches and uses an experiment-only concurrency group', () => {
    expect(WORKFLOW_TEXT).not.toContain('actions/cache/save');
    expect(WORKFLOW_TEXT).not.toMatch(/uses:\s*actions\/cache@/u);
    expect(String(WORKFLOW.concurrency.group)).not.toBe('pages-build-run');
  });

  it('builds the expected locale × variant include rows', () => {
    expect(WORKFLOW_TEXT).toContain('node scripts/ci/matrix-experiment-variants.mjs');
    expect(buildMatrix({
      locales: 'it',
      variants: 'base=\nmanifest=INCREMENTAL_MANIFEST=1',
    })).toEqual([
      { locale: 'it', variant: 'base', env_json: '{}', all_locales: false },
      { locale: 'it', variant: 'manifest', env_json: '{"INCREMENTAL_MANIFEST":"1"}', all_locales: false },
    ]);
  });

  it('fails clearly for an invalid name or env key', () => {
    expect(() => parseVariants('BadName=')).toThrow(/invalid variant name/);
    expect(() => parseVariants('bad=NOT_A_BUILD_FLAG=1')).toThrow(/disallowed env key/);
  });

  it('restores both production cache inputs read-only and uploads per-variant markers', () => {
    const steps = WORKFLOW.jobs['build-locale'].steps as Array<Record<string, any>>;
    const manifest = steps.find((step) => step.name === 'Restore previous incremental manifest');
    const html = steps.find((step) => step.name === 'Restore previous jobs SEO HTML cache');
    const extract = steps.find((step) => step.name === 'Extract build markers');
    const upload = steps.find((step) => step.name === 'Upload build markers');

    expect(manifest?.uses).toBe('actions/cache/restore@v5');
    expect(manifest?.with?.key).toBe('incremental-manifest-${{ matrix.locale }}-${{ github.run_id }}');
    expect(String(manifest?.with?.['restore-keys']).trim()).toBe('incremental-manifest-${{ matrix.locale }}-');
    expect(html?.uses).toBe('actions/cache/restore@v5');
    expect(html?.with?.key).toBe(
      "jobs-seo-html-${{ matrix.locale }}-${{ hashFiles(format('.cache/incremental-manifest/{0}.jsonl', matrix.locale)) }}",
    );
    expect(extract?.if).toBe('always()');
    expect(extract?.run).toContain('/tmp/build-${BUILD_LOCALE}.log');
    expect(extract?.run).toContain('[jobs-seo-profile');
    expect(extract?.run).toContain('post-walk');
    expect(upload?.with).toMatchObject({
      name: 'build-markers-${{ matrix.locale }}-${{ matrix.variant }}-${{ github.run_id }}',
      'retention-days': 14,
    });
  });

  it('only enables monolith/compare for an explicit single-variant comparison', () => {
    expect(WORKFLOW.jobs['build-locale'].name).toBe('build-locale (${{ matrix.locale }}, ${{ matrix.variant }})');
    expect(WORKFLOW.jobs.monolith.if).toContain('inputs.compare_monolith == true');
    expect(WORKFLOW.jobs.monolith.if).toContain("needs.matrix-setup.outputs.variant_count == '1'");
    expect(WORKFLOW.jobs.compare.if).toContain('inputs.compare_monolith == true');
    expect(WORKFLOW.jobs.compare.if).toContain("needs.matrix-setup.outputs.variant_count == '1'");
  });
});
