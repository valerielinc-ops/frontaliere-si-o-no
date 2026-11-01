import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(resolve(ROOT, "scripts/ci/review-gate.mjs"), 'utf8');

describe('review-gate contract', () => {
  it('keeps the source-backed automation invariants explicit', () => {
    expect(SOURCE).toContain("Important");
    expect(SOURCE).toContain("fetchPrFiles");
    expect(SOURCE).toContain('REVIEW_GATE_RATE_LIMIT_RETRIES = 1');
    expect(SOURCE).toContain("failure_kind");
    expect(SOURCE).toContain("REVIEW_REVISION");
  });
});
