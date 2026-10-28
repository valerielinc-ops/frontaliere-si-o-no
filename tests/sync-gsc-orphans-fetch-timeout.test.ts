import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const source = readFileSync(resolve(ROOT, 'scripts/sync-gsc-orphans.mjs'), 'utf8');
const fetchSource = readFileSync(resolve(ROOT, 'scripts/lib/gsc-fetch.mjs'), 'utf8');

describe('GSC orphan synchronizer requests', () => {
  it('bounds token, property, analytics, and inspection calls', () => {
    expect(fetchSource).toContain('const DEFAULT_TIMEOUT_MS');
    expect(fetchSource).toContain('const DEFAULT_ATTEMPTS = 3');
    expect(fetchSource).toContain('AbortSignal.timeout(timeoutMs)');
    expect(fetchSource).toContain('isRetryableStatus');
    expect(source.match(/await fetchGsc\(/g)).toHaveLength(4);
    expect(source.match(/await fetch\(/g) || []).toHaveLength(2);
    expect(source).toContain('res = await fetch(cdxUrl, { signal: controller.signal })');
    expect(source).toContain("const pageRes = await fetch(archiveUrl, {");
  });
});
