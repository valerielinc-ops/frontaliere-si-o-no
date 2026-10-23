import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(resolve(ROOT, "tests/conflict-handoff-reconcile.test.ts"), 'utf8');

describe('conflict-handoff-reconcile contract', () => {
  it('keeps the source-backed automation invariants explicit', () => {
    expect(SOURCE).toContain("Chiusura degli hand-off");
    expect(SOURCE).toContain("FOLLOWUP_NO_AUTOCLOSE=1");
  });
});
