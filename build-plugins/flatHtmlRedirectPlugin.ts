/**
 * Convert every `<path>.html` file that has a sibling `<path>/index.html`
 * into a tiny redirect-bridge HTML pointing to the trailing-slash URL.
 *
 * Why: Semrush flagged ~3.2k pages with "hreflang ↔ rel=canonical conflict"
 * and "missing self-referential hreflang" because crawlers can hit the same
 * static page via two distinct URLs:
 *
 *   1. /foo            → served from  dist/foo.html      (flat, no trailing slash)
 *   2. /foo/           → served from  dist/foo/index.html (canonical)
 *
 * Both files carried identical `<head>` content, so the no-slash URL had
 * `<link rel="canonical" href=".../foo/">` AND `<link rel="alternate"
 * hreflang="it" href=".../foo/">` — neither pointed back to itself, which
 * Semrush counted as a conflict on every URL that produced a flat sibling.
 *
 * This plugin replaces each such flat .html with a redirect bridge
 * (canonical link to `/foo/`, JS replace, noindex). Crawlers follow the
 * redirect, index `/foo/` once, and the conflict disappears.
 *
 * Note: the meta http-equiv="refresh" tag was removed because Semrush flags
 * meta-refresh redirects as a separate issue category, and per-URL <title>
 * extracted from the canonical sibling avoids duplicate-title issues.
 *
 * Skips:
 *   - .html files with no `<dir>/index.html` sibling (genuine flat pages —
 *     /404.html, /sitemap.html, top-level routes, etc.)
 *   - Files outside dist/.
 *
 * Runs as `closeBundle` so it sees every build plugin's output, including
 * staticPages, ogPages, jobs, and the various landing plugins.
 */
import path from 'node:path';
import { stripScriptsAndStyles } from '../scripts/lib/strip-scripts-styles.mjs';
import fs from 'node:fs';
import type { Plugin } from 'vite';

// Single producer (issue #4974 item 3, migration §10.4 step 2): these live in
// the colocated articles package so nanako's fast-publish path and this repo's
// full build cannot emit different output for the same page. Re-exported under
// their original names — every existing importer of this module is unchanged.
import { NOINDEX_BRIDGE, buildFlatBridgeFromSibling, extractOgTags } from '../packages/articles/engine/flatHtmlRedirect';
export { NOINDEX_BRIDGE, buildFlatBridgeFromSibling, extractOgTags };


interface FlatRedirectOptions {
  readonly baseUrl: string;
}

/**
 * Pure transform: given a flat `.html` file path, the file's current HTML, and
 * the dist root, return the redirect-bridge HTML — or `null` if the file is
 * NOT a bridge candidate (no sibling `<basename>/index.html` on disk).
 *
 * Extracted from the plugin's closeBundle handler so the
 * `postWalkCoordinatorPlugin` can apply it during a single shared dist/ walk.
 *
 * Inputs:
 *   - filePath: absolute path to the candidate flat .html file
 *   - distDir: absolute path to dist/ (used only to build the public URL)
 *   - trimmedBase: baseUrl with trailing slashes stripped
 *   - readSibling: callback that returns the sibling index.html contents
 *     (or `null` if the sibling does not exist). Centralises filesystem
 *     access so the coordinator can pass an in-memory cache.
 */
export interface FlatRedirectTransformInput {
  readonly filePath: string;
  readonly distDir: string;
  readonly trimmedBase: string;
  readonly readSibling: (siblingPath: string) => string | null;
}

export function transformFlatRedirect(input: FlatRedirectTransformInput): string | null {
  const { filePath, distDir, trimmedBase, readSibling } = input;
  if (path.basename(filePath) === 'index.html') return null;
  if (!filePath.endsWith('.html')) return null;
  // Defense-in-depth: a dotfile `<dir>/.html` is never a legitimate flat
  // sibling of `<dir>/index.html`. Some plugins concat `+ '.html'` onto a
  // path that may end with `/`, producing `<dir>/.html` accidentally; if
  // we let it pass, transformFlatRedirect would emit a bridge there and
  // GitHub Pages would serve the bridge for the `/<dir>/` URL with
  // content-type=application/octet-stream, masking the real index.html.
  // Skip basenames that start with a dot.
  if (path.basename(filePath).startsWith('.')) return null;

  const stem = filePath.slice(0, -'.html'.length);
  const sibling = path.join(stem, 'index.html');
  const siblingHtml = readSibling(sibling);
  if (siblingHtml === null) return null;

  const relPath = path.relative(distDir, stem).replace(/\\/g, '/');
  const slashUrl = `${trimmedBase}/${relPath}/`;
  return buildFlatBridgeFromSibling(siblingHtml, slashUrl);
}

/**
 * @deprecated Consumed internally by {@link postWalkCoordinatorPlugin}.
 * Kept exported for backward compatibility and unit-test access. Do NOT
 * register both this plugin AND the coordinator — they would duplicate work.
 */
export function flatHtmlRedirectPlugin(rootDir: string, opts: FlatRedirectOptions): Plugin {
  const { baseUrl } = opts;
  const trimmedBase = baseUrl.replace(/\/+$/, '');

  return {
    name: 'flat-html-redirect',
    apply: 'build',
    // Run LAST: enforce 'post' moves us into the post phase (after default-phase
    // plugins like ogPagesPlugin), and closeBundle.order 'post' + sequential
    // makes us the last closeBundle to execute within the post phase. This is
    // critical because staticPagesPlugin / *LinksPlugin all run with enforce
    // 'post' and would otherwise overwrite our bridges with full content.
    enforce: 'post',
    closeBundle: {
      order: 'post',
      sequential: true,
      handler: async () => {
      const distDir = path.resolve(rootDir, 'dist');
      if (!fs.existsSync(distDir)) return;

      let converted = 0;
      let skipped = 0;

      function* walk(dir: string): Iterable<string> {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (entry.name === 'assets' || entry.name === 'data' || entry.name === 'images') continue;
            yield* walk(p);
          } else if (entry.isFile() && entry.name.endsWith('.html')) {
            yield p;
          }
        }
      }

      for (const file of walk(distDir)) {
        if (path.basename(file) === 'index.html') continue;
        const stem = file.slice(0, -'.html'.length);
        const sibling = path.join(stem, 'index.html');
        if (!fs.existsSync(sibling)) {
          skipped++;
          continue;
        }
        const relPath = path.relative(distDir, stem).replace(/\\/g, '/');
        const slashUrl = `${trimmedBase}/${relPath}/`;
        let title = `Redirecting to ${slashUrl}`;
        let ogTags = '';
        try {
          const siblingHtml = fs.readFileSync(sibling, 'utf-8');
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
        fs.writeFileSync(file, NOINDEX_BRIDGE(slashUrl, title, ogTags));
        converted++;
      }

      console.log(
        `\x1b[36m[flat-html-redirect]\x1b[0m Converted ${converted} flat .html → redirect bridge` +
          (skipped > 0 ? ` (skipped ${skipped} flat pages without /index.html sibling)` : ''),
      );
      },
    },
  };
}
