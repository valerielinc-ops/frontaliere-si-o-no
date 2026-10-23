import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(resolve(ROOT, '.github/workflows/stale-pr-rescuer.yml'), 'utf8');

describe('stale PR rescuer workflow contract', () => {
  it('keeps workflow-validation drift as an observable rescue class', () => {
    expect(SOURCE).toContain('Stale PR rescuer');
    expect(SOURCE).toContain('workflow-validation drift');
  });
});
