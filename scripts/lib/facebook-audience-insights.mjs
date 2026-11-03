export const FACEBOOK_GRAPH_API_VERSION = 'v26.0';
const FACEBOOK_POST_INSIGHTS_UNVERIFIED = 'post-insights-eligibility-unverified';

function metaReasonCode(response, body) {
  const code = Number(body?.error?.code);
  if (response.status === 429 || [4, 17, 32].includes(code)) return 'rate-limited';
  if (code === 190) return 'credentials-invalid';
  if ([10, 200].includes(code) || [401, 403].includes(response.status)) return 'permission-unavailable';
  if (Number.isSafeInteger(code) && code > 0) return `meta-${code}`;
  return `http-${response.status}`;
}

function safeCount(value) {
  if (typeof value === 'string' && !/^\d+$/u.test(value.trim())) return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

/** Read only the Page's current follower count; never return the Page ID. */
export async function collectFacebookAudienceSnapshot({
  pageId = process.env.FB_PAGE_ID,
  accessToken = process.env.FB_PAGE_ACCESS_TOKEN,
  asOf = new Date(),
  fetchImpl = fetch,
} = {}) {
  const safePageId = String(pageId || '').trim();
  const safeToken = String(accessToken || '').trim();
  if (!safePageId || !safeToken) {
    return {
      status: 'credentials-missing',
      snapshot: null,
      postInsightsStatus: FACEBOOK_POST_INSIGHTS_UNVERIFIED,
    };
  }
  const snapshotAt = new Date(asOf).toISOString();
  const url = new URL(`https://graph.facebook.com/${FACEBOOK_GRAPH_API_VERSION}/${encodeURIComponent(safePageId)}`);
  url.searchParams.set('fields', 'followers_count,fan_count');
  let response;
  let body;
  try {
    response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${safeToken}` },
      signal: AbortSignal.timeout(12_000),
    });
    body = await response.json();
  } catch (error) {
    return {
      status: error?.name === 'TimeoutError' ? 'api-error' : 'network-error',
      snapshot: null,
      postInsightsStatus: FACEBOOK_POST_INSIGHTS_UNVERIFIED,
      reasonCode: error?.name === 'TimeoutError' ? 'timeout' : 'network-error',
    };
  }
  if (!response.ok || body?.error) {
    const reasonCode = metaReasonCode(response, body);
    return {
      status: ['rate-limited', 'credentials-invalid', 'permission-unavailable'].includes(reasonCode)
        ? reasonCode
        : 'api-error',
      snapshot: null,
      postInsightsStatus: FACEBOOK_POST_INSIGHTS_UNVERIFIED,
      reasonCode,
    };
  }
  const followers = safeCount(body?.followers_count);
  if (followers === null) {
    return {
      status: 'metric-unavailable',
      snapshot: null,
      postInsightsStatus: FACEBOOK_POST_INSIGHTS_UNVERIFIED,
      reasonCode: 'followers-count-missing',
    };
  }
  const likes = safeCount(body?.fan_count);
  const postInsightsStatus = likes !== null
    ? likes < 100 ? 'post-insights-below-100-page-likes' : 'post-insights-exact-id-probe-required'
    : FACEBOOK_POST_INSIGHTS_UNVERIFIED;
  return {
    status: 'available',
    postInsightsStatus,
    snapshot: {
      channel: 'facebook',
      metric: 'followers',
      value: followers,
      snapshotAt,
      status: 'available',
      source: 'facebook-page-followers-count',
    },
  };
}
