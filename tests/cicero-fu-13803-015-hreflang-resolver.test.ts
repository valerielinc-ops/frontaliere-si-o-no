import { describe, expect, it } from 'vitest';
import { createBoundedHreflangTargetResolver } from '../scripts/lib/hreflang-reciprocity.mjs';

describe('bounded hreflang target resolver (#13803 FU-015)', () => {
  it('evicts a rejected in-flight lookup so a later audit can retry it', async () => {
    let reads = 0;
    const resolver = createBoundedHreflangTargetResolver(async () => {
      reads += 1;
      throw new Error('temporary target read failure');
    }, { maxEntries: 2 });

    await expect(resolver.resolve('https://frontaliereticino.ch/broken?attempt=1')).rejects.toThrow(
      'temporary target read failure',
    );
    expect(resolver.cacheSize).toBe(0);

    await expect(resolver.resolve('https://frontaliereticino.ch/broken/')).rejects.toThrow(
      'temporary target read failure',
    );
    expect(reads).toBe(2);
    expect(resolver.cacheSize).toBe(0);
  });

  it('shares normalized trailing-slash and query variants within the bounded cache', async () => {
    let reads = 0;
    const resolver = createBoundedHreflangTargetResolver(async (href) => {
      reads += 1;
      return { url: href, alternates: {} };
    }, { maxEntries: 1 });

    await resolver.resolve('/guide?source=it');
    await resolver.resolve('https://frontaliereticino.ch/guide/');
    expect(reads).toBe(1);
    expect(resolver.cacheSize).toBe(1);
    expect(resolver.peakCacheSize).toBe(1);
  });
});
