import { sourcePostingDateFields } from './source-posting-date.mjs';

// WordPress REST: date_gmt is publication in GMT; date is publication in the
// site's timezone. modified/modified_gmt are not publication evidence.
// https://developer.wordpress.org/rest-api/reference/posts/#schema
const LOCAL_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/;
export function wordpressPublicationDateFields(post = {}, now = new Date()) {
  const gmt = typeof post.date_gmt === 'string' ? post.date_gmt.trim() : '';
  const utc = sourcePostingDateFields(LOCAL_TIMESTAMP.test(gmt) ? `${gmt}Z` : gmt, now);
  if (utc.postingDateSource === 'reported') return utc;
  const local = typeof post.date === 'string' ? post.date.trim() : '';
  const exact = sourcePostingDateFields(local, now);
  if (exact.postingDateSource === 'reported') return exact;
  const naive = LOCAL_TIMESTAMP.exec(local);
  // Keep the explicitly stated calendar day without inventing a UTC offset.
  return sourcePostingDateFields(naive?.[1], now);
}
