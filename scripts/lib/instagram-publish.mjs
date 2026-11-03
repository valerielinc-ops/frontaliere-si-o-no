/**
 * instagram-publish.mjs — the Instagram Graph API carousel publish layer,
 * extracted from scripts/post-to-instagram.mjs for the same reason as its
 * TikTok twin (scripts/lib/tiktok-publish.mjs): the poster calls main() and
 * process.exit(0) at module scope, so importing it from a test killed the test
 * process, and the request/response shape had therefore never been exercised —
 * not against a live token (no App Review yet) and not even against a mock.
 *
 * The three-step flow is the part worth pinning, because none of its steps is
 * guessable from the others:
 *
 *   1. one child container per image   POST {ig-user-id}/media
 *                                      image_url + is_carousel_item=true
 *   2. every child polled to FINISHED  GET  {container-id}?fields=status_code
 *   3. carousel container, then publish POST {ig-user-id}/media
 *                                      media_type=CAROUSEL + children=…
 *                                      POST {ig-user-id}/media_publish
 *
 * Step 2 is the one that bites: Meta returns a container id immediately and
 * rejects it at publish time if it is not FINISHED yet, so skipping the poll
 * produces an error that reads like a permissions problem. The poll budget
 * (5 attempts × 2s) is deliberately short and is the thing to re-measure
 * against a real token — see the issue this file's PR reclassified.
 *
 * Publish mutations are sent once; without a Graph idempotency key, retrying
 * a timed-out /media_publish could duplicate a post. The result records
 * pre-publish versus publish phase so callers can release definite failures
 * while retaining reservations for ambiguous final outcomes.
 */
import { fetchRetry, sleep } from './ga4-service-account.mjs';
import { GRAPH_API, GRAPH_API_VERSION } from './instagram-graph-constants.mjs';
import { isAmbiguousSocialPublishResponse } from './social-publish-outcome.mjs';

// Re-exported so the contract test and the poster read the same base without
// a second literal: the single definition lives in the dependency-free Graph
// constants module shared with the Mac community worker.
export { GRAPH_API, GRAPH_API_VERSION };
export const CONTAINER_STATUS_MAX_ATTEMPTS = 5;
export const CONTAINER_STATUS_DELAY_MS = 2000;
export const REEL_CONTAINER_STATUS_MAX_ATTEMPTS = 30;
export const REEL_CONTAINER_STATUS_DELAY_MS = 10_000;

/** @typedef {{ ok: true, mediaId: string } | { ok: false, reason: string, phase?: 'pre-publish', uncertain?: false } | { ok: false, reason: string, phase: 'publish', uncertain?: boolean }} InstagramPublishResult */

/**
 * One form-encoded POST against the Graph API. Mutation POSTs do not use the
 * retrying transport; status GETs remain safe to retry.
 *
 * Note the verdict rule differs from TikTok's: Meta signals failure with a
 * non-2xx AND an `error` object, so the presence of `error` alone is enough.
 */
export async function graphPost(pathSuffix, params, accessToken, { fetchImpl = fetch } = {}) {
  const body = new URLSearchParams({ ...params, access_token: accessToken });
  const res = await fetchImpl(`${GRAPH_API}/${pathSuffix}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res?.ok || data.error) {
    return { ok: false, status: res?.status, error: data.error || { message: 'no response body' } };
  }
  return { ok: true, data };
}

function ambiguousFinalPublish(result) {
  if (isAmbiguousSocialPublishResponse(result)) return true;
  const status = Number(result?.status);
  return status >= 200 && status < 300 && !result?.error && !result?.data?.id;
}

export async function waitForContainerReady(containerId, accessToken, opts = {}) {
  const { fetchImpl = fetchRetry, sleepImpl = sleep, maxAttempts = CONTAINER_STATUS_MAX_ATTEMPTS, delayMs = CONTAINER_STATUS_DELAY_MS } = opts;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetchImpl(
      `${GRAPH_API}/${containerId}?fields=status_code&access_token=${encodeURIComponent(accessToken)}`,
    );
    const data = await res?.json().catch(() => ({}));
    if (!res?.ok || data?.error) return false;
    const status = data?.status_code;
    if (status === 'FINISHED') return true;
    if (status === 'ERROR' || status === 'EXPIRED') return false;
    if (attempt < maxAttempts) await sleepImpl(delayMs);
  }
  return false;
}

/**
 * Full carousel publish: child containers → poll → carousel container →
 * publish. A failure records whether it happened before the final publish
 * request or during it; `uncertain: true` means the caller must retain its
 * reservation because Meta may have accepted the post. Never throws.
 *
 * @returns {Promise<InstagramPublishResult>}
 */
export async function publishCarousel({ igUserId, accessToken, imageUrls, caption, ...opts }) {
  const fetchImpl = opts.fetchImpl || fetch;
  const statusFetchImpl = opts.statusFetchImpl || (opts.fetchImpl ? opts.fetchImpl : fetchRetry);
  const childIds = [];
  let finalPublishAttempted = false;
  try {
    for (const imageUrl of imageUrls) {
      const res = await graphPost(`${igUserId}/media`, { image_url: imageUrl, is_carousel_item: 'true' }, accessToken, { fetchImpl });
      if (!res.ok) return { ok: false, phase: 'pre-publish', reason: `child container failed: ${res.error?.message || res.status}` };
      childIds.push(res.data.id);
    }

    for (const id of childIds) {
      const ready = await waitForContainerReady(id, accessToken, { ...opts, fetchImpl: statusFetchImpl });
      if (!ready) return { ok: false, phase: 'pre-publish', reason: `child container ${id} never reached FINISHED` };
    }

    const containerRes = await graphPost(
      `${igUserId}/media`,
      { media_type: 'CAROUSEL', children: childIds.join(','), caption },
      accessToken,
      { fetchImpl },
    );
    if (!containerRes.ok) {
      return { ok: false, phase: 'pre-publish', reason: `carousel container failed: ${containerRes.error?.message || containerRes.status}` };
    }

    finalPublishAttempted = true;
    const publishRes = await graphPost(`${igUserId}/media_publish`, { creation_id: containerRes.data.id }, accessToken, { fetchImpl });
    if (!publishRes.ok) {
      return {
        ok: false,
        phase: 'publish',
        ...(ambiguousFinalPublish(publishRes) ? { uncertain: true } : {}),
        reason: `publish failed: ${publishRes.error?.message || publishRes.status}`,
      };
    }
    if (!publishRes.data?.id) {
      return { ok: false, phase: 'publish', uncertain: true, reason: 'publish response did not include a media id' };
    }
    return { ok: true, mediaId: publishRes.data.id };
  } catch (error) {
    return {
      ok: false,
      phase: finalPublishAttempted ? 'publish' : 'pre-publish',
      ...(finalPublishAttempted ? { uncertain: true } : {}),
      reason: `${finalPublishAttempted ? 'publish' : 'pre-publish'} request failed: ${error.message || error}`,
    };
  }
}

/**
 * Publish one Instagram Reel through the documented Graph API container flow.
 * Video processing can take several minutes, so this uses a bounded five
 * minute poll budget while keeping each status check observable and finite.
 *
 * @returns {Promise<InstagramPublishResult>}
 */
export async function publishReel({
  igUserId,
  accessToken,
  videoUrl,
  caption,
  coverUrl,
  shareToFeed = true,
  ...opts
}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const statusFetchImpl = opts.statusFetchImpl || (opts.fetchImpl ? opts.fetchImpl : fetchRetry);
  if (!igUserId || !accessToken || !videoUrl || !caption) {
    return { ok: false, reason: 'Instagram Reel requires account, token, video URL, and caption' };
  }

  const containerParams = {
    media_type: 'REELS',
    video_url: videoUrl,
    caption,
    share_to_feed: String(Boolean(shareToFeed)),
    ...(coverUrl ? { cover_url: coverUrl } : {}),
  };
  let finalPublishAttempted = false;
  try {
    const containerRes = await graphPost(`${igUserId}/media`, containerParams, accessToken, { fetchImpl });
    if (!containerRes.ok || !containerRes.data?.id) {
      return { ok: false, phase: 'pre-publish', reason: `Reel container failed: ${containerRes.error?.message || 'missing container id'}` };
    }

    const ready = await waitForContainerReady(containerRes.data.id, accessToken, {
      ...opts,
      fetchImpl: statusFetchImpl,
      maxAttempts: opts.maxAttempts ?? REEL_CONTAINER_STATUS_MAX_ATTEMPTS,
      delayMs: opts.delayMs ?? REEL_CONTAINER_STATUS_DELAY_MS,
    });
    if (!ready) return { ok: false, phase: 'pre-publish', reason: `Reel container ${containerRes.data.id} never reached FINISHED` };

    finalPublishAttempted = true;
    const publishRes = await graphPost(
      `${igUserId}/media_publish`,
      { creation_id: containerRes.data.id },
      accessToken,
      { fetchImpl },
    );
    if (!publishRes.ok) {
      return {
        ok: false,
        phase: 'publish',
        ...(ambiguousFinalPublish(publishRes) ? { uncertain: true } : {}),
        reason: `Reel publish failed: ${publishRes.error?.message || 'missing media id'}`,
      };
    }
    if (!publishRes.data?.id) {
      return { ok: false, phase: 'publish', uncertain: true, reason: 'Reel publish response did not include a media id' };
    }
    return { ok: true, mediaId: publishRes.data.id };
  } catch (error) {
    return {
      ok: false,
      phase: finalPublishAttempted ? 'publish' : 'pre-publish',
      ...(finalPublishAttempted ? { uncertain: true } : {}),
      reason: `${finalPublishAttempted ? 'Reel publish' : 'Reel pre-publish'} request failed: ${error.message || error}`,
    };
  }
}
