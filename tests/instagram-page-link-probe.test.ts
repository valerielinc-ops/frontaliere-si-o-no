import { describe, expect, it } from 'vitest';

import { probeInstagramPageLink } from '../scripts/lib/instagram-page-link-probe.mjs';

const credentials = {
  pageId: 'page-123',
  userAccessToken: 'test-user-token',
  instagramAccountId: 'ig-123',
  publisherAccessToken: 'test-page-token',
};

function response(payload: unknown, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => payload };
}

describe('probeInstagramPageLink', () => {
  it('matches the Page link to the configured Instagram account and keeps the token out of the URL', async () => {
    let requestedUrl: URL | null = null;
    let authorization = '';
    const result = await probeInstagramPageLink({
      ...credentials,
      fetchImpl: async (url: string | URL, init?: RequestInit) => {
        requestedUrl = new URL(url);
        authorization = String(new Headers(init?.headers).get('authorization') || '');
        return response({
          id: 'page-123',
          access_token: 'test-page-token',
          tasks: ['ANALYZE', 'CREATE_CONTENT'],
          instagram_business_account: { id: 'ig-123' },
        });
      },
    });

    expect(result.pageLinkStatus).toBe('matched');
    expect(result.publisherTokenSourceStatus).toBe('matched');
    expect(result.pageTaskStatus).toBe('granted');
    expect(result.note).not.toContain('ig-123');
    expect(result.note).not.toContain('test-page-token');
    expect(requestedUrl?.searchParams.get('access_token')).toBeNull();
    expect(authorization).toBe('Bearer test-user-token');
  });

  it('marks a different linked account as a mismatch without returning either id', async () => {
    const result = await probeInstagramPageLink({
      ...credentials,
      fetchImpl: async () => response({
        id: 'page-123',
        access_token: 'test-page-token',
        tasks: ['CREATE_CONTENT'],
        instagram_business_account: { id: 'ig-other' },
      }),
    });

    expect(result.pageLinkStatus).toBe('mismatch');
    expect(result.note).not.toContain('ig-other');
    expect(result.note).not.toContain('ig-123');
  });

  it('treats a missing field as unverified because link and scope cannot be distinguished', async () => {
    const result = await probeInstagramPageLink({
      ...credentials,
      fetchImpl: async () => response({ id: 'page-123', access_token: 'test-page-token', tasks: ['CREATE_CONTENT'] }),
    });

    expect(result.pageLinkStatus).toBe('unverified');
    expect(result.note).toMatch(/linkage and API scopes remain unverified/);
  });

  it('detects when the configured publisher token does not come from this Page and user token', async () => {
    const result = await probeInstagramPageLink({
      ...credentials,
      publisherAccessToken: 'other-page-token',
      fetchImpl: async () => response({
        id: 'page-123',
        access_token: 'expected-page-token',
        tasks: ['CREATE_CONTENT'],
        instagram_business_account: { id: 'ig-123' },
      }),
    });

    expect(result.pageLinkStatus).toBe('matched');
    expect(result.publisherTokenSourceStatus).toBe('mismatch');
    expect(result.note).not.toContain('expected-page-token');
    expect(result.note).not.toContain('other-page-token');
  });

  it('requires the Page CREATE_CONTENT task', async () => {
    const result = await probeInstagramPageLink({
      ...credentials,
      fetchImpl: async () => response({
        id: 'page-123',
        access_token: 'test-page-token',
        tasks: ['ANALYZE'],
        instagram_business_account: { id: 'ig-123' },
      }),
    });

    expect(result.pageTaskStatus).toBe('missing');
  });

  it('accepts the equivalent PROFILE_PLUS_CREATE_CONTENT task on New Pages Experience', async () => {
    const result = await probeInstagramPageLink({
      ...credentials,
      fetchImpl: async () => response({
        id: 'page-123',
        access_token: 'test-page-token',
        tasks: ['PROFILE_PLUS_CREATE_CONTENT'],
        instagram_business_account: { id: 'ig-123' },
      }),
    });

    expect(result.pageTaskStatus).toBe('granted');
  });

  it('reports Graph errors as unavailable without exposing response messages', async () => {
    const result = await probeInstagramPageLink({
      ...credentials,
      fetchImpl: async () => response({ error: { code: 10, message: 'private response detail' } }, { ok: false, status: 403 }),
    });

    expect(result.pageLinkStatus).toBe('unavailable');
    expect(result.note).toContain('HTTP 403, code 10');
    expect(result.note).not.toContain('private response detail');
    expect(result.note).not.toContain('test-user-token');
  });

  it('does not call the API when Page credentials are missing', async () => {
    let called = false;
    const result = await probeInstagramPageLink({
      pageId: 'page-123',
      fetchImpl: async () => { called = true; return response({}); },
    });

    expect(called).toBe(false);
    expect(result.pageLinkStatus).toBe('unavailable');
  });
});
