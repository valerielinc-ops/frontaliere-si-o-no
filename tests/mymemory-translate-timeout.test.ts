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
    let readerCancellationResolved = false;
    const cancelReader = vi.fn(async () => {
      readerCancellationResolved = true;
    });
    const cancelBody = vi.fn(async () => {});
    const releaseLock = vi.fn();
    const json = vi.fn(() => new Promise(() => {}));
    let requestSignal: AbortSignal | null | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestSignal = init?.signal;
      return {
        ok: true,
        body: {
          cancel: cancelBody,
          getReader: () => ({
            cancel: cancelReader,
            read: () => new Promise(() => {}),
            releaseLock,
          }),
        },
        json,
      };
    }));

    const translation = translateWithMyMemory('secondo testo da tradurre', 'it', 'de');
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(8001);

    await expect(translation).resolves.toBeNull();
    expect(requestSignal?.aborted).toBe(true);
    expect(cancelReader).toHaveBeenCalledOnce();
    expect(readerCancellationResolved).toBe(true);
    expect(cancelBody).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalledOnce();
  });

  it('parses a successful JSON response through the owned body reader', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({
      responseData: { translatedText: 'Pendolare', match: 0.9 },
    }));
    const read = vi.fn()
      .mockResolvedValueOnce({ done: false, value: bytes })
      .mockResolvedValueOnce({ done: true, value: undefined });
    const cancelReader = vi.fn(async () => {});
    const releaseLock = vi.fn();
    const json = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      body: {
        cancel: vi.fn(async () => {}),
        getReader: () => ({ read, cancel: cancelReader, releaseLock }),
      },
      json,
    })));

    await expect(translateWithMyMemory('Frontaliere', 'it', 'de')).resolves.toBe('Pendolare');
    expect(read).toHaveBeenCalledTimes(2);
    expect(cancelReader).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalledOnce();
  });

  it('copies each chunk when the response source reuses its Uint8Array buffer', async () => {
    const payload = new TextEncoder().encode(JSON.stringify({
      responseData: { translatedText: 'Basilea', match: 0.9 },
    }));
    const split = Math.floor(payload.length / 2);
    const first = payload.subarray(0, split);
    const second = payload.subarray(split);
    const reusedBuffer = new Uint8Array(Math.max(first.length, second.length));
    let readIndex = 0;
    const read = vi.fn(async () => {
      if (readIndex === 0) {
        readIndex += 1;
        reusedBuffer.set(first);
        return { done: false, value: reusedBuffer.subarray(0, first.length) };
      }
      if (readIndex === 1) {
        readIndex += 1;
        reusedBuffer.set(second);
        return { done: false, value: reusedBuffer.subarray(0, second.length) };
      }
      return { done: true, value: undefined };
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      body: {
        cancel: vi.fn(async () => {}),
        getReader: () => ({ read, cancel: vi.fn(async () => {}), releaseLock: vi.fn() }),
      },
      json: vi.fn(),
    })));

    await expect(translateWithMyMemory('Frontaliere', 'it', 'de')).resolves.toBe('Basilea');
    expect(read).toHaveBeenCalledTimes(3);
  });
});
