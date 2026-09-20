import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';
import {
  ALLOWED_ENV_KEYS,
  buildMatrix,
  parseVariants,
} from '../scripts/ci/matrix-experiment-variants.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const WORKFLOWS_DIR = resolve(ROOT, '.github/workflows');
const WORKFLOW_PATH = resolve(WORKFLOWS_DIR, 'deploy-matrix-experiment.yml');
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
      'JOBS_SEO_REUSE_PROBE',
      'JOBS_SEO_REUSE_PROBE_MAX',
      'JOBS_SEO_REUSE_PROBE_MIN',
      'JOBS_SEO_REUSE_PROBE_PER_STRATUM',
      'JOBS_SEO_REUSE_PROBE_RATE',
      'JOBS_SEO_REUSE_VERIFY',
      'JOBS_SEO_REUSE_VERIFY_SAMPLE',
      'JOBS_SEO_SAMPLE',
      'POST_WALK_INCREMENTAL',
      'POST_WALK_INCREMENTAL_VERIFY',
      'POST_WALK_TARGETED_WALK',
      'RELATED_SEARCH_CLUSTERS_NO_CACHE',
      'RELATED_SEARCH_POSTINGS_SPARSE',
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
    expect(WORKFLOW.concurrency.group).toBe('deploy-matrix-experiment');
    expect(String(WORKFLOW.concurrency.group)).not.toBe('pages-build-run');
  });

  // Osservatore del budget di capacità (misura 2026-09-19: 3.091 job-minuti/24 h,
  // media 2,14 slot, picco 6, media 5,24 nel plateau 18:30→19:45Z, su un tetto
  // account di 20-22 job). Lo studio scarta il proprio output: il costo va
  // tenuto limitato per costruzione, non per disciplina di chi fa il dispatch.
  describe('budget di capacità', () => {
    it('serializza i dispatch con un gruppo di concorrenza STABILE', () => {
      // `github.run_id` è unico per run: un gruppo che lo contiene non può
      // serializzare nulla ed è ciò che permetteva 6 run vivi insieme.
      const group = String(WORKFLOW.concurrency.group);
      expect(group).toBe('deploy-matrix-experiment');
      expect(group).not.toMatch(/github\.run_id|github\.run_number|github\.sha/u);
      // Un run già partito non va ucciso a metà misura.
      expect(WORKFLOW.concurrency['cancel-in-progress']).toBe(false);
    });

    it('fa girare UNA gamba per volta, cosi\u2019 il tetto dichiarato vale per costruzione', () => {
      // Con 2 un dispatch `variants` multilinea terrebbe due runner di build
      // insieme e il tetto di ~1 slot annunciato in testa al file sarebbe
      // falso proprio nel caso peggiore.
      expect(WORKFLOW.jobs['build-locale'].strategy['max-parallel']).toBe(1);
    });

    it('nessun job di build puo\u2019 girare accanto a un altro nello stesso run', () => {
      // `max-parallel: 1` serializza solo le gambe della matrix. Il job
      // `monolith` di `compare_monolith` condivideva i soli prerequisiti
      // `matrix-setup`/`prep`, quindi partiva in parallelo a `build-locale` e
      // il dispatch teneva DUE runner di build: il tetto di ~1 slot dichiarato
      // in testa al file era falso proprio nella modalita' di confronto.
      expect(WORKFLOW.jobs.monolith.needs).toContain('build-locale');
      // E deve comunque girare quando uno shard fallisce (`fail-fast: false`),
      // altrimenti il termine di paragone sparisce nel giro in cui serve.
      expect(String(WORKFLOW.jobs.monolith.if)).toContain('!cancelled()');

      // Tutti i job che accendono un runner di build devono stare in catena.
      const buildJobs = ['prep', 'build-locale', 'monolith'];
      for (const [index, job] of buildJobs.slice(1).entries()) {
        expect(WORKFLOW.jobs[job].needs, job).toContain(buildJobs[index]);
      }
    });

    it('il gate di scadenza rifiuta una data di CALENDARIO impossibile, non solo la forma', () => {
      const guard = String((WORKFLOW.jobs['matrix-setup'].steps as Array<Record<string, any>>)[0].run);
      // La sola regex lascia passare `2026-02-31`, che non esiste: una scadenza
      // malformata resterebbe attiva invece di fallire subito.
      expect(guard).toMatch(/date -u -d/u);
      expect(guard).toMatch(/canonical/u);
    });

    it('nessun altro workflow contende i gruppi di concorrenza degli studi', () => {
      // I gruppi ora sono letterali: se un altro workflow ne usasse uno, i due
      // si serializzerebbero a vicenda senza che nessuno l\u2019abbia chiesto.
      const groups = new Map<string, string[]>();
      for (const name of readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.yml'))) {
        let doc: any;
        try {
          doc = YAML.parse(readFileSync(resolve(WORKFLOWS_DIR, name), 'utf8'));
        } catch {
          continue;
        }
        const seen = [doc?.concurrency, ...Object.values(doc?.jobs ?? {}).map((job: any) => job?.concurrency)];
        for (const entry of seen) {
          const group = typeof entry === 'string' ? entry : entry?.group;
          if (typeof group !== 'string' || !group.trim()) continue;
          groups.set(group, [...(groups.get(group) ?? []), name]);
        }
      }
      for (const group of ['deploy-matrix-experiment', 'cluster-pages-experiment', 'matrix-equivalence', 'post-build-matrix-test']) {
        expect(groups.get(group), group).toEqual([`${group === 'matrix-equivalence' ? 'matrix-equivalence-check' : group}.yml`]);
      }
    });

    it('dichiara una scadenza e la fa valere prima di accendere un runner di build', () => {
      const expiry = String(WORKFLOW.env?.EXPERIMENT_EXPIRES_ON ?? '');
      expect(expiry).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
      expect(Number.isNaN(Date.parse(`${expiry}T00:00:00Z`))).toBe(false);

      const setupSteps = WORKFLOW.jobs['matrix-setup'].steps as Array<Record<string, any>>;
      const guard = setupSteps[0];
      expect(String(guard.name)).toMatch(/expiry/iu);
      expect(String(guard.run)).toContain('EXPERIMENT_EXPIRES_ON');

      // `prep` da solo vale ~11 job-minuti a dispatch: senza questa dipendenza
      // girerebbe anche a studio scaduto, perché non ha altri `needs`.
      expect(WORKFLOW.jobs.prep.needs).toContain('matrix-setup');
      expect(WORKFLOW.jobs['build-locale'].needs).toContain('matrix-setup');
    });
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
