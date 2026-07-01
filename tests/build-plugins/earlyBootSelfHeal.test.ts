import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { SELF_HEAL_SCRIPT_CONTENT, EARLY_BOOT_CONTENT } from '../../build-plugins/constants.ts';

/**
 * Every static SEO page (job-detail, hub, landing, ...) loads EARLY_BOOT_CONTENT
 * before its module SPA script. Only the root index.html previously had listeners
 * that recover from a cross-chunk version-skew SyntaxError/TypeError — this guards
 * that SELF_HEAL_SCRIPT_CONTENT (now folded into EARLY_BOOT_CONTENT) registers the
 * same recovery on every other static page, using message patterns that mirror
 * services/resilientImport.ts's isVersionSkewError / isModuleLinkSkewMessage.
 */
function loadSelfHeal(): void {
  new Function(SELF_HEAL_SCRIPT_CONTENT)();
}

describe('SELF_HEAL_SCRIPT_CONTENT', () => {
  // Registers the window/unhandledrejection listeners exactly once — the IIFE
  // must not be re-run per test, since jsdom's window (and its listeners)
  // persists across tests within this file.
  beforeAll(() => {
    loadSelfHeal();
  });

  beforeEach(() => {
    sessionStorage.clear();
    // The version-skew listeners intentionally no-op on localhost/127.0.0.1 (dev),
    // so exercise them against a production-like hostname.
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, hostname: 'frontaliereticino.ch', reload: vi.fn() },
    });
  });

  it('is valid, self-contained JS and is included in EARLY_BOOT_CONTENT', () => {
    expect(() => new Function(SELF_HEAL_SCRIPT_CONTENT)).not.toThrow();
    expect(EARLY_BOOT_CONTENT.endsWith(SELF_HEAL_SCRIPT_CONTENT)).toBe(true);
  });

  it('reloads on a Safari-style link-time SyntaxError ("Importing binding name ... is not found")', async () => {
    const err = Object.assign(new SyntaxError("Importing binding name 'r' is not found."), {});
    window.dispatchEvent(Object.assign(new Event('error'), { error: err, message: err.message }));

    await vi.waitFor(() => expect(sessionStorage.getItem('_swReloadCount')).toBe('1'));
    const info = JSON.parse(sessionStorage.getItem('_forceReloadInfo') || '{}');
    expect(info.source).toBe('index_html_skew');
  });

  it('reloads on a Chrome-style link-time SyntaxError ("does not provide an export named")', async () => {
    const err = Object.assign(new SyntaxError("does not provide an export named 'getApp'"), {});
    window.dispatchEvent(Object.assign(new Event('error'), { error: err, message: err.message }));

    await vi.waitFor(() => expect(sessionStorage.getItem('_swReloadCount')).toBe('1'));
  });

  it('reloads on a call-time version-skew TypeError ("is not a function")', async () => {
    const err = Object.assign(new TypeError('n.getApp is not a function'), {});
    window.dispatchEvent(Object.assign(new Event('error'), { error: err, message: err.message }));

    await vi.waitFor(() => expect(sessionStorage.getItem('_swReloadCount')).toBe('1'));
  });

  it('ignores unrelated TypeErrors that are not version-skew signatures', async () => {
    const err = Object.assign(new TypeError('Cannot read properties of undefined'), {});
    window.dispatchEvent(Object.assign(new Event('error'), { error: err, message: err.message }));

    await new Promise((r) => setTimeout(r, 0));
    expect(sessionStorage.getItem('_swReloadCount')).toBeNull();
  });

  it('reloads on an unhandledrejection carrying a module-link skew message', async () => {
    const reason = new Error("Importing binding name 'x' is not found.");
    const ev = Object.assign(new Event('unhandledrejection'), { reason });
    window.dispatchEvent(ev);

    await vi.waitFor(() => expect(sessionStorage.getItem('_swReloadCount')).toBe('1'));
    const info = JSON.parse(sessionStorage.getItem('_forceReloadInfo') || '{}');
    expect(info.source).toBe('index_html_import');
  });

  it('does not reload for ad-blocked resource script errors', async () => {
    const script = document.createElement('script');
    script.src = 'https://example.com/adsbygoogle.js';
    document.body.appendChild(script);
    const ev = new Event('error');
    Object.defineProperty(ev, 'target', { value: script });
    window.dispatchEvent(ev);

    await new Promise((r) => setTimeout(r, 0));
    expect(sessionStorage.getItem('_swReloadCount')).toBeNull();
  });

  it('stops reloading once the per-session ceiling (2) is reached', async () => {
    sessionStorage.setItem('_swReloadCount', '2');
    const err = Object.assign(new TypeError('n.getApp is not a function'), {});
    window.dispatchEvent(Object.assign(new Event('error'), { error: err, message: err.message }));

    await new Promise((r) => setTimeout(r, 0));
    expect(sessionStorage.getItem('_swReloadCount')).toBe('2');
  });
});
