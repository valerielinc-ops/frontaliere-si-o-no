import { isAmbiguousSocialPublishResponse } from './social-publish-outcome.mjs';

export function classifyLinkedInMemberPostResponse({ status, postId, body = '' } = {}) {
  const statusCode = Number(status);
  const nativeId = String(postId || '').trim();
  if (Number.isInteger(statusCode) && statusCode >= 200 && statusCode < 300) {
    if (nativeId && !['unknown', 'none', 'null', 'undefined'].includes(nativeId.toLowerCase())) {
      return { ok: true, postId: nativeId };
    }
    return {
      ok: false,
      status: statusCode,
      body: 'accepted response did not include a valid x-restli-id',
      deliveryUncertain: true,
    };
  }
  return {
    ok: false,
    status: Number.isInteger(statusCode) ? statusCode : null,
    body: String(body || '').slice(0, 300),
    deliveryUncertain: isAmbiguousSocialPublishResponse({ status }),
  };
}
