import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

describe('deploy IT build-to-publish handoff', () => {
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
    const ready = namedStep(cdnSteps, 'Require IT CDN build id before shard pushes');
    const gateIndex = groupSteps.findIndex((step) => step.name === 'Wait for current IT CDN build id before IT section pushes');
    const pushIndex = groupSteps.findIndex((step) => step.name === 'Push and package IT section group');
    expect(early?.run).toContain('bash scripts/lib/deploy-it-pages-prep.sh');
    expect(early?.env?.DEPLOY_CDN_PUSH_ONLY).toBe('1');
    expect(early?.['timeout-minutes']).toBe(45);
    expect(retry?.if).toBe("steps.cdn-push-early.outcome == 'failure'");
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
    expect(readFileSync(resolve(root, 'scripts/ci/push-it-shard-group.sh'), 'utf8'))
      .toMatch(/timeout --verbose --signal=TERM --kill-after=600s 3600s bash scripts\/lib\/push-section-shard\.sh/);
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
