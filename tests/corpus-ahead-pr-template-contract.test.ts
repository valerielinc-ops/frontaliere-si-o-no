import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = readFileSync(resolve(ROOT, '.github/pull_request_template.md'), 'utf8');

describe('pull request template parity contract', () => {
  it('keeps both mandatory review sections and one-issue close guidance', () => {
    expect(TEMPLATE).toContain('## Implementato');
    expect(TEMPLATE).toContain('## Non implementato (ancora)');
    expect(TEMPLATE).toMatch(/Closes #N/);
    expect(TEMPLATE).toContain('una keyword per issue');
  });
});
