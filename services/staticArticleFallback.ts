/**
 * Keeps the shard's static article recoverable after the CLS handoff has eaten it.
 *
 * `index.tsx` moves `<main class="seo-static-content">` INSIDE `#root` before
 * `createRoot().render()`, so React replaces it in place instead of collapsing
 * ~800px of external content (issue #886/#855). That is the right trade for a
 * page the SPA can actually render — and it is exactly why an article the
 * bundle does not know ends up destroyed rather than merely hidden: measured in
 * Chromium on 2026-08-04, after hydration `document.querySelector('main.seo-static-content')`
 * on /articoli-frontaliere/poste-italiane-consulenti-finanziari-varese/ returns
 * null and the only h1 left on the page is "Guida Frontaliere".
 *
 * So before the move, article pages stash a detached clone here. Nothing about
 * the handoff changes for the pages it was built for; the clone simply gives
 * the runtime resolver something to put back when it turns out the SPA cannot
 * render this article after all.
 */

let stashed: HTMLElement | null = null;

/** Called by the entry, immediately before the fallback is moved into `#root`. */
export function stashStaticArticleFallback(fallback: HTMLElement): void {
  const clone = fallback.cloneNode(true) as HTMLElement;
  clone.style.removeProperty('display');
  stashed = clone;
}

/**
 * The static article element, wherever it currently is: still in the document
 * if the handoff left it alone, otherwise the stashed clone. `null` when this
 * page never had one — a client-side arrival, or a URL with no shard page.
 */
export function staticArticleFallback(): HTMLElement | null {
  if (typeof document !== 'undefined') {
    const root = document.getElementById('root');
    const live = document.querySelector<HTMLElement>('main.seo-static-content');
    // A live node still INSIDE #root is on borrowed time — React owns that
    // subtree and will drop it on the next render. Only a node outside it can
    // be relied on, and the stash covers the rest.
    if (live && !root?.contains(live)) return live;
  }
  return stashed;
}

/** True when there is a correct article to fall back to. */
export function hasStaticArticleFallback(): boolean {
  return !!staticArticleFallback()?.querySelector('article.ft-blog-article');
}

/**
 * Put the static article back on screen, outside `#root` where the SPA's
 * overlay mode expects it. Idempotent; `false` means there was nothing to
 * restore and the caller must NOT switch to overlay mode — that would leave a
 * blank page, which is worse than anything this module exists to prevent.
 */
export function restoreStaticArticleFallback(): boolean {
  if (typeof document === 'undefined' || !document.body) return false;
  const el = staticArticleFallback();
  if (!el?.querySelector('article.ft-blog-article')) return false;
  el.style.removeProperty('display');
  if (!document.body.contains(el) || document.getElementById('root')?.contains(el)) {
    document.body.appendChild(el);
  }
  return true;
}

/** Test seam. */
export function __resetStaticArticleFallback(): void {
  stashed = null;
}
