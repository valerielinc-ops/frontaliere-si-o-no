import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(resolve(ROOT, "scripts/batch-add-faq-to-articles.mjs"), 'utf8');

describe('batch-add-faq contract', () => {
  it('keeps the source-backed automation invariants explicit', () => {
    expect(SOURCE).toContain("callLLM");
    expect(SOURCE).toContain("FAQ");
  });

  it('uses the shared per-pair locale verdict and preserves rejection diagnostics', () => {
    expect(SOURCE).toContain('wrongLocalePair');
    expect(SOURCE).toContain('source-function-words=');
    expect(SOURCE).toContain('translation rejected: FAQ not written');
  });
});
