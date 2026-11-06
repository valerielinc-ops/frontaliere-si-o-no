import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(resolve(ROOT, '.github/workflows/followup-drainer.yml'), 'utf8');

describe('follow-up drainer workflow contract', () => {
  it('keeps queued follow-ups delegated to the bounded drainer', () => {
    expect(SOURCE).toContain('agent:fix-queued');
    expect(SOURCE).toContain('followup-drainer.mjs');
  });
});
