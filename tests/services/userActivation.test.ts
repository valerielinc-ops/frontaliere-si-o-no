// @vitest-environment jsdom
/**
 * `watchNewTabOpened`: the only signal that a `window.open(..., 'noopener')`
 * really opened a tab is this page losing the foreground right after it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NEW_TAB_CONFIRM_MS, watchNewTabOpened } from '@/services/userActivation';

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
