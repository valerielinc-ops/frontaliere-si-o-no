import { describe, expect, it } from 'vitest';
import { parsePrebidConfig } from '@/services/prebidConfig';

describe('parsePrebidConfig', () => {
  it('keeps valid bids and rejects malformed keys, bidders, and params', () => {
    const config = parsePrebidConfig(JSON.stringify({
      ' /valid-slot ': [
        { bidder: '  criteo ', params: { networkId: 123 } },
        { bidder: ' ', params: { networkId: 456 } },
        { bidder: 'array-params', params: [] },
        { bidder: 'missing-params' },
      ],
      '   ': [{ bidder: 'ignored', params: {} }],
    }));

    expect(config).toEqual({ '/valid-slot': [{ bidder: 'criteo', params: { networkId: 123 } }] });
  });

  it('returns an empty map for malformed JSON or non-object roots', () => {
    expect(parsePrebidConfig('{bad json')).toEqual({});
    expect(parsePrebidConfig(JSON.stringify([]))).toEqual({});
  });
});
