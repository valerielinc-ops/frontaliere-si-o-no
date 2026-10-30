/**
 * GA4 keeps at most 100 characters of an event parameter, and the property's
 * 50 event-scoped custom dimensions are all taken, so `resource_url` can never
 * be queried. `resource_load_error` therefore names the failed resource in the
 * registered `error_message` dimension, as the short label built here.
 */
export const GA4_PARAM_MAX_CHARS = 100;

const ELLIPSIS = '…';

/**
 * `host/path` of a failed resource. Query and hash are dropped: they can carry
 * tokens, and they would explode the dimension's cardinality. When the label
 * does not fit, the middle of the path goes: the host says who served it and
 * the file name says what it was.
 */
export const buildResourceErrorLabel = (rawUrl: string): string => {
 if (!rawUrl) return '(empty)';
 let label: string;
 try {
  const url = new URL(rawUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return `${url.protocol}(inline)`;
  label = `${url.host}${url.pathname}`;
 } catch {
  label = rawUrl.split(/[?#]/)[0];
 }
 if (label.length <= GA4_PARAM_MAX_CHARS) return label;
 const slash = label.indexOf('/');
 const host = slash > 0 ? label.slice(0, slash + 1) : '';
 const tailLength = GA4_PARAM_MAX_CHARS - host.length - ELLIPSIS.length;
 if (tailLength <= 0) return label.slice(0, GA4_PARAM_MAX_CHARS);
 return `${host}${ELLIPSIS}${label.slice(-tailLength)}`;
};
