/**
 * tiktok-publish.mjs — the TikTok Content Posting API layer, extracted from
 * scripts/post-to-tiktok.mjs so it can be exercised without a live token.
 *
 * WHY THIS FILE EXISTS. post-to-tiktok.mjs's header says the request/response
 * shape below "is written from TikTok's published Content Posting API docs …
 * but still never exercised against a live call". That statement was true and
 * stayed true, but it hid a second, fixable problem: the shape was also never
 * exercised against a MOCK, because the three functions lived inside a script
 * that calls main() and process.exit(0) at module scope — importing it from a
 * test kills the test process. So a typo in a field name (`photo_images` →
 * `photo_urls`), a wrong nesting level, or a response reader that stops
 * matching the documented payload would have shipped silently, and would have
 * been discovered only on the first real post after TikTok's audit — the one
 * run where a soft-skip is no longer available to hide it.
 *
 * Extracting the layer does NOT prove TikTok behaves as documented; only a
 * real token can. It proves the code still matches what the docs say, which is
 * the half that is checkable today and the half that silently rots.
 *
 * Every network call goes through the injected `fetchImpl`/`sleepImpl`, so
 * tests/tiktok-content-posting-contract.test.ts drives the whole two-call
 * async flow against payloads copied verbatim from the reference docs.
 *
 * Doc reference (re-check before the first non-dry-run post, as the caller's
 * header instructs):
 *   developers.tiktok.com/doc/content-posting-api-reference-direct-post
 */
import { fetchRetry, sleep } from './ga4-service-account.mjs';

export const TIKTOK_API = 'https://open.tiktokapis.com/v2';
export const PUBLISH_STATUS_MAX_ATTEMPTS = 6;
export const PUBLISH_STATUS_DELAY_MS = 3000;

/**
 * The only privacy level an UNAUDITED app may use. TikTok 400s a PUBLIC post
 * until the app audit is granted, so this is the safe pre-audit default and
 * the owner overrides it via TIKTOK_PRIVACY_LEVEL once audited.
 */
export const PRE_AUDIT_PRIVACY_LEVEL = 'SELF_ONLY';

export function getPrivacyLevel(env = process.env) {
  // Trim BEFORE the fallback, not after: `'   ' || 'SELF_ONLY'` is `'   '`,
  // which then trims to the empty string — an all-whitespace override used to
  // send `privacy_level: ''` and lose the pre-audit floor entirely. Found by
  // tests/tiktok-content-posting-contract.test.ts the first time this layer was
  // ever exercised; the poster's fail-soft skip had hidden it since day one.
  return String(env.TIKTOK_PRIVACY_LEVEL ?? '').trim() || PRE_AUDIT_PRIVACY_LEVEL;
}

/**
 * Build the `content/init/` request body for a photo carousel.
 *
 * Pure and exported on purpose: it is the single place where the documented
 * field names live, so a contract test can assert the shape without having to
 * stand up the whole publish flow.
 */
export function buildCarouselInitBody({ caption, imageUrls, privacyLevel }) {
  return {
    post_info: {
      title: caption,
      privacy_level: privacyLevel,
      disable_duet: true,
      disable_comment: false,
      disable_stitch: true,
      auto_add_music: true,
    },
    source_info: {
      source: 'PULL_FROM_URL',
      photo_cover_index: 0,
      photo_images: imageUrls,
    },
    post_mode: 'DIRECT_POST',
    media_type: 'PHOTO',
  };
}

/**
 * One POST against the Content Posting API.
 *
 * TikTok answers 200 with an `error` envelope even on failure, so `res.ok`
 * alone is not the verdict: `error.code === 'ok'` is. Both halves are checked.
 */
export async function tiktokPost(pathSuffix, body, accessToken, { fetchImpl = fetchRetry } = {}) {
  const res = await fetchImpl(`${TIKTOK_API}${pathSuffix}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res?.ok || data?.error?.code !== 'ok') {
    return { ok: false, status: res?.status, error: data?.error || { message: 'no response body' } };
  }
  return { ok: true, data: data.data };
}

/**
 * Poll `status/fetch/` until the post is live.
 *
 * `publicaly_available_post_id` is misspelled in TikTok's OWN response — the
 * misspelling is deliberate here, not a typo to "fix".
 */
export async function waitForPublishComplete(publishId, accessToken, opts = {}) {
  const { fetchImpl = fetchRetry, sleepImpl = sleep, maxAttempts = PUBLISH_STATUS_MAX_ATTEMPTS, delayMs = PUBLISH_STATUS_DELAY_MS } = opts;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await tiktokPost('/post/publish/status/fetch/', { publish_id: publishId }, accessToken, { fetchImpl });
    if (!res.ok) return { ok: false, reason: res.error?.message || `status ${res.status}` };
    const status = res.data?.status;
    if (status === 'PUBLISH_COMPLETE') return { ok: true, postId: res.data?.publicaly_available_post_id?.[0] || publishId };
    if (status === 'FAILED') return { ok: false, reason: res.data?.fail_reason || 'FAILED' };
    await sleepImpl(delayMs);
  }
  return { ok: false, reason: 'status never reached PUBLISH_COMPLETE within the poll budget' };
}

/**
 * Full photo-carousel publish: init (PULL_FROM_URL, all image URLs at once —
 * unlike Instagram, TikTok's photo endpoint takes the whole set in one call,
 * no per-image child container) → poll until PUBLISH_COMPLETE.
 */
export async function publishCarousel({ accessToken, imageUrls, caption, env = process.env, ...opts }) {
  const { fetchImpl = fetchRetry } = opts;
  const initRes = await tiktokPost(
    '/post/publish/content/init/',
    buildCarouselInitBody({ caption, imageUrls, privacyLevel: getPrivacyLevel(env) }),
    accessToken,
    { fetchImpl },
  );
  if (!initRes.ok) return { ok: false, reason: `init failed: ${initRes.error?.message || initRes.status}` };

  const publishId = initRes.data?.publish_id;
  if (!publishId) return { ok: false, reason: 'init succeeded but returned no publish_id' };

  return waitForPublishComplete(publishId, accessToken, opts);
}
