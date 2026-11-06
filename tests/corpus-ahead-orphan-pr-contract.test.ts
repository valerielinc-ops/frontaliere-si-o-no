import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(resolve(ROOT, 'scripts/ci/orphan-pr-custodian.mjs'), 'utf8');

describe('orphan PR custodian contract', () => {
  it('keeps autonomous ownership labels in the custody boundary', () => {
    expect(SOURCE).toContain('Custode delle PR orfane');
    expect(SOURCE).toContain('agent:autofix');
  });
});
