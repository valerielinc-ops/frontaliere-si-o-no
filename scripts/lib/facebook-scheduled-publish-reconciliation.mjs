import { GRAPH_API } from './instagram-graph-constants.mjs';
import { socialPublishReservationKey } from './social-publish-reservations.mjs';

function facebookTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1000 : value;
  if (typeof value === 'string' && /^\d{10,13}$/u.test(value.trim())) {
    const numeric = Number(value);
    return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : NaN;
}

function readFacebookPostUrl(postId, token) {
  const url = new URL(`${GRAPH_API}/${encodeURIComponent(postId)}`);
  url.searchParams.set('fields', 'id,is_published,created_time,scheduled_publish_time');
  url.searchParams.set('access_token', token);
  return url;
}

/**
 * Read back due Facebook Page schedules by their exact native post IDs. A
 * schedule remains reserved until Meta confirms publication and provides its
 * actual created_time; uncertain or still-pending posts keep a rolling
 * today-and-next-day cap hold.
 */
export async function reconcileFacebookScheduledPosts({
  rows,
  pageId,
  token,
  fetchImpl = globalThis.fetch,
  now = new Date(),
  markPublished,
  refreshReservation,
  saveRows,
  log = () => {},
  warn = () => {},
  concurrency = 4,
} = {}) {
  if (!Array.isArray(rows)) throw new Error('Facebook scheduled ledger rows are required');
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new Error('Facebook reconciliation concurrency must be between 1 and 16');
  }

  const nowDate = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(nowDate.getTime())) throw new Error('Facebook reconciliation time is invalid');
  const due = rows.map((row, index) => ({ row, index }))
    .filter(({ row }) => row && typeof row === 'object'
      && typeof row.id === 'string' && row.id.trim()
      && typeof row.fbPostId === 'string' && row.fbPostId.trim()
      && typeof row.scheduledFor === 'string'
      && !Number.isFinite(facebookTimestamp(row.actualPublishedAt))
      && facebookTimestamp(row.scheduledFor) <= nowDate.getTime());
  if (due.length === 0) return { checked: 0, reconciled: 0, pending: 0, uncertain: 0 };

  const needsHoldRefresh = new Map();
  const confirmed = [];
  let pending = 0;
  let uncertain = 0;
  let reconciled = 0;

  const refreshHold = async (row, unpublishedConfirmed = false) => {
    needsHoldRefresh.set(row.id, { row, unpublishedConfirmed });
  };

  if (!pageId || !token || typeof fetchImpl !== 'function') {
    warn('⚠️ Facebook scheduled-post reconciliation is missing Page credentials or fetch');
    uncertain = due.length;
    for (const { row } of due) await refreshHold(row);
  } else {
    for (let start = 0; start < due.length; start += concurrency) {
      const batch = due.slice(start, start + concurrency);
      const outcomes = await Promise.all(batch.map(async ({ row }) => {
        try {
          const response = await fetchImpl(readFacebookPostUrl(row.fbPostId, token));
          let data;
          try {
            data = await response.json();
          } catch {
            data = null;
          }
          if (!response.ok || data?.id !== row.fbPostId) {
            warn(`⚠️ Facebook scheduled post ${row.id} could not be reconciled (HTTP ${response.status})`);
            await refreshHold(row);
            return 'uncertain';
          }
          if (data.is_published === false) {
            await refreshHold(row, true);
            return 'pending';
          }
          if (data.is_published !== true) {
            warn(`⚠️ Facebook scheduled post ${row.id} returned no definitive publication state`);
            await refreshHold(row);
            return 'uncertain';
          }
          const publishedAtMs = facebookTimestamp(data.created_time);
          if (!Number.isFinite(publishedAtMs)) {
            warn(`⚠️ Facebook scheduled post ${row.id} is published but has no valid created_time`);
            await refreshHold(row);
            return 'uncertain';
          }
          confirmed.push({ row, publishedAt: new Date(publishedAtMs).toISOString() });
          return 'published';
        } catch (error) {
          warn(`⚠️ Facebook scheduled post ${row.id} reconciliation failed: ${error.message}`);
          await refreshHold(row);
          return 'uncertain';
        }
      }));
      pending += outcomes.filter((result) => result === 'pending').length;
      uncertain += outcomes.filter((result) => result === 'uncertain').length;
    }
  }

  if (confirmed.length > 0) {
    for (const { row, publishedAt } of confirmed) row.actualPublishedAt = publishedAt;
    if (typeof saveRows !== 'function') {
      uncertain += confirmed.length;
      warn('⚠️ Facebook confirmed publication timestamps could not be persisted');
    } else {
      try {
        await saveRows(rows);
        reconciled = confirmed.length;
      } catch (error) {
        uncertain += confirmed.length;
        warn(`⚠️ Facebook actual publication timestamps could not be persisted: ${error.message}`);
      }
    }
    for (const { row, publishedAt } of confirmed) {
      try {
        if (typeof markPublished !== 'function') throw new Error('shared reservation marker is unavailable');
        await markPublished({
          platform: 'facebook',
          accountId: pageId,
          key: socialPublishReservationKey('facebook', 'job', row.id),
          publishAt: publishedAt,
          publishedAt,
          now: nowDate,
        });
      } catch (error) {
        uncertain += 1;
        warn(`⚠️ Facebook actual publication reservation remains held for ${row.id}: ${error.message}`);
      }
    }
  }

  for (const { row, unpublishedConfirmed } of needsHoldRefresh.values()) {
    try {
      if (typeof refreshReservation !== 'function') throw new Error('shared reservation refresh is unavailable');
      const refreshed = await refreshReservation({
        platform: 'facebook',
        accountId: pageId,
        key: socialPublishReservationKey('facebook', 'job', row.id),
        publishAt: nowDate,
        now: nowDate,
        unpublishedConfirmed,
      });
      if (refreshed !== true) throw new Error('reservation is not refreshable');
    } catch (error) {
      uncertain += 1;
      warn(`⚠️ Facebook unresolved schedule cap hold could not be refreshed for ${row.id}: ${error.message}`);
    }
  }

  if (reconciled > 0) log(`✅ reconciled ${reconciled} Facebook scheduled post(s) to actual publish time`);
  return { checked: due.length, reconciled, pending, uncertain };
}
