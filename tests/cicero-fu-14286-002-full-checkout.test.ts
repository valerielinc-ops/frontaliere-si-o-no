import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const WORKFLOW = execFileSync('git', ['show', 'HEAD:.github/workflows/tests.yml'], {
  encoding: 'utf8',
});

describe('FU-2026-10-21-002 — related tests use the trusted full-checkout profile', () => {
  it('keeps complete history with a treeless fetch instead of a shallow clone', () => {
    const checkoutStart = WORKFLOW.indexOf('CHECKOUT UNICO per tutte e quattro le famiglie');
    expect(checkoutStart).toBeGreaterThan(-1);
    const checkout = WORKFLOW.slice(checkoutStart, WORKFLOW.indexOf('      # per `compare`', checkoutStart));

    expect(checkout).toContain('actions/checkout@v7');
    expect(checkout).toMatch(/fetch-depth:\s*0/);
    expect(checkout).toMatch(/filter:\s*tree:0/);
    expect(checkout).not.toMatch(/^\s+sparse-checkout(?:-cone-mode)?:/m);
  });

  it('invokes the related selector both for planning and for the PR verdict', () => {
    expect(WORKFLOW).toContain('node scripts/ci/run-related-tests.mjs --select-only');
    expect(WORKFLOW).toContain('node scripts/ci/run-related-tests.mjs --reporter=default');
    expect(WORKFLOW).toContain('CHANGED_PATHS_STATUS_FILE: changed-paths-status.txt');
  });
});
