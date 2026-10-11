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

  it('copies each response chunk before a reader reuses its backing buffer', async () => {
    const payload = new TextEncoder().encode(JSON.stringify({
      responseData: { translatedText: 'Rückmeldung', match: 0.9 },
    }));
    const pieces = [payload.slice(0, 24), payload.slice(24)];
    const backingBuffer = new Uint8Array(Math.max(...pieces.map((piece) => piece.length)));
    let index = 0;
    const read = vi.fn(async () => {
      if (index >= pieces.length) return { done: true, value: undefined };
      const piece = pieces[index++];
      backingBuffer.fill(0);
      backingBuffer.set(piece);
      return { done: false, value: backingBuffer.subarray(0, piece.length) };
    });
    const releaseLock = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      body: { getReader: () => ({ read, releaseLock }) },
    })));

    await expect(translateWithMyMemory('Frontaliere', 'it', 'de')).resolves.toBe('Rückmeldung');
    expect(read).toHaveBeenCalledTimes(3);
    expect(releaseLock).toHaveBeenCalledOnce();
  });
});
