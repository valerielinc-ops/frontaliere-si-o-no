import { afterEach, describe, expect, it, vi } from 'vitest';

import { translateWithMyMemory } from '@/scripts/lib/mymemory-translate.mjs';

describe('MyMemory bounded request deadline', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('returns null when fetch ignores the abort signal', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Promise<Response>(() => {});
    });
    vi.stubGlobal('fetch', fetchMock);

    const translation = translateWithMyMemory('testo da tradurre', 'it', 'en');
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(8001);

    await expect(translation).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('bounds and cancels a response body that ignores the abort signal', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(async () => {});
    let requestSignal: AbortSignal | null | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestSignal = init?.signal;
      return {
        ok: true,
        body: { cancel },
        json: () => new Promise(() => {}),
      };
    }));

    const translation = translateWithMyMemory('secondo testo da tradurre', 'it', 'de');
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(8001);

    await expect(translation).resolves.toBeNull();
    expect(requestSignal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
