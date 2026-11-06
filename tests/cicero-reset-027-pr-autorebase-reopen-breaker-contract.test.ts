import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(resolve(ROOT, "tests/pr-autorebase-reopen-breaker.test.ts"), 'utf8');

describe('pr-autorebase-reopen-breaker contract', () => {
  it('keeps the source-backed automation invariants explicit', () => {
    expect(SOURCE).toContain("reopenToRetrigger");
    expect(SOURCE).toContain("reopened");
  });
});
