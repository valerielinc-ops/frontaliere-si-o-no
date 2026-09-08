import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT = 'scripts/ci/check-dependency-free-import-closure.mjs';
const WORKFLOW = '.github/workflows/followup-drainer.yml';

describe('followup-drainer dependency-free import closure (#7341)', () => {
  it('walks the complete closure and reports only the documented guarded package', () => {
    const output = execFileSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8' });
    expect(output).toMatch(/dependency-free import closure OK: \d+ files/);
    expect(output).toContain('guarded package exception: scripts/load-rc-env.mjs -> firebase-admin');
  });

  it('runs the closure check before the zero-dependency drain entrypoint', () => {
    const document = YAML.parse(readFileSync(resolve(ROOT, WORKFLOW), 'utf8')) as any;
    const steps = Object.values(document.jobs ?? {}).flatMap((job: any) => job.steps ?? []);
    const checkIndex = steps.findIndex((step: any) => step.name === 'Verify dependency-free import closure');
    const drainIndex = steps.findIndex((step: any) =>
      typeof step.run === 'string' && step.run.includes('node scripts/ci/followup-drainer.mjs'),
    );
    expect(checkIndex).toBeGreaterThan(-1);
    expect(drainIndex).toBeGreaterThan(checkIndex);
    expect(steps[checkIndex].run).toBe(`node ${SCRIPT}`);
    expect(steps.some((step: any) => typeof step.run === 'string' && /\bnpm ci\b/.test(step.run))).toBe(false);
  });
});
