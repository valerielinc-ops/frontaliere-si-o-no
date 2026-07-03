/**
 * Root index.html — regression test for its OWN inline cross-chunk version-skew
 * self-heal listeners.
 *
 * Every static SEO page (job-detail, hub, landing, ...) loads the shared
 * EARLY_BOOT_CONTENT script (see build-plugins/constants.ts, covered by
 * tests/build-plugins/earlyBootSelfHeal.test.ts). The root index.html — the
 * actual SPA entry point — carries its OWN hand-maintained inline copy of the
 * same recovery logic instead, registered before the deferred
 * `<script type="module">` so it can catch link-time errors that fire before
 * React ever mounts. It cannot `import` services/resilientImport.ts (this
 * script runs pre-module), so its message patterns must be kept in sync by
 * hand — the same pattern-class drift risk flagged in AGENTS.md
 * §Non-Negotiables #6.
 *
 * This test pins that the inline copy stays in sync with
 * CHUNK_LOAD_ERROR_SUBSTRINGS (resilientImport.ts): it was previously missing
 * 'Importing a module script failed' (WebKit's generic module-load-failure
 * wording), the exact same gap fixed in EARLY_BOOT_CONTENT for issue #3216
 * item 1 — a Safari user landing directly on `/` (cold entry, not via a
 * static SEO page) and hitting that signature had no self-heal listener here
 * either.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

const indexHtml = readFileSync(resolve(__dirname, '..', 'index.html'), 'utf8');

// Extract the inline bootstrap <script> block — it starts right after the
// "Chunk-load error recovery" comment and ends at the </script> immediately
// preceding the deferred `<script type="module" src="/index.tsx">` tag.
const BOOTSTRAP_SCRIPT = (() => {
  const marker = 'Reload BUDGET shared by every recovery handler below';
  const commentStart = indexHtml.indexOf(marker);
  expect(commentStart, 'bootstrap self-heal comment must exist in index.html').toBeGreaterThan(-1);
  const scriptOpenEnd = indexHtml.indexOf('>', indexHtml.lastIndexOf('<script>', commentStart)) + 1;
  const scriptClose = indexHtml.indexOf('</script>', commentStart);
  expect(scriptClose, 'closing </script> for the bootstrap block must exist').toBeGreaterThan(commentStart);
  return indexHtml.slice(scriptOpenEnd, scriptClose);
})();

function loadBootstrap(): void {
  new Function(BOOTSTRAP_SCRIPT)();
}

function reloadBudgetTotal(): number {
  const budget: Record<string, number> = JSON.parse(sessionStorage.getItem('_swReloadCount') || '{}');
  return Object.values(budget).reduce((a, b) => a + Number(b), 0);
}

describe('index.html inline bootstrap self-heal', () => {
  it('is valid, self-contained JS', () => {
    expect(() => new Function(BOOTSTRAP_SCRIPT)).not.toThrow();
  });

  it("includes 'Importing a module script failed' in its unhandledrejection detection (issue #3216 item 1)", () => {
    expect(BOOTSTRAP_SCRIPT).toMatch(/Importing a module script failed/);
  });

  describe('runtime behaviour', () => {
    beforeAll(() => {
      loadBootstrap();
    });

    beforeEach(() => {
      sessionStorage.clear();
      // The version-skew listeners intentionally no-op on localhost/127.0.0.1
      // (dev), so exercise them against a production-like hostname.
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: { ...window.location, hostname: 'frontaliereticino.ch', reload: vi.fn() },
      });
    });

    it('reloads on an unhandledrejection with WebKit\'s "Importing a module script failed" wording', async () => {
      const reason = new Error('Importing a module script failed.');
      const ev = Object.assign(new Event('unhandledrejection'), { reason });
      window.dispatchEvent(ev);

      await vi.waitFor(() => expect(reloadBudgetTotal()).toBe(1));
      const info = JSON.parse(sessionStorage.getItem('_forceReloadInfo') || '{}');
      expect(info.source).toBe('index_html_import');
    });

    it('reloads on a link-time module-export skew SyntaxError', async () => {
      const err = Object.assign(new SyntaxError("does not provide an export named 'getApp'"), {});
      window.dispatchEvent(Object.assign(new Event('error'), { error: err, message: err.message }));

      await vi.waitFor(() => expect(reloadBudgetTotal()).toBe(1));
      const info = JSON.parse(sessionStorage.getItem('_forceReloadInfo') || '{}');
      expect(info.source).toBe('index_html_skew');
    });
  });
});
