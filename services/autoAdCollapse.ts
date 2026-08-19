/**
 * autoAdCollapse — give back the space of an Auto Ad container that never fills.
 *
 * Google Auto Ads inject their own `.google-auto-placed` containers, each with
 * an `<ins>` carrying an inline height (~280px). Two of the three outcomes are
 * already handled in `index.css`:
 *
 *   - the container stays empty            → `.google-auto-placed:empty`
 *   - AdSense answers `unfilled`           → `:has(ins[data-ad-status="unfilled"])`
 *
 * The third outcome has no owner: the `<ins>` is inserted, `adsbygoogle.js`
 * marks it `data-adsbygoogle-status="done"`, and then **no answer ever comes** —
 * `data-ad-status` is never written and no creative iframe appears. Neither CSS
 * rule matches (the container is not empty and nothing is flagged unfilled), so
 * the box holds its ~280px forever. This is the same failure mode already
 * documented for our own slots in `AdSenseBanner`: Privacy Sandbox / Attestation
 * / ad blockers cut AdSense off *before* it can report `unfilled`. Our slots got
 * a fill timeout for it; the containers Google injects never did.
 *
 * Measured live on frontaliereticino.ch (2026-08-19, ads serving — a sibling
 * slot in the same page load reported `filled`):
 *
 *   | page                  | stuck containers | dead space |
 *   |-----------------------|------------------|------------|
 *   | `/`                   | 4 × 280px        | 1120px     |
 *   | `/cerca-lavoro-ticino/` | 3 × 280px      |  840px     |
 *   | `/statistiche/`       | 3 × 280px        |  840px     |
 *
 * still unresolved after 16s with the container parked in the viewport. On
 * `/statistiche/` that is 12% of the whole document height rendered as blank.
 *
 * NOT an Auto Ads opt-out (AGENTS.md §7). Nothing here gates, delays or blocks
 * an ad request: the `<ins>` is never touched, never removed, never hidden
 * before it has had `AD_FILL_TIMEOUT_MS` to answer — the same budget our own
 * slots use, from the same constant. The collapse is reverted the moment a
 * creative shows up, so an ad that arrives late still gets its space back.
 */
import { AD_FILL_TIMEOUT_MS } from './adsenseSlots';
import { isElementInViewport } from './adViewport';
import { isLikelyBot } from './botPatterns';

/** The containers Google Auto Ads inject. */
export const AUTO_AD_CONTAINER_SELECTOR = '.google-auto-placed';

/** Marks a container whose reserve has been given back. `index.css` keys the
 *  collapse rule on this exact attribute — `tests/auto-ad-collapse.test.ts`
 *  pins the two together so a rename here cannot silently un-style the rule. */
export const AUTO_AD_COLLAPSED_ATTR = 'data-ft-autoad-collapsed';

/**
 * True when the container is actually showing an ad, i.e. its space is earned.
 *
 * Deliberately positive ("has a creative") rather than a list of failure
 * states: `data-ad-status` has exactly one value that means an ad is on
 * screen, while the ways of *not* filling are open-ended — absent, `unfilled`,
 * and the silent no-answer case this module exists for. Anything that is not
 * demonstrably filled is treated as unresolved, which is the safe direction:
 * the worst case is collapsing a box that had nothing in it.
 */
export function autoAdHasCreative(el: Element): boolean {
  if (el.querySelector('iframe')) return true;
  return !!el.querySelector('ins[data-ad-status="filled"]');
}

type Watch = {
  timer: ReturnType<typeof setTimeout> | null;
  offscreen: IntersectionObserver | null;
  subtree: MutationObserver | null;
};

const watched = new WeakMap<Element, Watch>();
let containerObserver: MutationObserver | null = null;

function clearWatch(el: Element): void {
  const w = watched.get(el);
  if (!w) return;
  if (w.timer !== null) clearTimeout(w.timer);
  w.offscreen?.disconnect();
  w.subtree?.disconnect();
  watched.delete(el);
}

/**
 * Collapse now if the container is offscreen, otherwise wait until it is.
 *
 * Mirrors `collapseWhenLayoutSafe` in `AdSenseBanner`: removing 280px from
 * under the reader's eyes is itself a layout shift, so the space is only taken
 * back while nobody is looking at it. A container the reader is parked on keeps
 * its blank box until they scroll past — annoying for one container, never a
 * jump.
 */
function collapseWhenLayoutSafe(el: HTMLElement): void {
  const w = watched.get(el);
  if (!w) return;

  if (!isElementInViewport(el) || typeof IntersectionObserver === 'undefined') {
    el.setAttribute(AUTO_AD_COLLAPSED_ATTR, '');
    return;
  }

  w.offscreen?.disconnect();
  const observer = new IntersectionObserver((entries) => {
    if (entries[0]?.isIntersecting) return;
    observer.disconnect();
    const current = watched.get(el);
    if (current) current.offscreen = null;
    if (!autoAdHasCreative(el)) el.setAttribute(AUTO_AD_COLLAPSED_ATTR, '');
  });
  observer.observe(el);
  w.offscreen = observer;
}

/**
 * Start the fill budget for one container.
 *
 * The subtree observer runs for the container's whole life, not just until the
 * timeout: an ad that arrives at 30s must get its space back, otherwise this
 * module would be doing exactly what §7 forbids — turning a slow ad into no ad.
 */
function watch(el: HTMLElement): void {
  if (watched.has(el)) return;

  const w: Watch = { timer: null, offscreen: null, subtree: null };
  watched.set(el, w);

  const onSubtreeChange = () => {
    if (!autoAdHasCreative(el)) return;
    // A creative landed — undo any collapse and stop policing this container.
    el.removeAttribute(AUTO_AD_COLLAPSED_ATTR);
    clearWatch(el);
  };

  if (typeof MutationObserver !== 'undefined') {
    const subtree = new MutationObserver(onSubtreeChange);
    subtree.observe(el, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-ad-status'],
    });
    w.subtree = subtree;
  }

  w.timer = setTimeout(() => {
    const current = watched.get(el);
    if (current) current.timer = null;
    // Google removes and re-inserts containers as the page reflows; a detached
    // one has no space to give back.
    if (!el.isConnected || autoAdHasCreative(el)) {
      clearWatch(el);
      return;
    }
    collapseWhenLayoutSafe(el);
  }, AD_FILL_TIMEOUT_MS);
}

/**
 * Watch every Auto Ad container on the page, present and future.
 *
 * Returns the teardown. Safe to call more than once — a second call is a no-op
 * while the first is still installed.
 */
export function installAutoAdCollapse(): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
    return () => {};
  }
  // Bots never see the page anyway, and collapsing under a crawler would only
  // add DOM churn to a render that has no ads in it.
  if (isLikelyBot()) return () => {};
  if (containerObserver) return () => {};

  // Driven by the mutation records, NOT by re-querying the document on every
  // mutation: this observer sees every DOM change the SPA makes (the job list
  // alone re-renders on each keystroke), and a full-document
  // `querySelectorAll` per mutation would cost far more than the blank space
  // it removes. Auto Ads insert their containers with the class already on
  // them, so watching insertions is sufficient.
  containerObserver = new MutationObserver((records) => {
    for (const record of records) {
      record.addedNodes.forEach((node) => {
        if (!(node instanceof HTMLElement)) return;
        if (node.matches(AUTO_AD_CONTAINER_SELECTOR)) {
          watch(node);
          return;
        }
        node
          .querySelectorAll<HTMLElement>(AUTO_AD_CONTAINER_SELECTOR)
          .forEach((el) => watch(el));
      });
    }
  });
  containerObserver.observe(document.body, { childList: true, subtree: true });
  document
    .querySelectorAll<HTMLElement>(AUTO_AD_CONTAINER_SELECTOR)
    .forEach((el) => watch(el));

  return () => {
    containerObserver?.disconnect();
    containerObserver = null;
    document
      .querySelectorAll<HTMLElement>(AUTO_AD_CONTAINER_SELECTOR)
      .forEach((el) => clearWatch(el));
  };
}
