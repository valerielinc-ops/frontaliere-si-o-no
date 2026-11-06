// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_OWNER_PROBE_URL,
  isOwnerProbeSuccess,
  probeOwnership,
  resolveOwnerToken,
} from '../scripts/lib/indexing-owner.mjs';
import {
  parseArgs,
  verifyIndexingOwner,
} from '../scripts/ci/verify-indexing-owner.mjs';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('Indexing API owner probe', () => {
  it.each([
    [200, true],
    [404, true],
    [403, false],
    [429, false],
  ])('accepts only HTTP %s as an ownership result', (status, expected) => {
    expect(isOwnerProbeSuccess(status)).toBe(expected);
  });

  it('reports 200/404 as read-only ownership proof and keeps 403 an error', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Failed to verify the URL ownership' } }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(probeOwnership('token', DEFAULT_OWNER_PROBE_URL)).resolves.toEqual({ ok: true, status: 404 });
    await expect(probeOwnership('token', DEFAULT_OWNER_PROBE_URL)).resolves.toMatchObject({
      ok: false,
      status: 403,
      reason: 'Failed to verify the URL ownership',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain('url=https%3A%2F%2Ffrontaliereticino.ch%2F');
  });

  it('does not resolve a publish token when the metadata probe returns 403', async () => {
    vi.stubEnv('GSC_CLIENT_ID', 'client-id');
    vi.stubEnv('GSC_CLIENT_SECRET', 'client-secret');
    vi.stubEnv('GSC_REFRESH_TOKEN', 'refresh-token');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'oauth-token' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Failed to verify the URL ownership' } }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveOwnerToken(DEFAULT_OWNER_PROBE_URL)).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toContain('/urlNotifications/metadata');
  });
});

describe('verify-indexing-owner CLI', () => {
  it('defaults to the canonical site and delegates without publishing', async () => {
    const resolve = vi.fn().mockResolvedValue('owner-token');
    await expect(verifyIndexingOwner({ resolve })).resolves.toBe(true);
    expect(resolve).toHaveBeenCalledWith(DEFAULT_OWNER_PROBE_URL);
  });

  it('accepts only same-site HTTPS probe URLs', () => {
    expect(parseArgs([])).toEqual({ probeUrl: DEFAULT_OWNER_PROBE_URL });
    expect(parseArgs(['--url=https://frontaliereticino.ch/cerca-lavoro-ticino/test/'])).toEqual({
      probeUrl: 'https://frontaliereticino.ch/cerca-lavoro-ticino/test/',
    });
    expect(() => parseArgs(['--url', 'http://frontaliereticino.ch/'])).toThrow(/HTTPS/);
    expect(() => parseArgs(['--url', 'https://example.com/'])).toThrow(/frontaliereticino\.ch/);
  });
});
