/**
 * Composite action `npm-ci-cached` (perf-plan email senders, A3): stessa cache
 * di node_modules di send-job-alerts.yml. La chiave deve restare identica a
 * quella del workflow della jobalert (cosi' i due condividono l'hit) e `npm ci`
 * deve girare solo su miss.
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const action: any = YAML.parse(fs.readFileSync(path.join(ROOT, '.github/actions/npm-ci-cached/action.yml'), 'utf8'));
const steps: any[] = action.runs.steps;
const jobAlerts: any = YAML.parse(fs.readFileSync(path.join(ROOT, '.github/workflows/send-job-alerts.yml'), 'utf8'), { logLevel: 'silent' });

describe('npm-ci-cached', () => {
  it('e una composite action con setup-node, cache e npm ci condizionato', () => {
    expect(action.runs.using).toBe('composite');
    const cache = steps.find((s) => s.id === 'node-modules-cache');
    expect(cache.uses).toMatch(/^actions\/cache@/);
    expect(cache.with.path).toBe('node_modules');
    expect(cache.with.key).toContain("hashFiles('package-lock.json')");
    expect(cache.with.key).toContain('node${{ inputs.node-version }}');
    expect(cache.with['restore-keys']).toBeUndefined();
    const install = steps.find((s) => s.name === 'Install dependencies');
    expect(install.run).toBe('npm ci');
    expect(install.if).toContain("steps.node-modules-cache.outputs.cache-hit != 'true'");
    expect(install.shell).toBe('bash');
    expect(action.inputs['node-version'].default).toBe('22');
  });

  it('non usa cache: npm di setup-node (nessun save della ~/.npm su ref di PR)', () => {
    const setup = steps.find((s) => String(s.uses).startsWith('actions/setup-node@'));
    expect(setup.with.cache).toBeUndefined();
  });

  it('la chiave coincide con quella di send-job-alerts.yml a parita di major (cache condivisa)', () => {
    const jobSteps: any[] = jobAlerts.jobs['send-alerts'].steps;
    const reference = jobSteps.find((s) => s.id === 'node-modules-cache');
    const resolved = String(steps.find((s) => s.id === 'node-modules-cache').with.key).replace('${{ inputs.node-version }}', '22');
    expect(resolved).toBe(reference.with.key);
  });
});
