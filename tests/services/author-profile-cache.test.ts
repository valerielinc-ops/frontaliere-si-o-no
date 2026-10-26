import { describe, expect, it } from 'vitest';
import { parseAuthorCacheMap } from '@/services/authorProfileCache';

const normalizePatch = (value: unknown): { name: string } | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const name = (value as { name?: unknown }).name;
  return typeof name === 'string' && name.trim() ? { name: name.trim() } : undefined;
};

describe('parseAuthorCacheMap', () => {
  const now = 10_000;

  it('rejects non-object envelopes and future or non-finite timestamps', () => {
    expect(parseAuthorCacheMap(JSON.stringify({ data: 'bad', timestamp: now }), 3_600, normalizePatch, now)).toBeNull();
    expect(parseAuthorCacheMap(JSON.stringify({ data: {}, timestamp: now + 1 }), 3_600, normalizePatch, now)).toBeNull();
    expect(parseAuthorCacheMap('{"data":{},"timestamp":NaN}', 3_600, normalizePatch, now)).toBeNull();
  });

  it('keeps valid values and discards malformed entries', () => {
    const result = parseAuthorCacheMap(
      JSON.stringify({ data: { good: { name: '  Ada  ' }, bad: { name: 42 } }, timestamp: now - 10 }),
      3_600,
      normalizePatch,
      now,
    );
    expect([...result?.entries() ?? []]).toEqual([['good', { name: 'Ada' }]]);
  });
});
