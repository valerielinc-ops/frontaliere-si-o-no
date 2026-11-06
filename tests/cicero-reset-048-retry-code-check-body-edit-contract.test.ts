import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(resolve(ROOT, ".github/workflows/retry-code-check-after-body-edit.yml"), 'utf8');

describe('retry-code-check-body-edit contract', () => {
  it('keeps the source-backed automation invariants explicit', () => {
    expect(SOURCE).toContain("Retry code check after corrected PR body");
    expect(SOURCE).toContain("workflow_run");
    expect(SOURCE).toContain('validRecoveryState');
    expect(SOURCE).toContain('currentRecoveryPr');
  });
});
