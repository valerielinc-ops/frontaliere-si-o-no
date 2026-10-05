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

/**
 * User-timing mark set right before `#root` (the static HTML, after the
 * adoption above) goes to `opacity: 0` for the crossfade. The Lighthouse CI
 * check `scripts/ci/lighthouse-first-paint-order.mjs` reads it from the LHR
 * `user-timings` audit and compares it with the observed first contentful
 * paint: the static HTML must have painted BEFORE this mark.
 */
export const STATIC_HANDOFF_HIDE_MARK = 'ft:static-handoff-hide';

/** Upper bound on how long the mount waits for the static HTML's first frame. */
export const STATIC_FIRST_PAINT_TIMEOUT_MS = 100;

export interface StaticFirstPaintEnv {
  doc?: Pick<Document, 'visibilityState'>;
  requestFrame?: (cb: () => void) => unknown;
  setTimer?: (cb: () => void, ms: number) => unknown;
  timeoutMs?: number;
}

/**
 * Resolve once the browser has presented at least one frame of the static
 * HTML (double `requestAnimationFrame`: the first callback runs in the
 * rendering step of the next frame, the second one after that frame painted).
 *
 * Why: the SPA mount hides the static HTML (`opacity: 0` on `#root`, see
 * {@link hideRootForCrossfade}). When that hide ran before the browser's first
 * frame, the page stayed blank until React had rendered — observed first
 * paint 1.3-2.4 s instead of ~0.3 s on `/` and `/cerca-lavoro-ticino/`, and a
 * simulated mobile FCP of 8-13 s instead of 4.6 s (Lighthouse runs of
 * 2026-10-02..05, issue 11666). Whether the frame won the race depended only
 * on network timing; waiting for it makes the static paint come first by
 * construction.
 *
 * Bounded: a hidden document (background tab, speculation-rules prerender)
 * never runs animation frames, so it does not wait at all, and a visible one
 * waits at most `timeoutMs`.
 */
export function waitForStaticFirstPaint(env: StaticFirstPaintEnv = {}): Promise<void> {
  const doc = env.doc ?? document;
  if (doc.visibilityState !== 'visible') return Promise.resolve();
  const requestFrame = env.requestFrame ?? ((cb: () => void) => window.requestAnimationFrame(cb));
  const setTimer = env.setTimer ?? ((cb: () => void, ms: number) => window.setTimeout(cb, ms));
  const timeoutMs = env.timeoutMs ?? STATIC_FIRST_PAINT_TIMEOUT_MS;
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    setTimer(finish, timeoutMs);
    requestFrame(() => requestFrame(finish));
  });
}

/**
 * Start the static → React crossfade: reserve `#root`'s painted height as a
 * min-height floor (CLS #886/#855 — createRoot().render() empties #root for a
 * moment), mark {@link STATIC_HANDOFF_HIDE_MARK}, then fade `#root` out.
 * Call only after {@link waitForStaticFirstPaint}.
 */
export function hideRootForCrossfade(
  root: HTMLElement,
  perf: Pick<Performance, 'mark'> | undefined = typeof performance === 'undefined' ? undefined : performance,
): void {
  const reservedRootHeight = root.offsetHeight;
  if (reservedRootHeight > 0) root.style.minHeight = `${reservedRootHeight}px`;
  try {
    perf?.mark(STATIC_HANDOFF_HIDE_MARK);
  } catch {
    /* user timing unavailable — the mark is diagnostics only */
  }
  root.style.transition = 'opacity 80ms ease-out';
  root.style.opacity = '0';
}
