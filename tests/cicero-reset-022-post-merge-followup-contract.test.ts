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

  it('parallelizes reads without racing bridge mutations', () => {
    const writeStart = SOURCE.indexOf('**Scritture seriali e verificabili:**');
    const readStart = SOURCE.indexOf('**Token-lever (solo letture):**');

    expect(writeStart).toBeGreaterThan(-1);
    expect(readStart).toBeGreaterThan(writeStart);

    const writeContract = SOURCE.slice(writeStart, readStart);
    expect(writeContract).toContain('gh issue create/edit/comment');
    expect(writeContract).toContain('gh pr comment');
    expect(writeContract).toMatch(/non avviare in parallelo/i);
    expect(writeContract).toMatch(/massimo 3 tentativi/i);
    expect(writeContract).toContain('ogni PR del batch positivo');
    expect(writeContract).toContain('Triage completata');
    expect(SOURCE.slice(readStart, readStart + 300)).toContain('non autorizza scritture concorrenti');
  });
});
