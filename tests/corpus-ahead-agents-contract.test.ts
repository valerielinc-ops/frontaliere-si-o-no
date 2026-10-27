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

  it('keeps the shared PR body and scoped fixer contract aligned', () => {
    for (const literal of [
      'Contratto comune del PR body',
      'PR concatenata #N',
      'falso positivo',
      'scripts/ci/pr-body-check-gate.mjs --body-file',
      'wip(issue-N): checkpoint pre-test',
      'npx vitest run <path/glob pertinente>',
    ]) expect(SOURCE).toContain(literal);
  });
});
