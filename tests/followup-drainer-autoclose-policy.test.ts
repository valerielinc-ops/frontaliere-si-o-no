import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verdictExitDecision } from '../scripts/ci/followup-drainer.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = readFileSync(resolve(ROOT, '.github/workflows/followup-drainer.yml'), 'utf8');
const DRAINER = readFileSync(resolve(ROOT, 'scripts/ci/followup-drainer.mjs'), 'utf8');

describe('follow-up drainer — autoclose policy', () => {
  it('keeps verified autoclose enabled for cron and exposes an emergency manual switch', () => {
    expect(WORKFLOW).toContain('workflow_dispatch:');
    expect(WORKFLOW).toContain('no_autoclose:');
    expect(WORKFLOW).toContain("default: '0'");
    expect(WORKFLOW).toContain("options: ['0', '1']");
    expect(WORKFLOW).toMatch(/FOLLOWUP_NO_AUTOCLOSE:\s*\$\{\{[\s\S]*?inputs\.no_autoclose/);
    expect(WORKFLOW).not.toMatch(/^\s+FOLLOWUP_NO_AUTOCLOSE:\s*['"]1['"]/m);
  });

  it('does not weaken the terminal verdict guard', () => {
    expect(verdictExitDecision('already-fixed').action).toBe('close');
    expect(verdictExitDecision('already-fixed', { noAutoclose: true }).action).toBe('flag');
    expect(DRAINER).toContain("process.env.FOLLOWUP_NO_AUTOCLOSE === '1'");
    expect(DRAINER).toContain('already-fixed: difetto verificato assente');
    expect(DRAINER).toContain('already-fixed, autoclose disattivato');
  });
});
