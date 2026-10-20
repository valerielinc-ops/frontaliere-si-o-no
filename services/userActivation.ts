/**
 * Whether the page still holds the transient activation of a recent click
 * (HTML user activation v2: about 5 s in Chrome and Firefox), the condition
 * under which `window.open` is not blocked as a popup.
 *
 * Browsers without `navigator.userActivation` report `false`: a caller that
 * must open a new tab then asks for a click instead of risking a blocked one.
 */
export function hasTransientUserActivation(): boolean {
  if (typeof navigator === 'undefined') return false;
  const activation = (navigator as Navigator & { userActivation?: { isActive?: boolean } }).userActivation;
  return activation?.isActive === true;
}

/**
 * WebKit's popup blocker (Safari on macOS, every browser on iOS) does not
 * follow the transient activation above: it lets `window.open` through only
 * from the call stack of the click itself (or a short promise chain from
 * it). A reward detected by a timer after a click inside Google's iframe
 * therefore reports `isActive` and is still blocked. Measured live 30-09:
 * 2 of 3 automatic openings on Safari never brought a new tab forward, 0 of
 * 13 on Chrome and Edge.
 */
export function usesWebKitPopupPolicy(
  userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent,
  maxTouchPoints: number = typeof navigator === 'undefined' ? 0 : navigator.maxTouchPoints || 0,
): boolean {
  if (/iPhone|iPad|iPod/.test(userAgent)) return true;
  // iPadOS reports a desktop Mac user agent; touch points give it away.
  if (/Macintosh/.test(userAgent) && maxTouchPoints > 1) return true;
  return /Version\/[\d.]+.*Safari\//.test(userAgent)
    && !/Chrome|Chromium|CriOS|Edg|OPR|FxiOS|Firefox|SamsungBrowser/.test(userAgent);
}

/**
 * Whether a new tab can be opened now without a further click: a click's
 * activation is still held and the browser honours it for popups.
 */
export function canOpenTabWithoutClick(): boolean {
  return hasTransientUserActivation() && !usesWebKitPopupPolicy();
}

/** How long a new tab has to take the foreground before it counts as blocked. */
export const NEW_TAB_CONFIRM_MS = 1500;

/**
 * Resolves `true` once this page loses the foreground (hidden, blurred or
 * unloaded), the sign that the tab just opened by `window.open` took it, and
 * `false` if nothing happens within `timeoutMs`. `window.open` with
 * `noopener` always returns `null`, so this is the only way to notice a popup
 * the browser blocked although `navigator.userActivation.isActive` was true.
 * Start watching BEFORE calling `window.open`: the switch can happen at once.
 */
export function watchNewTabOpened(timeoutMs: number = NEW_TAB_CONFIRM_MS): Promise<boolean> {
  if (typeof window === 'undefined' || typeof document === 'undefined') return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') finish(true);
    };
    const onLeave = () => finish(true);
    const timer = window.setTimeout(() => finish(false), timeoutMs);
    function finish(opened: boolean) {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onLeave);
      window.removeEventListener('pagehide', onLeave);
      resolve(opened);
    }
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onLeave);
    window.addEventListener('pagehide', onLeave);
  });
}
