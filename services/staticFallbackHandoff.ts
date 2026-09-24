/**
 * SPA-takeover handoff of a body-level crawler fallback into `#root` (CLS).
 *
 * SPA-owned routes (router `staticOverlay` falsy — the job board, job detail,
 * search…) ship their crawler-facing `<main class="seo-static-content">` (or
 * `main.cluster-seo-prose`) OUTSIDE `#root`, usually wrapped in the build-time
 * `.ft-rail-grid`. index.tsx moves it INTO `#root` right before
 * `createRoot().render()`, so React replaces it in place under the reserved
 * height instead of App.tsx collapsing it from outside.
 *
 * The hub pages (`/cerca-lavoro-ticino/` and its locale twins) also emit the
 * static hub sub-nav `nav.seo-hub-subnav` as a BODY-DIRECT sibling BETWEEN
 * `#root` and the fallback. Moving only the fallback reorders the document:
 * the fallback jumps above the sub-nav, and the 100px sub-nav is thrown from
 * just under the header to below the whole listing — a 0.106 layout shift on
 * desktop measured with Playwright attribution against production (#8868).
 * Adopting the sub-nav together with the fallback, in its original order,
 * keeps both exactly where they were painted; React then clears `#root` and
 * renders its own interactive SubTabNav in the same place.
 *
 * Pure DOM, no React: index.tsx owns the timing (after App has loaded, before
 * the crossfade reserve is measured).
 */
export interface StaticFallbackAdoption {
  /** The static sub-nav that was moved along with the fallback, if any. */
  subnav: HTMLElement | null;
  /** The build-time rail wrapper that was hidden, if any. */
  railWrap: HTMLElement | null;
}

const isBetween = (before: Node, node: Node, after: Node): boolean =>
  Boolean(before.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)
  && Boolean(node.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING);

/**
 * Move `fallback` (and the body-level static hub sub-nav painted above it) to
 * the end of `root`, preserving their visual order, and hide the now-empty
 * `.ft-rail-grid` wrapper the fallback came from.
 */
export function adoptStaticFallbackIntoRoot(
  root: HTMLElement,
  fallback: HTMLElement,
): StaticFallbackAdoption {
  const doc = root.ownerDocument;
  const railWrap = fallback.closest<HTMLElement>('.ft-rail-grid');
  const anchor = railWrap ?? fallback;

  // Only a sub-nav that is a direct child of <body> and sits between #root and
  // the fallback belongs to this handoff; any other nav is left untouched.
  let subnav: HTMLElement | null = null;
  for (const el of Array.from(doc.body.children)) {
    if (el.tagName === 'NAV'
      && el.classList.contains('seo-hub-subnav')
      && isBetween(root, el, anchor)) {
      subnav = el as HTMLElement;
      break;
    }
  }

  fallback.style.removeProperty('display');
  if (subnav) root.appendChild(subnav);
  root.appendChild(fallback);
  if (railWrap) railWrap.style.display = 'none';
  return { subnav, railWrap };
}
