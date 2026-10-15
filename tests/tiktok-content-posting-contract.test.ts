/**
 * Contract guard for scripts/lib/tiktok-publish.mjs — the TikTok Content
 * Posting API request/response shape.
 *
 * WHAT THIS PROVES AND WHAT IT DOES NOT. It does NOT prove TikTok behaves as
 * documented: only a real access token can, and there is none until the app
 * audit clears. It proves that OUR request body still matches the field names
 * in the published reference, and that our reader still parses the documented
 * response payloads — the half that is checkable today, and the half that rots
 * silently, because the poster fail-soft-skips and would never have told us.
 *
 * The response payloads below are copied verbatim from
 * developers.tiktok.com/doc/content-posting-api-reference-direct-post,
 * including TikTok's own misspelling of `publicaly_available_post_id`. Do not
 * "fix" that spelling: the API sends it that way and correcting it here would
 * make the test pass while the poster loses the post id in production.
 */
import { describe, it, expect, vi } from 'vitest';

import {
  buildCarouselInitBody,
  getPrivacyLevel,
  tiktokPost,
  waitForPublishComplete,
  publishCarousel,
  TIKTOK_API,
  PRE_AUDIT_PRIVACY_LEVEL,
} from '../scripts/lib/tiktok-publish.mjs';

/** A fetch double that answers a queue of payloads and records every call. */
function fakeFetch(responses: any[]) {
  const calls: { url: string; options: any }[] = [];
  const impl = vi.fn(async (url: string, options: any) => {
    calls.push({ url, options });
    const next = responses.shift() ?? { status: 200, body: { error: { code: 'ok' }, data: {} } };
    return {
      ok: next.status ? next.status < 400 : true,
      status: next.status ?? 200,
      json: async () => next.body,
    };
  });
  return { impl, calls };
}

const OK = { error: { code: 'ok', message: '', log_id: 'x' } };

describe('buildCarouselInitBody — the documented request shape', () => {
  const body = buildCarouselInitBody({
    caption: 'I lavori più cliccati',
    imageUrls: ['https://cdn.frontaliereticino.ch/a.jpg', 'https://cdn.frontaliereticino.ch/b.jpg'],
    privacyLevel: 'SELF_ONLY',
  });

  it('nests post_info / source_info exactly as the reference does', () => {
    expect(Object.keys(body).sort()).toEqual(['media_type', 'post_info', 'post_mode', 'source_info']);
    expect(body.post_mode).toBe('DIRECT_POST');
    expect(body.media_type).toBe('PHOTO');
  });

  it('sends the whole image set in one call — TikTok has no per-image child container', () => {
    // This is the concrete difference from Instagram's flow; getting it wrong
    // would post a one-slide carousel and look like a content bug, not an API one.
    expect(body.source_info.source).toBe('PULL_FROM_URL');
    expect(body.source_info.photo_images).toHaveLength(2);
    expect(body.source_info.photo_cover_index).toBe(0);
  });

  it('carries the caption as post_info.title and the privacy level beside it', () => {
    expect(body.post_info.title).toBe('I lavori più cliccati');
    expect(body.post_info.privacy_level).toBe('SELF_ONLY');
  });

  it('keeps every documented post_info toggle present, not merely truthy', () => {
    for (const k of ['disable_duet', 'disable_comment', 'disable_stitch', 'auto_add_music']) {
      expect(body.post_info).toHaveProperty(k);
      expect(typeof body.post_info[k]).toBe('boolean');
    }
  });
});

describe('getPrivacyLevel — the unaudited-app floor', () => {
  it('defaults to SELF_ONLY, the only level an unaudited app may use', () => {
    expect(getPrivacyLevel({})).toBe(PRE_AUDIT_PRIVACY_LEVEL);
    expect(PRE_AUDIT_PRIVACY_LEVEL).toBe('SELF_ONLY');
  });

  it('lets the owner widen it once the audit is granted', () => {
    expect(getPrivacyLevel({ TIKTOK_PRIVACY_LEVEL: 'PUBLIC_TO_EVERYONE' })).toBe('PUBLIC_TO_EVERYONE');
  });

  it('ignores an all-whitespace override instead of sending an empty level', () => {
    expect(getPrivacyLevel({ TIKTOK_PRIVACY_LEVEL: '   ' })).toBe('SELF_ONLY');
  });
});

describe('tiktokPost — the error envelope, not the HTTP status, is the verdict', () => {
  it('authenticates with a bearer token and posts JSON to the v2 host', async () => {
    const { impl, calls } = fakeFetch([{ body: { ...OK, data: { publish_id: 'p1' } } }]);
    await tiktokPost('/post/publish/content/init/', { a: 1 }, 'act.tok', { fetchImpl: impl });
    expect(calls[0].url).toBe(`${TIKTOK_API}/post/publish/content/init/`);
    expect(calls[0].options.headers.Authorization).toBe('Bearer act.tok');
    expect(calls[0].options.headers['Content-Type']).toMatch(/application\/json/);
    expect(JSON.parse(calls[0].options.body)).toEqual({ a: 1 });
  });

  it('fails on a 200 that carries a non-ok error code — the trap of this API', async () => {
    const { impl } = fakeFetch([
      { status: 200, body: { error: { code: 'spam_risk_too_many_posts', message: 'daily post cap reached' } } },
    ]);
    const res = await tiktokPost('/post/publish/content/init/', {}, 't', { fetchImpl: impl });
    expect(res.ok).toBe(false);
    expect(res.error.message).toMatch(/daily post cap/);
  });

  it('fails on an HTTP error even when the body cannot be parsed', async () => {
    const impl = vi.fn(async () => ({ ok: false, status: 401, json: async () => { throw new Error('not json'); } }));
    const res = await tiktokPost('/x/', {}, 't', { fetchImpl: impl as any });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
    expect(res.error.message).toBe('no response body');
  });
});

describe('waitForPublishComplete — the async second half', () => {
  const sleepImpl = async () => {};

  it('polls status/fetch until PUBLISH_COMPLETE and returns the live post id', async () => {
    const { impl, calls } = fakeFetch([
      { body: { ...OK, data: { status: 'PROCESSING_UPLOAD' } } },
      { body: { ...OK, data: { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: ['7300000000000000000'] } } },
    ]);
    const res = await waitForPublishComplete('pub-1', 't', { fetchImpl: impl, sleepImpl });
    expect(res).toEqual({ ok: true, postId: '7300000000000000000' });
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(`${TIKTOK_API}/post/publish/status/fetch/`);
    expect(JSON.parse(calls[0].options.body)).toEqual({ publish_id: 'pub-1' });
  });

  it('reads TikTok’s own misspelling of publicaly_available_post_id', async () => {
    // Correcting the spelling here would silently drop every post id in prod.
    const { impl } = fakeFetch([
      { body: { ...OK, data: { status: 'PUBLISH_COMPLETE', publicly_available_post_id: ['correctly-spelled'] } } },
    ]);
    const res = await waitForPublishComplete('pub-2', 't', { fetchImpl: impl, sleepImpl });
    expect(res.postId).toBe('pub-2'); // falls back to publish_id — the correct spelling is NOT what TikTok sends
  });

  it('surfaces fail_reason on FAILED instead of polling to exhaustion', async () => {
    const { impl, calls } = fakeFetch([
      { body: { ...OK, data: { status: 'FAILED', fail_reason: 'picture_size_check_failed' } } },
    ]);
    const res = await waitForPublishComplete('pub-3', 't', { fetchImpl: impl, sleepImpl });
    expect(res).toEqual({ ok: false, reason: 'picture_size_check_failed' });
    expect(calls).toHaveLength(1);
  });

  it('gives up with a readable reason when the status never settles', async () => {
    const responses = Array.from({ length: 10 }, () => ({ body: { ...OK, data: { status: 'PROCESSING_UPLOAD' } } }));
    const { impl, calls } = fakeFetch(responses);
    const res = await waitForPublishComplete('pub-4', 't', { fetchImpl: impl, sleepImpl, maxAttempts: 3, delayMs: 0 });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/never reached PUBLISH_COMPLETE/);
    expect(calls).toHaveLength(3);
  });
});

describe('publishCarousel — the whole two-call flow', () => {
  const sleepImpl = async () => {};

  it('inits then polls, and returns the post id', async () => {
    const { impl, calls } = fakeFetch([
      { body: { ...OK, data: { publish_id: 'pub-9' } } },
      { body: { ...OK, data: { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: ['7311'] } } },
    ]);
    const res = await publishCarousel({
      accessToken: 't',
      imageUrls: ['https://cdn.frontaliereticino.ch/a.jpg'],
      caption: 'c',
      env: {},
      fetchImpl: impl,
      sleepImpl,
    });
    expect(res).toEqual({ ok: true, postId: '7311' });
    expect(calls[0].url).toMatch(/content\/init\/$/);
    expect(calls[1].url).toMatch(/status\/fetch\/$/);
    expect(JSON.parse(calls[1].options.body)).toEqual({ publish_id: 'pub-9' });
  });

  it('applies the unaudited SELF_ONLY floor to the init body by default', async () => {
    const { impl, calls } = fakeFetch([
      { body: { ...OK, data: { publish_id: 'p' } } },
      { body: { ...OK, data: { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: ['1'] } } },
    ]);
    await publishCarousel({ accessToken: 't', imageUrls: ['u'], caption: 'c', env: {}, fetchImpl: impl, sleepImpl });
    expect(JSON.parse(calls[0].options.body).post_info.privacy_level).toBe('SELF_ONLY');
  });

  it('never polls when init fails', async () => {
    const { impl, calls } = fakeFetch([
      { status: 400, body: { error: { code: 'invalid_params', message: 'photo_images is required' } } },
    ]);
    const res = await publishCarousel({ accessToken: 't', imageUrls: [], caption: 'c', env: {}, fetchImpl: impl, sleepImpl });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/init failed: photo_images is required/);
    expect(calls).toHaveLength(1);
  });

  it('refuses to poll on an init that answers ok but carries no publish_id', async () => {
    const { impl, calls } = fakeFetch([{ body: { ...OK, data: {} } }]);
    const res = await publishCarousel({ accessToken: 't', imageUrls: ['u'], caption: 'c', env: {}, fetchImpl: impl, sleepImpl });
    expect(res).toEqual({ ok: false, reason: 'init succeeded but returned no publish_id' });
    expect(calls).toHaveLength(1);
  });
});
