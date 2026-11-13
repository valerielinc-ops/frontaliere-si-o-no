import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';
import YAML from 'yaml';

const root = resolve(import.meta.dirname, '..');
const deployText = readFileSync(resolve(root, '.github/workflows/deploy.yml'), 'utf8');
const publishText = readFileSync(resolve(root, '.github/workflows/deploy-publish.yml'), 'utf8');
const deploy = YAML.parse(deployText) as any;
const publish = YAML.parse(publishText) as any;
const buildSteps = deploy.jobs['build-locale'].steps as Array<Record<string, any>>;
const cdnSteps = publish.jobs['publish-it-cdn'].steps as Array<Record<string, any>>;
const groupSteps = publish.jobs['push-it-shard-groups'].steps as Array<Record<string, any>>;
const finalizeSteps = publish.jobs['finalize-it-publish'].steps as Array<Record<string, any>>;
const namedStep = (steps: Array<Record<string, any>>, name: string) => steps.find((step) => step.name === name);

const publisherEntrypoints = [
  'scripts/ci/list-live-shard-sections.mjs',
  'scripts/ci/report-shard-push-failure.mjs',
  'scripts/ci/section-shard-purge-urls.mjs',
  'scripts/ci/shard-content-manifest.mjs',
  'scripts/ci/shard-manifest-delta.mjs',
  'scripts/ci/shard-push-verify.mjs',
  'scripts/lib/externally-served-paths.mjs',
  'scripts/lib/shrink-ack-check.mjs',
  'scripts/offload-generated-images-cdn.mjs',
];
const publisherRuntimePaths = [
  'scripts/lib/bounded-parallel.sh',
  'scripts/lib/deploy-shard-sections.sh',
  'scripts/lib/push-section-shard.sh',
  'scripts/lib/shard-cdn-rewrite.sh',
  'scripts/lib/section-shard-slugs.json',
  'scripts/lib/section-shard-owners.json',
];

function resolveModulePath(fromFile: string, specifier: string): string {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [base, ...['.mjs', '.js', '.cjs', '.ts', '.json'].map((extension) => `${base}${extension}`),
    ...['index.mjs', 'index.js', 'index.cjs', 'index.ts'].map((name) => resolve(base, name))];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`${relative(root, fromFile)} imports missing local module ${specifier}`);
  return found;
}

function importedModules(entrypoint: string): Set<string> {
  const visited = new Set<string>();
  const pending = [resolve(root, entrypoint)];
  while (pending.length) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const visit = (node: ts.Node) => {
      const moduleSpecifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
          ? node.arguments[0]
          : undefined;
      if (moduleSpecifier && ts.isStringLiteral(moduleSpecifier) && moduleSpecifier.text.startsWith('.')) {
        pending.push(resolveModulePath(file, moduleSpecifier.text));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return new Set([...visited].map((file) => relative(root, file).split('\\').join('/')));
}

function sparseCheckoutIncludes(patterns: string[], file: string): boolean {
  return patterns.some((rawPattern) => {
    const pattern = rawPattern.trim().replace(/^\/+/, '');
    if (!pattern || pattern.startsWith('!')) return false;
    const prefix = pattern.endsWith('/') ? pattern : `${pattern}/`;
    return file === pattern.replace(/\/$/u, '') || file.startsWith(prefix);
  });
}

describe('deploy IT build-to-publish handoff', () => {
  it('resolves the non-IT tail matrix without ever scheduling IT', () => {
    const receiptSteps = publish.jobs['resolve-publish-receipts'].steps as Array<Record<string, any>>;
    const receiptResolver = namedStep(receiptSteps, 'Resolve source-run receipts');
    const nonIt = publish.jobs['publish-nonit-shards'];
    const outputs = publish.jobs['resolve-publish-receipts'].outputs;

    expect(outputs.pending_nonit_locales).toBe('${{ steps.receipts.outputs.pending_nonit_locales }}');
    expect(receiptResolver?.run).toContain('--resolve');
    expect(nonIt.if).toContain("needs.resolve-publish-receipts.outputs.pending_nonit_locales != '[]'");
    expect(nonIt.strategy.matrix.locale).toContain('pending_nonit_locales');
    expect(nonIt.strategy.matrix.locale).not.toContain('pending_locales }}');
  });

  it('keeps the sparse current publisher checkout closed over every runtime import', () => {
    const checkout = namedStep(
      publish.jobs['publish-nonit-shards'].steps as Array<Record<string, any>>,
      'Checkout current shard publisher',
    );
    const sparsePaths = String(checkout.with['sparse-checkout']).split('\n').map((line) => line.trim()).filter(Boolean);
    const closure = new Set(publisherEntrypoints.flatMap((entrypoint) => [...importedModules(entrypoint)]));
    const missing = [...new Set([...closure, ...publisherRuntimePaths])]
      .filter((file) => !sparseCheckoutIncludes(sparsePaths, file));

    expect(checkout.with.ref).toBe('refs/heads/main');
    expect(missing).toEqual([]);
    expect(closure.has('services/publicConfigConstants.mjs')).toBe(true);
  });

  it('builds the IT plan from the canonical full-deploy section order and fails closed on an empty result', () => {
    const sourcePackager = readFileSync(resolve(root, 'scripts/ci/package-it-publish-source.sh'), 'utf8');
    expect(sourcePackager).toContain('bp_section_order "$repo_root/dist" it "$repo_root"');
    expect(sourcePackager).toContain('cannot compute the IT section set from the full deploy contract');
    expect(sourcePackager).toContain('the full deploy contract produced an empty IT section set');
    expect(sourcePackager).not.toContain('list-live-shard-sections.mjs');

    const assembler = readFileSync(resolve(root, 'scripts/ci/assemble-it-publish-root.sh'), 'utf8');
    expect(assembler).toContain('--validate-plan "$plan_dir/it-shard-group-plan.json"');
    expect(assembler).toContain('required_sections_output="$(jq -er');
    expect(assembler).toContain('cannot read required IT sections from the publish plan');
    expect(assembler).not.toContain('mapfile -t required_sections < <(jq');
    expect(assembler).toContain('missing the required ok-marker for $section');
    expect(assembler).toContain('missing the required section manifest for $section');
  });

  it('fails before the success marker when jq cannot read required sections', () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'it-publish-jq-failure-'));
    const repo = resolve(tempRoot, 'repo');
    const runnerTemp = resolve(tempRoot, 'runner-temp');
    const fakeBin = resolve(tempRoot, 'bin');
    const script = resolve(repo, 'scripts/ci/assemble-it-publish-root.sh');

    try {
      mkdirSync(resolve(repo, 'scripts/ci'), { recursive: true });
      mkdirSync(resolve(repo, 'scripts/lib'), { recursive: true });
      mkdirSync(resolve(runnerTemp, 'it-publish-plan'), { recursive: true });
      mkdirSync(resolve(runnerTemp, 'it-publish-root'), { recursive: true });
      mkdirSync(resolve(runnerTemp, 'it-shard-results'), { recursive: true });
      mkdirSync(fakeBin, { recursive: true });
      writeFileSync(script, readFileSync(resolve(root, 'scripts/ci/assemble-it-publish-root.sh'), 'utf8'));
      writeFileSync(resolve(repo, 'scripts/lib/parallel-tar.sh'), 'ptar_extract() { return 0; }\n');
      writeFileSync(resolve(runnerTemp, 'it-publish-plan/it-shard-group-plan.json'), '{}');
      writeFileSync(resolve(runnerTemp, 'it-publish-plan/locale-sitemap-manifest-it.json'), '{}');
      writeFileSync(resolve(runnerTemp, 'it-publish-root/it-publish-root.tar.zst'), 'fixture');

      const fakeNode = resolve(fakeBin, 'node');
      const fakeJq = resolve(fakeBin, 'jq');
      writeFileSync(fakeNode, '#!/bin/sh\nexit 0\n');
      writeFileSync(fakeJq, '#!/bin/sh\nexit 1\n');
      chmodSync(fakeNode, 0o755);
      chmodSync(fakeJq, 0o755);

      const result = spawnSync('bash', [script], {
        cwd: repo,
        encoding: 'utf8',
        env: {
          ...process.env,
          RUNNER_TEMP: runnerTemp,
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        },
      });

      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).not.toContain('[it-publish] root extracted');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('keeps build and rearm lanes non-cancelling while moving only the publish tail', () => {
    expect(deploy.concurrency.group).toContain('pages-build-run');
    expect(deploy.concurrency.group).toContain('pages-build-rearm');
    expect(deploy.concurrency.group).toContain('deploy-schedule-reconcile');
    expect(deploy.concurrency['cancel-in-progress']).toBe(false);
    expect(deploy.jobs['build-locale'].concurrency).toMatchObject({
      group: 'pages-build-locale-${{ matrix.locale }}',
      'cancel-in-progress': false,
    });
    expect(deploy.jobs.rearm).toBeDefined();
    expect(deploy.jobs['schedule-reconcile']).toBeDefined();
    expect(buildSteps.some((step) => /Push generated assets to CDN|Push section shards \(IT|Strip section subtrees \(IT|Deploy prep \(IT|Upload Pages artifact|Save deploy metadata to Firestore/.test(String(step.name)))).toBe(false);
    expect(namedStep(buildSteps, 'Package IT publication source artifacts')?.if).toBe("matrix.locale == 'it'");
    expect(namedStep(buildSteps, 'Upload IT root publication source')?.with?.name)
      .toBe('it-publish-root-${{ github.run_id }}');
    expect(namedStep(buildSteps, 'Upload IT root publication source')?.with?.['retention-days']).toBe(2);
    expect(namedStep(buildSteps, 'Upload IT shard publication plan and support files')?.with?.name)
      .toBe('it-shard-source-plan-${{ github.run_id }}');
    for (const group of ['zurigo', 'svizzera', 'small-1', 'small-2', 'small-3', 'small-4']) {
      expect(buildSteps.some((step) => step.with?.name === `it-shard-source-group-${group}-\${{ github.run_id }}`)).toBe(true);
    }
    expect(buildSteps.some((step) => step.with?.name === 'shard-batch-1-dist-it-${{ github.run_id }}')).toBe(false);
  });

  it('publishes the CDN before both shard fan-outs and keeps each IT phase within its own six-hour job', () => {
    const cdn = publish.jobs['publish-it-cdn'];
    const groups = publish.jobs['push-it-shard-groups'];
    const finalizer = publish.jobs['finalize-it-publish'];
    expect(cdn['timeout-minutes']).toBe(360);
    expect(groups['timeout-minutes']).toBe(360);
    expect(finalizer['timeout-minutes']).toBe(360);
    expect(groups.environment).toBe('shard-secrets-overflow');
    expect(groups.strategy.matrix.group).toEqual(['zurigo', 'svizzera', 'small-1', 'small-2', 'small-3', 'small-4']);
    expect([].concat(groups.needs)).toContain('publish-it-cdn');
    expect([].concat(publish.jobs['publish-nonit-shards'].needs)).toContain('publish-it-cdn');
    expect(cdn.concurrency).toMatchObject({ group: 'it-cdn-assets-publish', 'cancel-in-progress': false });
    expect(groups.concurrency).toMatchObject({
      group: 'it-section-tail-${{ matrix.group }}',
      'cancel-in-progress': false,
    });

    const early = namedStep(cdnSteps, 'Push generated assets to CDN (early — ahead of the shard pushes)');
    const retry = namedStep(cdnSteps, 'Retry early CDN push (before the section shards give up)');
    const observer = namedStep(cdnSteps, 'Observe IT early CDN push budget (advisory)');
    const ready = namedStep(cdnSteps, 'Require IT CDN build id before shard pushes');
    const retryIndex = cdnSteps.findIndex((step) => step.name === 'Retry early CDN push (before the section shards give up)');
    const observerIndex = cdnSteps.findIndex((step) => step.name === 'Observe IT early CDN push budget (advisory)');
    const readyIndex = cdnSteps.findIndex((step) => step.name === 'Require IT CDN build id before shard pushes');
    const gateIndex = groupSteps.findIndex((step) => step.name === 'Wait for current IT CDN build id before IT section pushes');
    const pushIndex = groupSteps.findIndex((step) => step.name === 'Push and package IT section group');
    expect(early?.run).toContain('bash scripts/lib/deploy-it-pages-prep.sh');
    expect(early?.run).toContain('duration_s=');
    expect(early?.env?.DEPLOY_CDN_PUSH_ONLY).toBe('1');
    expect(early?.env?.R2_TIMEOUT_OG_S).toBe('900');
    expect(early?.['timeout-minutes']).toBe(45);
    expect(retry?.if).toBe("steps.cdn-push-early.outcome == 'failure'");
    expect(retry?.run).toContain('duration_s=');
    expect(retry?.env?.R2_TIMEOUT_OG_S).toBe('900');
    expect(observer?.if).toBe('always()');
    expect(observer?.run).toContain('cdnEarlyPushBudgetObserved()');
    expect(observer?.run).toContain('GITHUB_STEP_SUMMARY');
    expect(observer?.env?.R2_TIMEOUT_OG_S).toContain("'900'");
    expect(retryIndex).toBeLessThan(observerIndex);
    expect(observerIndex).toBeLessThan(readyIndex);
    expect(ready?.id).toBe('cdn-ready');
    expect([gateIndex, pushIndex]).toEqual([expect.any(Number), expect.any(Number)]);
    expect(gateIndex).toBeLessThan(pushIndex);
    expect(groupSteps[gateIndex].env.CDN_IT_JOB_NAME).toBe('Publish IT CDN assets first');
    expect(groupSteps[gateIndex].env.CDN_IT_READY_STEP_NAME).toBe('Require IT CDN build id before shard pushes');
    expect(groupSteps[pushIndex].run).toContain('scripts/ci/push-it-shard-group.sh');
    expect(groupSteps[pushIndex].run).toContain('wall_seconds=$SECONDS');
    expect(groupSteps[pushIndex]['continue-on-error']).toBe(true);
    expect(groupSteps[pushIndex].env.SHARD_PUSH_MODE).toBe("${{ vars.SHARD_PUSH_MODE == 'delta' && 'delta' || 'full' }}");
    expect(groupSteps[pushIndex].env.SHARD_PUSH_VERIFY).toBe("${{ vars.SHARD_PUSH_VERIFY == '1' && '1' || '' }}");
    expect(namedStep(groupSteps, 'Upload IT section group results and ok-markers')?.if).toBe('always()');
    expect(namedStep(groupSteps, 'Require IT section group and CDN gate success')?.if).toBe('always()');
    const batchPackager = readFileSync(resolve(root, 'scripts/ci/package-it-shard-validation-batches.mjs'), 'utf8');
    expect(batchPackager).toContain('validateItShardGroupPlan(plan)');
    const itGroupHelper = readFileSync(resolve(root, 'scripts/ci/push-it-shard-group.sh'), 'utf8');
    expect(itGroupHelper).toContain('job_start + 360 * 60 - now_epoch - cleanup_grace_seconds - post_push_reserve_seconds');
    expect(itGroupHelper).toContain('timeout_seconds=$((available_seconds / (sections_remaining + 1)))');
    expect(itGroupHelper).toContain('section_timeout_cap_seconds=3600');
    expect(itGroupHelper).toContain('bash scripts/lib/push-section-shard.sh "$section" it dist');
  });

  it('keeps fail-closed finalization and creates validation batches only after successful shard groups', () => {
    const finalizer = publish.jobs['finalize-it-publish'];
    expect(finalizer.concurrency).toMatchObject({ group: 'it-pages-finalize', 'cancel-in-progress': false });
    expect(finalizer.if).toContain('always()');
    expect([].concat(finalizer.needs)).toEqual(expect.arrayContaining([
      'publish-it-cdn',
      'push-it-shard-groups',
    ]));
    expect(namedStep(finalizeSteps, 'Download IT section group results')?.['continue-on-error']).toBe(true);
    const packageBatches = namedStep(finalizeSteps, 'Package IT post-push validation batches');
    expect(packageBatches?.if).toBe("needs.push-it-shard-groups.result == 'success'");
    expect(packageBatches?.run).toContain('package-it-shard-validation-batches.mjs');

    const finalizeIndex = finalizeSteps.findIndex((step) => step.name === 'Finalize IT section content manifests');
    const manifestUploadIndex = finalizeSteps.findIndex((step) => step.name === 'Upload IT section content manifest');
    const cdnRecheckIndex = finalizeSteps.findIndex((step) => step.name === 'Recheck current IT CDN build id before Pages preparation');
    const stripIndex = finalizeSteps.findIndex((step) => step.name === 'Strip section subtrees (IT)');
    const prepIndex = finalizeSteps.findIndex((step) => step.name === 'Deploy prep (IT → Pages + CDN)');
    const pagesIndex = finalizeSteps.findIndex((step) => step.name === 'Upload Pages artifact (compression-level 9)');
    const metadataIndex = finalizeSteps.findIndex((step) => step.name === 'Save deploy metadata to Firestore');
    expect(finalizeSteps[finalizeIndex].run).toContain('finalize-sections');
    expect(finalizeSteps[finalizeIndex].run).toContain('--required-sections');
    expect(finalizeSteps[manifestUploadIndex].with.name).toBe('section-page-manifest-it-${{ github.run_id }}');
    expect(finalizeSteps[cdnRecheckIndex].env.CDN_IT_JOB_NAME).toBe('Publish IT CDN assets first');
    expect(finalizeIndex).toBeLessThan(manifestUploadIndex);
    expect(manifestUploadIndex).toBeLessThan(cdnRecheckIndex);
    expect(cdnRecheckIndex).toBeLessThan(stripIndex);
    expect(stripIndex).toBeLessThan(prepIndex);
    expect(prepIndex).toBeLessThan(pagesIndex);
    expect(pagesIndex).toBeLessThan(metadataIndex);

    for (let batch = 1; batch <= 6; batch += 1) {
      const upload = namedStep(finalizeSteps, `Upload shard batch ${batch} dist for post-deploy validation`);
      expect(upload?.if).toBe("needs.push-it-shard-groups.result == 'success'");
      expect(upload?.with?.name).toBe(`shard-batch-${batch}-dist-it-\${{ github.run_id }}`);
      expect(Number(upload?.with?.['retention-days'])).toBeGreaterThanOrEqual(8);
    }
    expect(publish.jobs.deploy.needs).toContain('resolve-nonit-publish');
    expect(deployText).not.toMatch(/cancel-in-progress:\s*true/);
  });
});
