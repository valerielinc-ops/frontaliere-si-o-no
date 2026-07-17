/**
 * Drop <script>/<style> blocks so heading/title regexes match only rendered
 * DOM. A JSON-LD or JS string inside <script> can contain literal
 * "<h1>…</h1>" / "<title>…</title>" markup (Refline JSON-LD incident
 * 2026-07, PR #4335): matching the raw html captures that embedded text
 * instead of the visible element.
 *
 * Zero-dependency on purpose: consumed by crawler parsers (via re-export in
 * crawler-template.mjs), build-plugins (vite config graph — must not drag
 * crawler deps in) and tests.
 */
export function stripScriptsAndStyles(html = '') {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');
}
