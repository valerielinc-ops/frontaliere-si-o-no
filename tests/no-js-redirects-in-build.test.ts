import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Post-build verification: ensures no flat .html files in dist/ still
 * contain ACCIDENTAL JavaScript redirects.
 *
 * As of `flatHtmlRedirectPlugin` (2026-04-25), every flat `<path>.html`
 * with a sibling `<path>/index.html` is INTENTIONALLY rewritten into a
 * 12-line redirect bridge (canonical link, meta-refresh, location.replace,
 * `<meta name="robots" content="noindex,follow">`) to close ~3.2k Semrush
 * "hreflang ↔ canonical conflict" reports. Those bridges are EXPECTED
 * to carry `location.replace`; they're explicitly noindex so Google
 * follows the redirect and never indexes the no-slash URL twice.
 *
 * This test therefore now flags any flat .html that:
 *  - Contains `location.replace(`
 *  - AND does NOT also carry `<meta name="robots" content="noindex` (i.e.
 *    a deliberate redirect bridge)
 *  - AND is not the SPA action-only conditional redirect.
 *
 * If this test fails, it means a content page accidentally shipped with
 * a JS redirect — Google would mark it as "Pagina con reindirizzamento".
 */

const DIST_DIR = path.resolve(__dirname, '..', 'dist');

describe('no JS redirects in built flat files', () => {
  it('dist/ flat .html files must not contain location.replace()', { timeout: 300_000 }, () => {
    if (!fs.existsSync(DIST_DIR)) {
      // Build hasn't run — skip gracefully
      console.log('  ⏭  dist/ not found, skipping post-build redirect check');
      return;
    }

    const violations: string[] = [];

    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch { return; /* skip directories that can't be read (e.g. long filenames) */ }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          walk(path.join(dir, entry.name));
          continue;
        }

        if (
          !entry.name.endsWith('.html') ||
          entry.name === 'index.html' ||
          entry.name === '404.html'
        ) continue;

        const filePath = path.join(dir, entry.name);
        let content: string;
        try { content = fs.readFileSync(filePath, 'utf-8'); }
        catch { continue; /* file may have been removed between readdir and read */ }

        if (content.includes('location.replace(')) {
          // The SPA_ACTION_REDIRECT_SCRIPT uses location.replace('/') inside a
          // guarded `if` that only fires for specific query params (action,
          // authToken, newsletter_autologin). This is NOT a general JS redirect
          // — it's a conditional SPA parameter handler. Skip these.
          const isSpaActionOnly =
            content.includes('SPA_ACTION_REDIRECT_SCRIPT') ||
            (content.includes("p.get('action')") && content.includes("sessionStorage.redirect"));
          // flatHtmlRedirectPlugin (2026-04-25) intentionally emits a redirect
          // bridge for every flat .html that has a sibling /index.html. The
          // bridge is explicitly noindex so Google follows the redirect and
          // does not double-index. These are EXPECTED, not accidental.
          const isIntentionalBridge =
            content.includes('name="robots"') &&
            content.includes('noindex') &&
            content.includes('http-equiv="refresh"');
          if (!isSpaActionOnly && !isIntentionalBridge) {
            const relPath = path.relative(DIST_DIR, filePath);
            violations.push(relPath);
          }
        }
      }
    };

    walk(DIST_DIR);

    if (violations.length > 0) {
      const sample = violations.slice(0, 10).join('\n  ');
      expect.fail(
        `Found ${violations.length} flat .html files with JS redirects (Google classifies as "Page with redirect"):\n  ${sample}${violations.length > 10 ? `\n  ... and ${violations.length - 10} more` : ''}`,
      );
    }
  });
});
