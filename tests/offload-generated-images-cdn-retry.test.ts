import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SOURCE = readFileSync(resolve(__dirname, '../scripts/offload-generated-images-cdn.mjs'), 'utf8');

describe('offload-generated-images CDN retry contract (follow-up #14673)', () => {
  it('keeps retries and per-asset timeout bounded', () => {
    expect(SOURCE).toMatch(/CDN_ASSET_RETRY_MAX_ATTEMPTS\s*=\s*5/u);
    expect(SOURCE).toMatch(/CDN_ASSET_RETRY_DELAY_MS\s*=\s*500/u);
    expect(SOURCE).toMatch(/CDN_ASSET_PROBE_TIMEOUT_MS\s*=\s*8_000/u);
    expect(SOURCE).toMatch(/const assetDeadline = Math\.min\(now\(\) \+ Math\.max\(1, timeoutMs\), globalDeadline\)/u);
  });

  it('retries only transient 5xx responses and shares the global deadline', () => {
    expect(SOURCE).toMatch(/response\.status < 500 \|\| response\.status > 599 \|\| attempt >= attemptsLimit/u);
    expect(SOURCE).toMatch(/Math\.min\(assetDeadline - now\(\), globalDeadline - now\(\)\)/u);
    expect(SOURCE).toMatch(/releaseCdnProbeResponse\(response\);\s*await sleepImpl\(backoffMs\)/su);
    expect(SOURCE).not.toMatch(/catch\s*\{[^}]*retryCdnAssetProbe/su);
  });
});
