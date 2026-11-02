/** Static HTML's viewport/width scheduler. Functions are passed by the emitter
 * so this controller can be serialized without a runtime module dependency. */
export function createStaticAdDelivery(
  requests: { request: (el: HTMLElement) => { state: string; width: number; minimum: number; code?: string; errorName?: string } },
  eligibility: { park: (els: Element[], target: (el: Element) => boolean) => Element[]; activate: (el: Element) => boolean; defer: (el: Element) => void },
  watch: (el: Element) => { request: () => void; fail: (reason: string) => void } | null,
  isTarget: (el: Element) => boolean,
  emit: (event: string, data: Record<string, string | number>) => void,
  margin: string,
) {
  let io: IntersectionObserver | null = null;
  let resize: ResizeObserver | null = null;
  let slots: Element[] = [];
  let near = new Set<Element>();
  const reported = new WeakSet<Element>();
  let frame: number | undefined;
  const push = (element: Element) => {
    if (!near.has(element) || !eligibility.activate(element)) return;
    const el = element as HTMLElement;
    const result = requests.request(el);
    if (result.state === 'waiting_width') {
      eligibility.defer(el);
      el.setAttribute('data-ft-ad-width-wait', 'pending');
      if (!reported.has(el)) {
        reported.add(el);
        emit('ad_slot_waiting_width', { slot: el.getAttribute('data-ad-slot') || '', width: result.width, minimum_width: result.minimum, render_path: 'static' });
      }
      return;
    }
    el.removeAttribute('data-ft-ad-width-wait');
    io?.unobserve(el); resize?.unobserve(el);
    near.delete(el);
    slots = slots.filter((slot) => slot !== el);
    if (slots.length === 0) { io?.disconnect(); resize?.disconnect(); }
    if (result.state === 'failed') {
      emit('ad_slot_error', { slot: el.getAttribute('data-ad-slot') || '', reason: result.code || 'unknown', error_name: result.errorName || 'Error', width: result.width, minimum_width: result.minimum, render_path: 'static' });
      watch(el)?.fail('push_failed');
    } else watch(el)?.request();
  };
  const retry = () => {
    if (frame !== undefined) return;
    frame = requestAnimationFrame(() => { frame = undefined; for (const el of near) push(el); });
  };
  const arm = () => {
    io?.disconnect(); resize?.disconnect();
    near = new Set();
    slots = eligibility.park(Array.from(document.querySelectorAll('ins[data-ad-slot]')), isTarget);
    resize = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(retry) : null;
    io = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.isIntersecting && slots.includes(entry.target)) {
        near.add(entry.target); push(entry.target);
      }
    }, { rootMargin: margin }) : null;
    for (const el of slots) {
      watch(el);
      resize?.observe(el);
      if (io) io.observe(el);
      else { near.add(el); push(el); }
    }
  };
  window.addEventListener('resize', retry);
  return { arm };
}
