import { GRAPH_API } from './instagram-graph-constants.mjs';

const PROBE_TIMEOUT_MS = 15000;

/**
 * Use a Page-authorized User Access Token and keep it out of the request URL.
 * Meta returns the Page token, Page tasks, and linked Instagram account from
 * this read-only lookup; compare the returned Page token in memory with the
 * configured publisher token so both credentials are tied to the same Page
 * and app grant without logging either token.
 */
export async function probeInstagramPageLink({
  pageId,
  userAccessToken,
  instagramAccountId,
  publisherAccessToken,
  fetchImpl = fetch,
} = {}) {
  const normalizedPageId = String(pageId || '').trim();
  const normalizedToken = String(userAccessToken || '').trim();
  const normalizedInstagramId = String(instagramAccountId || '').trim();
  const normalizedPublisherToken = String(publisherAccessToken || '').trim();
  if (!normalizedPageId || !normalizedToken) {
    return {
      pageLinkStatus: 'unavailable',
      note: 'Page link probe skipped because FB_PAGE_ID or FB_USER_ACCESS_TOKEN is missing',
      publisherTokenSourceStatus: 'unavailable',
      pageTaskStatus: 'unavailable',
      pageTaskStatuses: {
        createContent: 'unavailable', analyze: 'unavailable', moderate: 'unavailable', messaging: 'unavailable',
      },
    };
  }

  const url = new URL(`${GRAPH_API}/${encodeURIComponent(normalizedPageId)}`);
  url.searchParams.set('fields', 'id,access_token,tasks,instagram_business_account');
  let response;
  let payload;
  try {
    response = await fetchImpl(url.toString(), {
      headers: { Authorization: `Bearer ${normalizedToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    payload = await response.json().catch(() => null);
  } catch (error) {
    const reasonCode = String(error?.name || 'network-error').replace(/[^a-z0-9_-]/giu, '_').slice(0, 40);
    return { pageLinkStatus: 'unavailable', note: `Meta Graph probe failed (${reasonCode})` };
  }

  if (!response?.ok || payload?.error) {
    const status = Number(response?.status) || 0;
    const code = Number(payload?.error?.code);
    return {
      pageLinkStatus: 'unavailable',
      note: `Meta Graph probe failed (HTTP ${status}${Number.isFinite(code) && code > 0 ? `, code ${code}` : ''})`,
    };
  }

  const returnedPageId = String(payload?.id || '').trim();
  const returnedPageToken = String(payload?.access_token || '').trim();
  const tasks = Array.isArray(payload?.tasks) ? payload.tasks : null;
  const pageTaskStatus = tasks === null
    ? 'unavailable'
    : tasks.some((task) => ['CREATE_CONTENT', 'PROFILE_PLUS_CREATE_CONTENT'].includes(task))
      ? 'granted'
      : 'missing';
  const pageTaskStatuses = Object.freeze({
    createContent: pageTaskStatus,
    analyze: tasks === null ? 'unavailable' : tasks.includes('ANALYZE') ? 'granted' : 'missing',
    moderate: tasks === null ? 'unavailable' : tasks.includes('MODERATE') ? 'granted' : 'missing',
    messaging: tasks === null ? 'unavailable' : tasks.some((task) => ['MESSAGING', 'MODERATE'].includes(task)) ? 'granted' : 'missing',
  });
  const publisherTokenSourceStatus = !normalizedPublisherToken || !returnedPageToken
    ? 'unavailable'
    : normalizedPublisherToken === returnedPageToken ? 'matched' : 'mismatch';
  const linkedInstagramId = String(payload?.instagram_business_account?.id || '').trim();
  if (returnedPageId && returnedPageId !== normalizedPageId) {
    return {
      pageLinkStatus: 'mismatch',
      publisherTokenSourceStatus,
      pageTaskStatus,
      pageTaskStatuses,
      note: 'Meta returned a different Facebook Page than the configured Page ID',
    };
  }
  if (!linkedInstagramId) {
    return {
      pageLinkStatus: 'unverified',
      publisherTokenSourceStatus,
      pageTaskStatus,
      pageTaskStatuses,
      note: 'Page response does not expose instagram_business_account; Page linkage and API scopes remain unverified',
    };
  }
  if (!normalizedInstagramId) {
    return {
      pageLinkStatus: 'unverified',
      publisherTokenSourceStatus,
      pageTaskStatus,
      pageTaskStatuses,
      note: 'Page exposes an Instagram account but INSTAGRAM_BUSINESS_ACCOUNT_ID is missing',
    };
  }
  if (linkedInstagramId !== normalizedInstagramId) {
    return {
      pageLinkStatus: 'mismatch',
      publisherTokenSourceStatus,
      pageTaskStatus,
      pageTaskStatuses,
      note: 'Page exposes a different Instagram account than the configured account ID',
    };
  }
  return {
    pageLinkStatus: 'matched',
    publisherTokenSourceStatus,
    pageTaskStatus,
    pageTaskStatuses,
    note: 'Page exposes the configured Instagram account; publisher token source and content-creation task checked',
  };
}
