import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { flatHtmlRedirectPlugin, transformFlatRedirect } from '../build-plugins/flatHtmlRedirectPlugin';

/**
 * Verifies the redirect bridge emitted by `flatHtmlRedirectPlugin` after
 * the 2026-04-26 fix:
 *
 *   1. Per-URL <title> is extracted from the canonical sibling (no more
 *      "Redirecting…" duplicates flagged by Semrush as 426 dup titles).
 *   2. <meta http-equiv="refresh"> is dropped (Semrush flags meta-refresh
 *      redirects as a separate issue category).
 *
 * We use a real tmpdir + a real plugin invocation rather than mocking
 * `node:fs` because the plugin imports fs as a default-export module and
 * mock hoisting for default exports is brittle across vitest versions —
 * a tmpdir is functionally equivalent and more reliable.
 */

interface BridgeFixture {
  readonly tmpRoot: string;
  readonly distDir: string;
  readonly flatFile: string;
  readonly siblingFile: string;
}

function setupFixture(siblingHtml: string): BridgeFixture {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flat-html-redirect-'));
  const distDir = path.join(tmpRoot, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  const fooDir = path.join(distDir, 'foo');
  fs.mkdirSync(fooDir, { recursive: true });
  const flatFile = path.join(distDir, 'foo.html');
  const siblingFile = path.join(fooDir, 'index.html');
  // Pre-bridge content (full SPA shell with hreflang/canonical) — the plugin
  // should overwrite this with the redirect bridge.
  fs.writeFileSync(flatFile, '<html><head><title>Original Foo</title></head><body>full content</body></html>');
  fs.writeFileSync(siblingFile, siblingHtml);
  return { tmpRoot, distDir, flatFile, siblingFile };
}

async function runPluginCloseBundle(rootDir: string): Promise<void> {
  const plugin = flatHtmlRedirectPlugin(rootDir, { baseUrl: 'https://frontaliereticino.ch' });
  const closeBundle = plugin.closeBundle;
  if (!closeBundle || typeof closeBundle !== 'object' || !('handler' in closeBundle)) {
    throw new Error('closeBundle must be an object hook with handler');
  }
  await closeBundle.handler.call({} as never);
}

describe('flatHtmlRedirectPlugin redirect bridge', () => {
  let fixture: BridgeFixture | null = null;

  afterEach(() => {
    if (fixture && fs.existsSync(fixture.tmpRoot)) {
      fs.rmSync(fixture.tmpRoot, { recursive: true, force: true });
    }
    fixture = null;
  });

  it('uses the canonical sibling <title> in the bridge', async () => {
    fixture = setupFixture(
      '<!DOCTYPE html><html><head><title>Foo Bar — Frontaliere Ticino</title></head><body>canonical</body></html>',
    );

    await runPluginCloseBundle(fixture.tmpRoot);

    const bridge = fs.readFileSync(fixture.flatFile, 'utf-8');
    expect(bridge).toContain('<title>Foo Bar — Frontaliere Ticino</title>');
    expect(bridge).toContain('<link rel="canonical" href="https://frontaliereticino.ch/foo/">');
    expect(bridge).toContain('<meta name="robots" content="noindex,follow">');
    expect(bridge).toContain('location.replace("https://frontaliereticino.ch/foo/" + window.location.search + window.location.hash)');
  });

  it('preserves window.location.search and hash so newsletter/job-alert autologin params survive the redirect', async () => {
    fixture = setupFixture(
      '<!DOCTYPE html><html><head><title>Foo</title></head><body>canonical</body></html>',
    );

    await runPluginCloseBundle(fixture.tmpRoot);

    const bridge = fs.readFileSync(fixture.flatFile, 'utf-8');
    expect(bridge).toMatch(/location\.replace\([^)]*window\.location\.search[^)]*window\.location\.hash[^)]*\)/);
    expect(bridge).not.toMatch(/location\.replace\("https:\/\/frontaliereticino\.ch\/foo\/"\)/);
  });

  it('drops the meta http-equiv="refresh" redirect', async () => {
    fixture = setupFixture(
      '<!DOCTYPE html><html><head><title>Foo Bar</title></head><body>canonical</body></html>',
    );

    await runPluginCloseBundle(fixture.tmpRoot);

    const bridge = fs.readFileSync(fixture.flatFile, 'utf-8');
    expect(bridge).not.toMatch(/http-equiv\s*=\s*["']refresh["']/i);
  });

  it('keeps social preview meta on noindex bridge pages', async () => {
    fixture = setupFixture(
      '<!DOCTYPE html><html><head><title>Foo Bar</title>' +
        '<meta name="description" content="Useful summary">' +
        '<meta property="og:title" content="Share title">' +
        '<meta property="og:description" content="Share description">' +
        '<meta property="og:image" content="https://frontaliereticino.ch/og/foo.webp">' +
        '<meta property="og:image:alt" content="Preview alt">' +
        '<meta property="og:type" content="article">' +
        '<meta property="og:site_name" content="Frontaliere Ticino">' +
        '<meta property="og:locale" content="it_IT">' +
        '<meta property="og:url" content="https://frontaliereticino.ch/foo/">' +
        '<meta property="og:image:width" content="1200">' +
        '<meta property="og:image:height" content="630">' +
        '<meta property="og:image:type" content="image/webp">' +
        '<meta name="twitter:title" content="Duplicate title">' +
        '</head><body>canonical</body></html>',
    );

    await runPluginCloseBundle(fixture.tmpRoot);

    const bridge = fs.readFileSync(fixture.flatFile, 'utf-8');
    expect(bridge).toContain('<meta name="description" content="Useful summary">');
    expect(bridge).toContain('<meta property="og:title" content="Share title">');
    expect(bridge).toContain('<meta property="og:description" content="Share description">');
    expect(bridge).toContain('<meta property="og:image" content="https://frontaliereticino.ch/og/foo.webp">');
    expect(bridge).toContain('<meta property="og:image:alt" content="Preview alt">');
    expect(bridge).toContain('og:type');
    expect(bridge).toContain('og:site_name');
    expect(bridge).toContain('og:locale');
    expect(bridge).toContain('og:url');
    expect(bridge).toContain('og:image:width');
    expect(bridge).toContain('og:image:height');
    expect(bridge).toContain('og:image:type');
    expect(bridge).not.toContain('twitter:title');
  });

  it('ignores social preview meta inside comments, templates, and scripts', async () => {
    fixture = setupFixture(
      '<!DOCTYPE html><html><head><template><meta property="og:title" content="Stale template title"></template>' +
        '<!-- <meta property="og:description" content="Stale comment description"> -->' +
        '<script>const fake = \'<meta property="og:image" content="https://example.test/fake.webp">\';</script>' +
        '<meta property="og:title" content="Live title">' +
        '<meta property="og:description" content="Live description">' +
        '</head><body>canonical</body></html>',
    );

    await runPluginCloseBundle(fixture.tmpRoot);

    const bridge = fs.readFileSync(fixture.flatFile, 'utf-8');
    expect(bridge).toContain('<meta property="og:title" content="Live title">');
    expect(bridge).toContain('<meta property="og:description" content="Live description">');
    expect(bridge).not.toContain('Stale template title');
    expect(bridge).not.toContain('Stale comment description');
    expect(bridge).not.toContain('https://example.test/fake.webp');
  });

  it('uses the active title in the full-build transform', () => {
    fixture = setupFixture(
      '<!DOCTYPE html><html><head><template><title>Stale template title</title></template>' +
        '<!-- <title>Stale comment title</title> -->' +
        '<title>Live title</title></head><body>canonical</body></html>',
    );
    const bridge = transformFlatRedirect({
      filePath: fixture.flatFile,
      distDir: fixture.distDir,
      trimmedBase: 'https://frontaliereticino.ch',
      readSibling: (siblingPath: string): string | null =>
        fs.existsSync(siblingPath) ? fs.readFileSync(siblingPath, 'utf-8') : null,
    });

    expect(bridge).toContain('<title>Live title</title>');
    expect(bridge).not.toContain('Stale template title');
    expect(bridge).not.toContain('Stale comment title');
  });

  it('masks nested inactive templates in bridge title and OG extraction', () => {
    fixture = setupFixture(
      '<!DOCTYPE html><html><head><template><template>' +
        '<meta property="og:title" content="inner-stale">' +
        '</template><meta property="og:title" content="outer-stale">' +
        '<title>outer-stale</title></template>' +
        '<meta property="og:title" content="active">' +
        '<title>active</title></head><body>canonical</body></html>',
    );
    const bridge = transformFlatRedirect({
      filePath: fixture.flatFile,
      distDir: fixture.distDir,
      trimmedBase: 'https://frontaliereticino.ch',
      readSibling: (siblingPath: string): string | null =>
        fs.existsSync(siblingPath) ? fs.readFileSync(siblingPath, 'utf-8') : null,
    });

    expect(bridge).toContain('<meta property="og:title" content="active">');
    expect(bridge).toContain('<title>active</title>');
    expect(bridge).not.toContain('inner-stale');
    expect(bridge).not.toContain('outer-stale');
  });

  it('keeps templates with slash-valued unquoted attributes inactive', () => {
    fixture = setupFixture(
      '<!DOCTYPE html><html><head><template data-src=/foo/>'
        + '<meta property="og:title" content="stale">'
        + '<title>stale</title></template>'
        + '<meta property="og:title" content="active">'
        + '<title>active</title></head><body>canonical</body></html>',
    );
    const bridge = transformFlatRedirect({
      filePath: fixture.flatFile,
      distDir: fixture.distDir,
      trimmedBase: 'https://frontaliereticino.ch',
      readSibling: (siblingPath: string): string | null =>
        fs.existsSync(siblingPath) ? fs.readFileSync(siblingPath, 'utf-8') : null,
    });

    expect(bridge).toContain('<meta property="og:title" content="active">');
    expect(bridge).toContain('<title>active</title>');
    expect(bridge).not.toContain('content="stale"');
  });

  it('skips dotfile basenames like <dir>/.html so they never get rewritten as a bridge', () => {
    // Regression: ogPagesPlugin used to concat `+ '.html'` onto a path that
    // already ended in `/` (from canonicalPath), producing
    // `dist/articoli-frontaliere/<slug>/.html`. transformFlatRedirect would
    // then read the sibling `<slug>/index.html` (the real article), build a
    // self-referencing bridge, and write it to the dotfile. GitHub Pages
    // served that dotfile for the `/<slug>/` URL with content-type=
    // application/octet-stream, masking the real article and crashing
    // AdSense RPM. Skip basenames starting with `.` defensively.
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flat-html-dotfile-'));
    try {
      const distDir = path.join(tmpRoot, 'dist');
      const fooDir = path.join(distDir, 'foo');
      fs.mkdirSync(fooDir, { recursive: true });
      const dotfile = path.join(fooDir, '.html');
      const siblingFile = path.join(fooDir, 'index.html');
      fs.writeFileSync(dotfile, 'should not be touched');
      fs.writeFileSync(
        siblingFile,
        '<!DOCTYPE html><html><head><title>Real</title></head><body>full</body></html>',
      );
      const readSibling = (p: string): string | null =>
        fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null;
      const result = transformFlatRedirect({
        filePath: dotfile,
        distDir,
        trimmedBase: 'https://frontaliereticino.ch',
        readSibling,
      });
      expect(result).toBeNull();
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('falls back to a per-URL string when the sibling has no parsable title', async () => {
    fixture = setupFixture('<!DOCTYPE html><html><head></head><body>no title here</body></html>');

    await runPluginCloseBundle(fixture.tmpRoot);

    const bridge = fs.readFileSync(fixture.flatFile, 'utf-8');
    expect(bridge).toContain('<title>Redirecting to https://frontaliereticino.ch/foo/</title>');
    // Crucially, the fallback is NOT the legacy hard-coded "Redirecting…"
    // string that produced 426 duplicate-title issues in Semrush.
    expect(bridge).not.toContain('<title>Redirecting…</title>');
  });

  it('keeps the parser contract required by the mirrored fast-publish engine', () => {
    const engine = fs.readFileSync(
      path.resolve('packages/articles/engine/flatHtmlRedirect.ts'),
      'utf-8',
    );

    expect(engine).toContain('const HTML_VOID_ELEMENTS = new Set([');
    expect(engine).toContain('const HTML_INACTIVE_RAW_TEXT_ELEMENTS = new Set([');
    expect(engine).toContain('const HTML_TEMPLATE_RAW_TEXT_ELEMENTS = new Set([');
    expect(engine).toContain('maskInactiveMarkup(indexHtml, { maskRcdata: true })');
  });
});
