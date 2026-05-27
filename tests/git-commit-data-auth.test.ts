// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const GIT_COMMIT_DATA = readFileSync(resolve(ROOT, 'scripts/lib/git-commit-data.sh'), 'utf-8');

const DEDICATED_WORKFLOWS = [
  '.github/workflows/update-jobs-spital-lachen.yml',
  '.github/workflows/update-jobs-hopital-de-lavaux.yml',
  '.github/workflows/update-jobs-hoch-health.yml',
] as const;

describe('git-commit-data.sh GitHub auth hardening', () => {
  it('prefers workflow/checkout auth over stale Remote Config GITHUB_PAT values', () => {
    expect(GIT_COMMIT_DATA).toContain('local token="${GH_TOKEN:-${GITHUB_TOKEN:-}}"');
    expect(GIT_COMMIT_DATA).toContain('CHECKOUT_GIT_EXTRAHEADER=');
    expect(GIT_COMMIT_DATA).not.toContain('GITHUB_PAT:-');
    expect(GIT_COMMIT_DATA).toContain('git config --local http.https://github.com/.extraheader');
  });

  it('refreshes git auth before every network operation in the retry loop', () => {
    const networkOps = [...GIT_COMMIT_DATA.matchAll(/^\s*git (fetch|pull|push)\b/gm)];
    expect(networkOps.length).toBeGreaterThan(0);

    for (const match of networkOps) {
      const before = GIT_COMMIT_DATA.slice(Math.max(0, match.index - 160), match.index);
      expect(before, `missing ensure_git_auth before: ${match[0]}`).toMatch(/ensure_git_auth\s*$/m);
    }
  });
});

describe('dedicated crawler workflows using git-commit-data.sh', () => {
  it('pass github.token explicitly to the commit step for affected workflows', () => {
    for (const workflowPath of DEDICATED_WORKFLOWS) {
      const workflow = readFileSync(resolve(ROOT, workflowPath), 'utf-8');
      expect(workflow).toMatch(/- name: Commit and push[\s\S]*?env:\n[\s\S]*?GH_TOKEN: \$\{\{ github\.token \}\}/);
    }
  });
});
