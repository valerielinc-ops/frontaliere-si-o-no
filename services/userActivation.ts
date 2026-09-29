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
