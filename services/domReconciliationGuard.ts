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
 * Scope: the guard is restricted to DOM operations whose parent (`this`) lives
 * within the React root (#root). DOM operations by third-party scripts outside
 * that subtree (AdSense Auto Ads, Clarity, CMP iframes) fall through to native
 * so their own lifecycle management is never silently no-opped.
 */

interface GuardedNodePrototype extends Node {
  __domReconciliationGuardInstalled?: boolean;
}

export function installDomReconciliationGuard(): void {
  if (typeof Node !== 'function' || !Node.prototype) return;

  const proto = Node.prototype as GuardedNodePrototype;
  if (proto.__domReconciliationGuardInstalled) return;
  proto.__domReconciliationGuardInstalled = true;

  const originalRemoveChild = proto.removeChild;
  proto.removeChild = function removeChild<T extends Node>(this: Node, child: T): T {
    const root = document.getElementById('root');
    if (!root || !root.contains(this)) {
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
    const root = document.getElementById('root');
    if (!root || !root.contains(this)) {
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
