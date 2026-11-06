import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

describe('campaign goal provider requests', () => {
  it('bounds OAuth, GSC, and both GA4 request paths', () => {
    const source = readFileSync(resolve(ROOT, 'scripts/campaign-goal-check.mjs'), 'utf8');
    expect(source).toContain('const CAMPAIGN_PROVIDER_TIMEOUT_MS = 30_000;');
    expect(source).toContain('AbortSignal.timeout(CAMPAIGN_PROVIDER_TIMEOUT_MS)');
    expect(source.match(/fetchCampaignProvider\(/g)).toHaveLength(5);
    expect(source.match(/await fetch\(/g) || []).toHaveLength(0);
  });
});
