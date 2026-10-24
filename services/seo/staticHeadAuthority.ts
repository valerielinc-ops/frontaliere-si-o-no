/**
 * The static head is authoritative.
 *
 * Every crawlable URL of the site ships a head written at build time (or by
 * the edge) — robots, canonical, hreflang — computed with information the SPA
 * does not have: whether the page is below a floor, whether a translation
 * exists, whether an offer has expired, which URL is the canonical twin.
 * Googlebot renders the page and reads the head AFTER the SPA ran, so any SPA
 * write wins. Measured in the 2026-10 audit: hydration turned the static
 * `noindex` of expired/orphan offers into an indexable page (JobBoard removed
 * the tag), rewrote canonicals from `window.location.origin`, and rebuilt
 * hreflang towards locale URLs that do not exist.
 *
 * Contract, for the document's INITIAL path only (a soft navigation to
 * another path has no static head, so the SPA owns it):
 *   - robots: the SPA may ADD `noindex`, never remove one the HTML shipped;
 *   - canonical and hreflang: the static values stay verbatim (including
 *     "no canonical" and "no hreflang", e.g. a noindex bridge).
 *
 * Two initial documents are NOT authoritative: the generic SPA shell
 * (index.html served for a path without its own HTML), recognised because it
 * carries the homepage canonical of its locale root on a URL that is not that
 * root; and a document with neither a canonical nor a noindex, which has no
 * head of its own to defend. The SPA writes those.
 */

const LOCALE_ROOTS = new Set(['/', '/en/', '/de/', '/fr/']);

export interface StaticHeadSnapshot {
  path: string;
  robots: string | null;
  canonical: string | null;
  hreflang: { lang: string; href: string }[];
  /** False only for the generic SPA shell (see module doc). */
  authoritative: boolean;
}

const hasNoindex = (value: string | null | undefined): boolean => /\bnoindex\b/i.test(value || '');

let snapshot: StaticHeadSnapshot | null = null;
let captured = false;
let navigatedSinceCapture = false;
let navigationObserver: {
  history: History;
  pushState: History['pushState'];
  replaceState: History['replaceState'];
  onPopState: () => void;
  wrappedPushState: History['pushState'];
  wrappedReplaceState: History['replaceState'];
} | null = null;

const normalizePath = (p: string): string => {
  if (!p) return '/';
  return p.endsWith('/') ? p : `${p}/`;
};

const isGenericShell = (canonical: string | null, path: string): boolean => {
  if (!canonical) return false;
  try {
    const canonicalPath = normalizePath(new URL(canonical, 'https://frontaliereticino.ch').pathname);
    return LOCALE_ROOTS.has(canonicalPath) && canonicalPath !== normalizePath(path);
  } catch {
    return false;
  }
};

/**
 * Once the document has crossed a pathname boundary, its original head no
 * longer belongs to the current SPA route — even if the user navigates back
 * to the pathname that was served initially. History API calls do not emit a
 * `popstate` event, so observe them alongside browser back/forward events.
 */
function markPathnameNavigation(): void {
  if (!snapshot || typeof window === 'undefined') return;
  if (normalizePath(window.location.pathname) !== normalizePath(snapshot.path)) {
    navigatedSinceCapture = true;
  }
}

function installNavigationObserver(): void {
  if (typeof window === 'undefined' || navigationObserver) return;
  const history = window.history;
  const pushState = history.pushState;
  const replaceState = history.replaceState;
  const wrappedPushState = function (this: History, ...args: Parameters<History['pushState']>) {
    const result = pushState.apply(this, args);
    markPathnameNavigation();
    return result;
  } as History['pushState'];
  const wrappedReplaceState = function (this: History, ...args: Parameters<History['replaceState']>) {
    const result = replaceState.apply(this, args);
    markPathnameNavigation();
    return result;
  } as History['replaceState'];
  const onPopState = () => markPathnameNavigation();
  try {
    history.pushState = wrappedPushState;
    history.replaceState = wrappedReplaceState;
    window.addEventListener('popstate', onPopState);
    navigationObserver = {
      history,
      pushState,
      replaceState,
      onPopState,
      wrappedPushState,
      wrappedReplaceState,
    };
  } catch {
    // A host may expose a non-writable History object. currentSnapshot still
    // checks the live pathname, so hydration remains safe on that host.
  }
}

function removeNavigationObserver(): void {
  if (!navigationObserver || typeof window === 'undefined') return;
  const observer = navigationObserver;
  window.removeEventListener('popstate', observer.onPopState);
  if (observer.history.pushState === observer.wrappedPushState) {
    observer.history.pushState = observer.pushState;
  }
  if (observer.history.replaceState === observer.wrappedReplaceState) {
    observer.history.replaceState = observer.replaceState;
  }
  navigationObserver = null;
}

/**
 * Record the head the document was served with. Idempotent: only the first
 * call counts. index.tsx (the only SPA entry) calls it before any module can
 * write the head. Deliberately NOT called lazily by the writers: a lazy
 * capture would record whatever an earlier SPA pass had already written and
 * mistake it for the served HTML. Without a capture every writer behaves as
 * before (the SPA owns the head).
 */
export function captureStaticHead(): void {
  if (captured || typeof document === 'undefined' || typeof window === 'undefined') return;
  captured = true;
  const path = window.location.pathname;
  const robots = document.querySelector('meta[name="robots"]')?.getAttribute('content') ?? null;
  const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null;
  const hreflang = Array.from(document.querySelectorAll('link[rel="alternate"][hreflang]')).map((el) => ({
    lang: el.getAttribute('hreflang') || '',
    href: el.getAttribute('href') || '',
  }));
  // A document that ships neither a canonical nor a noindex has no head of
  // its own to defend (a bare shell, a test fixture): the SPA writes it.
  const ownsHead = canonical != null || hasNoindex(robots);
  snapshot = { path, robots, canonical, hreflang, authoritative: ownsHead && !isGenericShell(canonical, path) };
  navigatedSinceCapture = false;
  installNavigationObserver();
}

/** Test-only: forget the captured head. */
export function resetStaticHeadAuthorityForTests(): void {
  removeNavigationObserver();
  snapshot = null;
  captured = false;
  navigatedSinceCapture = false;
}

/** The snapshot, when the document is still on the path it was served for. */
function currentSnapshot(): StaticHeadSnapshot | null {
  if (!snapshot || typeof window === 'undefined') return null;
  markPathnameNavigation();
  return !navigatedSinceCapture && normalizePath(window.location.pathname) === normalizePath(snapshot.path)
    ? snapshot
    : null;
}

/** True when canonical/hreflang of the current path belong to the static HTML. */
export function hasAuthoritativeStaticHead(): boolean {
  return currentSnapshot()?.authoritative === true;
}

/**
 * The robots directive to write, given what the SPA would like to write.
 * The only override: the SPA never lifts a `noindex` the HTML shipped for
 * this path (it keeps its own wording otherwise, noindex included).
 */
export function resolveRobotsDirective(spaDirective: string): string {
  const snap = currentSnapshot();
  if (snap && hasNoindex(snap.robots) && !hasNoindex(spaDirective)) return snap.robots as string;
  return spaDirective;
}

/**
 * Drop a `noindex` an earlier SPA pass left behind — but only one the SPA
 * wrote: a `noindex` the HTML shipped for this path stays.
 */
export function clearSpaNoindex(): void {
  if (typeof document === 'undefined') return;
  const el = document.querySelector('meta[name="robots"]');
  if (!el || !hasNoindex(el.getAttribute('content'))) return;
  const snap = currentSnapshot();
  // A shipped directive (noindex included) is restored verbatim; only a tag
  // the HTML did not have is removed.
  if (snap && snap.robots != null) {
    el.setAttribute('content', snap.robots);
    return;
  }
  el.remove();
}

/** Write the canonical — or restore the static one when the HTML owns it. */
export function applyCanonicalHref(spaHref: string): void {
  if (typeof document === 'undefined') return;
  const snap = currentSnapshot();
  const href = snap?.authoritative ? snap.canonical : spaHref;
  const existing = document.querySelectorAll('link[rel="canonical"]');
  if (href == null) {
    existing.forEach((el) => el.remove());
    return;
  }
  existing.forEach((el, i) => { if (i > 0) el.remove(); });
  let canonical = existing[0] as HTMLLinkElement | undefined;
  if (!canonical) {
    canonical = document.createElement('link');
    canonical.setAttribute('rel', 'canonical');
    document.head.appendChild(canonical);
  }
  canonical.setAttribute('href', href);
}

/**
 * Replace the hreflang block — or restore the static one when the HTML owns
 * it. Returns true when the SPA's entries were written.
 */
export function applyHreflangEntries(spaEntries: { lang: string; href: string }[]): boolean {
  if (typeof document === 'undefined') return false;
  const snap = currentSnapshot();
  const entries = snap?.authoritative ? snap.hreflang : spaEntries;
  const current = Array.from(document.querySelectorAll('link[hreflang]')).map((el) => ({
    lang: el.getAttribute('hreflang') || '',
    href: el.getAttribute('href') || '',
  }));
  const key = (list: { lang: string; href: string }[]) => list.map((e) => `${e.lang} ${e.href}`).join('\n');
  // Already what it should be: leave the nodes (and their order) untouched.
  if (key(current) === key(entries.filter((e) => e.lang && e.href))) return !snap?.authoritative;
  document.querySelectorAll('link[hreflang]').forEach((el) => el.remove());
  for (const { lang, href } of entries) {
    if (!lang || !href) continue;
    const link = document.createElement('link');
    link.setAttribute('rel', 'alternate');
    link.setAttribute('hreflang', lang);
    link.setAttribute('href', href);
    document.head.appendChild(link);
  }
  return !snap?.authoritative;
}
