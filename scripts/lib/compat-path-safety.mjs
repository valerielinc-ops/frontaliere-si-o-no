/**
 * Shared safety predicates for external URL paths.
 *
 * The compatibility accumulator and the build both turn observed URL paths
 * into filesystem paths. Keep the filesystem and payload checks here so data
 * writers and dist emitters cannot drift apart.
 */

import { MID_PLUGINS_FAST } from './mid-plugins-flag.mjs';

export const MAX_FILESYSTEM_SEGMENT_BYTES = 255;
export const MAX_DIST_PATH_BYTES = 4096;

/**
 * Conservative filesystem bounds for a URL-derived path. The segment limit
 * matches POSIX NAME_MAX; the total limit leaves the absolute runner path well
 * below POSIX PATH_MAX.
 */
export function isDistPathOverFilesystemLimits(pathname) {
  if (typeof pathname !== 'string') return true;
  // Un'unita' UTF-16 vale al massimo 3 byte in UTF-8: sotto 86 unita' nessun
  // segmento puo' superare 255 byte e il totale resta ben sotto 4096.
  if (MID_PLUGINS_FAST && pathname.length * 3 <= MAX_FILESYSTEM_SEGMENT_BYTES) return false;
  if (Buffer.byteLength(pathname, 'utf8') > MAX_DIST_PATH_BYTES) return true;
  return pathname
    .split('/')
    .some((segment) => Buffer.byteLength(segment, 'utf8') > MAX_FILESYSTEM_SEGMENT_BYTES);
}

const COMPAT_ATTACK_PATTERNS = [
  /%27%29/i, // URL-encoded `')`
  /%3c\s*script\b/i,
  /<\s*script\b/i,
  /%2f%2a%2a%2f/i, // URL-encoded `/**/`
  /\/\*\*\//i,
  /\bunion(?:%20|\+|\s)+select\b/i,
];

const SQL_SELECT_DELIMITER_RE = /(?:%28|%29|%27|%2f%2a|\/\*\*\/|\(|\)|')/i;
const SQL_SELECT_FOLLOWING_KEYWORD_RE =
  /^(?:(?:\s|%20|%09|%0a|%0d))*(?:from|upper|xmltype|chr|concat|sleep|case|null)\b/i;

function hasSqlSelectContext(value) {
  // URL decoding leaves `+` untouched, although query-style SQL probes use it
  // as a space (`SELECT+FROM`). Normalize it only for this context check so
  // legitimate path handling elsewhere keeps the original representation.
  const normalized = value.replace(/\+/g, ' ');
  for (const match of normalized.matchAll(/\bselect\b/gi)) {
    const selectEnd = match.index + match[0].length;
    const beforeSelect = normalized.slice(Math.max(0, match.index - 8), match.index);
    const afterSelect = normalized.slice(selectEnd, selectEnd + 8);

    if (
      SQL_SELECT_DELIMITER_RE.test(beforeSelect) ||
      SQL_SELECT_DELIMITER_RE.test(afterSelect) ||
      SQL_SELECT_FOLLOWING_KEYWORD_RE.test(normalized.slice(selectEnd))
    ) return true;
  }
  return false;
}

function decodedVariants(value) {
  const variants = [value];
  let current = value;
  // A second decode catches double-escaped payloads without turning this into
  // an unbounded or permissive URL parser.
  for (let i = 0; i < 2; i++) {
    let decoded;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      break;
    }
    if (decoded === current) break;
    variants.push(decoded);
    current = decoded;
  }
  return variants;
}

// Ogni pattern d'attacco richiede almeno uno di questi indizi: '%' (anche per
// la doppia decodifica, che senza '%' non cambia la stringa), '<', '/**/',
// 'union' o 'select'. Senza nessuno dei cinque il verdetto e' `false`.
const COMPAT_ATTACK_CANDIDATE = /[%<]|\/\*\*\/|union|select/i;

export function hasCompatAttackPayload(pathname) {
  if (typeof pathname !== 'string') return true;
  if (MID_PLUGINS_FAST && !COMPAT_ATTACK_CANDIDATE.test(pathname)) return false;
  return decodedVariants(pathname).some((variant) =>
    COMPAT_ATTACK_PATTERNS.some((pattern) => pattern.test(variant)) || hasSqlSelectContext(variant),
  );
}

/**
 * Classify a path before it enters the committed 404-compat accumulator.
 * `null` means that the path is safe for these two source-level invariants.
 */
export function classifyCompatPath(pathname) {
  if (isDistPathOverFilesystemLimits(pathname)) return 'filesystem-limit';
  if (hasCompatAttackPayload(pathname)) return 'attack-payload';
  return null;
}

/**
 * Remove only paths that violate the compatibility accumulator's external
 * input contract. A malicious path may still resolve to a generic fallback,
 * so this filter deliberately runs before resolver pruning.
 */
export function filterCompatPaths(paths) {
  const kept = [];
  const dropped = [];
  for (const pathname of Array.isArray(paths) ? paths : []) {
    const reason = classifyCompatPath(pathname);
    if (reason) dropped.push({ path: pathname, reason });
    else if (typeof pathname === 'string') kept.push(pathname);
  }
  return { paths: kept, dropped };
}

/**
 * The dist writer has a stricter URL-shape gate than the compatibility data
 * filter: dot segments, malformed escapes, encoded separators and structured
 * data/XSS probes must never become output paths even when they fit on disk.
 */
export const MAX_SAFE_URL_SEGMENT_BYTES = 200;

// Segmento di soli caratteri ASCII non riservati, che non inizia per '.': per
// costruzione non contiene '%', separatori, virgolette ne' controlli, quindi
// restano da valutare solo i PROBE_MARKERS (decodeURIComponent e' l'identita').
const PLAIN_SAFE_SEGMENT = /^[A-Za-z0-9_~-][A-Za-z0-9._~-]*$/;

const INVALID_SEGMENT_CHARACTERS = /[\u0000-\u001f\u007f"'<>[\]{}\\]/;
const MALFORMED_PERCENT_ESCAPE = /%(?![0-9a-f]{2})/i;
const ENCODED_INVALID_CHARACTERS = /%(?:22|27|2f|3c|3e|5b|5d|7b|7d|5c)/i;
// `select` alone is a legitimate token in many job slugs (`selecta`,
// `selection`, `selective`). The SQL family is identified by its encoded
// comment/quote markers, an SQL keyword segment, or functions that do not occur
// in canonical slugs.
const PROBE_MARKERS = /(?:javascript\s*:|xmltype|dbms_pipe|extractvalue|waitfor|sleep\s*\(|union\s+select|(?:^|[^a-z])select(?:$|[^a-z]))/i;

function isSafeSegment(segment, maxSegmentBytes = MAX_SAFE_URL_SEGMENT_BYTES) {
  // Preserve the router's existing tolerance for repeated/trailing slashes;
  // callers still get the same segment-level safety checks for root-relative
  // URL paths and dist-relative stems.
  if (segment.length === 0) return true;
  if (MID_PLUGINS_FAST && segment.length <= maxSegmentBytes && PLAIN_SAFE_SEGMENT.test(segment)) {
    return !PROBE_MARKERS.test(`${segment} ${segment}`);
  }
  if (segment.startsWith('.')) return false;
  if (Buffer.byteLength(segment, 'utf8') > maxSegmentBytes) return false;
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
export function isSafeCompatPath(pathname, { maxSegmentBytes = MAX_SAFE_URL_SEGMENT_BYTES } = {}) {
  if (typeof pathname !== 'string' || pathname.length === 0) return false;
  if (isDistPathOverFilesystemLimits(pathname) || hasCompatAttackPayload(pathname)) return false;
  // Callers use both root-relative URL paths and dist-relative stems.
  const segments = pathname.split('/');
  return (pathname.startsWith('/') ? segments.slice(1) : segments)
    .every((segment) => isSafeSegment(segment, maxSegmentBytes));
}

/** Partition string paths so dist writers can reject unsafe inputs explicitly. */
export function filterSafeCompatPaths(paths) {
  const safePaths = [];
  const rejectedPaths = [];
  for (const value of Array.isArray(paths) ? paths : []) {
    if (typeof value !== 'string') continue;
    (isSafeCompatPath(value) ? safePaths : rejectedPaths).push(value);
  }
  return { safePaths, rejectedPaths };
}
