import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(resolve(ROOT, ".github/workflows/retry-code-check-after-body-edit.yml"), 'utf8');

describe('retry-code-check-body-edit contract', () => {
  it('keeps the source-backed automation invariants explicit', () => {
    expect(SOURCE).toContain("Retry code check after corrected PR body");
    expect(SOURCE).toContain("workflow_run");
    expect(SOURCE).toContain("const TESTS_WORKFLOW_EVENT = 'pull_request'");
    expect(SOURCE).toContain('isTrustedTestsRun');
    expect(SOURCE).toContain('run?.head_branch === branch');
    expect(SOURCE).toContain('pullRequestMatchesRun');
    expect(SOURCE).toContain('validRecoveryState');
    expect(SOURCE).toContain('currentRecoveryPr');
    expect(SOURCE).toContain('headRef');
    expect(SOURCE).toContain('runStartedBeforeLastBodyEdit');
    expect(SOURCE).toContain('cancelWorkflowRun');
    expect(SOURCE).toContain("const INTERRUPTED_CONCLUSIONS = ['cancelled', 'timed_out']");
    expect(SOURCE).toContain('interruptedRetry');
    expect(SOURCE).toContain('completedRecoveryRun');
    expect(SOURCE).toContain('Marker completed senza una run tests verificabile');
    expect(SOURCE).not.toMatch(/createWorkflowDispatch\(\{\s*\.\.\.repo,\s*workflow_id: 'tests\.yml'/u);
  });
});
