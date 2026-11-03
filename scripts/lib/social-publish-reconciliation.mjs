import { FACEBOOK_GRAPH_API_VERSION } from './facebook-audience-insights.mjs';
import { GRAPH_API } from './instagram-graph-constants.mjs';
import { LINKEDIN_REST_VERSION } from './linkedin-links.mjs';
import { socialPublishContentFingerprint } from './social-publish-reservations.mjs';

const LINKEDIN_POSTS_API = 'https://api.linkedin.com/rest/posts';

function validTimestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

async function readJson(url, { accessToken, headers = {}, fetchImpl = fetch } = {}) {
  let response;
  let body;
  try {
    response = await fetchImpl(url, {
      headers: { ...headers, Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(12_000),
    });
    body = await response.json().catch(() => null);
  } catch (error) {
    throw new Error(error?.name === 'TimeoutError' ? 'native API read timed out' : 'native API read failed');
  }
  if (!response.ok || body?.error) throw new Error(`native API read was not authoritative (HTTP ${response.status})`);
  return body;
}

/** Verify a specific native post ID. Errors and non-published states never imply absence. */
export async function verifyExactSocialPublishedPost({
  platform,
  capGroup = 'feed',
  accountId,
  nativePostId,
  accessToken,
  fetchImpl = fetch,
} = {}) {
  const account = String(accountId || '').trim();
  const postId = String(nativePostId || '').trim();
  const token = String(accessToken || '').trim();
  if (!account || !postId || !token || /[\r\n\u0000]/u.test(postId) || postId.length > 256) {
    throw new Error('account, exact native post ID, and access token are required');
  }

  if (platform === 'facebook' && capGroup === 'feed') {
    const url = new URL(`https://graph.facebook.com/${FACEBOOK_GRAPH_API_VERSION}/${encodeURIComponent(postId)}`);
    url.searchParams.set('fields', 'id,from,created_time,is_published,message,link');
    const body = await readJson(url, { accessToken: token, fetchImpl });
    const publishedAt = validTimestamp(body?.created_time);
    if (body?.id !== postId || String(body?.from?.id || '') !== account
      || body?.is_published !== true || !publishedAt) {
      throw new Error('Meta did not confirm this exact Facebook post and Page as published');
    }
    return {
      provider: 'facebook-graph',
      publishedAt,
      nativeContentFingerprint: socialPublishContentFingerprint('facebook', {
        message: body?.message,
        link: body?.link,
      }),
    };
  }

  if (platform === 'instagram' && ['feed', 'story'].includes(capGroup)) {
    const accountUrl = new URL(`${GRAPH_API}/${encodeURIComponent(account)}`);
    accountUrl.searchParams.set('fields', 'id');
    const accountBody = await readJson(accountUrl, { accessToken: token, fetchImpl });
    if (accountBody?.id !== account) throw new Error('Instagram access token does not resolve to the configured account');

    const mediaUrl = new URL(`${GRAPH_API}/${encodeURIComponent(postId)}`);
    mediaUrl.searchParams.set('fields', 'id,timestamp,media_type,media_product_type,caption');
    const media = await readJson(mediaUrl, { accessToken: token, fetchImpl });
    const publishedAt = validTimestamp(media?.timestamp);
    if (media?.id !== postId || !publishedAt) throw new Error('Meta did not confirm this exact Instagram media ID');
    const isStory = media?.media_product_type === 'STORY';
    if ((capGroup === 'story' && !isStory) || (capGroup === 'feed' && isStory)) {
      throw new Error('Instagram media type does not match the reservation cap group');
    }
    return {
      provider: 'instagram-graph',
      publishedAt,
      nativeContentFingerprint: socialPublishContentFingerprint('instagram', { caption: media?.caption }),
    };
  }

  if (platform === 'linkedinMember' && capGroup === 'feed') {
    const url = `${LINKEDIN_POSTS_API}/${encodeURIComponent(postId)}`;
    const body = await readJson(url, {
      accessToken: token,
      headers: {
        'LinkedIn-Version': LINKEDIN_REST_VERSION,
        'X-Restli-Protocol-Version': '2.0.0',
      },
      fetchImpl,
    });
    const publishedAtMs = body?.publishedAt;
    const publishedAt = Number.isSafeInteger(publishedAtMs) && publishedAtMs > 0
      ? validTimestamp(new Date(publishedAtMs))
      : null;
    if (body?.id !== postId || body?.author !== account || body?.lifecycleState !== 'PUBLISHED' || !publishedAt) {
      throw new Error('LinkedIn did not confirm this exact member post as published by the configured author');
    }
    return {
      provider: 'linkedin-posts',
      publishedAt,
      nativeContentFingerprint: socialPublishContentFingerprint('linkedinMember', {
        commentary: body?.commentary,
        content: body?.content,
      }),
    };
  }

  throw new Error('exact native-post verification is unavailable for this platform and cap group');
}
