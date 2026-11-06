import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(resolve(ROOT, "scripts/ci/unwedge-pages-deploy-queue.mjs"), 'utf8');

describe('unwedge-pages-deploy-queue contract', () => {
  it('keeps the source-backed automation invariants explicit', () => {
    expect(SOURCE).toContain("pages-deploy");
    expect(SOURCE).toContain("github-pages");
  });
});
