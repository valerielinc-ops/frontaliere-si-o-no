/**
 * useReveal — IntersectionObserver-based scroll-reveal + "in-view" trigger.
 *
 * Returns a ref to attach to the element and a boolean that flips to `true` the
 * first time the element scrolls into view (once; it never flips back). Used to
 * (a) fade/slide elements in and (b) start chart / count-up animations only
 * when the element is actually visible — cheaper and more "wow" than animating
 * everything on mount.
 *
 * Honours `prefers-reduced-motion`: reduced-motion users (or browsers without
 * IntersectionObserver) get `inView = true` immediately, so they see the final
 * state with no animation and no waiting.
 *
 * Shared by every insights sub-component so reveal behaviour stays identical.
 */
import { useEffect, useRef, useState, type RefObject } from 'react';

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function useReveal<T extends HTMLElement = HTMLDivElement>(
  { rootMargin = '0px 0px -10% 0px', threshold = 0.15 }: { rootMargin?: string; threshold?: number } = {},
): { ref: RefObject<T | null>; inView: boolean } {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // No observer or reduced motion → show final state immediately.
    if (prefersReducedMotion() || typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setInView(true);
            observer.disconnect();
            break;
          }
        }
      },
      { rootMargin, threshold },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [rootMargin, threshold]);

  return { ref, inView };
}
