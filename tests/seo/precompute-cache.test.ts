/**
 * Unit tests for build-plugins/shared/precomputeCache.ts.
 *
 * Pattern: covers the L1 build-cache utility introduced in #339 (and
 * vincolo N1 in the design). Validates the cap-overflow contract that
 * guards against accidentally high-cardinality keys.
 */
import { describe, expect, it } from 'vitest';
import { PrecomputeCache } from '../../build-plugins/shared/precomputeCache';

describe('PrecomputeCache', () => {
  it('returns cached value on second lookup, computing only once', () => {
    const cache = new PrecomputeCache<string>({ name: 'test' });
    let compute = 0;
    const get = () => cache.getOrCompute('k', () => { compute++; return 'v'; });
    expect(get()).toBe('v');
    expect(get()).toBe('v');
    expect(get()).toBe('v');
    expect(compute).toBe(1);
  });

  it('caches distinct keys independently', () => {
    const cache = new PrecomputeCache<number>({ name: 'test' });
    expect(cache.getOrCompute('a', () => 1)).toBe(1);
    expect(cache.getOrCompute('b', () => 2)).toBe(2);
    expect(cache.getOrCompute('a', () => 99)).toBe(1); // cached, ignores compute
    expect(cache.getOrCompute('b', () => 99)).toBe(2);
    expect(cache.size).toBe(2);
  });

  it('throws when maxSize is exceeded on getOrCompute', () => {
    const cache = new PrecomputeCache<number>({ name: 'small', maxSize: 2 });
    cache.getOrCompute('a', () => 1);
    cache.getOrCompute('b', () => 2);
    expect(() => cache.getOrCompute('c', () => 3)).toThrow(/exceeded maxSize=2/);
    // Existing keys still work after the cap is hit
    expect(cache.getOrCompute('a', () => 99)).toBe(1);
  });

  it('throws when maxSize is exceeded on set()', () => {
    const cache = new PrecomputeCache<number>({ name: 'small', maxSize: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    expect(() => cache.set('c', 3)).toThrow(/exceeded maxSize=2/);
    // Re-setting an existing key does NOT trigger overflow
    cache.set('a', 10);
    expect(cache.get('a')).toBe(10);
  });

  it('has / get / size mirror the underlying Map semantics', () => {
    const cache = new PrecomputeCache<string>({ name: 'mirror' });
    expect(cache.has('x')).toBe(false);
    expect(cache.get('x')).toBeUndefined();
    expect(cache.size).toBe(0);
    cache.set('x', 'foo');
    expect(cache.has('x')).toBe(true);
    expect(cache.get('x')).toBe('foo');
    expect(cache.size).toBe(1);
  });

  it('stats() returns name + size + maxSize for telemetry', () => {
    const cache = new PrecomputeCache<number>({ name: 'tel', maxSize: 100 });
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.stats()).toEqual({ name: 'tel', size: 2, maxSize: 100 });
  });

  it('default maxSize is 5000 (fits realistic locale × canton × sector combos)', () => {
    const cache = new PrecomputeCache<number>({ name: 'default' });
    expect(cache.stats().maxSize).toBe(5000);
  });

  it('error message includes the offending key + cache name for debuggability', () => {
    const cache = new PrecomputeCache<number>({ name: 'mycache', maxSize: 1 });
    cache.set('first', 1);
    let err: Error | null = null;
    try { cache.set('second', 2); } catch (e) { err = e as Error; }
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain('mycache');
    expect(err!.message).toContain('second');
    expect(err!.message).toContain('maxSize=1');
  });
});
