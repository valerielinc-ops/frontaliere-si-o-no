import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';

const workflow = YAML.parse(readFileSync(resolve('.github/workflows/deploy.yml'), 'utf8'));
const buildSteps = workflow.jobs['build-locale'].steps as Array<Record<string, any>>;

describe('deploy workflow write-collisions artifact upload', () => {
  it('retries one failed upload and keeps a second failure blocking', () => {
    const initial = buildSteps.find((step) => step.id === 'write_collisions_analysis');
    const retry = buildSteps.find((step) => step.name === 'Retry write-collisions analysis upload');

    expect(initial).toBeDefined();
    expect(retry).toBeDefined();
    expect(initial!.uses).toBe('actions/upload-artifact@v7');
    expect(initial!['continue-on-error']).toBe(true);
    expect(retry!.if).toContain("steps.write_collisions_analysis.outcome == 'failure'");
    expect(retry!.uses).toBe(initial!.uses);
    expect(retry!.with.name).toBe(initial!.with.name);
    expect(retry!.with.path).toBe(initial!.with.path);
    expect(retry!.with.overwrite).toBe(true);
    expect(retry!['continue-on-error']).toBeUndefined();
  });
});
