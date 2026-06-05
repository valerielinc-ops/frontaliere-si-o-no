import { describe, it, expect, vi } from 'vitest';
import {
  isTransientFetchError,
  isConnectionLevelFetchError,
  fetchWithRetry,
  RETRYABLE_STATUS,
} from '../scripts/lib/transient-fetch.mjs';

describe('isTransientFetchError', () => {
  it('classifies node "fetch failed" TypeError as transient', () => {
    const err = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    expect(isTransientFetchError(err)).toBe(true);
  });

  it('classifies SuccessFactors-style wrapped network error as transient', () => {
    // The SF client re-throws as a generic Error losing the TypeError name.
    const err = new Error('SuccessFactors network error: fetch failed');
    expect(isTransientFetchError(err)).toBe(true);
  });

  it('classifies Playwright navigation timeout as transient', () => {
    const err = new Error('page.goto: Timeout 60000ms exceeded.');
    expect(isTransientFetchError(err)).toBe(true);
  });

  it('classifies AbortError (our own timeout) as transient', () => {
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(isTransientFetchError(err)).toBe(true);
  });

  it.each([408, 425, 429, 500, 502, 503, 504])('classifies retryable status %i as transient', (status) => {
    expect(RETRYABLE_STATUS.has(status)).toBe(true);
    expect(isTransientFetchError({ status })).toBe(true);
  });

  it.each([400, 401, 403, 404, 410])('does NOT classify persistent status %i as transient', (status) => {
    expect(RETRYABLE_STATUS.has(status)).toBe(false);
    expect(isTransientFetchError({ status })).toBe(false);
  });

  it('does NOT classify a generic 404 message as transient', () => {
    expect(isTransientFetchError(new Error('HTTP 404 from https://x.test'))).toBe(false);
  });

  it('honours an explicit retryable=true tag', () => {
    expect(isTransientFetchError(Object.assign(new Error('whatever'), { retryable: true }))).toBe(true);
  });
});

describe('isConnectionLevelFetchError (Jina egress fallback gate)', () => {
  it('classifies a node "fetch failed" network error as connection-level', () => {
    const err = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    expect(isConnectionLevelFetchError(err)).toBe(true);
  });

  it('classifies an AbortError (our own timeout) as connection-level', () => {
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(isConnectionLevelFetchError(err)).toBe(true);
  });

  it.each([500, 502, 503, 504, 429, 408, 425])(
    'does NOT classify a retryable HTTP %i (server responded) as connection-level',
    (status) => {
      // Even though these are transient/retryable, the server WAS reached → the
      // egress works → the Jina fallback must NOT fire on them.
      const err = Object.assign(new Error(`HTTP ${status} from https://x.test`), {
        status,
        retryable: true,
      });
      expect(isTransientFetchError(err)).toBe(true);
      expect(isConnectionLevelFetchError(err)).toBe(false);
    },
  );

  it.each([400, 403, 404])('does NOT classify a persistent HTTP %i as connection-level', (status) => {
    expect(isConnectionLevelFetchError({ status })).toBe(false);
  });

  it('returns false for nullish input', () => {
    expect(isConnectionLevelFetchError(null)).toBe(false);
    expect(isConnectionLevelFetchError(undefined)).toBe(false);
  });
});

describe('fetchWithRetry', () => {
  it('retries a transient failure then succeeds', async () => {
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce('ok');
    const result = await fetchWithRetry(attempt, { retryBaseMs: 0 });
    expect(result).toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a persistent (404-like) error', async () => {
    const attempt = vi.fn().mockRejectedValue(Object.assign(new Error('HTTP 404'), { status: 404 }));
    await expect(fetchWithRetry(attempt, { retryBaseMs: 0 })).rejects.toThrow(/404/);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('exhausts retries then throws the last error', async () => {
    const attempt = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    await expect(fetchWithRetry(attempt, { retries: 2, retryBaseMs: 0 })).rejects.toThrow(/fetch failed/);
    expect(attempt).toHaveBeenCalledTimes(3); // 1 + 2 retries
  });

  it('supports a custom isTransient predicate', async () => {
    const attempt = vi.fn().mockRejectedValue(new Error('weird-but-retryable'));
    await expect(
      fetchWithRetry(attempt, { retries: 1, retryBaseMs: 0, isTransient: () => true }),
    ).rejects.toThrow();
    expect(attempt).toHaveBeenCalledTimes(2);
  });
});
