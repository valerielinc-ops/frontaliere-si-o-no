import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(resolve(ROOT, 'ISSUES.md'), 'utf8');

describe('issue automation instructions contract', () => {
  it('keeps the daily follow-up bucket contract documented', () => {
    expect(SOURCE).toContain('Issue Automation Instructions');
    expect(SOURCE).toContain('Bucket giornaliero follow-up');
  });

  it('keeps the fixer checkpoint, scoped test and body-file rules documented', () => {
    for (const literal of [
      'wip(issue-N): checkpoint pre-test',
      'npx vitest run <path/glob pertinente>',
      'node scripts/ci/pr-body-check-gate.mjs --body-file <file>',
      'Closes #N',
      'Addresses #N',
      'PR concatenata #N',
      'blocked: <causa esterna reale>',
      'falso positivo',
      'Nessuno',
    ]) expect(SOURCE).toContain(literal);
  });
});
