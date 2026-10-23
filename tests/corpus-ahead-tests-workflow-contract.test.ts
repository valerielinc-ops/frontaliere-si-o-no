import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(resolve(ROOT, '.github/workflows/tests.yml'), 'utf8');

describe('tests workflow contract', () => {
  it('keeps the required unit/integration check and manual recovery entrypoint', () => {
    expect(SOURCE).toContain('vitest (unit + integration)');
    expect(SOURCE).toContain('workflow_dispatch:');
  });
});
