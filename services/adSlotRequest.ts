/** Shared by React and the serialized static loader. Never push an undersized
 * slot: AdSense selects the first eligible ins in DOM order, not by slot ID. */
export function createAdSlotRequests(): {
  request: (el: HTMLElement) => { state: 'processed' | 'waiting_width' | 'requested' | 'failed'; width: number; minimum: number; code?: string; errorName?: string };
  geometry: (el: HTMLElement) => { width: number; minimum: number };
  processed: (el: Element) => boolean;
} {
  const host = window as Window & { __ftAdRequests?: ReturnType<typeof createAdSlotRequests>; adsbygoogle?: Array<Record<string, unknown>> };
  if (host.__ftAdRequests) return host.__ftAdRequests;
  const requested = new WeakSet<Element>();
  const processed = (el: Element) => requested.has(el) || el.hasAttribute('data-ft-ad-requested') || el.hasAttribute('data-adsbygoogle-status');
  const geometry = (el: HTMLElement) => {
    const parent = el.parentElement;
    const style = parent ? getComputedStyle(parent) : null;
    const parentWidth = parent ? parent.getBoundingClientRect().width - (parseFloat(style?.paddingLeft || '') || 0) - (parseFloat(style?.paddingRight || '') || 0) - (parseFloat(style?.borderLeftWidth || '') || 0) - (parseFloat(style?.borderRightWidth || '') || 0) : 0;
    const width = Math.min(el.getBoundingClientRect().width, parentWidth);
    const minimum = el.getAttribute('data-ad-layout') === 'in-article' ? 250 : 1;
    return { width: Math.max(0, Math.floor(width)), minimum };
  };
  const request = (el: HTMLElement) => {
    if (processed(el)) return { state: 'processed' as const, ...geometry(el) };
    const size = geometry(el);
    if (!el.isConnected || size.width < size.minimum) {
      el.classList.remove('adsbygoogle');
      return { state: 'waiting_width' as const, ...size };
    }
    el.classList.add('adsbygoogle');
    try {
      (host.adsbygoogle = host.adsbygoogle || []).push({});
      requested.add(el);
      el.setAttribute('data-ft-ad-requested', '');
      return { state: 'requested' as const, ...size };
    } catch (error) {
      // Do not leave a failed slot ahead of valid ones in Google's DOM queue.
      // A processed element may already own a request; never retry that node.
      if (processed(el)) return { state: 'processed' as const, ...size };
      el.classList.remove('adsbygoogle');
      const message = error instanceof Error ? error.message : '';
      const code = /width|size|availableWidth|container/i.test(message) ? 'invalid_size'
        : /already|filled|done|push.*all/i.test(message) ? 'duplicate_request'
        : /slot|format|layout|client/i.test(message) ? 'invalid_configuration' : 'unknown';
      return { state: 'failed' as const, code, errorName: error instanceof Error && /^[A-Za-z]{1,32}$/.test(error.name) ? error.name : 'Error', ...size };
    }
  };
  const api = { request, geometry, processed };
  host.__ftAdRequests = api;
  return api;
}
