import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(resolve(ROOT, 'scripts/ci/native-automerge-gate.mjs'), 'utf8');

describe('native auto-merge parity contract', () => {
  it('requires the approving review to belong to the current head', () => {
    expect(SOURCE).toMatch(/review\?\.commit_id === head/);
    expect(SOURCE).toContain('firstTerminalReviewOnHead');
  });
});
