import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { flatHtmlRedirectPlugin } from '../build-plugins/flatHtmlRedirectPlugin';

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

  it('falls back to a per-URL string when the sibling has no parsable title', async () => {
    fixture = setupFixture('<!DOCTYPE html><html><head></head><body>no title here</body></html>');

    await runPluginCloseBundle(fixture.tmpRoot);

    const bridge = fs.readFileSync(fixture.flatFile, 'utf-8');
    expect(bridge).toContain('<title>Redirecting to https://frontaliereticino.ch/foo/</title>');
    // Crucially, the fallback is NOT the legacy hard-coded "Redirecting…"
    // string that produced 426 duplicate-title issues in Semrush.
    expect(bridge).not.toContain('<title>Redirecting…</title>');
  });
});
