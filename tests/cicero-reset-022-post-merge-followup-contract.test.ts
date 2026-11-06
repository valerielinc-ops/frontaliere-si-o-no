import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(resolve(ROOT, ".github/workflows/post-merge-followup.yml"), 'utf8');

describe('post-merge-followup contract', () => {
  it('keeps the source-backed automation invariants explicit', () => {
    expect(SOURCE).toContain("Post-merge follow-up triage");
    expect(SOURCE).toContain("collect-followup-batch.mjs");
  });
});
