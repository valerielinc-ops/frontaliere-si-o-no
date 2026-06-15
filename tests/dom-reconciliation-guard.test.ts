import { describe, it, expect, beforeEach } from 'vitest';
import { installDomReconciliationGuard } from '../services/domReconciliationGuard';

/**
 * Reproduces the field crash (PostHog replay, French-translated job auth-gate):
 *   NotFoundError: Failed to execute 'insertBefore'/'removeChild' on 'Node'.
 * Google Translate reparents a text node (wraps it in a <font>), so when React
 * calls removeChild/insertBefore with the original node the parent no longer
 * matches and the DOM throws, crashing the whole app via the ErrorBoundary.
 *
 * The guard must (a) make the cross-parent case a no-op instead of throwing and
 * (b) leave well-formed same-parent calls behaving exactly as native.
 */
describe('installDomReconciliationGuard', () => {
  beforeEach(() => {
    installDomReconciliationGuard();
  });

  it('does not throw when removeChild is called for a node reparented by Translate', () => {
    const reactParent = document.createElement('div');
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
    const child = document.createElement('span');
    parent.appendChild(child);
    expect(() => parent.removeChild(child)).not.toThrow();
    expect(parent.contains(child)).toBe(false);
  });
});
