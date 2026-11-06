import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(resolve(ROOT, 'scripts/ci/lib/vitestCheck.mjs'), 'utf8');

describe('vitest selection parity contract', () => {
  it('selects completed verdicts on one head instead of stale runs', () => {
    expect(SOURCE).toContain('latestCompletedRunSelectionByName');
    expect(SOURCE).toMatch(/run\.head_sha\.toLowerCase\(\)/);
    expect(SOURCE).toMatch(/status !== 'completed'/);
  });
});
