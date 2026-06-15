import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installDomReconciliationGuard } from '../services/domReconciliationGuard';

/**
 * Reproduces the field crash (PostHog replay, French-translated job auth-gate):
 *   NotFoundError: Failed to execute 'insertBefore'/'removeChild' on 'Node'.
 * Google Translate reparents a text node (wraps it in a <font>), so when React
 * calls removeChild/insertBefore with the original node the parent no longer
 * matches and the DOM throws, crashing the whole app via the ErrorBoundary.
 *
 * The guard must (a) make the cross-parent case a no-op instead of throwing,
 * (b) leave well-formed same-parent calls behaving exactly as native,
 * (c) protect ALL React DOM including portals rendered OUTSIDE #root
 *     (#modal-root, #footer-root, document.body — paywall/newsletter/search), and
 * (d) NOT intercept DOM ops inside third-party (AdSense / Clarity) containers so
 *     their own lifecycle management is never silently no-opped (issue #2061).
 */
describe('installDomReconciliationGuard', () => {
  let reactRoot: HTMLDivElement;
  let modalRoot: HTMLDivElement;

  beforeEach(() => {
    // #root and #modal-root are siblings in <body> (mirrors index.html); React
    // portals (paywall, newsletter) render into #modal-root, outside #root.
    reactRoot = document.createElement('div');
    reactRoot.id = 'root';
    document.body.appendChild(reactRoot);
    modalRoot = document.createElement('div');
    modalRoot.id = 'modal-root';
    document.body.appendChild(modalRoot);
    installDomReconciliationGuard();
  });

  afterEach(() => {
    document.body.removeChild(reactRoot);
    document.body.removeChild(modalRoot);
  });

  it('does not throw when removeChild is called for a node reparented by Translate', () => {
    const reactParent = document.createElement('div');
    reactRoot.appendChild(reactParent);
    const text = document.createTextNode('Coordinatore BIM CVSE');
    reactParent.appendChild(text);

    // Simulate Google Translate wrapping the text node in a <font>.
    const font = document.createElement('font');
    reactParent.appendChild(font);
    font.appendChild(text); // text.parentNode is now `font`, not `reactParent`

    // React still believes `text` is a child of `reactParent`.
    expect(() => reactParent.removeChild(text)).not.toThrow();
    // The node was left where it actually lives; nothing was wrongly detached.
    expect(text.parentNode).toBe(font);
  });

  it('does not throw when insertBefore reference node was reparented by Translate', () => {
    const reactParent = document.createElement('div');
    reactRoot.appendChild(reactParent);
    const reference = document.createElement('span');
    reactParent.appendChild(reference);

    // Translate moves the reference node out from under reactParent.
    const font = document.createElement('font');
    reactParent.appendChild(font);
    font.appendChild(reference);

    const newNode = document.createElement('em');
    // Would throw NotFoundError natively; guard appends instead of crashing.
    expect(() => reactParent.insertBefore(newNode, reference)).not.toThrow();
    expect(newNode.parentNode).toBe(reactParent);
  });

  it('protects React portals rendered OUTSIDE #root (paywall/newsletter in #modal-root)', () => {
    // CalculatorPaywall / NewsletterPopup portal into #modal-root, a sibling of
    // #root. Translate reparenting text there must still be guarded, not crash.
    const paywall = document.createElement('div');
    modalRoot.appendChild(paywall);
    const text = document.createTextNode('Sblocca il risultato');
    paywall.appendChild(text);

    const font = document.createElement('font');
    paywall.appendChild(font);
    font.appendChild(text); // reparented out of `paywall`

    expect(() => paywall.removeChild(text)).not.toThrow();
    expect(text.parentNode).toBe(font);
  });

  it('protects React portals rendered directly into <body> (SiteSearch/toasts)', () => {
    // SiteSearch and toasts createPortal straight into document.body — outside
    // both #root and #modal-root. The guard must still cover them.
    const searchModal = document.createElement('div');
    document.body.appendChild(searchModal);
    const reference = document.createElement('span');
    searchModal.appendChild(reference);

    const font = document.createElement('font');
    searchModal.appendChild(font);
    font.appendChild(reference);

    try {
      const newNode = document.createElement('em');
      expect(() => searchModal.insertBefore(newNode, reference)).not.toThrow();
      expect(newNode.parentNode).toBe(searchModal);
    } finally {
      document.body.removeChild(searchModal);
    }
  });

  it('preserves native behaviour for well-formed same-parent calls', () => {
    const parent = document.createElement('div');
    reactRoot.appendChild(parent);
    const a = document.createElement('span');
    const b = document.createElement('span');
    parent.appendChild(b);

    parent.insertBefore(a, b);
    expect(parent.firstChild).toBe(a);
    expect(parent.lastChild).toBe(b);

    parent.removeChild(a);
    expect(parent.contains(a)).toBe(false);
    expect(parent.firstChild).toBe(b);
  });

  it('is idempotent — installing twice does not double-wrap', () => {
    installDomReconciliationGuard();
    const parent = document.createElement('div');
    reactRoot.appendChild(parent);
    const child = document.createElement('span');
    parent.appendChild(child);
    expect(() => parent.removeChild(child)).not.toThrow();
    expect(parent.contains(child)).toBe(false);
  });

  it('does not guard removeChild inside an AdSense container (ins.adsbygoogle)', () => {
    // AdSense Auto Ads manage their own <ins class="adsbygoogle"> subtree. A
    // cross-parent op there must fall through to native, never be no-opped.
    const adSlot = document.createElement('ins');
    adSlot.className = 'adsbygoogle';
    document.body.appendChild(adSlot);
    const adNode = document.createElement('div');
    adSlot.appendChild(adNode);

    // Ad SDK moves the node to a different ad container.
    const elsewhere = document.createElement('div');
    elsewhere.className = 'adsbygoogle';
    document.body.appendChild(elsewhere);
    elsewhere.appendChild(adNode); // adNode.parentNode is now `elsewhere`

    try {
      // Guard must NOT intercept — third-party subtree, native behaviour (throws).
      expect(() => adSlot.removeChild(adNode)).toThrow();
    } finally {
      document.body.removeChild(adSlot);
      document.body.removeChild(elsewhere);
    }
  });

  it('does not guard insertBefore inside an ad iframe / Clarity subtree', () => {
    // A Google ad iframe (aswift_) — third-party. Reference moved by the SDK.
    const adFrame = document.createElement('iframe');
    adFrame.id = 'aswift_3';
    document.body.appendChild(adFrame);
    const container = document.createElement('div');
    adFrame.appendChild(container);
    const reference = document.createElement('div');
    container.appendChild(reference);

    const elsewhere = document.createElement('div');
    adFrame.appendChild(elsewhere);
    elsewhere.appendChild(reference); // reference.parentNode is now `elsewhere`

    try {
      const newNode = document.createElement('div');
      // Inside an ad iframe subtree → guard steps aside → native (throws).
      expect(() => container.insertBefore(newNode, reference)).toThrow();
    } finally {
      document.body.removeChild(adFrame);
    }
  });
});
