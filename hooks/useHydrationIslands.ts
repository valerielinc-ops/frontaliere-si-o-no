/**
 * useHydrationIslands — the ONE scan/portal loop for static-page hydration
 * islands (extracted for issue #5012 phase 2).
 *
 * The site emits SSG pages that the SPA renders as `staticOverlay`: App.tsx
 * renders header + footer only and the build-time HTML body stays visible. An
 * interactive widget on such a page cannot be a React child of the page — it
 * has to be an island: the plugin emits a `data-*` placeholder, and at boot a
 * mount component finds it, reads its props off the attributes and
 * `createPortal`s the real component in.
 *
 * That loop has four details that are each a bug when forgotten, which is why
 * it lives in one place instead of being retyped per island:
 *
 *  1. **`createPortal` APPENDS** — it does not clear the container. Skip the
 *     clear and the pre-hydration skeleton stays visible underneath the real
 *     component.
 *  2. **Idempotency.** The MutationObserver below fires on every DOM change,
 *     including the ones this hook causes. Without a "already mounted" marker
 *     baked into the selector, the scan re-adds the same element forever.
 *  3. **SPA re-entry.** A client-side navigation between two staticOverlay
 *     pages swaps the static body without a reload, so a one-shot scan on mount
 *     silently stops hydrating from the second page onward. Hence `popstate` +
 *     MutationObserver.
 *  4. **Never drop the state.** Targets accumulate; a re-scan appends rather
 *     than replaces, or portals from a previous page would unmount.
 *
 * `NewsletterMount` had all four inline; `CompanyFollowMount` was about to have
 * a second copy (surfaced by check-sibling-patterns). Non-Negotiable #6.
 */
import { useEffect, useState } from 'react';

export interface IslandTarget<P> {
  el: HTMLElement;
  props: P;
}

export interface UseHydrationIslandsOptions<P> {
  /**
   * Attribute that marks a placeholder, WITHOUT brackets — e.g.
   * `data-newsletter-mount`.
   */
  attribute: string;
  /**
   * Attribute stamped on an element once mounted, WITHOUT brackets — e.g.
   * `data-newsletter-mounted`. Also excluded from the scan selector, which is
   * what makes re-scanning idempotent.
   */
  mountedAttribute: string;
  /**
   * Read the component props off the placeholder. Return `null` to SKIP the
   * element: it is left untouched and unmarked, so a placeholder that is
   * missing required data does not become an empty box (and can still hydrate
   * if the data appears later).
   */
  readProps: (el: HTMLElement) => P | null;
}

/**
 * Scan the document for hydration placeholders and return the accumulated
 * targets to portal into. Returns a stable, append-only array.
 */
export function useHydrationIslands<P>({
  attribute,
  mountedAttribute,
  readProps,
}: UseHydrationIslandsOptions<P>): Array<IslandTarget<P>> {
  const [targets, setTargets] = useState<Array<IslandTarget<P>>>([]);

  useEffect(() => {
    const selector = `[${attribute}]:not([${mountedAttribute}])`;
    const scan = () => {
      const elements = Array.from(document.querySelectorAll<HTMLElement>(selector));
      if (elements.length === 0) return;
      const next: Array<IslandTarget<P>> = [];
      for (const el of elements) {
        const props = readProps(el);
        if (props === null) continue; // required data missing — leave it alone
        el.setAttribute(mountedAttribute, '1');
        // createPortal appends; drop the build-time skeleton first.
        el.innerHTML = '';
        next.push({ el, props });
      }
      if (next.length > 0) setTargets((prev) => [...prev, ...next]);
    };
    scan();
    // Re-scan on SPA navigation between static-overlay pages (no reload): the
    // router emits popstate, and the observer catches the static body swap.
    const onPop = () => scan();
    window.addEventListener('popstate', onPop);
    const observer = new MutationObserver(() => scan());
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      window.removeEventListener('popstate', onPop);
      observer.disconnect();
    };
    // `readProps` is intentionally NOT a dependency: every caller passes an
    // inline arrow, so depending on it would tear down and re-create the
    // observer on every render. The attributes are the real identity of the
    // island, and they are module constants at every call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attribute, mountedAttribute]);

  return targets;
}
