import { describe, expect, it, vi } from 'vitest';
import {
  createGitHubActionsReadClient,
  isMissingExactGitHubResource,
} from '../scripts/lib/github-actions-read-client.mjs';

function client(fetchImpl: typeof fetch, sleep = vi.fn()) {
  return createGitHubActionsReadClient({
    apiUrl: 'https://api.github.test',
    token: 'test-token',
    fetchImpl,
    sleep,
    timeoutMs: 1_000,
  });
}

describe('GitHub Actions read-only client', () => {
  it.each([429, 500])('retries GET %s once and never emits another method', async (status) => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status, headers: { 'Retry-After': '1' } }))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    await expect(client(fetchImpl).json('/repos/o/r/actions/runs/1')).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });

  it('retries transport/abort and 403 only when Retry-After is present', async () => {
    const transport = vi.fn()
      .mockRejectedValueOnce(new DOMException('timed out', 'AbortError'))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    await expect(client(transport).json('/repos/o/r/actions/runs/1')).resolves.toEqual({ ok: true });

    const throttled = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 403, headers: { 'Retry-After': '9' } }))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    const sleep = vi.fn();
    await expect(client(throttled, sleep).json('/repos/o/r/actions/runs/1')).resolves.toEqual({ ok: true });
    expect(sleep).toHaveBeenCalledWith(5_000);

    const forbidden = vi.fn().mockResolvedValue(new Response('{}', { status: 403 }));
    await expect(client(forbidden).json('/repos/o/r/actions/runs/1')).rejects.toThrow(/github_api_failed/);
    expect(forbidden).toHaveBeenCalledTimes(1);
  });

  it('bounds attempts and response bytes without retrying malformed or oversized bodies', async () => {
    const unavailable = vi.fn().mockResolvedValue(new Response('{}', { status: 503 }));
    await expect(client(unavailable).json('/repos/o/r/actions/runs/1')).rejects.toThrow(/github_api_failed/);
    expect(unavailable).toHaveBeenCalledTimes(3);

    const oversized = vi.fn().mockResolvedValue(new Response('x'.repeat(33), { status: 200 }));
    await expect(client(oversized).json('/repos/o/r/actions/runs/1', 32))
      .rejects.toThrow(/github_response_too_large/);
    expect(oversized).toHaveBeenCalledTimes(1);
  });

  it('follows exactly one HTTPS artifact redirect and never forwards the bearer token', async () => {
    const redirected = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { location: 'https://storage.test/artifact.zip?sig=1' },
      }))
      .mockResolvedValueOnce(new Response('PK', { status: 200 }));
    const body = await client(redirected).bytes('/repos/o/r/actions/artifacts/1/zip');
    expect(new TextDecoder().decode(body)).toBe('PK');
    expect(redirected).toHaveBeenCalledTimes(2);
    const [firstUrl, firstInit] = redirected.mock.calls[0];
    const [hopUrl, hopInit] = redirected.mock.calls[1];
    expect(firstUrl).toBe('https://api.github.test/repos/o/r/actions/artifacts/1/zip');
    expect(firstInit?.redirect).toBe('manual');
    expect(hopUrl).toBe('https://storage.test/artifact.zip?sig=1');
    expect(hopInit?.redirect).toBe('error');
    expect(hopInit?.headers).not.toHaveProperty('authorization');

    const insecure = vi.fn().mockResolvedValue(new Response(null, {
      status: 302,
      headers: { location: 'http://storage.test/artifact.zip' },
    }));
    await expect(client(insecure).bytes('/repos/o/r/actions/artifacts/1/zip'))
      .rejects.toThrow(/github_redirect_invalid/);
    expect(insecure).toHaveBeenCalledTimes(1);
  });

  it('preserves an authoritative 404 status for bounded domain classification', async () => {
    const missing = vi.fn().mockResolvedValue(new Response('{}', { status: 404 }));
    const error = await client(missing).json('/repos/o/r/actions/runs/1').catch((reason) => reason);
    expect(error).toMatchObject({ code: 'github_api_failed', status: 404 });
    expect(isMissingExactGitHubResource(error)).toBe(true);
    expect(missing).toHaveBeenCalledTimes(1);
  });
});
