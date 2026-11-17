import { describe, expect, it, vi } from 'vitest';
import {
  getLiveWithRetry,
  LIVE_REQUEST_ATTEMPTS,
  LIVE_REQUEST_RETRY_DELAY_MS,
} from './e2e/lib/live-request';

const response = (status: number) => ({ status: () => status });

describe('getLiveWithRetry', () => {
  it('uses six attempts and a 5 s delay by default', () => {
    expect(LIVE_REQUEST_ATTEMPTS).toBe(6);
    expect(LIVE_REQUEST_RETRY_DELAY_MS).toBe(5_000);
  });

  it('recovers a transient server response on the fifth attempt', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(200));

    const recovered = await getLiveWithRetry(get, 'https://example.test/page', undefined, { delayMs: 0 });
    expect(recovered.status()).toBe(200);
    expect(get).toHaveBeenCalledTimes(5);
  });

  it('returns the last 503 after six attempts when the server error persists', async () => {
    const responses = Array.from({ length: 6 }, () => response(503));
    const get = vi.fn();
    for (const item of responses) get.mockResolvedValueOnce(item);

    const lastResponse = await getLiveWithRetry(get, 'https://example.test/page', undefined, { delayMs: 0 });
    expect(lastResponse).toBe(responses[5]);
    expect(lastResponse.status()).toBe(503);
    expect(get).toHaveBeenCalledTimes(6);
  });

  it('retries a transient server response and returns the recovered response', async () => {
    const get = vi.fn().mockResolvedValueOnce(response(503)).mockResolvedValueOnce(response(200));

    const recovered = await getLiveWithRetry(get, 'https://example.test/page', undefined, { delayMs: 0 });
    expect(recovered.status()).toBe(200);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('allows a second transient server response before failing the live gate', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(200));

    const recovered = await getLiveWithRetry(get, 'https://example.test/page', undefined, { delayMs: 0 });
    expect(recovered.status()).toBe(200);
    expect(get).toHaveBeenCalledTimes(3);
  });

  it('retries a transport error without retrying a client error', async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(new Error('request timed out'))
      .mockResolvedValueOnce(response(404));

    const clientError = await getLiveWithRetry(get, 'https://example.test/page', undefined, { delayMs: 0 });
    expect(clientError.status()).toBe(404);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 4xx response', async () => {
    const get = vi.fn().mockResolvedValue(response(404));

    const missing = await getLiveWithRetry(get, 'https://example.test/missing');
    expect(missing.status()).toBe(404);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('propagates the final transport error after the retry budget', async () => {
    const error = new Error('request timed out');
    const get = vi.fn().mockRejectedValue(error);

    await expect(getLiveWithRetry(get, 'https://example.test/page', undefined, { delayMs: 0 })).rejects.toBe(error);
    expect(get).toHaveBeenCalledTimes(6);
  });
});
