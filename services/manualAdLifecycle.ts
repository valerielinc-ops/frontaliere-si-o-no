/** Browser-only controller, also serialized into the static loader. Keep it
 * dependency-free: both render paths must classify slow responses identically. */
export function observeManualAd(
  el: HTMLElement,
  box: HTMLElement,
  timeoutMs: number,
  onState: (state: 'loading' | 'waiting_response' | 'filled' | 'unfilled' | 'unavailable' | 'collapsed', reason?: string) => void,
  emitEvent: (event: 'ad_request' | 'ad_waiting' | 'ad_filled' | 'ad_unfilled' | 'ad_collapsed' | 'ad_measurable' | 'ad_viewable', metrics?: Record<string, string | number>) => void,
) {
  const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const emit: typeof emitEvent = (event, data = {}) => emitEvent(event, { request_id: requestId, ...data });
  let stopped = false;
  let requested = false;
  let filled = false;
  let terminal = '';
  let failureReason = '';
  let measurable = false;
  let viewable = false;
  let inView = false;
  let responseTimer: ReturnType<typeof setTimeout> | undefined;
  let viewTimer: ReturnType<typeof setTimeout> | undefined;
  let offscreen: IntersectionObserver | undefined;
  let visibility: IntersectionObserver | undefined;
  let resize: ResizeObserver | undefined;
  let creativeTarget: HTMLElement | null = null;
  const findCreative = (): HTMLElement | null => Array.from(el.querySelectorAll('iframe'))
    .filter((frame) => { const r = frame.getBoundingClientRect(); return r.width > 1 && r.height > 1; })
    .sort((a, b) => { const ar = a.getBoundingClientRect(); const br = b.getBoundingClientRect(); return br.width * br.height - ar.width * ar.height; })[0] ?? null;
  const metrics = () => ({
    reserved_height: Math.round(parseFloat(getComputedStyle(box).minHeight) || parseFloat(getComputedStyle(el).minHeight) || 0),
    slot_height: Math.round(box.getBoundingClientRect().height),
    creative_height: Math.round(findCreative()?.getBoundingClientRect().height || 0),
  });
  const clearViewTimer = () => { clearTimeout(viewTimer); viewTimer = undefined; };
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
  const measure = () => {
    if (!filled) return;
    const creative = findCreative();
    if (creativeTarget !== creative) {
      clearViewTimer();
      inView = false;
      creativeTarget = creative;
      visibility?.disconnect();
      resize?.disconnect();
      resize?.observe(el);
      if (creative) {
        resize?.observe(creative);
        if (typeof IntersectionObserver !== 'undefined') {
          visibility = new IntersectionObserver((entries) => {
            const entry = entries[entries.length - 1];
            if (entry?.target !== creativeTarget) return;
            inView = !!entry?.isIntersecting && entry.intersectionRatio >= 0.5;
            updateView();
          }, { threshold: [0, 0.5] });
          visibility.observe(creative);
        }
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
  const collapse = () => {
    if (stopped || filled || !terminal || visible()) return;
    offscreen?.disconnect();
    window.removeEventListener('scroll', collapse);
    window.removeEventListener('resize', collapse);
    onState('collapsed', terminal);
    emit('ad_collapsed', { reason: terminal, ...metrics() });
    terminal = '';
  };
  const fail = (reason: string) => {
    if (stopped || filled || failureReason === reason) return;
    failureReason = reason;
    clearTimeout(responseTimer);
    terminal = reason;
    onState(reason === 'unfilled' ? 'unfilled' : 'unavailable', reason);
    if (!visible()) { collapse(); return; }
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
    const status = el.getAttribute('data-ad-status');
    if (status === 'filled' && !filled) {
      filled = true;
      terminal = '';
      clearTimeout(responseTimer);
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
  const observer = new MutationObserver(check);
  observer.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-ad-status', 'style', 'height', 'width'] });
  document.addEventListener('visibilitychange', updateView);
  return {
    request() {
      if (stopped || requested) return;
      requested = true;
      onState('loading');
      emit('ad_request', metrics());
      responseTimer = setTimeout(() => {
        check();
        if (filled || terminal || stopped || el.getAttribute('data-ad-status') === 'unfilled') return;
        // A deadline is not a no-fill. Keep listening: measured company/fuel
        // creatives can arrive after 30 seconds, including 1534px frames.
        onState('waiting_response');
        emit('ad_waiting', { reason: 'response_pending', ...metrics() });
      }, timeoutMs);
      check();
    },
    fail,
    stop() {
      stopped = true;
      clearTimeout(responseTimer);
      clearViewTimer();
      observer.disconnect();
      offscreen?.disconnect();
      visibility?.disconnect();
      resize?.disconnect();
      document.removeEventListener('visibilitychange', updateView);
      window.removeEventListener('scroll', collapse);
      window.removeEventListener('resize', collapse);
    },
  };
}
