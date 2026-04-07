import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Post-build verification: ensures no flat .html files in dist/ still
 * contain JavaScript redirects after the flatContentPlugin has run.
 *
 * If this test fails, it means:
 * 1. flatContentPlugin is not running, OR
 * 2. A flat redirect file has no corresponding index.html (orphan)
 *
 * Google classifies JS redirect pages as "Pagina con reindirizzamento"
 * and refuses to index them.
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
          if (!isSpaActionOnly) {
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
