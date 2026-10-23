/**
 * Shared safety gate for URL paths that may become filesystem paths.
 *
 * The compatibility accumulator is fed by external URL observations. A path
 * can therefore be syntactically a URL while still being a SQL/XSS probe or
 * an oversized filesystem component. Keep this predicate in the JS library
 * used by data writers and by the TS build plugins so the two gates cannot
 * drift.
 */

/**
 * Existing slug producers cap individual slugs at 180–200 characters. Keep
 * observed compatibility segments below 200 UTF-8 bytes, well under the
 * Linux 255-byte component limit and accounting for percent-encoded input.
 */
export const MAX_SAFE_URL_SEGMENT_BYTES = 200;

const INVALID_SEGMENT_CHARACTERS = /[\u0000-\u001f\u007f"'<>[\]{}\\]/;
const MALFORMED_PERCENT_ESCAPE = /%(?![0-9a-f]{2})/i;
const ENCODED_INVALID_CHARACTERS = /%(?:22|27|2f|3c|3e|5b|5d|7b|7d|5c)/i;
// `select` alone is a legitimate token in many job slugs (`selecta`,
// `selection`, `selective`). The SQL family is identified by its encoded
// comment/quote markers, an SQL keyword segment, or functions that do not occur
// in canonical slugs.
const PROBE_MARKERS = /(?:javascript\s*:|xmltype|dbms_pipe|extractvalue|waitfor|sleep\s*\(|union\s+select|(?:^|[^a-z])select(?:$|[^a-z]))/i;

function isSafeSegment(segment) {
  // Preserve the router's existing tolerance for repeated/trailing slashes;
  // callers still get the same segment-level safety checks for root-relative
  // URL paths and dist-relative stems.
  if (segment.length === 0) return true;
  if (segment.startsWith('.')) return false;
  if (Buffer.byteLength(segment, 'utf8') > MAX_SAFE_URL_SEGMENT_BYTES) return false;
  if (INVALID_SEGMENT_CHARACTERS.test(segment)) return false;
  if (MALFORMED_PERCENT_ESCAPE.test(segment) || ENCODED_INVALID_CHARACTERS.test(segment)) return false;

  let decoded;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return false;
  }
  if (decoded.includes('/') || INVALID_SEGMENT_CHARACTERS.test(decoded)) return false;
  return !PROBE_MARKERS.test(`${segment} ${decoded}`);
}

/** Return false when any URL segment is unsafe for dist emission. */
export function isSafeCompatPath(pathname) {
  if (typeof pathname !== 'string' || pathname.length === 0) return false;
  // Callers use both root-relative URL paths and dist-relative stems.
  const segments = pathname.split('/');
  return (pathname.startsWith('/') ? segments.slice(1) : segments).every(isSafeSegment);
}

/** Partition string paths so data writers can reject unsafe inputs explicitly. */
export function filterSafeCompatPaths(paths) {
  const safePaths = [];
  const rejectedPaths = [];
  for (const value of Array.isArray(paths) ? paths : []) {
    if (typeof value !== 'string') continue;
    (isSafeCompatPath(value) ? safePaths : rejectedPaths).push(value);
  }
  return { safePaths, rejectedPaths };
}
