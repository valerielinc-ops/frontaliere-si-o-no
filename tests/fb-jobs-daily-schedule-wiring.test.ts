import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const WORKFLOW_PATH = '.github/workflows/fb-jobs-daily-schedule.yml';

function workflow(): any {
  return YAML.parse(fs.readFileSync(WORKFLOW_PATH, 'utf8'));
}

describe('FB jobs daily schedule assembly wiring', () => {
  it('caches the exact no-summary dataset used by the scheduler', () => {
    const steps = workflow().jobs.schedule.steps;
    const key = steps.find((step: any) => step.id === 'assemble_cache_key');
    const restore = steps.find((step: any) => step.id === 'assemble_cache');
    const assemble = steps.find((step: any) => step.id === 'assemble');
    const save = steps.find((step: any) => step.uses === 'actions/cache/save@v6');

    expect(key?.uses).toBe('./.github/actions/assemble-jobs-cache-key');
    expect(key?.with?.args).toBe('--no-summaries');
    expect(restore?.uses).toBe('actions/cache/restore@v6');
    expect(restore?.with?.path).toBe('.cache/assemble-jobs');
    expect(restore?.with?.key).toBe('assemble-jobs-${{ runner.os }}-${{ steps.assemble_cache_key.outputs.key }}');
    expect(assemble?.run).toBe('node scripts/assemble-jobs-dataset.mjs --no-summaries');
    expect(save?.with?.path).toBe('.cache/assemble-jobs');
    expect(save?.with?.key).toBe('assemble-jobs-${{ runner.os }}-${{ steps.assemble_cache_key.outputs.key }}');

    const order = steps.map((step: any) => step.id || step.name);
    expect(order.indexOf('assemble_cache_key')).toBeLessThan(order.indexOf('assemble_cache'));
    expect(order.indexOf('assemble_cache')).toBeLessThan(order.indexOf('assemble'));
    expect(order.indexOf('assemble')).toBeLessThan(order.indexOf('Schedule FB jobs'));
  });
});
