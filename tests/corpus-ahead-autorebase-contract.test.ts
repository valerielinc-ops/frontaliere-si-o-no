import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(resolve(ROOT, 'scripts/ci/pr-autorebase.mjs'), 'utf8');

describe('autorebase parity contract', () => {
  it('uses merge-tree as the conflict oracle and leaves unknown states unchanged', () => {
    expect(SOURCE).toContain("spawnSync('git', ['merge-tree'");
    expect(SOURCE).toContain("state !== 'clean' && state !== 'conflicted'");
    expect(SOURCE).toContain('MAIN_CONFLICT_LABEL');
  });
});
