/**
 * Flat `.html` → trailing-slash redirect bridge (fast-publish step 2).
 *
 * `renderArticlePages` emits both `<path>/index.html` (canonical) and a flat
 * `<path>.html` sibling. Both would otherwise carry identical `<head>`
 * content, so the no-slash URL advertises a canonical and an hreflang set
 * that point at the OTHER URL and never at itself — what Semrush counts as an
 * "hreflang ↔ rel=canonical conflict" on every flat sibling. This replaces
 * the flat file with a tiny noindex bridge.
 *
 * Transported for issue #4974 item 3 (migration §10.4 step 2) BY FUNCTION
 * CLOSURE from `build-plugins/flatHtmlRedirectPlugin.ts` (257 lines): only the
 * three declarations `buildFlatBridgeFromSibling` reaches, plus
 * `stripScriptsAndStyles` from `scripts/lib/strip-scripts-styles.mjs`. The
 * Vite plugin wrapper and `transformFlatRedirect` stay in the host — they are
 * full-build dist-walk machinery that `publish-article-fast.mjs` never calls.
 *
 * SINGLE PRODUCER: `build-plugins/flatHtmlRedirectPlugin.ts` re-exports these
 * rather than keeping its own copy, so the fast path and the full build cannot
 * emit different bridges for the same page.
 *
 * Zero imports on purpose — pure string transforms, no host coupling.
 */


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
function stripScriptsAndStyles(html = '') {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');
}

/**
 * Extract og:* / description meta tags from the sibling index.html
 * so the bridge can serve them to crawlers (Facebook, Twitter, LinkedIn, Slack…)
 * that don't follow the JS location.replace redirect. The bridge keeps
 * `noindex,follow` for Google — only social crawlers care about OG.
 *
 * Tolerant matching: meta tags can appear with attributes in any order,
 * single or double quotes. We capture the entire <meta ...> tag verbatim and
 * filter by property/name.
 *
 * Defense-in-depth for deploy run #25033670793: even if a crawler hits the
 * no-slash URL, it now gets correct preview metadata instead of a blank bridge.
 * Re-applied 2026-04-28 after confirming the text-html-ratio regression
 * was caused by the SPA-style job-card refactor (commit affb542cc), NOT by
 * this OG injection (offender count was identical with/without it).
 */
export function extractOgTags(indexHtml: string): string {
  const tags: string[] = [];
  const metaRx = /<meta\b[^>]*\/?>/gi;
  const attrRx = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = metaRx.exec(indexHtml))) {
    const tag = match[0];
    attrRx.lastIndex = 0;
    const attrs: Record<string, string> = {};
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrRx.exec(tag))) {
      const [, rawName, dq = '', sq = ''] = attrMatch;
      attrs[String(rawName || '').toLowerCase()] = dq || sq || '';
    }
    const property = String(attrs.property || '').toLowerCase();
    const name = String(attrs.name || '').toLowerCase();
    const isOg = property.startsWith('og:');
    const isDescription = name === 'description';
    if (isOg || isDescription) {
      tags.push(tag);
    }
  }
  return tags.join('\n');
}

/** Shared noindex redirect-bridge template — reused by any plugin that needs to
 * point a stale-but-still-crawled URL at its live replacement (see
 * `findOrphanedCompanyCityPairs` in weeklyEmployersPlugin.ts). */
export const NOINDEX_BRIDGE = (slashUrl: string, title: string, ogTags: string): string =>
  `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="utf-8">
<title>${title}</title>
<link rel="canonical" href="${slashUrl}">
<meta name="robots" content="noindex,follow">${ogTags ? `\n${ogTags}` : ''}
<script>location.replace(${JSON.stringify(slashUrl)} + window.location.search + window.location.hash)</script>
</head>
<body><h1>${title}</h1><a href="${slashUrl}">Continua su ${slashUrl}</a></body>
</html>`;

/**
 * Build the redirect-bridge HTML directly from the canonical (sibling)
 * HTML content + the trailing-slash URL. Title and OG tags are extracted
 * via the same regex the post-walk transform uses, so a bridge produced
 * here is byte-identical to the one `transformFlatRedirect` would produce
 * given the same `siblingHtml`.
 *
 * Why public: build plugins that emit BOTH `dist/foo.html` and
 * `dist/foo/index.html` (cluster pages, jobs-seo-pages, …) can call this
 * directly for the flat path instead of writing the full ~30 KB HTML and
 * waiting for `postWalkCoordinator` to rewrite it as a bridge. With ~150 k
 * such pairs across the build, that's ~4 GB of redundant write+read
 * traffic on the closeBundle thread — the canonical bridge content is
 * already known the moment we render the sibling. Post-walk still runs
 * `transformFlatRedirect` on every flat .html for safety; when the
 * pre-emitted bridge matches its output (same sibling → same bridge) the
 * coordinator's `html === original` guard skips the rewrite.
 */
export function buildFlatBridgeFromSibling(siblingHtml: string, slashUrl: string): string {
  let title = `Redirecting to ${slashUrl}`;
  let ogTags = '';
  try {
    const titleMatch = stripScriptsAndStyles(siblingHtml).match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch && titleMatch[1]) {
      const extracted = titleMatch[1].trim();
      if (extracted.length > 0) {
        title = extracted;
      }
    }
    ogTags = extractOgTags(siblingHtml);
  } catch {
    // fallback already set; ogTags stays empty
  }
  return NOINDEX_BRIDGE(slashUrl, title, ogTags);
}

export { stripScriptsAndStyles };
