/**
 * A URL path segment beginning with `.` must never become a dist output path.
 *
 * A trailing-slash URL such as `/foo/.env.bak/` otherwise produces both
 * `dist/foo/.env.bak/index.html` and the flat sibling
 * `dist/foo/.env.bak.html`; the latter is an invalid dotfile HTML output.
 * Rejecting every dot-prefixed segment also keeps `.`/`..` path segments away
 * from writers that turn external URL paths into filesystem paths.
 */
export function isSafeDistPath(pathname: string): boolean {
  return !pathname.split('/').some((segment) => segment.startsWith('.'));
}
