/**
 * index.html — the GitHub-Pages SPA redirect handler must only ever restore a
 * SITE-RELATIVE path from `?p=`.
 *
 * Every legitimate producer of `p` writes `canonicalPath.slice(1)`, i.e. a
 * relative path with no leading slash: public/404.html's spaRedirect,
 * build-plugins/staticPagesPlugin.ts and packages/articles/engine/ogPagesPlugin.ts.
 * The handler nevertheless prefixed WHATEVER arrived with '/' and handed it to
 * history.replaceState, so a request carrying an absolute URL minted a real
 * navigable path:
 *
 *     /?p=https://frontaliereticino.ch/cerca-lavoro-ticino/
 *   → /https://frontaliereticino.ch/cerca-lavoro-ticino/
 *
 * That is the literal string GA4 reported as the Page for issues #5531/#5533.
 * It is not only a telemetry artefact: replaceState moves the DOCUMENT BASE URL,
 * the minted path 404s on the origin, and public/404.html then re-saves the
 * corrupted href into sessionStorage.redirect, which the sibling handler in this
 * same block replays on the next load — so the corruption sustains itself.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect, beforeEach } from 'vitest';

const indexHtml = readFileSync(resolve(__dirname, '..', 'index.html'), 'utf8');

/** The inline `<script>` holding the SPA redirect + dark-mode bootstrap. */
const SPA_REDIRECT_SCRIPT = (() => {
  const marker = 'GitHub Pages SPA redirect handler';
  const commentStart = indexHtml.indexOf(marker);
  expect(commentStart, 'SPA redirect handler comment must exist in index.html').toBeGreaterThan(-1);
  const scriptOpenEnd = indexHtml.indexOf('>', indexHtml.lastIndexOf('<script>', commentStart)) + 1;
  const scriptClose = indexHtml.indexOf('</script>', commentStart);
  expect(scriptClose, 'closing </script> for the SPA redirect block must exist').toBeGreaterThan(commentStart);
  return indexHtml.slice(scriptOpenEnd, scriptClose);
})();

/**
 * Runs the real inline bootstrap against a given query string.
 *
 * Returns the PATHNAME separately from the full URL: a rejected `p` is left
 * sitting in the query string (nothing navigates), so only the pathname can
 * tell "restored" from "refused".
 */
function runWithQuery(query: string): { pathname: string; url: string } {
  sessionStorage.clear();
  localStorage.clear();
  window.history.replaceState(null, '', `/${query}`);
  // eslint-disable-next-line no-new-func -- executing the shipped inline script verbatim is the point
  new Function(SPA_REDIRECT_SCRIPT)();
  return {
    pathname: window.location.pathname,
    url: window.location.pathname + window.location.search,
  };
}

describe('index.html SPA redirect — legitimate relative `p` still restores', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('restores a relative path', () => {
    expect(runWithQuery('?p=cerca-lavoro-ticino/').url).toBe('/cerca-lavoro-ticino/');
  });

  it('restores a nested relative path', () => {
    expect(runWithQuery('?p=cerca-lavoro-vallese/qa-manager-lonza-visp/').url).toBe(
      '/cerca-lavoro-vallese/qa-manager-lonza-visp/',
    );
  });

  it('restores the ~and~-encoded query alongside the path', () => {
    expect(runWithQuery('?p=cerca-lavoro-ticino/&q=a=1~and~b=2').url).toBe('/cerca-lavoro-ticino/?a=1&b=2');
  });

  it('leaves the URL alone when there is no `p`', () => {
    expect(runWithQuery('').url).toBe('/');
  });
});

describe('index.html SPA redirect — a non-relative `p` must be rejected (#5531/#5533)', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('does not mint "/https://frontaliereticino.ch/..." from an absolute same-origin URL', () => {
    // The exact string GA4 reported as the Page on #5531 and #5533.
    const { pathname } = runWithQuery('?p=https://frontaliereticino.ch/cerca-lavoro-ticino/');
    expect(pathname).toBe('/');
    expect(pathname).not.toContain('https:');
  });

  it('rejects an absolute cross-origin URL', () => {
    const { pathname } = runWithQuery('?p=https://evil.example/phish/');
    expect(pathname).toBe('/');
  });

  it('rejects a protocol-relative "//host" path', () => {
    // '/' + '//evil.example/x' would have produced '///evil.example/x', which
    // browsers normalise back toward the authority form.
    const { pathname } = runWithQuery('?p=//evil.example/x');
    expect(pathname).toBe('/');
  });

  it('rejects a leading-slash path (would double into "//")', () => {
    expect(runWithQuery('?p=/cerca-lavoro-ticino/').pathname).toBe('/');
  });

  it('rejects a backslash-prefixed path', () => {
    expect(runWithQuery('?p=\\evil.example/x').pathname).toBe('/');
  });

  it('rejects a non-http scheme', () => {
    expect(runWithQuery('?p=javascript:alert(1)').pathname).toBe('/');
  });
});

describe('index.html SPA redirect — the guard is present in the shipped file', () => {
  it('validates `p` before building the path', () => {
    // A source-level pin: the runtime cases above would also pass if the whole
    // handler were deleted, so assert the guard itself is what is shipped.
    expect(SPA_REDIRECT_SCRIPT).toMatch(/\^\[\/\\\\\]/);
    expect(SPA_REDIRECT_SCRIPT).toContain("p.get('p')");
  });
});
