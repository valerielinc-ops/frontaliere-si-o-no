import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(resolve(ROOT, "scripts/ci/gate-minted-followups.mjs"), 'utf8');

describe('gate-minted-followups contract', () => {
  it('keeps the source-backed automation invariants explicit', () => {
    expect(SOURCE).toContain("gate DETERMINISTICO");
    expect(SOURCE).toContain("hasFalsifiableAcceptance()");
  });
});
