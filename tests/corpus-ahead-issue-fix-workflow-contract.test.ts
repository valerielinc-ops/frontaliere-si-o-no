import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(resolve(ROOT, '.github/workflows/issue-fix.yml'), 'utf8');

describe('issue fix workflow contract', () => {
  it('keeps per-issue serialization and the deterministic fixer entrypoint', () => {
    expect(SOURCE).toContain('Issue fix (Codex Luna Max');
    expect(SOURCE).toContain('per-issue');
  });
});
