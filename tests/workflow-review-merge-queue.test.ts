import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const TESTS_WORKFLOW = readFileSync(resolve(ROOT, '.github/workflows/tests.yml'), 'utf8');

describe('tests workflow — review gate and native merge queue', () => {
  it('validates merge-group refs for the native GitHub Merge Queue', () => {
    expect(TESTS_WORKFLOW).toMatch(/^\s+merge_group:\s*$/m);
  });

  it('keeps Claude approval as a blocking gate on pull-request runs', () => {
    expect(TESTS_WORKFLOW).toContain('- name: Require approving Claude review');
    expect(TESTS_WORKFLOW).toContain("id: review_gate");
    expect(TESTS_WORKFLOW).toContain('manca LGTM oppure è presente un finding');
  });

  it('does not rebase or load Remote Config from the test job', () => {
    expect(TESTS_WORKFLOW).not.toMatch(/autorebase|Rebase near-merge PRs/i);
    expect(TESTS_WORKFLOW).not.toMatch(/load-rc-env\.mjs/);
  });
});
