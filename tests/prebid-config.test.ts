import { describe, expect, it } from 'vitest';
import { parsePrebidConfig } from '@/services/prebidConfig';

describe('prebidConfig', () => {
  it('keeps valid neighboring bids while filtering malformed entries', () => {
    const config = parsePrebidConfig(
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

    expect(config['/valid-ad-unit']).toEqual([
      { bidder: 'criteo', params: { networkId: 12345 } },
      { bidder: 'yieldlab', params: { tagid: '998877' } },
    ]);
    expect(config['']).toBeUndefined();
    expect(Object.keys(config)).toEqual(['/valid-ad-unit']);
  });

  it('does not throw or expose invalid bidder arrays', () => {
    const config = parsePrebidConfig(
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

    expect(config).toEqual({});
  });
});
