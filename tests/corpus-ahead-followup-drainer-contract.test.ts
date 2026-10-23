import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(resolve(ROOT, 'scripts/ci/followup-drainer.mjs'), 'utf8');

describe('follow-up drainer contract', () => {
  it('keeps bounded attempts and the queued-label promotion path', () => {
    expect(SOURCE).toContain('MAX_ATTEMPTS');
    expect(SOURCE).toContain('agent:fix-queued');
    expect(SOURCE).toContain('quotaPromotionDecision');
  });
});
