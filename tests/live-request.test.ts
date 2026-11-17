import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LIVE_CHECK_USER_AGENT } from '../scripts/lib/live-link-check.mjs';
import {
  getLiveWithRetry,
  LIVE_REQUEST_ATTEMPTS,
  LIVE_REQUEST_EXTENDED_BUDGET_MS,
  LIVE_REQUEST_EXTENDED_DELAY_MS,
  LIVE_REQUEST_RETRY_DELAY_MS,
  liveRequestTimeoutMs,
  resetLiveRequestCircuitForTests,
} from './e2e/lib/live-request';

const response = (status: number) => ({ status: () => status });

describe('getLiveWithRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetLiveRequestCircuitForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetLiveRequestCircuitForTests();
  });

  it('adds the shared live-check User-Agent by default', async () => {
    const get = vi.fn().mockResolvedValue(response(200));

    await getLiveWithRetry(get, 'https://example.test/page');

    expect(get).toHaveBeenCalledWith('https://example.test/page', {
      headers: { 'User-Agent': DEFAULT_LIVE_CHECK_USER_AGENT },
    });
  });

  it.each([
    ['User-Agent', 'Explicit-Agent/1.0'],
    ['user-agent', 'lowercase-agent/1.0'],
  ])('preserves a caller-provided %s header', async (header, userAgent) => {
    const get = vi.fn().mockResolvedValue(response(200));
    const headers = { [header]: userAgent, 'X-Probe': 'kept' };

    await getLiveWithRetry(get, 'https://example.test/page', { headers });

    expect(get).toHaveBeenCalledWith('https://example.test/page', { headers });
  });

  it('keeps the six-attempt, 5 s phase 1 and exposes the live test timeout', () => {
    expect(LIVE_REQUEST_ATTEMPTS).toBe(6);
    expect(LIVE_REQUEST_RETRY_DELAY_MS).toBe(5_000);
    expect(LIVE_REQUEST_EXTENDED_DELAY_MS).toBe(30_000);
    expect(LIVE_REQUEST_EXTENDED_BUDGET_MS).toBe(10 * 60_000);
    expect(liveRequestTimeoutMs()).toBe(
      LIVE_REQUEST_ATTEMPTS * 15_000 + (LIVE_REQUEST_ATTEMPTS - 1) * LIVE_REQUEST_RETRY_DELAY_MS +
        LIVE_REQUEST_EXTENDED_BUDGET_MS + 15_000 + 60_000,
    );
    expect(liveRequestTimeoutMs(20_000)).toBe(
      LIVE_REQUEST_ATTEMPTS * 20_000 + (LIVE_REQUEST_ATTEMPTS - 1) * LIVE_REQUEST_RETRY_DELAY_MS +
        LIVE_REQUEST_EXTENDED_BUDGET_MS + 20_000 + 60_000,
    );
  });

  it('recovers a transient server response on the fifth attempt', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(200));

    const pending = getLiveWithRetry(get, 'https://example.test/page', undefined, { delayMs: 0 });
    await vi.runAllTimersAsync();
    const recovered = await pending;
    expect(recovered.status()).toBe(200);
    expect(get).toHaveBeenCalledTimes(5);
  });

  it('recovers during phase 2 after the expected 30 s simulated intervals', async () => {
    const get = vi.fn();
    const callTimes: number[] = [];
    const startedAt = Date.now();
    for (let attempt = 0; attempt < LIVE_REQUEST_ATTEMPTS + 1; attempt += 1) {
      get.mockImplementationOnce(async () => {
        callTimes.push(Date.now() - startedAt);
        return response(503);
      });
    }
    get.mockImplementationOnce(async () => {
      callTimes.push(Date.now() - startedAt);
      return response(200);
    });

    const pending = getLiveWithRetry(get, 'https://example.test/page');
    await Promise.resolve();
    for (let retry = 0; retry < LIVE_REQUEST_ATTEMPTS - 1; retry += 1) {
      await vi.advanceTimersByTimeAsync(LIVE_REQUEST_RETRY_DELAY_MS);
    }
    expect(get).toHaveBeenCalledTimes(LIVE_REQUEST_ATTEMPTS);

    await vi.advanceTimersByTimeAsync(LIVE_REQUEST_EXTENDED_DELAY_MS);
    await vi.advanceTimersByTimeAsync(LIVE_REQUEST_EXTENDED_DELAY_MS);
    const recovered = await pending;
    expect(recovered.status()).toBe(200);
    expect(get).toHaveBeenCalledTimes(LIVE_REQUEST_ATTEMPTS + 2);
    expect(callTimes.slice(LIVE_REQUEST_ATTEMPTS)).toEqual([
      (LIVE_REQUEST_ATTEMPTS - 1) * LIVE_REQUEST_RETRY_DELAY_MS + LIVE_REQUEST_EXTENDED_DELAY_MS,
      (LIVE_REQUEST_ATTEMPTS - 1) * LIVE_REQUEST_RETRY_DELAY_MS + LIVE_REQUEST_EXTENDED_DELAY_MS * 2,
    ]);
  });

  it('returns persistent 503s after the extended budget and opens the process circuit', async () => {
    const get = vi.fn().mockResolvedValue(response(503));

    const pending = getLiveWithRetry(get, 'https://example.test/page', undefined, { delayMs: 0 });
    await vi.runAllTimersAsync();
    const lastResponse = await pending;

    expect(lastResponse.status()).toBe(503);
    expect(get).toHaveBeenCalledTimes(LIVE_REQUEST_ATTEMPTS + 19);

    const afterCircuitOpens = vi.fn().mockResolvedValue(response(503));
    const circuitOpenPending = getLiveWithRetry(
      afterCircuitOpens,
      'https://example.test/second-page',
      undefined,
      { delayMs: 0 },
    );
    await vi.runAllTimersAsync();
    const circuitOpenResponse = await circuitOpenPending;
    expect(circuitOpenResponse.status()).toBe(503);
    expect(afterCircuitOpens).toHaveBeenCalledTimes(LIVE_REQUEST_ATTEMPTS);

    resetLiveRequestCircuitForTests();
    const afterReset = vi.fn().mockResolvedValue(response(503));
    const resetPending = getLiveWithRetry(afterReset, 'https://example.test/third-page', undefined, { delayMs: 0 });
    await vi.runAllTimersAsync();
    const resetResponse = await resetPending;
    expect(resetResponse.status()).toBe(503);
    expect(afterReset).toHaveBeenCalledTimes(LIVE_REQUEST_ATTEMPTS + 19);
  });

  it('returns a 404 after one call without retrying it', async () => {
    const get = vi.fn().mockResolvedValue(response(404));

    const missing = await getLiveWithRetry(get, 'https://example.test/missing');
    expect(missing.status()).toBe(404);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('preserves one-call success when there is no 5xx response', async () => {
    const get = vi.fn().mockResolvedValue(response(200));

    const success = await getLiveWithRetry(get, 'https://example.test/page');
    expect(success.status()).toBe(200);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('retries a transport error and then returns a client error without further retries', async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(new Error('request timed out'))
      .mockResolvedValueOnce(response(404));

    const pending = getLiveWithRetry(get, 'https://example.test/page', undefined, { delayMs: 0 });
    await vi.runAllTimersAsync();
    const clientError = await pending;
    expect(clientError.status()).toBe(404);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('rethrows the last persistent transport error after the extended budget', async () => {
    const error = new Error('request timed out');
    const get = vi.fn().mockRejectedValue(error);

    const pending = getLiveWithRetry(get, 'https://example.test/page', undefined, { delayMs: 0 });
    const rejection = expect(pending).rejects.toBe(error);
    await vi.runAllTimersAsync();
    await rejection;
    expect(get).toHaveBeenCalledTimes(LIVE_REQUEST_ATTEMPTS + 19);
  });
});
