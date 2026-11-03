import { describe, expect, it, vi } from 'vitest';
import { verifyExactSocialPublishedPost } from '../scripts/lib/social-publish-reconciliation.mjs';

function response(body: object, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('exact social publication verification', () => {
  it('requires the exact Facebook ID, published state, and native timestamp', async () => {
    const fetchImpl = vi.fn(async () => response({
      id: '123_456',
      from: { id: '123' },
      is_published: true,
      created_time: '2026-11-03T08:05:00+0000',
      message: 'Verified Facebook caption',
      link: 'https://frontaliereticino.ch/blog/story/',
    }));
    await expect(verifyExactSocialPublishedPost({
      platform: 'facebook',
      accountId: '123',
      nativePostId: '123_456',
      accessToken: 'private-token',
      fetchImpl,
    })).resolves.toMatchObject({ provider: 'facebook-graph', publishedAt: '2026-11-03T08:05:00.000Z' });
    expect(new URL(fetchImpl.mock.calls[0][0] as string).searchParams.get('fields'))
      .toBe('id,from,created_time,is_published,message,link');
  });

  it('does not treat mismatched IDs, unpublished posts, absent timestamps, or API errors as confirmation', async () => {
    for (const body of [
      { id: 'other-id', from: { id: '123' }, is_published: true, created_time: '2026-11-03T08:05:00Z', message: 'caption', link: 'https://example.com/' },
      { id: '123_456', from: { id: '123' }, is_published: false, created_time: '2026-11-03T08:05:00Z', message: 'caption', link: 'https://example.com/' },
      { id: '123_456', from: { id: '123' }, is_published: true, message: 'caption', link: 'https://example.com/' },
      { id: '123_456', from: { id: 'other-page' }, is_published: true, created_time: '2026-11-03T08:05:00Z', message: 'caption', link: 'https://example.com/' },
    ]) {
      await expect(verifyExactSocialPublishedPost({
        platform: 'facebook', accountId: '123', nativePostId: '123_456', accessToken: 'private-token',
        fetchImpl: async () => response(body),
      })).rejects.toThrow();
    }
    await expect(verifyExactSocialPublishedPost({
      platform: 'facebook', accountId: '123', nativePostId: '123_456', accessToken: 'private-token',
      fetchImpl: async () => response({ error: { message: 'permission detail must stay private' } }, 403),
    })).rejects.toThrow('native API read was not authoritative (HTTP 403)');
  });

  it('checks the configured Instagram token identity and exact media ID before resolving', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ id: 'ig-account-1' }))
      .mockResolvedValueOnce(response({
        id: 'media-7',
        timestamp: '2026-11-03T08:05:00+0000',
        media_type: 'CAROUSEL_ALBUM',
        media_product_type: 'FEED',
        caption: 'Verified Instagram caption',
      }));
    await expect(verifyExactSocialPublishedPost({
      platform: 'instagram', capGroup: 'feed', accountId: 'ig-account-1', nativePostId: 'media-7',
      accessToken: 'private-token', fetchImpl,
    })).resolves.toMatchObject({ provider: 'instagram-graph', publishedAt: '2026-11-03T08:05:00.000Z' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(new URL(fetchImpl.mock.calls[1][0] as string).searchParams.get('fields'))
      .toBe('id,timestamp,media_type,media_product_type,caption');
  });

  it('keeps Instagram media whose account or reserved product type does not match unresolved', async () => {
    await expect(verifyExactSocialPublishedPost({
      platform: 'instagram', accountId: 'configured-account', nativePostId: 'media-7', accessToken: 'private-token',
      fetchImpl: async () => response({ id: 'different-account' }),
    })).rejects.toThrow('Instagram access token does not resolve to the configured account');

    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ id: 'configured-account' }))
      .mockResolvedValueOnce(response({
        id: 'media-7', timestamp: '2026-11-03T08:05:00Z', media_product_type: 'FEED',
      }));
    await expect(verifyExactSocialPublishedPost({
      platform: 'instagram', capGroup: 'story', accountId: 'configured-account', nativePostId: 'media-7',
      accessToken: 'private-token', fetchImpl,
    })).rejects.toThrow('Instagram media type does not match the reservation cap group');
  });

  it('requires LinkedIn to return the exact published member post and author', async () => {
    const fetchImpl = vi.fn(async () => response({
      id: 'urn:li:share:77',
      author: 'urn:li:person:3',
      lifecycleState: 'PUBLISHED',
      publishedAt: 1793693100000,
      commentary: 'Verified LinkedIn copy',
      content: { article: { source: 'https://frontaliereticino.ch/blog/story/', title: 'Story' } },
    }));
    await expect(verifyExactSocialPublishedPost({
      platform: 'linkedinMember', accountId: 'urn:li:person:3', nativePostId: 'urn:li:share:77',
      accessToken: 'private-token', fetchImpl,
    })).resolves.toMatchObject({ provider: 'linkedin-posts' });
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/urn%3Ali%3Ashare%3A77');

    await expect(verifyExactSocialPublishedPost({
      platform: 'linkedinMember', accountId: 'urn:li:person:3', nativePostId: 'urn:li:share:77',
      accessToken: 'private-token',
      fetchImpl: async () => response({
        id: 'urn:li:share:77', author: 'urn:li:person:other', lifecycleState: 'PUBLISHED', publishedAt: 1793693100000,
        commentary: 'Other copy', content: { article: { source: 'https://example.com/', title: 'Other' } },
      }),
    })).rejects.toThrow('LinkedIn did not confirm this exact member post as published by the configured author');
  });

  it('does not infer Telegram absence or publication from Bot API support', async () => {
    await expect(verifyExactSocialPublishedPost({
      platform: 'telegram', accountId: '@channel', nativePostId: '17', accessToken: 'private-token',
      fetchImpl: vi.fn(),
    })).rejects.toThrow('exact native-post verification is unavailable for this platform and cap group');
  });
});
