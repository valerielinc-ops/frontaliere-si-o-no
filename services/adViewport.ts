/**
 * Shared viewport test for the ad layer.
 *
 * Lives here rather than inside a component because both consumers need the
 * exact same answer: `AdSenseBanner` uses it to defer collapsing one of our
 * declared slots until it is offscreen, and `autoAdCollapse` uses it for the
 * containers Google injects. Two copies would be free to drift, and a
 * disagreement about "is this on screen" is precisely a visible layout jump.
 */

/** True when any part of `el` is inside the visual viewport right now. */
export function isElementInViewport(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  return rect.bottom > 0 && rect.right > 0 && rect.top < viewportHeight && rect.left < viewportWidth;
}
