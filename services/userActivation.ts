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
