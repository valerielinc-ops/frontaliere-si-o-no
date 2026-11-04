/** One bounded loader per Google library, shared across static HTML and React.
 * Serialized at build time; keep this function dependency-free. */
export function createAdScriptLoader(
  kind: 'adsense' | 'gpt' | 'cmp',
  src: string,
  canLoad: () => boolean,
  emit: (event: string, props: Record<string, string | number>) => void,
) {
  // Let genuinely slow Google downloads complete, but do not leave a script
  // without load/error events latched in waiting_response for the whole page.
  const SCRIPT_HARD_TIMEOUT_MS = 30_000;
  type State = 'idle' | 'loading' | 'waiting_response' | 'loaded' | 'failed' | 'retry_wait';
  type Listener = (state: State) => void;
  type Loader = { load: () => void; subscribe: (listener: Listener) => () => void; state: () => State; attempts: () => number; dispose: () => void };
  const w = window as Window & { __ftAdLoaders?: Partial<Record<typeof kind, Loader>>; __ftAdBlock?: { blocked?: boolean; adsAllowed?: boolean }; __ftAdBlockProbe?: string; adsbygoogle?: { loaded?: boolean }; googletag?: { apiReady?: boolean }; googlefc?: { showRevocationMessage?: unknown } };
  const registry = w.__ftAdLoaders = w.__ftAdLoaders || {};
  if (registry[kind]) return registry[kind]!;
  let state: State = 'idle';
  let attempts = 0;
  let disposed = false;
  let script: HTMLScriptElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<Listener>();
  const ready = () => kind === 'adsense' ? w.adsbygoogle?.loaded === true : kind === 'gpt' ? w.googletag?.apiReady === true : typeof w.googlefc?.showRevocationMessage === 'function';
  const publish = (next: State, reason = '') => {
    if (state === next) return;
    state = next;
    script?.setAttribute('data-ft-script-state', state);
    emit('ad_script_state', { library: kind, state, attempt: attempts, reason });
    for (const listener of listeners) try { listener(state); } catch { /* detached consumer */ }
  };
  const blocked = () => (w.__ftAdBlock?.blocked === true || w.__ftAdBlockProbe === 'blocked') && w.__ftAdBlock?.adsAllowed !== true;
  const succeed = (element: HTMLScriptElement) => {
    if (disposed || element !== script) return;
    clearTimeout(timer); clearTimeout(retryTimer);
    element.setAttribute('data-loaded', '1');
    element.removeAttribute('data-failed');
    element.removeAttribute('data-gpt-load-failed');
    publish('loaded');
  };
  const fail = (element: HTMLScriptElement, reason: string) => {
    if (disposed || element !== script || state === 'loaded') return;
    if (ready()) { succeed(element); return; }
    clearTimeout(timer);
    element.setAttribute('data-failed', '1');
    if (kind === 'gpt') element.setAttribute('data-gpt-load-failed', 'true');
    // One initial attempt + two retries per document, including online events
    // and every mounted slot. A detected blocker never triggers a retry storm.
    if (attempts >= 3 || blocked() || navigator.onLine === false) { publish('failed', reason); return; }
    publish('retry_wait', reason);
    clearTimeout(retryTimer);
    retryTimer = setTimeout(load, attempts === 1 ? 2000 : 6000);
  };
  function load() {
    if (disposed || !canLoad()) return;
    // A document/shell reset can remove our tag before it finishes. Reuse the
    // same attempt budget, but do not keep a detached node as a permanent latch.
    if (script?.src && !script.isConnected && !ready()) {
      clearTimeout(timer); clearTimeout(retryTimer); script = null;
      publish('idle', 'script_removed');
    }
    if (state === 'loaded' || state === 'loading' || state === 'waiting_response') return;
    if (attempts > 0 && blocked()) { publish('failed', 'block_signal'); return; }
    if (attempts >= 3) { publish('failed', 'attempt_budget'); return; }
    if (navigator.onLine === false) return;
    clearTimeout(retryTimer);
    if (ready()) { publish('loaded'); return; }
    let existing = Array.from(document.scripts).find((el) => el.src.split('?')[0] === src.split('?')[0]);
    if (existing && (ready() || existing.getAttribute('data-loaded') === '1')) {
      script = existing; succeed(existing); return;
    }
    if (existing?.getAttribute('data-failed') === '1' || existing?.getAttribute('data-gpt-load-failed') === 'true') {
      if (attempts === 0) attempts = 1; // Count the failed HTML bootstrap too.
      if (blocked() || attempts >= 3) { script = existing; publish('failed', 'existing_load_error'); return; }
      existing.remove(); existing = undefined;
    }
    script = existing || document.createElement('script');
    const element = script;
    attempts++;
    publish('loading');
    element.addEventListener('load', () => succeed(element), { once: true });
    element.addEventListener('error', () => fail(element, 'load_error'), { once: true });
    timer = setTimeout(() => {
      if (disposed || element !== script || state === 'loaded') return;
      if (ready()) succeed(element);
      else {
        publish('waiting_response', 'load_timeout');
        timer = setTimeout(() => {
          if (disposed || element !== script || state !== 'waiting_response') return;
          if (ready()) succeed(element);
          else fail(element, 'load_timeout');
        }, SCRIPT_HARD_TIMEOUT_MS);
      }
    }, 12000);
    if (!existing) {
      element.src = src;
      element.async = true;
      // Funding Choices has no ACAO header. Adding crossOrigin kills the CMP.
      if (kind !== 'cmp') element.crossOrigin = 'anonymous';
      if (kind === 'adsense') {
        element.setAttribute('data-overlays', 'bottom');
        element.setAttribute('data-ad-frequency-hint', '60s');
      }
      if (kind === 'cmp') {
        element.setAttribute('data-fc-loader', '1');
        if (document.body && !document.querySelector('iframe[name="googlefcPresent"]')) {
          const signal = document.createElement('iframe'); signal.name = 'googlefcPresent';
          signal.style.cssText = 'display:none;width:0;height:0;border:none;'; document.body.appendChild(signal);
        }
      }
      document.head.appendChild(element);
    }
  }
  const api: Loader = {
    load,
    subscribe(listener) { listeners.add(listener); listener(state); return () => { listeners.delete(listener); }; },
    state: () => state,
    attempts: () => attempts,
    dispose() {
      disposed = true; clearTimeout(timer); clearTimeout(retryTimer); listeners.clear();
      window.removeEventListener('online', onOnline);
      if (registry[kind] === api) delete registry[kind];
    },
  };
  const onOnline = () => { if (state === 'failed' || state === 'retry_wait') load(); };
  registry[kind] = api;
  window.addEventListener('online', onOnline);
  return api;
}
