import { describe, expect, it } from 'vitest';
import { AD_CLIENT } from '../services/adsenseSlots.ts';
import { resolveAdSenseAccount } from '../scripts/lib/adsense-account.mjs';

describe('resolveAdSenseAccount', () => {
  it('maps the configured publisher client to its AdSense API account', () => {
    expect(resolveAdSenseAccount()).toBe(`accounts/${AD_CLIENT.replace(/^ca-/, '')}`);
  });

  it('fails closed when the publisher client cannot identify an AdSense account', () => {
    for (const client of ['', 'ca-invalid', 'pub-123', null, 123]) {
      expect(() => resolveAdSenseAccount(client)).toThrow(/AD_CLIENT/);
    }
  });
});
