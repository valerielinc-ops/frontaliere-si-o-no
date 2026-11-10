/**
 * The last published R2 OG manifest must survive a build leg that does not
 * promote a new one.
 *
 * Without the carry step the manifest is only saved after a successful OG copy.
 * The repository cache sits at its 10 GB cap and evicts by last access, and the
 * IT leg restores the manifest at its start and only later saves several GB of
 * other caches, so one non-promoting leg is enough to lose it. The next leg then
 * copies every OG card (`[r2-og] mode=full`, ~1.19 GB on 42746424682) and its
 * early CDN push runs out of time.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';

type Step = { name?: string; id?: string; if?: string; uses?: string; with?: Record<string, string> };

const workflow = YAML.parse(readFileSync(resolve(process.cwd(), '.github/workflows/deploy.yml'), 'utf8'));
const steps: Step[] = workflow.jobs['build-locale'].steps;
const indexOf = (name: string) => steps.findIndex((s) => s.name === name);

describe('deploy.yml — R2 OG published manifest carry', () => {
  const restore = indexOf('Restore last published R2 OG manifest');
  const promote = indexOf('Promote successfully published R2 OG manifest');
  const save = indexOf('Save successfully published R2 OG manifest');
  const carry = indexOf('Carry the last published R2 OG manifest forward');

  it('has the restore, promote, promoted-save and carry steps in that order', () => {
    expect(restore).toBeGreaterThan(-1);
    expect(promote).toBeGreaterThan(restore);
    expect(save).toBeGreaterThan(promote);
    expect(carry).toBeGreaterThan(save);
  });

  it('carries the restored manifest exactly when nothing was promoted', () => {
    const cond = steps[carry].if ?? '';
    expect(cond).toContain('always()');
    expect(cond).toContain("steps.promote-r2-og-manifest.outputs.promoted != 'true'");
    expect(cond).toContain("hashFiles('.cache/r2-og-published-manifest.json') != ''");
    expect(cond).toContain("matrix.locale == 'it'");
    expect(cond).toContain("vars.CDN_TARGET == 'r2'");
    expect(steps[save].if).toContain("steps.promote-r2-og-manifest.outputs.promoted == 'true'");
  });

  it('saves the same file under the same run key as the promoted save, without failing the leg', () => {
    const carryStep = steps[carry];
    const saveStep = steps[save];
    expect(carryStep.uses).toMatch(/^actions\/cache\/save@/);
    expect(carryStep.with?.path).toBe(saveStep.with?.path);
    expect(carryStep.with?.key).toBe(saveStep.with?.key);
    expect(carryStep.with?.key).toBe('r2-og-published-${{ github.run_id }}');
    expect((carryStep as { 'continue-on-error'?: boolean })['continue-on-error']).toBe(true);
  });

  it('restores by prefix, so any carried run key is found by the next leg', () => {
    const restoreStep = steps[restore];
    expect(restoreStep.with?.key).toBe('r2-og-published-${{ github.run_id }}');
    expect(String(restoreStep.with?.['restore-keys']).trim()).toBe('r2-og-published-');
  });
});
