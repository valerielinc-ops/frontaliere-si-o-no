import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const source = readFileSync(resolve(ROOT, 'scripts/sync-gsc-orphans.mjs'), 'utf8');

describe('GSC orphan synchronizer requests', () => {
  it('bounds token, property, analytics, and inspection calls', () => {
    expect(source).toContain('const GSC_FETCH_TIMEOUT_MS');
    expect(source).toContain('AbortSignal.timeout(GSC_FETCH_TIMEOUT_MS)');
    expect(source.match(/fetchGsc\(/g)).toHaveLength(5);
    expect(source.match(/await fetch\(/g) || []).toHaveLength(2);
    expect(source).toContain('res = await fetch(cdxUrl, { signal: controller.signal })');
    expect(source).toContain("const pageRes = await fetch(archiveUrl, {");
  });
});
