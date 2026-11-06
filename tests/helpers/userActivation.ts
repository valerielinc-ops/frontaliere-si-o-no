/**
 * Stub `navigator.userActivation` (jsdom has none) so a test can say whether
 * the page still holds a click's activation; `null` removes the stub.
 */
export function setUserActivation(isActive: boolean | null): void {
  if (isActive === null) {
    delete (navigator as Navigator & { userActivation?: unknown }).userActivation;
    return;
  }
  Object.defineProperty(navigator, 'userActivation', {
    configurable: true,
    value: { isActive, hasBeenActive: isActive },
  });
}
