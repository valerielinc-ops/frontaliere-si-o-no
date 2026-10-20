// @vitest-environment jsdom
/**
 * `watchNewTabOpened`: the only signal that a `window.open(..., 'noopener')`
 * really opened a tab is this page losing the foreground right after it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NEW_TAB_CONFIRM_MS, usesWebKitPopupPolicy, watchNewTabOpened } from '@/services/userActivation';

describe('usesWebKitPopupPolicy', () => {
  const UA = {
    safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    safariIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    chromeIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1',
    chromeMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    edgeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Edg/126.0',
    firefoxMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:127.0) Gecko/20100101 Firefox/127.0',
    chromeAndroid: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36',
    jsdom: 'Mozilla/5.0 (darwin) AppleWebKit/537.36 (KHTML, like Gecko) jsdom/24.0.0',
  };

  it.each([
    ['Safari on macOS', UA.safariMac, 0, true],
    ['Safari on iPhone', UA.safariIphone, 5, true],
    ['Chrome on iPhone (WebKit too)', UA.chromeIphone, 5, true],
    ['iPadOS with a desktop user agent', UA.safariMac, 5, true],
    ['Chrome on macOS', UA.chromeMac, 0, false],
    ['Edge on Windows', UA.edgeWin, 0, false],
    ['Firefox on macOS', UA.firefoxMac, 0, false],
    ['Chrome on Android', UA.chromeAndroid, 5, false],
    ['jsdom', UA.jsdom, 0, false],
  ])('%s → %s', (_label, ua, touch, expected) => {
    expect(usesWebKitPopupPolicy(ua, touch)).toBe(expected);
  });
});

const setVisibility = (state: DocumentVisibilityState) => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
};

beforeEach(() => {
  vi.useFakeTimers();
  setVisibility('visible');
});

afterEach(() => {
  vi.useRealTimers();
  setVisibility('visible');
});

describe('watchNewTabOpened', () => {
  it('resolves true when the page is hidden by the new tab', async () => {
    const opened = watchNewTabOpened();
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await expect(opened).resolves.toBe(true);
  });

  it('resolves true when the window loses focus', async () => {
    const opened = watchNewTabOpened();
    window.dispatchEvent(new Event('blur'));
    await expect(opened).resolves.toBe(true);
  });

  it('ignores a visibilitychange that leaves the page visible', async () => {
    const opened = watchNewTabOpened();
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(NEW_TAB_CONFIRM_MS);
    await expect(opened).resolves.toBe(false);
  });

  it('resolves false when nothing takes the foreground in time (blocked popup)', async () => {
    const opened = watchNewTabOpened(800);
    vi.advanceTimersByTime(799);
    let settled = false;
    void opened.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    vi.advanceTimersByTime(1);
    await expect(opened).resolves.toBe(false);
  });

  it('stops listening once settled', async () => {
    const removeDoc = vi.spyOn(document, 'removeEventListener');
    const removeWin = vi.spyOn(window, 'removeEventListener');
    const opened = watchNewTabOpened();
    window.dispatchEvent(new Event('blur'));
    await opened;
    expect(removeDoc).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    expect(removeWin).toHaveBeenCalledWith('blur', expect.any(Function));
    expect(removeWin).toHaveBeenCalledWith('pagehide', expect.any(Function));
    removeDoc.mockRestore();
    removeWin.mockRestore();
  });
});
