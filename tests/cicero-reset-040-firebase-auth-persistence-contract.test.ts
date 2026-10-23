import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(resolve(ROOT, "services/firebaseAuthPersistence.ts"), 'utf8');

describe('firebase-auth-persistence contract', () => {
  it('keeps the source-backed automation invariants explicit', () => {
    expect(SOURCE).toContain("setFirebaseApiKey");
    expect(SOURCE).toContain("Remote Config");
  });
});
