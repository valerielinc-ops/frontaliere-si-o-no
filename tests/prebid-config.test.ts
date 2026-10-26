import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadPrebidConfig(raw: string) {
  vi.resetModules();
  vi.stubEnv('VITE_PREBID_CONFIG', raw);
  return import('@/services/prebidConfig');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('prebidConfig', () => {
  it('keeps valid neighboring bids while filtering malformed entries', async () => {
    const { bidsForAdUnit, hasConfiguredBidders } = await loadPrebidConfig(
      JSON.stringify({
        '   ': [{ bidder: 'criteo', params: {} }],
        ' /valid-ad-unit ': [
          { bidder: '   ', params: { networkId: 1 } },
          { bidder: 'sovrn', params: [] },
          { bidder: ' criteo ', params: { networkId: 12345 } },
          { bidder: 'medianet', params: null },
          { bidder: 'yieldlab', params: { tagid: '998877' } },
        ],
      }),
    );

    expect(bidsForAdUnit('/valid-ad-unit')).toEqual([
      { bidder: 'criteo', params: { networkId: 12345 } },
      { bidder: 'yieldlab', params: { tagid: '998877' } },
    ]);
    expect(bidsForAdUnit('')).toEqual([]);
    expect(hasConfiguredBidders()).toBe(true);
  });

  it('does not throw or expose invalid bidder arrays', async () => {
    const { bidsForAdUnit, hasConfiguredBidders } = await loadPrebidConfig(
      JSON.stringify({
        '/invalid-only': [
          null,
          { bidder: '', params: {} },
          { bidder: 'sovrn', params: null },
          { bidder: 'criteo', params: [] },
        ],
        '/not-an-array': { bidder: 'criteo', params: {} },
      }),
    );

    expect(bidsForAdUnit('/invalid-only')).toEqual([]);
    expect(bidsForAdUnit('/not-an-array')).toEqual([]);
    expect(hasConfiguredBidders()).toBe(false);
  });
});
