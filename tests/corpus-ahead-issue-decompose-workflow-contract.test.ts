import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(resolve(ROOT, '.github/workflows/issue-decompose.yml'), 'utf8');

describe('issue decompose workflow contract', () => {
  it('keeps the deferred route for oversized autonomous fixes', () => {
    expect(SOURCE).toContain('Issue decompose (Codex Luna Max');
    expect(SOURCE).toContain('automation-deferred');
  });
});
