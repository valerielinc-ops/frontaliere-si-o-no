import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const issueFix = execFileSync('git', ['show', 'HEAD:.github/workflows/issue-fix.yml'], { encoding: 'utf8' });
const autorebase = execFileSync('git', ['show', 'HEAD:scripts/ci/pr-autorebase.mjs'], { encoding: 'utf8' });

describe('FU-2026-10-17-006 — app-token and autorebase sparse wiring', () => {
  it('keeps the verified workflow capability separate from token presence', () => {
    expect(issueFix).toContain('APP_TOKEN_WORKFLOWS');
    expect(issueFix).toContain('workflows-scope capability guard');
    expect(issueFix).toContain('clear-checkout-git-credentials.sh');
    expect(issueFix).toContain('Mint GitHub App token');
  });

  it('keeps generated-file closure and sparse safety in the autorebase path', () => {
    expect(autorebase).toContain('generated-files-registry.mjs');
    expect(autorebase).toContain('sparse-checkout');
    expect(autorebase).toContain('origin/main');
  });
});
