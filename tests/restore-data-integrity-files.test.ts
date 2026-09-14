import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SOURCE = readFileSync(
  resolve(import.meta.dirname, '../scripts/ci/restore-data-integrity-files.mjs'),
  'utf8',
);

describe('data-integrity conflict recovery', () => {
  it('reads the guard payload from the environment and restores every listed file', () => {
    expect(SOURCE).toContain('process.env.BEFORE');
    expect(SOURCE).toContain('process.env.VIOLATIONS');
    expect(SOURCE).toContain("['checkout', before, '--', violation.file]");
    expect(SOURCE).toContain("['add', '--', violation.file]");
    expect(SOURCE).toContain('Array.isArray(violations)');
  });
});
