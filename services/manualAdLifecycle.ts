/** Browser-only controller, also serialized into the static loader. Keep it
 * dependency-free: both render paths must classify slow responses identically. */
export function observeManualAd(
  el: HTMLElement,
  box: HTMLElement,
  timeoutMs: number,
  onState: (state: 'waiting_width' | 'loading' | 'waiting_response' | 'filled' | 'unfilled' | 'unavailable' | 'collapsed', reason?: string) => void,
  emitEvent: (event: 'ad_request' | 'ad_unavailable' | 'ad_waiting' | 'ad_filled' | 'ad_unfilled' | 'ad_collapsed' | 'ad_measurable' | 'ad_viewable', metrics?: Record<string, string | number>) => void,
) {
  // Preserve late Google fills (including known 30s+ creatives), then expose a
  // bounded stall signal so the publisher-owned fallback can occupy the slot.
  const STALLED_AD_FALLBACK_MS = 45_000;
  const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const emit: typeof emitEvent = (event, data = {}) => emitEvent(event, { request_id: requestId, ...data });
  let stopped = false;
  let requested = false;
  let requestPending = false;
  let filled = false;
  let terminal = '';
  let failureReason = '';
  let measurable = false;
  let viewable = false;
  let inView = false;
  let responseTimer: ReturnType<typeof setTimeout> | undefined;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let viewTimer: ReturnType<typeof setTimeout> | undefined;
  let offscreen: IntersectionObserver | undefined;
  let visibility: IntersectionObserver | undefined;
  let resize: ResizeObserver | undefined;
  let resizeFrame: number | undefined;
  let creativeTarget: HTMLElement | null = null;
  const setRequestPending = (active: boolean) => {
    if (requestPending === active) return;
    requestPending = active;
    // Rendered GPT placeholders start as loading even before display(). This
    // marker records actual requests, with independent owners for shared boxes.
    const attribute = 'data-ft-ad-request-pending';
    const previous = Math.max(0, parseInt(box.getAttribute(attribute) || '0', 10) || 0);
    const next = Math.max(0, previous + (active ? 1 : -1));
    if (next) box.setAttribute(attribute, String(next));
    else box.removeAttribute(attribute);
  };
  const findCreative = (): HTMLElement | null => Array.from(el.querySelectorAll('iframe'))
    .filter((frame) => { const r = frame.getBoundingClientRect(); return r.width > 1 && r.height > 1; })
    .sort((a, b) => { const ar = a.getBoundingClientRect(); const br = b.getBoundingClientRect(); return br.width * br.height - ar.width * ar.height; })[0] ?? null;
  const metrics = () => ({
    reserved_height: Math.round(parseFloat(getComputedStyle(box).minHeight) || parseFloat(getComputedStyle(el).minHeight) || 0),
    slot_height: Math.round(box.getBoundingClientRect().height),
    slot_width: Math.round(el.getBoundingClientRect().width),
    creative_height: Math.round(findCreative()?.getBoundingClientRect().height || 0),
  });
  const clearViewTimer = () => { clearTimeout(viewTimer); viewTimer = undefined; };
  const clearStallTimer = () => { clearTimeout(stallTimer); stallTimer = undefined; };
  const updateView = () => {
    clearViewTimer();
    if (!filled || !inView || document.visibilityState === 'hidden' || viewable) return;
    viewTimer = setTimeout(() => {
      if (!stopped && inView && creativeTarget?.isConnected && document.visibilityState !== 'hidden') {
        viewable = true;
        emit('ad_viewable', { ...metrics(), measurement: 'client_50pct_1s' });
      }
    }, 1000);
  };
  // Re-observing resets the last reported size, so doing it while the browser
  // is delivering notifications leaves `el` active at a depth it cannot deliver
  // in that frame: "ResizeObserver loop completed with undelivered
  // notifications". measure() also runs inside a delivery, directly or through
  // the MutationObserver when Google's own observers touch the creative, so the
  // rewiring waits for the next frame, before that frame's own delivery.
  const syncResizeTargets = () => {
    resizeFrame = undefined;
    if (stopped) return;
    resize?.disconnect();
    resize?.observe(el);
    if (creativeTarget) resize?.observe(creativeTarget);
  };
  const measure = () => {
    if (!filled) return;
    const creative = findCreative();
    if (creativeTarget !== creative) {
      clearViewTimer();
      inView = false;
      creativeTarget = creative;
      visibility?.disconnect();
      if (resize && resizeFrame === undefined) resizeFrame = requestAnimationFrame(syncResizeTargets);
      if (creative && typeof IntersectionObserver !== 'undefined') {
        visibility = new IntersectionObserver((entries) => {
          const entry = entries[entries.length - 1];
          if (entry?.target !== creativeTarget) return;
          inView = !!entry?.isIntersecting && entry.intersectionRatio >= 0.5;
          updateView();
        }, { threshold: [0, 0.5] });
        visibility.observe(creative);
      }
    }
    if (creative && !measurable) {
      measurable = true;
      emit('ad_measurable', { ...metrics(), measurement: 'client_frame_geometry' });
    }
  };
  const visible = () => {
    const rect = box.getBoundingClientRect();
    return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
  };
  // Collapsing is only layout-safe BELOW the viewport. A box above it that
  // drops to 0 pulls everything on screen up by its full height: measured live
  // 2026-10-24 on `/` (Pixel 5), an unfilled multiplex the reader had scrolled
  // past collapsed from 1790px at scrollY 4500 and scored a single 1.0 layout
  // shift. So an above-the-fold-of-the-reader box keeps its reserve until it is
  // below the viewport again (the reader scrolled back up past it), and only
  // then gives the space back, where nothing visible moves.
  const belowViewport = () => box.getBoundingClientRect().top >= window.innerHeight;
  const collapse = () => {
    if (stopped || filled || !terminal || visible() || !belowViewport()) return;
    offscreen?.disconnect();
    window.removeEventListener('scroll', collapse);
    window.removeEventListener('resize', collapse);
    onState('collapsed', terminal);
    emit('ad_collapsed', { reason: terminal, ...metrics() });
    terminal = '';
  };
  const fail = (reason: string) => {
    if (stopped || filled || failureReason === reason) return;
    setRequestPending(false);
    failureReason = reason;
    clearTimeout(responseTimer);
    clearStallTimer();
    terminal = reason;
    if (reason !== 'unfilled') emit('ad_unavailable', { reason, ...metrics() });
    onState(reason === 'unfilled' ? 'unfilled' : 'unavailable', reason);
    if (belowViewport()) { collapse(); return; }
    if (typeof IntersectionObserver !== 'undefined') {
      offscreen?.disconnect();
      offscreen = new IntersectionObserver(() => collapse());
      offscreen.observe(box);
    } else {
      window.addEventListener('scroll', collapse, { passive: true });
      window.addEventListener('resize', collapse, { passive: true });
    }
  };
  const check = () => {
    if (stopped) return;
    if (!el.isConnected && pollTimer !== undefined) {
      // The owner stops removed slots. A temporary detach/reinsert must not
      // permanently discard polling before the document cleanup sees it.
      return;
    }
    const status = el.getAttribute('data-ad-status');
    if (status === 'filled' && !filled) {
      setRequestPending(false);
      filled = true;
      terminal = '';
      clearTimeout(responseTimer);
      clearStallTimer();
      el.removeAttribute('data-ft-ad-stalled');
      offscreen?.disconnect();
      window.removeEventListener('scroll', collapse);
      window.removeEventListener('resize', collapse);
      onState('filled');
      emit('ad_filled', metrics());
      if (typeof ResizeObserver !== 'undefined') { resize = new ResizeObserver(measure); resize.observe(el); }
      measure();
    } else if (status === 'unfilled' && !filled && !failureReason) {
      emit('ad_unfilled');
      fail('unfilled');
    }
    if (filled) measure();
  };
  const observer = typeof MutationObserver === 'function' ? new MutationObserver(check) : undefined;
  observer?.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-ad-status', 'style', 'height', 'width'] });
  // Limited webviews still accept late Google responses. This fallback is
  // released by the lifecycle owner's stop(), like the observer. Static HTML
  // stops removed owners in its document monitor; React stops on unmount.
  if (!observer) pollTimer = setInterval(check, 1000);
  const onVisibility = () => { if (document.visibilityState !== 'hidden') check(); updateView(); };
  document.addEventListener('visibilitychange', onVisibility);
  return {
    defer() {
      if (stopped || filled) return;
      setRequestPending(false); clearTimeout(responseTimer);
      clearStallTimer(); el.removeAttribute('data-ft-ad-stalled');
      requested = false; terminal = ''; failureReason = '';
      onState('waiting_width');
    },
    request() {
      if (stopped || requested) return;
      requested = true;
      clearStallTimer(); el.removeAttribute('data-ft-ad-stalled');
      setRequestPending(true);
      onState('loading');
      emit('ad_request', metrics());
      responseTimer = setTimeout(() => {
        check();
        if (filled || terminal || stopped || el.getAttribute('data-ad-status') === 'unfilled') return;
        // A deadline is not a no-fill. Keep listening: measured company/fuel
        // creatives can arrive after 30 seconds, including 1534px frames.
        onState('waiting_response');
        emit('ad_waiting', { reason: 'response_pending', ...metrics() });
        stallTimer = setTimeout(() => {
          stallTimer = undefined;
          check();
          if (filled || terminal || stopped || !requestPending || el.getAttribute('data-ad-status') === 'unfilled') return;
          el.setAttribute('data-ft-ad-stalled', 'response_stalled');
          emit('ad_waiting', { reason: 'response_stalled', ...metrics() });
        }, Math.max(0, STALLED_AD_FALLBACK_MS - timeoutMs));
      }, timeoutMs);
      check();
    },
    fail,
    stop() {
      setRequestPending(false);
      stopped = true;
      clearTimeout(responseTimer);
      clearStallTimer();
      el.removeAttribute('data-ft-ad-stalled');
      clearViewTimer();
      observer?.disconnect();
      clearInterval(pollTimer); pollTimer = undefined;
      offscreen?.disconnect();
      visibility?.disconnect();
      resize?.disconnect();
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('scroll', collapse);
      window.removeEventListener('resize', collapse);
    },
  };
}
