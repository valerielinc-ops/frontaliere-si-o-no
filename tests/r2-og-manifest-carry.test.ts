/**
 * R2 OG progress must survive a later timeout in the IT publisher jobs.
 *
 * The early cache save persists verified partial/full checkpoints before the
 * section-shard fan-out; the final save refreshes the cache after larger cache
 * writes so GitHub's LRU does not evict the manifest immediately.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';

type Step = {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  with?: Record<string, string>;
  'continue-on-error'?: boolean;
};

const deployPath = resolve(process.cwd(), '.github/workflows/deploy.yml');
const deploySource = readFileSync(deployPath, 'utf8');
const deploy = YAML.parse(deploySource);
const publishSource = readFileSync(resolve(process.cwd(), '.github/workflows/deploy-publish.yml'), 'utf8');
const publish = YAML.parse(publishSource);
const buildSteps: Step[] = deploy.jobs['build-locale'].steps;
const cdnSteps: Step[] = publish.jobs['publish-it-cdn'].steps;
const finalizeSteps: Step[] = publish.jobs['finalize-it-publish'].steps;
const indexOf = (steps: Step[], name: string) => steps.findIndex((step) => step.name === name);

describe('deploy-publish.yml — R2 OG checkpoint persistence', () => {
  const buildRestore = indexOf(buildSteps, 'Restore last published R2 OG manifest');
  const restore = indexOf(cdnSteps, 'Restore last published R2 OG manifest');
  const earlySave = indexOf(cdnSteps, 'Save R2 OG manifest after early CDN push');
  const retry = indexOf(cdnSteps, 'Retry early CDN push (before the section shards give up)');
  const retrySave = indexOf(cdnSteps, 'Save R2 OG manifest after early CDN retry');
  const shardGroups = publish.jobs['push-it-shard-groups'];
  const prep = indexOf(finalizeSteps, 'Deploy prep (IT → Pages + CDN)');
  const finalSave = indexOf(finalizeSteps, 'Save final R2 OG manifest cache');

  it('restores and saves the manifest before shards, then refreshes it after larger caches', () => {
    expect(buildRestore).toBeGreaterThan(-1);
    expect(restore).toBeGreaterThan(-1);
    expect(earlySave).toBeGreaterThan(restore);
    expect(retry).toBeGreaterThan(earlySave);
    expect(retrySave).toBeGreaterThan(retry);
    expect(shardGroups.needs).toContain('publish-it-cdn');
    expect(finalSave).toBeGreaterThan(prep);
    expect(String(cdnSteps[restore].with?.['restore-keys']).trim()).toBe('r2-og-published-');
  });

  it('runs checkpoint saves even when the corresponding push fails', () => {
    for (const index of [earlySave, retrySave]) {
      const step = cdnSteps[index];
      expect(step.if).toContain('always()');
      expect(step.uses).toBe('actions/cache/save@v6');
      expect(step.with?.path).toBe('.cache/r2-og-published-manifest.json');
      expect(step['continue-on-error']).toBe(true);
      expect(step.if).toContain("hashFiles('.cache/r2-og-published-manifest.json') != ''");
    }
    const finalStep = finalizeSteps[finalSave];
    expect(finalStep.if).toContain('always()');
    expect(finalStep.uses).toBe('actions/cache/save@v6');
    expect(finalStep.with?.path).toBe('.cache/r2-og-published-manifest.json');
    expect(finalStep['continue-on-error']).toBe(true);
    expect(finalStep.if).toContain("hashFiles('.cache/r2-og-published-manifest.json') != ''");
    expect(cdnSteps[earlySave].if).toContain("vars.CDN_TARGET == 'r2' || vars.CDN_TARGET == 'both'");
    expect(cdnSteps[retrySave].if).toContain("steps.cdn-push-early-retry.outcome != 'skipped'");
    expect(cdnSteps[retrySave].if).toContain("vars.CDN_TARGET == 'r2' || vars.CDN_TARGET == 'both'");
    expect(finalStep.if).toContain("vars.CDN_TARGET == 'r2' || vars.CDN_TARGET == 'both'");
  });

  it('uses distinct cache keys for checkpoint and final saves and removes stale promotion references', () => {
    const earlyKey = cdnSteps[earlySave].with?.key ?? '';
    const retryKey = cdnSteps[retrySave].with?.key ?? '';
    const finalKey = finalizeSteps[finalSave].with?.key ?? '';
    expect(earlyKey).toBe('r2-og-published-${{ github.run_id }}-${{ hashFiles(\'.cache/r2-og-published-manifest.json\') }}');
    expect(retryKey).toBe(earlyKey);
    expect(finalKey).toBe('r2-og-published-${{ github.run_id }}-final-${{ hashFiles(\'.cache/r2-og-published-manifest.json\') }}');
    expect(deploySource).not.toContain('Promote successfully published R2 OG manifest');
    expect(deploySource).not.toContain('Carry the last published R2 OG manifest forward');
    expect(deploySource).not.toContain('steps.promote-r2-og-manifest.outputs.promoted');
    expect(publishSource).not.toContain('Promote successfully published R2 OG manifest');
  });

  it('restores for R2 and dual-publish deployments', () => {
    expect(buildSteps[buildRestore].if).toContain("vars.CDN_TARGET == 'r2' || vars.CDN_TARGET == 'both'");
    expect(buildSteps[buildRestore].with?.key).toBe('r2-og-published-${{ github.run_id }}');
    expect(String(buildSteps[buildRestore].with?.['restore-keys']).trim()).toBe('r2-og-published-');
    expect(cdnSteps[restore].if).toContain("vars.CDN_TARGET == 'r2' || vars.CDN_TARGET == 'both'");
    expect(cdnSteps[restore].with?.key).toBe('r2-og-published-${{ github.run_id }}');
  });
});
