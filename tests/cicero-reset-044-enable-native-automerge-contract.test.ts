import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(resolve(ROOT, ".github/workflows/enable-native-automerge.yml"), 'utf8');

describe('enable-native-automerge contract', () => {
  it('keeps the source-backed automation invariants explicit', () => {
    expect(SOURCE).toContain("Enable native auto-merge");
    expect(SOURCE).toContain("pull_request_review");
  });
});
