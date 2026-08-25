/**
 * Contract guard for scripts/lib/instagram-publish.mjs — the Instagram Graph
 * API carousel flow. Twin of tests/tiktok-content-posting-contract.test.ts,
 * and the same caveat applies: this does NOT prove Meta behaves as documented
 * (no App Review yet, therefore no token), it proves our three-step flow still
 * matches the documented one — the half that is checkable today and the half
 * that rots silently behind a poster that fail-soft-skips.
 *
 * The step these tests exist for is the container poll. Meta hands back a
 * container id immediately and refuses it at publish time if it has not
 * reached FINISHED, so a flow that skips or mis-reads the poll fails with an
 * error that reads like a permissions problem — the single most expensive
 * confusion available on the first real run.
 */
import { describe, it, expect, vi } from 'vitest';

import {
  graphPost,
  waitForContainerReady,
  publishCarousel,
  GRAPH_API,
  GRAPH_API_VERSION,
  CONTAINER_STATUS_MAX_ATTEMPTS,
} from '../scripts/lib/instagram-publish.mjs';

function fakeFetch(responses: any[]) {
  const calls: { url: string; options: any }[] = [];
  const impl = vi.fn(async (url: string, options?: any) => {
    calls.push({ url, options });
    const next = responses.shift() ?? { body: {} };
    return {
      ok: next.status ? next.status < 400 : true,
      status: next.status ?? 200,
      json: async () => next.body,
    };
  });
  return { impl, calls };
}

const noSleep = async () => {};

describe('graphPost — form encoding and the error verdict', () => {
  it('posts form-encoded params with the token folded into the body, never the URL', () => {
    // A token in the query string lands in every proxy log on the way out.
    const { impl, calls } = fakeFetch([{ body: { id: '1' } }]);
    return graphPost('123/media', { image_url: 'https://cdn/x.jpg' }, 'EAAG', { fetchImpl: impl }).then(() => {
      expect(calls[0].url).toBe(`${GRAPH_API}/123/media`);
      expect(calls[0].options.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
      const body = calls[0].options.body as URLSearchParams;
      expect(body.get('access_token')).toBe('EAAG');
      expect(body.get('image_url')).toBe('https://cdn/x.jpg');
      expect(calls[0].url).not.toContain('access_token');
    });
  });

  it('pins the Graph API version in one place', () => {
    expect(GRAPH_API).toBe(`https://graph.facebook.com/${GRAPH_API_VERSION}`);
    expect(GRAPH_API_VERSION).toMatch(/^v\d+\.\d+$/);
  });

  it('treats an `error` object as failure even on a 200', async () => {
    const { impl } = fakeFetch([{ status: 200, body: { error: { message: 'Unsupported post request', code: 100 } } }]);
    const res = await graphPost('x/media', {}, 't', { fetchImpl: impl });
    expect(res.ok).toBe(false);
    expect(res.error.message).toMatch(/Unsupported post request/);
  });

  it('reports a readable failure when the body is not JSON at all', async () => {
    const impl = vi.fn(async () => ({ ok: false, status: 500, json: async () => { throw new Error('nope'); } }));
    const res = await graphPost('x/media', {}, 't', { fetchImpl: impl as any });
    expect(res).toMatchObject({ ok: false, status: 500 });
    expect(res.error.message).toBe('no response body');
  });
});

describe('waitForContainerReady — the step that bites', () => {
  it('polls status_code until FINISHED', async () => {
    const { impl, calls } = fakeFetch([
      { body: { status_code: 'IN_PROGRESS' } },
      { body: { status_code: 'FINISHED' } },
    ]);
    expect(await waitForContainerReady('c1', 'tok', { fetchImpl: impl, sleepImpl: noSleep })).toBe(true);
    expect(calls[0].url).toContain('/c1?fields=status_code');
    expect(calls).toHaveLength(2);
  });

  it('url-encodes the access token in the status query', async () => {
    const { impl, calls } = fakeFetch([{ body: { status_code: 'FINISHED' } }]);
    await waitForContainerReady('c1', 'a b/c', { fetchImpl: impl, sleepImpl: noSleep });
    expect(calls[0].url).toContain('access_token=a%20b%2Fc');
  });

  it('gives up immediately on ERROR or EXPIRED rather than burning the budget', async () => {
    for (const status_code of ['ERROR', 'EXPIRED']) {
      const { impl, calls } = fakeFetch([{ body: { status_code } }]);
      expect(await waitForContainerReady('c', 't', { fetchImpl: impl, sleepImpl: noSleep })).toBe(false);
      expect(calls).toHaveLength(1);
    }
  });

  it('returns false — never hangs — when the container never settles', async () => {
    const { impl, calls } = fakeFetch(Array.from({ length: 20 }, () => ({ body: { status_code: 'IN_PROGRESS' } })));
    expect(await waitForContainerReady('c', 't', { fetchImpl: impl, sleepImpl: noSleep })).toBe(false);
    expect(calls).toHaveLength(CONTAINER_STATUS_MAX_ATTEMPTS);
  });
});

describe('publishCarousel — the three-step flow in order', () => {
  const ok = (id: string) => ({ body: { id } });
  const finished = { body: { status_code: 'FINISHED' } };

  it('creates one child per image, polls each, then containers and publishes', async () => {
    const { impl, calls } = fakeFetch([
      ok('child1'), ok('child2'),           // step 1, one per image
      finished, finished,                    // step 2, one poll per child
      ok('carousel'),                        // step 3a
      ok('media-live'),                      // step 3b
    ]);
    const res = await publishCarousel({
      igUserId: '178',
      accessToken: 'tok',
      imageUrls: ['https://cdn/a.jpg', 'https://cdn/b.jpg'],
      caption: 'ciao',
      fetchImpl: impl,
      sleepImpl: noSleep,
    });
    expect(res).toEqual({ ok: true, mediaId: 'media-live' });

    const childBody = calls[0].options.body as URLSearchParams;
    expect(childBody.get('is_carousel_item')).toBe('true');

    const carouselBody = calls[4].options.body as URLSearchParams;
    expect(carouselBody.get('media_type')).toBe('CAROUSEL');
    expect(carouselBody.get('children')).toBe('child1,child2');
    expect(carouselBody.get('caption')).toBe('ciao');

    expect(calls[5].url).toBe(`${GRAPH_API}/178/media_publish`);
    expect((calls[5].options.body as URLSearchParams).get('creation_id')).toBe('carousel');
  });

  it('never publishes a carousel whose children are not FINISHED', async () => {
    const { impl, calls } = fakeFetch([ok('child1'), { body: { status_code: 'ERROR' } }]);
    const res = await publishCarousel({
      igUserId: '178', accessToken: 't', imageUrls: ['u'], caption: 'c', fetchImpl: impl, sleepImpl: noSleep,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/never reached FINISHED/);
    expect(calls).toHaveLength(2); // no container, no publish
  });

  it('stops at the first failed child instead of half-building a carousel', async () => {
    const { impl, calls } = fakeFetch([{ status: 400, body: { error: { message: 'bad image_url' } } }]);
    const res = await publishCarousel({
      igUserId: '178', accessToken: 't', imageUrls: ['u1', 'u2'], caption: 'c', fetchImpl: impl, sleepImpl: noSleep,
    });
    expect(res.reason).toMatch(/child container failed: bad image_url/);
    expect(calls).toHaveLength(1);
  });

  it('reports the publish step distinctly from the container step', async () => {
    const { impl } = fakeFetch([
      ok('c1'), finished, ok('carousel'),
      { status: 400, body: { error: { message: 'permission denied' } } },
    ]);
    const res = await publishCarousel({
      igUserId: '178', accessToken: 't', imageUrls: ['u'], caption: 'c', fetchImpl: impl, sleepImpl: noSleep,
    });
    expect(res.reason).toBe('publish failed: permission denied');
  });
});
