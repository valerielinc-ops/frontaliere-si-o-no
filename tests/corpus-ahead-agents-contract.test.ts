import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(resolve(ROOT, 'AGENTS.md'), 'utf8');

describe('agent instructions contract', () => {
  it('keeps the non-negotiable quality guard visible to agents', () => {
    expect(SOURCE).toContain('## Non-Negotiables');
    expect(SOURCE).toContain('Mai abbassare');
  });
});
