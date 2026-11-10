/**
 * R2 OG progress must survive a later timeout in the IT deploy job.
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
const workflow = YAML.parse(deploySource);
const steps: Step[] = workflow.jobs['build-locale'].steps;
const indexOf = (name: string) => steps.findIndex((step) => step.name === name);

describe('deploy.yml — R2 OG checkpoint persistence', () => {
  const restore = indexOf('Restore last published R2 OG manifest');
  const earlySave = indexOf('Save R2 OG manifest after early CDN push');
  const retry = indexOf('Retry early CDN push (before the section shards give up)');
  const retrySave = indexOf('Save R2 OG manifest after early CDN retry');
  const sections = indexOf('Push section shards (IT → frontaliere-<section>-it)');
  const prep = indexOf('Deploy prep (IT → Pages + CDN)');
  const finalSave = indexOf('Save final R2 OG manifest cache');

  it('restores and saves the manifest before shards, then refreshes it after larger caches', () => {
    expect(restore).toBeGreaterThan(-1);
    expect(earlySave).toBeGreaterThan(restore);
    expect(retry).toBeGreaterThan(earlySave);
    expect(retrySave).toBeGreaterThan(retry);
    expect(sections).toBeGreaterThan(retrySave);
    expect(finalSave).toBeGreaterThan(prep);
    expect(String(steps[restore].with?.['restore-keys']).trim()).toBe('r2-og-published-');
  });

  it('runs checkpoint saves even when the corresponding push fails', () => {
    for (const index of [earlySave, retrySave, finalSave]) {
      const step = steps[index];
      expect(step.if).toContain('always()');
      expect(step.uses).toBe('actions/cache/save@v6');
      expect(step.with?.path).toBe('.cache/r2-og-published-manifest.json');
      expect(step['continue-on-error']).toBe(true);
      expect(step.if).toContain("hashFiles('.cache/r2-og-published-manifest.json') != ''");
    }
    expect(steps[earlySave].if).toContain("vars.CDN_TARGET == 'r2' || vars.CDN_TARGET == 'both'");
    expect(steps[retrySave].if).toContain("steps.cdn-push-early-retry.outcome != 'skipped'");
    expect(steps[retrySave].if).toContain("vars.CDN_TARGET == 'r2' || vars.CDN_TARGET == 'both'");
    expect(steps[finalSave].if).toContain("vars.CDN_TARGET == 'r2' || vars.CDN_TARGET == 'both'");
  });

  it('uses distinct cache keys for checkpoint and final saves and removes stale promotion references', () => {
    const earlyKey = steps[earlySave].with?.key ?? '';
    const retryKey = steps[retrySave].with?.key ?? '';
    const finalKey = steps[finalSave].with?.key ?? '';
    expect(earlyKey).toBe('r2-og-published-${{ github.run_id }}-${{ hashFiles(\'.cache/r2-og-published-manifest.json\') }}');
    expect(retryKey).toBe(earlyKey);
    expect(finalKey).toBe('r2-og-published-${{ github.run_id }}-final-${{ hashFiles(\'.cache/r2-og-published-manifest.json\') }}');
    expect(deploySource).not.toContain('Promote successfully published R2 OG manifest');
    expect(deploySource).not.toContain('Carry the last published R2 OG manifest forward');
    expect(deploySource).not.toContain('steps.promote-r2-og-manifest.outputs.promoted');
  });

  it('restores for R2 and dual-publish deployments', () => {
    expect(steps[restore].if).toContain("vars.CDN_TARGET == 'r2' || vars.CDN_TARGET == 'both'");
    expect(steps[restore].with?.key).toBe('r2-og-published-${{ github.run_id }}');
    expect(String(steps[restore].with?.['restore-keys']).trim()).toBe('r2-og-published-');
  });
});
