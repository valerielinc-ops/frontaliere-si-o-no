import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(resolve(ROOT, ".github/workflows/pr-redcheck-fixer.yml"), 'utf8');

describe('pr-redcheck-fixer contract', () => {
  it('keeps the source-backed automation invariants explicit', () => {
    expect(SOURCE).toContain("PR ❌ check fixer");
    expect(SOURCE).toContain("check_suite");
    expect(SOURCE).toContain('run_pr_match');
    expect(SOURCE).toContain('run_event');
  });
});
