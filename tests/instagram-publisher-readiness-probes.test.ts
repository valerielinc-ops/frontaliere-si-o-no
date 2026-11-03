import { describe, expect, it } from 'vitest';

import {
  probeInstagramPublishPermission,
  probeInstagramPublisherToken,
} from '../scripts/lib/instagram-publisher-readiness-probes.mjs';

function response(payload: unknown, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => payload };
}

describe('Instagram publisher readiness probes', () => {
  it('requires the explicit Meta publishing permission and keeps the user token out of the URL', async () => {
    let requestedUrl: URL | null = null;
    let authorization = '';
    const result = await probeInstagramPublishPermission({
      userAccessToken: 'user-token',
      fetchImpl: async (url: string | URL, init?: RequestInit) => {
        requestedUrl = new URL(url);
        authorization = String(new Headers(init?.headers).get('authorization') || '');
        return response({ data: [
          { permission: 'pages_show_list', status: 'granted' },
          { permission: 'instagram_content_publish', status: 'granted' },
        ] });
      },
    });

    expect(result.publishPermissionStatus).toBe('granted');
    expect(requestedUrl?.pathname).toMatch(/\/me\/permissions$/);
    expect(requestedUrl?.searchParams.get('access_token')).toBeNull();
    expect(authorization).toBe('Bearer user-token');
  });

  it('treats a valid permission response without the publish grant as missing', async () => {
    const result = await probeInstagramPublishPermission({
      userAccessToken: 'user-token',
      fetchImpl: async () => response({ data: [{ permission: 'pages_show_list', status: 'granted' }] }),
    });

    expect(result.publishPermissionStatus).toBe('missing');
  });

  it('matches the publisher token to the exact account without returning account IDs', async () => {
    let requestedUrl: URL | null = null;
    const result = await probeInstagramPublisherToken({
      instagramAccountId: 'ig-123',
      accessToken: 'publisher-token',
      fetchImpl: async (url: string | URL) => {
        requestedUrl = new URL(url);
        return response({ id: 'ig-123' });
      },
    });

    expect(result.publisherTokenStatus).toBe('matched');
    expect(result.note).not.toContain('ig-123');
    expect(requestedUrl?.searchParams.get('access_token')).toBeNull();
  });

  it('does not leak Graph error details or token values', async () => {
    const result = await probeInstagramPublisherToken({
      instagramAccountId: 'ig-123',
      accessToken: 'publisher-token',
      fetchImpl: async () => response({ error: { code: 10, message: 'private response detail' } }, { ok: false, status: 403 }),
    });

    expect(result.publisherTokenStatus).toBe('unavailable');
    expect(result.note).toContain('HTTP 403, code 10');
    expect(result.note).not.toContain('private response detail');
    expect(result.note).not.toContain('publisher-token');
  });
});
