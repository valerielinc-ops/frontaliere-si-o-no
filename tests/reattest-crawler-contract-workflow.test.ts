import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');
const WORKFLOW_PATH = path.join(ROOT, '.github/workflows/reattest-crawler-contract.yml');
const WORKFLOW = fs.readFileSync(WORKFLOW_PATH, 'utf8');

describe('crawler contract reattestation workflow', () => {
  it('runs required PR checks and delegates the merge to native auto-merge', () => {
    assert.match(WORKFLOW, /git commit -m "ci: reattest crawler contract to landed main"/);
    assert.doesNotMatch(WORKFLOW, /reattest crawler contract to landed main \[skip ci\]/);
    assert.match(WORKFLOW, /gh pr merge "\$pr_number"[\s\S]*?--auto --squash --delete-branch --match-head-commit "\$head_sha"/);
    assert.doesNotMatch(WORKFLOW, /\n\s+--admin(?:\s|$)/);
  });
});
