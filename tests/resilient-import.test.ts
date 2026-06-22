import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resilientImport, isChunkLoadError } from '@/services/resilientImport';

/**
 * resilientImport recovers from two stale-deploy failure modes:
 *  1. import() rejects with a chunk-load error (purged chunk → 404).
 *  2. import() resolves but the module is missing expected exports (version
 *     skew: stable-named chunks where a cached entry pulls a fresh chunk whose
 *     export shape differs → "n.getApp is not a function" on a minified name).
 * Both clear caches, retry once, then reload (guarded to once per session).
 */
describe('resilientImport', () => {
  beforeEach(() => {
    sessionStorage.clear();
    // Fresh caches mock per test.
    (globalThis as any).caches = {
      keys: vi.fn().mockResolvedValue(['c1', 'c2']),
      delete: vi.fn().mockResolvedValue(true),
    };
  });

  it('returns the module on first success', async () => {
    const mod = { getApp: () => 'app' };
    const factory = vi.fn().mockResolvedValue(mod);
    const result = await resilientImport(factory);
    expect(result).toBe(mod);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('passes a valid module through when validate() is satisfied', async () => {
    const mod = { getConfigValue: () => 'v' };
    const result = await resilientImport(
      () => Promise.resolve(mod),
      (m) => typeof m.getConfigValue === 'function',
    );
    expect(result).toBe(mod);
  });

  it('retries once after clearing caches when validate() fails, then recovers', async () => {
    const good = { getApp: () => 'app' };
    // First call resolves a stale (export-less) module; retry resolves a good one.
    const factory = vi
      .fn()
      .mockResolvedValueOnce({} as { getApp?: () => string })
      .mockResolvedValueOnce(good);

    const result = await resilientImport(factory, (m) => typeof m.getApp === 'function');

    expect(result).toBe(good);
    expect(factory).toHaveBeenCalledTimes(2);
    expect((globalThis as any).caches.delete).toHaveBeenCalledTimes(2); // c1 + c2
  });

  it('reloads at most once per session when the chunk is truly gone', async () => {
    const reload = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload: reload },
    });

    const chunkErr = Object.assign(new Error('Failed to fetch dynamically imported module'), {
      name: 'ChunkLoadError',
    });
    const factory = vi.fn().mockRejectedValue(chunkErr);

    await expect(resilientImport(factory)).rejects.toThrow();
    expect(factory).toHaveBeenCalledTimes(2); // initial + one retry
    expect(reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem('_serviceChunkReload')).toBe('1');

    // A subsequent failure must NOT reload again (guard holds across callers).
    reload.mockClear();
    await expect(resilientImport(factory)).rejects.toThrow();
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not swallow non-chunk errors', async () => {
    const factory = vi.fn().mockRejectedValue(new TypeError('genuine bug'));
    await expect(resilientImport(factory)).rejects.toThrow('genuine bug');
    expect(factory).toHaveBeenCalledTimes(1); // no retry for unrelated errors
  });

  it('isChunkLoadError recognises the stale-deploy signatures', () => {
    expect(isChunkLoadError(new Error('Failed to fetch dynamically imported module'))).toBe(true);
    expect(isChunkLoadError(new Error('Importing a module script failed'))).toBe(true);
    expect(isChunkLoadError(Object.assign(new Error('x'), { name: 'ChunkLoadError' }))).toBe(true);
    expect(isChunkLoadError(new Error('something else'))).toBe(false);
  });
});
