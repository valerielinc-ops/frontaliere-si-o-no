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
      'BUILD_BENCH',
      'BUILD_PROFILE',
      'BUILD_STOP_AFTER',
      'CPU_PROFILE',
      'FAST_BUILD',
      'INCREMENTAL_MANIFEST',
      'INCREMENTAL_MANIFEST_VERIFY',
      'JOBS_SEO_MEM_GC',
      'JOBS_SEO_REUSE',
      'JOBS_SEO_REUSE_VERIFY',
      'JOBS_SEO_REUSE_VERIFY_SAMPLE',
      'JOBS_SEO_SAMPLE',
      'POST_WALK_INCREMENTAL',
      'POST_WALK_INCREMENTAL_VERIFY',
      'POST_WALK_TARGETED_WALK',
      'RELATED_SEARCH_CLUSTERS_NO_CACHE',
      'SEQUENTIAL_PROFILE',
    ]);
  });

  it('declares variants as a multiline string input and keeps monolith comparison opt-in', () => {
    const inputs = WORKFLOW.on.workflow_dispatch.inputs;
    expect(inputs.variants).toMatchObject({ type: 'string', default: 'base=' });
    expect(inputs.chain).toMatchObject({ type: 'string', default: '' });
    expect(inputs.stop_after_jobs_seo).toMatchObject({ type: 'boolean', default: false });
    expect(inputs.cpu_profile).toMatchObject({ type: 'boolean', default: false });
    expect(inputs.compare_monolith).toMatchObject({ type: 'boolean', default: false });
  });

  it('writes only namespaced chained caches and uses an experiment-only concurrency group', () => {
    const saveSteps = (WORKFLOW.jobs['build-locale'].steps as Array<Record<string, any>>)
      .filter((step) => step.uses === 'actions/cache/save@v5');
    expect(saveSteps.length).toBe(2);
    expect(saveSteps.every((step) => String(step.with?.key).startsWith('bench-'))).toBe(true);
    expect(saveSteps.map((step) => step.with?.key)).toEqual(expect.arrayContaining([
      'bench-${{ inputs.chain }}-${{ matrix.variant }}-${{ matrix.locale }}-${{ github.run_id }}',
      "bench-${{ inputs.chain }}-${{ matrix.variant }}-${{ matrix.locale }}-${{ hashFiles(format('.cache/incremental-manifest/{0}.jsonl', matrix.locale)) }}",
    ]));
    expect(WORKFLOW_TEXT).not.toMatch(/hashFiles\([^)]*(?:incremental-html|dist)\/\*\*/u);
    expect(WORKFLOW_TEXT).not.toMatch(/uses:\s*actions\/cache@/u);
    expect(WORKFLOW.concurrency.group).toBe('deploy-matrix-experiment-${{ github.run_id }}');
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

  it('accepts the benchmark-only stop and sample flags in a variant', () => {
    expect(parseVariants(
      'canary=BUILD_STOP_AFTER=jobsSeoPages,JOBS_SEO_SAMPLE=0.1,BUILD_BENCH=1,JOBS_SEO_REUSE_VERIFY_SAMPLE=0.02',
    )).toEqual([{
      name: 'canary',
      env: {
        BUILD_STOP_AFTER: 'jobsSeoPages',
        JOBS_SEO_SAMPLE: '0.1',
        BUILD_BENCH: '1',
        JOBS_SEO_REUSE_VERIFY_SAMPLE: '0.02',
      },
    }]);
  });

  it('accepts CPU profiling as a variant-local flag', () => {
    expect(parseVariants('profile=CPU_PROFILE=1')).toEqual([{
      name: 'profile',
      env: { CPU_PROFILE: '1' },
    }]);
  });

  it('restores chained caches before production fallbacks and uploads per-variant markers', () => {
    const steps = WORKFLOW.jobs['build-locale'].steps as Array<Record<string, any>>;
    const benchManifest = steps.find((step) => step.name === 'Restore chained incremental manifest');
    const manifest = steps.find((step) => step.name === 'Restore previous incremental manifest');
    const benchHtml = steps.find((step) => step.name === 'Restore chained jobs SEO HTML cache');
    const html = steps.find((step) => step.name === 'Restore previous jobs SEO HTML cache');
    const benchHtmlSave = steps.find((step) => step.name === 'Save chained jobs SEO HTML cache');
    const benchManifestSave = steps.find((step) => step.name === 'Save chained incremental manifest');
    const extract = steps.find((step) => step.name === 'Extract build markers');
    const upload = steps.find((step) => step.name === 'Upload build markers');
    const stop = steps.find((step) => step.name === 'Enforce stop-after jobs SEO control');

    expect(benchManifest?.uses).toBe('actions/cache/restore@v5');
    expect(benchManifest?.with?.key).toBe(
      'bench-${{ inputs.chain }}-${{ matrix.variant }}-${{ matrix.locale }}-${{ github.run_id }}',
    );
    expect(String(benchManifest?.with?.['restore-keys']).trim()).toBe(
      'bench-${{ inputs.chain }}-${{ matrix.variant }}-${{ matrix.locale }}-',
    );
    expect(manifest?.uses).toBe('actions/cache/restore@v5');
    expect(manifest?.with?.key).toBe('incremental-manifest-${{ matrix.locale }}-${{ github.run_id }}');
    expect(String(manifest?.with?.['restore-keys']).trim()).toBe('incremental-manifest-${{ matrix.locale }}-');
    expect(steps.indexOf(benchManifest!)).toBeLessThan(steps.indexOf(manifest!));

    expect(benchHtml?.uses).toBe('actions/cache/restore@v5');
    const benchHtmlKey =
      "bench-${{ inputs.chain }}-${{ matrix.variant }}-${{ matrix.locale }}-${{ hashFiles(format('.cache/incremental-manifest/{0}.jsonl', matrix.locale)) }}";
    expect(benchHtml?.with?.key).toBe(benchHtmlKey);
    expect(benchHtmlSave?.with?.key).toBe(benchHtmlKey);
    expect(benchHtmlSave?.if).toContain("steps.bench-jobs-seo-html-content.outputs.has_files == 'true'");
    expect(benchManifestSave?.if).toContain(
      "hashFiles(format('.cache/incremental-manifest/{0}.jsonl', matrix.locale)) != ''",
    );
    expect(html?.uses).toBe('actions/cache/restore@v5');
    expect(html?.with?.key).toBe(
      "jobs-seo-html-${{ matrix.locale }}-${{ hashFiles(format('.cache/incremental-manifest/{0}.jsonl', matrix.locale)) }}",
    );
    expect(steps.indexOf(benchHtml!)).toBeLessThan(steps.indexOf(html!));
    expect(extract?.if).toBe('always()');
    expect(extract?.run).toContain('/tmp/build-${BUILD_LOCALE}.log');
    expect(extract?.run).toContain('[jobs-seo-profile');
    expect(extract?.run).toContain('[jobs-seo-reuse');
    expect(extract?.run).toContain('[post-walk');
    expect(extract?.run).toContain('incremental-verify');
    expect(extract?.run).toContain('jobs-seo-sample');
    expect(extract?.run).toContain('build-stop-after');
    expect(extract?.run).toContain('wall-time-build-status');
    expect(extract?.run).toContain('post-walk');
    expect(stop?.if).toBe('inputs.stop_after_jobs_seo == true');
    expect(WORKFLOW.jobs['build-locale'].env).toMatchObject({
      BUILD_BENCH: '1',
      BUILD_STOP_AFTER: "${{ inputs.stop_after_jobs_seo == true && 'jobsSeoPages' || '' }}",
      CPU_PROFILE: "${{ inputs.cpu_profile == true && '1' || '' }}",
    });
    const build = steps.find((step) => String(step.name).startsWith('Build ('));
    expect(build?.run).toContain('./node_modules/.bin/vite build --minify esbuild');
    expect(build?.run).toContain('--cpu-prof');
    expect(build?.run).toContain('--cpu-prof-dir=/tmp/cpuprof');
    expect(build?.run).toContain('NODE_OPTIONS');
    expect(build?.run).toContain('skip post-build SPA asset verification');
    expect(build?.run).toContain('build_exit="${PIPESTATUS[0]}"');
    expect(build?.run).toContain('stop_after=${BUILD_STOP_AFTER:-}');
    const prune = steps.find((step) => step.name === 'Prune to locale shard (filesystem-level, mirrors production push_shard)');
    const validate = steps.find((step) => step.name === 'Validate locale shard output');
    expect(prune?.if).toContain("steps.build_step.outputs.stop_after == ''");
    expect(validate?.if).toContain("steps.build_step.outputs.stop_after == ''");
    expect(upload?.with).toMatchObject({
      name: 'build-markers-${{ matrix.locale }}-${{ matrix.variant }}-${{ github.run_id }}',
      'retention-days': 14,
    });
    const cpuUpload = steps.find((step) => step.name === 'Upload CPU profile');
    expect(cpuUpload?.if).toContain('inputs.cpu_profile == true');
    expect(cpuUpload?.uses).toBe('actions/upload-artifact@v7');
    expect(cpuUpload?.with).toMatchObject({
      name: 'cpu-profile-${{ matrix.locale }}-${{ matrix.variant }}-${{ github.run_id }}',
      path: '/tmp/cpuprof/*.cpuprofile',
      'retention-days': 7,
      'if-no-files-found': 'warn',
    });
  });

  it('only enables monolith/compare for an explicit single-variant comparison', () => {
    expect(WORKFLOW.jobs['build-locale'].name).toBe('build-locale (${{ matrix.locale }}, ${{ matrix.variant }})');
    expect(WORKFLOW.jobs.monolith.if).toContain('inputs.compare_monolith == true');
    expect(WORKFLOW.jobs.monolith.if).toContain('inputs.stop_after_jobs_seo != true');
    expect(WORKFLOW.jobs.monolith.if).toContain("needs.matrix-setup.outputs.variant_count == '1'");
    expect(WORKFLOW.jobs.compare.if).toContain('inputs.compare_monolith == true');
    expect(WORKFLOW.jobs.compare.if).toContain('inputs.stop_after_jobs_seo != true');
    expect(WORKFLOW.jobs.compare.if).toContain("needs.matrix-setup.outputs.variant_count == '1'");
    expect(WORKFLOW.jobs.monolith.env.BUILD_BENCH).toBe('1');
  });
});
