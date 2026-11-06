import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(resolve(ROOT, 'scripts/ci/check-quota-backoff.mjs'), 'utf8');

describe('quota backoff parity contract', () => {
  it('keeps the active Claude beacon separate from the Codex fallback', () => {
    expect(SOURCE).toContain('quotaFallbackDecision');
    expect(SOURCE).toMatch(/quotaBlocked: active && !codexFallbackMode/);
    expect(SOURCE).toContain('resetsAt');
  });
});
