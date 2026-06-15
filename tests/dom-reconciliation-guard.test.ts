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
 * (b) leave well-formed same-parent calls behaving exactly as native, and
 * (c) NOT intercept DOM ops outside the React root (#root) so AdSense / Clarity
 * lifecycle management is never silently no-opped.
 */
describe('installDomReconciliationGuard', () => {
  let reactRoot: HTMLDivElement;

  beforeEach(() => {
    // Provide the #root element the guard uses to scope itself to React's subtree.
    reactRoot = document.createElement('div');
    reactRoot.id = 'root';
    document.body.appendChild(reactRoot);
    installDomReconciliationGuard();
  });

  afterEach(() => {
    document.body.removeChild(reactRoot);
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

  it('does not guard removeChild outside the React root (AdSense / Clarity nodes)', () => {
    // Simulate an AdSense container injected outside #root (e.g. directly into <body>).
    const adsContainer = document.createElement('div');
    document.body.appendChild(adsContainer);
    const adNode = document.createElement('div');
    adsContainer.appendChild(adNode);

    // Simulate the ad SDK moving the node to a different container.
    const elsewhere = document.createElement('div');
    document.body.appendChild(elsewhere);
    elsewhere.appendChild(adNode); // adNode.parentNode is now `elsewhere`

    try {
      // Guard must NOT intercept — outside #root, so native behaviour (throws).
      expect(() => adsContainer.removeChild(adNode)).toThrow();
    } finally {
      document.body.removeChild(adsContainer);
      document.body.removeChild(elsewhere);
    }
  });

  it('does not guard insertBefore outside the React root (AdSense / Clarity nodes)', () => {
    const adsContainer = document.createElement('div');
    document.body.appendChild(adsContainer);
    const reference = document.createElement('div');
    adsContainer.appendChild(reference);

    // Move reference out — simulates ad SDK rearranging its own nodes.
    const elsewhere = document.createElement('div');
    document.body.appendChild(elsewhere);
    elsewhere.appendChild(reference); // reference.parentNode is now `elsewhere`

    try {
      const newNode = document.createElement('div');
      // Guard must NOT intercept — falls through to native (throws).
      expect(() => adsContainer.insertBefore(newNode, reference)).toThrow();
    } finally {
      document.body.removeChild(adsContainer);
      document.body.removeChild(elsewhere);
    }
  });
});
