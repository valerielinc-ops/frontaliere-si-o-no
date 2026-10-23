/**
 * Shared safety predicates for external URL paths.
 *
 * The build writes URL path segments as-is (including percent escapes), so the
 * filesystem limits apply to the UTF-8 bytes of the string passed to `path`.
 * Keep the limits here so emitters and compat-data writers cannot drift apart.
 */

export const MAX_FILESYSTEM_SEGMENT_BYTES = 255;
export const MAX_DIST_PATH_BYTES = 4096;

/**
 * Return true when a URL-derived path cannot be represented safely below dist.
 * The total limit is deliberately conservative and leaves the actual absolute
 * runner path well below POSIX PATH_MAX.
 */
export function isDistPathOverFilesystemLimits(pathname) {
  if (typeof pathname !== 'string') return true;
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

const SQL_SELECT_RE = /\bselect\b/i;
const SQL_SELECT_DELIMITER_RE = /(?:%28|%29|%27|%2f%2a|\/\*\*\/|\(|\)|')/i;
const SQL_SELECT_FOLLOWING_KEYWORD_RE =
  /^(?:(?:\s|%20|%09|%0a|%0d))*(?:from|upper|xmltype|chr|concat|sleep|case|null)\b/i;

function hasSqlSelectContext(value) {
  const match = SQL_SELECT_RE.exec(value);
  if (!match) return false;

  const selectEnd = match.index + match[0].length;
  const beforeSelect = value.slice(Math.max(0, match.index - 8), match.index);
  const afterSelect = value.slice(selectEnd, selectEnd + 8);

  return (
    SQL_SELECT_DELIMITER_RE.test(beforeSelect) ||
    SQL_SELECT_DELIMITER_RE.test(afterSelect) ||
    SQL_SELECT_FOLLOWING_KEYWORD_RE.test(value.slice(selectEnd))
  );
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

export function hasCompatAttackPayload(pathname) {
  if (typeof pathname !== 'string') return true;
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
 * Remove only paths that violate the external-input safety contract. This is
 * intentionally separate from resolver pruning: a malicious path may still
 * resolve to a generic fallback and must be removed regardless.
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
