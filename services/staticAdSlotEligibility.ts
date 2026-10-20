/**
 * Keeps static AdSense slots out of AdSense's implicit DOM-order push queue
 * until each slot enters the shared request margin. The emitted HTML keeps the
 * original `<ins>` and its inline reserve; only the `adsbygoogle` eligibility
 * class is parked.
 *
 * The loader serializes this dependency-free function into its external script
 * so the static queue can use the same behavior without a runtime import.
 */
export function createStaticAdSlotEligibility() {
  var pending: Element[] = [];
  var activated: Element[] = [];
  var pendingAttr = 'data-ft-static-ad-pending';

  function isAttached(el: Element): boolean {
    return !!document.documentElement && document.documentElement.contains(el);
  }

  function prune(): void {
    for (var i = pending.length - 1; i >= 0; i--) {
      var el = pending[i];
      if (!isAttached(el)) {
        el.removeAttribute(pendingAttr);
        pending.splice(i, 1);
        continue;
      }
      // Another loader may have completed this slot while it was parked.
      // Restore its class so later diagnostics and styles see the processed ad.
      if (el.getAttribute('data-adsbygoogle-status') !== null) {
        el.removeAttribute(pendingAttr);
        if (!el.classList.contains('adsbygoogle')) el.classList.add('adsbygoogle');
        if (activated.indexOf(el) === -1) activated.push(el);
        pending.splice(i, 1);
      }
    }
    for (var j = activated.length - 1; j >= 0; j--) {
      if (!isAttached(activated[j])) activated.splice(j, 1);
    }
  }

  function park(slots: Element[], isTarget: (el: Element) => boolean): Element[] {
    prune();
    for (var i = 0; i < slots.length; i++) {
      var el = slots[i];
      if (!isTarget(el)) continue;
      if (el.getAttribute('data-adsbygoogle-status') !== null) {
        el.removeAttribute(pendingAttr);
        if (activated.indexOf(el) === -1) activated.push(el);
        continue;
      }
      if (!isAttached(el)) continue;
      // `armSlots()` may be called again when an already-loaded script is
      // reused. A pushed slot remains active while its response is pending;
      // never park or observe it for a second request.
      if (activated.indexOf(el) !== -1) continue;
      if (pending.indexOf(el) === -1) pending.push(el);
      el.setAttribute(pendingAttr, '');
      el.classList.remove('adsbygoogle');
    }
    return pending.slice();
  }

  function activate(el: Element): boolean {
    prune();
    var index = pending.indexOf(el);
    if (index === -1) return false;
    pending.splice(index, 1);
    if (activated.indexOf(el) === -1) activated.push(el);
    el.removeAttribute(pendingAttr);
    if (!isAttached(el)) return false;
    if (el.getAttribute('data-adsbygoogle-status') !== null) {
      el.classList.add('adsbygoogle');
      return false;
    }
    el.classList.add('adsbygoogle');
    return true;
  }

  function pendingCount(): number {
    prune();
    return pending.length;
  }

  return { park: park, activate: activate, pendingCount: pendingCount };
}
