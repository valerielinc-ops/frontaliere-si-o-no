import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(new URL('../.github/workflows/issue-fix.yml', import.meta.url), 'utf8');

describe('issue-fix FIX_OUTCOME backstop', () => {
  it('non lascia che un marker storico sopprima il run corrente', () => {
    expect(workflow).toContain('RUN_STARTED_AT=$(gh api "repos/$REPO/actions/runs/$GITHUB_RUN_ID"');
    expect(workflow).toContain("--jq '.run_started_at // .created_at'");
    expect(workflow).toContain('--arg started "$RUN_STARTED_AT"');
    expect(workflow).toContain('.createdAt // "") >= $started');
    expect(workflow).not.toContain(
      '--jq \'[.comments[].body | select(test("<!-- FIX_OUTCOME:"))] | length\'',
    );
  });
});
