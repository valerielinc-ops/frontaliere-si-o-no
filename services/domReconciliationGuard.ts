/**
 * Defensive guard against third-party DOM mutation crashing React's reconciler.
 *
 * Browser-native Google Translate (and the extension), Grammarly, and similar
 * tools rewrite text nodes inside React-managed DOM — e.g. wrapping a text node
 * in a <font> element so the original node's parent silently changes. When React
 * later reconciles those nodes it calls Node.insertBefore / Node.removeChild with
 * a reference/child whose parent is no longer `this`, throwing:
 *
 *   NotFoundError: Failed to execute 'insertBefore' on 'Node':
 *   The node before which the new node is to be inserted is not a child of this node.
 *   NotFoundError: Failed to execute 'removeChild' on 'Node':
 *   The node to be removed is not a child of this node.
 *
 * The throw escapes React, unmounts the whole tree via the top-level
 * ErrorBoundary and shows the white "ERRORE / Ricarica Pagina" screen. Observed
 * in the field on the job auth-gate (PostHog replay, French-translated page +
 * Google CMP) where conditional text siblings re-render on sign-in interaction.
 *
 * The standard mitigation (facebook/react#11538) makes both methods a no-op when
 * the reference/child node is not actually a child of `this`, instead of throwing.
 * React's next render re-synchronises the tree from the VDOM. For well-formed
 * callers this is a zero-behaviour-change patch: it only intercepts the
 * cross-parent case that would otherwise crash.
 *
 * Scope: the guard must protect every React-managed subtree, which is NOT just
 * `#root`. React renders many surfaces via `createPortal` OUTSIDE `#root` — into
 * sibling containers (`#modal-root`: CalculatorPaywall, NewsletterPopup;
 * `#footer-root`: footer) or directly into `<body>` (SiteSearch, toasts). A
 * `#root`-only whitelist would drop the guard for those portals and re-introduce
 * the crash exactly where it hurts most (the calculator paywall on a translated
 * page). So instead of whitelisting React's container we EXCLUDE the known
 * third-party containers: DOM operations whose parent (`this`) or moved/reference
 * node live inside an AdSense (`ins.adsbygoogle`, Google ad iframes) or Clarity
 * subtree fall through to native, so their own lifecycle management is never
 * silently no-opped (issue #2061). Everything else — all React DOM, portaled or
 * not — keeps the cross-parent protection.
 */

interface GuardedNodePrototype extends Node {
  __domReconciliationGuardInstalled?: boolean;
}

/**
 * Containers managed by third-party ad/analytics scripts whose own DOM lifecycle
 * must never be intercepted by the guard. Matched against the operation's parent
 * and the node(s) it moves, via `closest()` (native ancestor walk).
 */
const THIRD_PARTY_CONTAINER_SELECTOR = [
  'ins.adsbygoogle',
  '.adsbygoogle',
  '[data-ad-client]',
  '[data-google-query-id]',
  'iframe[id^="aswift_"]',
  'iframe[name^="aswift_"]',
  'iframe[id^="google_ads_iframe"]',
  'iframe[src*="googlesyndication.com"]',
  'iframe[src*="googleads"]',
  'iframe[src*="doubleclick.net"]',
  '[id^="google_anchor"]',
  '[id^="google_vignette"]',
  'iframe[src*="clarity.ms"]',
  '[id^="clarity"]',
].join(',');

/**
 * True when `node` is, or lives inside, a known third-party (AdSense/Clarity)
 * container — in which case the guard steps aside and native behaviour applies.
 */
function isThirdPartyManaged(node: Node | null | undefined): boolean {
  if (!node) return false;
  const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
  return !!el && typeof el.closest === 'function'
    && el.closest(THIRD_PARTY_CONTAINER_SELECTOR) !== null;
}

export function installDomReconciliationGuard(): void {
  if (typeof Node !== 'function' || !Node.prototype) return;

  const proto = Node.prototype as GuardedNodePrototype;
  if (proto.__domReconciliationGuardInstalled) return;
  proto.__domReconciliationGuardInstalled = true;

  const originalRemoveChild = proto.removeChild;
  proto.removeChild = function removeChild<T extends Node>(this: Node, child: T): T {
    if (isThirdPartyManaged(this) || isThirdPartyManaged(child)) {
      return originalRemoveChild.call(this, child) as T;
    }
    if (child.parentNode !== this) {
      if (import.meta.env.DEV) {
        console.warn('[domGuard] removeChild skipped: node is not a child of this parent', child, this);
      }
      return child;
    }
    return originalRemoveChild.call(this, child) as T;
  };

  const originalInsertBefore = proto.insertBefore;
  proto.insertBefore = function insertBefore<T extends Node>(
    this: Node,
    newNode: T,
    referenceNode: Node | null,
  ): T {
    if (
      isThirdPartyManaged(this)
      || isThirdPartyManaged(newNode)
      || isThirdPartyManaged(referenceNode)
    ) {
      return originalInsertBefore.call(this, newNode, referenceNode) as T;
    }
    if (referenceNode && referenceNode.parentNode !== this) {
      if (import.meta.env.DEV) {
        console.warn('[domGuard] insertBefore fell back to append: reference node is not a child of this parent', referenceNode, this);
      }
      return originalInsertBefore.call(this, newNode, null) as T;
    }
    return originalInsertBefore.call(this, newNode, referenceNode) as T;
  };
}
