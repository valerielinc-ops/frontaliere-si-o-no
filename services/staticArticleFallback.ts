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
 *
 * THE STASH BELONGS TO ONE URL, and every accessor here enforces that.
 * There is exactly one stash per document and it survives client-side
 * navigation, so without the check it answers for pages it knows nothing
 * about. Measured in production 2026-08-09: a visitor who landed on
 * /articoli-frontaliere/bollettino-frontaliere-2026-08-09/ and then moved to an
 * article the bundle did not know got the BOLLETTINO's body published under the
 * other article's id — correct title and excerpt from the corpus index, the
 * daily brief underneath ("Buongiorno, è domenica 9 agosto 2026…"). Both
 * consumers meant "the static article OF THE PAGE I AM ON"; nothing made them
 * say so, so both were wrong on the same navigation.
 */

let stashed: HTMLElement | null = null;
/** The path `stashed` was taken from. `null` only while nothing is stashed. */
let stashedPath: string | null = null;

/** Trailing slash, query and hash carry no article identity. */
export function normalizeArticlePath(path: string): string {
  const bare = String(path || '').split('?')[0].split('#')[0];
  return bare.length > 1 && bare.endsWith('/') ? bare.slice(0, -1) : bare;
}

function currentPath(): string {
  return typeof window !== 'undefined' && window.location
    ? normalizeArticlePath(window.location.pathname)
    : '';
}

/**
 * Called by the entry, immediately before the fallback is moved into `#root`.
 *
 * `path` defaults to the document's own URL, which is the only page whose HTML
 * the shard can have served — the parameter exists so callers can be explicit
 * and so tests can stage a stash without touching `location`.
 */
export function stashStaticArticleFallback(fallback: HTMLElement, path?: string): void {
  const clone = fallback.cloneNode(true) as HTMLElement;
  clone.style.removeProperty('display');
  stashed = clone;
  stashedPath = normalizeArticlePath(path ?? currentPath());
}

/** The path the stashed article was served at, for callers that must compare. */
export function staticArticleFallbackPath(): string | null {
  return stashedPath;
}

/**
 * The static article element for `expectedPath` (default: the current URL),
 * wherever it currently is: still in the document if the handoff left it alone,
 * otherwise the stashed clone. `null` when this page never had one — a
 * client-side arrival, or a URL with no shard page — AND null when what we hold
 * came from a different URL, which is the only answer that cannot mislead.
 */
export function staticArticleFallback(expectedPath?: string): HTMLElement | null {
  const want = normalizeArticlePath(expectedPath ?? currentPath());
  // Applies to the live node too: it is the landing document's static content,
  // so a client-side navigation leaves it describing the page we came FROM.
  if (stashedPath !== null && stashedPath !== want) return null;
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

/** True when there is a correct article to fall back to FOR THIS PAGE. */
export function hasStaticArticleFallback(expectedPath?: string): boolean {
  return !!staticArticleFallback(expectedPath)?.querySelector('article.ft-blog-article');
}

/**
 * Put the static article back on screen, outside `#root` where the SPA's
 * overlay mode expects it. Idempotent; `false` means there was nothing to
 * restore and the caller must NOT switch to overlay mode — that would leave a
 * blank page, which is worse than anything this module exists to prevent.
 */
export function restoreStaticArticleFallback(expectedPath?: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false;
  const el = staticArticleFallback(expectedPath);
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
  stashedPath = null;
}
