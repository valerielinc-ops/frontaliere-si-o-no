import { describe, expect, it, vi } from 'vitest';
import { getLiveWithRetry } from './e2e/lib/live-request';

const response = (status: number) => ({ status: () => status });

describe('getLiveWithRetry', () => {
  it('retries a transient server response and returns the recovered response', async () => {
    const get = vi.fn().mockResolvedValueOnce(response(503)).mockResolvedValueOnce(response(200));

    const recovered = await getLiveWithRetry(get, 'https://example.test/page', undefined, { delayMs: 0 });
    expect(recovered.status()).toBe(200);
    expect(get).toHaveBeenCalledTimes(2);
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

    const missing = await getLiveWithRetry(get, 'https://example.test/missing', undefined, { delayMs: 0 });
    expect(missing.status()).toBe(404);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('propagates the final transport error after the retry budget', async () => {
    const error = new Error('request timed out');
    const get = vi.fn().mockRejectedValue(error);

    await expect(getLiveWithRetry(get, 'https://example.test/page', undefined, { delayMs: 0 })).rejects.toBe(error);
    expect(get).toHaveBeenCalledTimes(2);
  });
});
