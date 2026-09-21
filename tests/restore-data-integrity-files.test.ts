import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SOURCE = readFileSync(
  resolve(import.meta.dirname, '../scripts/ci/restore-data-integrity-files.mjs'),
  'utf8',
);
const WORKFLOW_SOURCE = readFileSync(
  resolve(import.meta.dirname, '../.github/workflows/guard-data-integrity.yml'),
  'utf8',
);

describe('data-integrity conflict recovery', () => {
  it('reads the guard payload from the environment and restores every listed file', () => {
    expect(SOURCE).toContain('process.env.BEFORE');
    expect(SOURCE).toContain('process.env.VIOLATIONS');
    expect(SOURCE).toContain(
      "['checkout', '--ignore-skip-worktree-bits', before, '--', violation.file]",
    );
    expect(SOURCE).toContain("['add', '--sparse', '--', violation.file]");
    expect(SOURCE).toContain('Array.isArray(violations)');
  });

  it('restores sparse-excluded files in the main guard workflow', () => {
    expect(WORKFLOW_SOURCE).toContain(
      'git checkout --ignore-skip-worktree-bits "$BEFORE" -- "$f"',
    );
    expect(WORKFLOW_SOURCE).toContain('git add --sparse -- "$f"');
  });
});
