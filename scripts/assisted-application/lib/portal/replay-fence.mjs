/** Network fence for a public, read-only portal replay. */
import { resolvesToPublicHost } from '../../../../functions/src/assistedApplicationAiJob.js';

const REPLAY_ALLOWED_METHODS = Object.freeze(['GET', 'HEAD', 'OPTIONS']);
const isReplayAllowedMethod = (method) => REPLAY_ALLOWED_METHODS.includes(String(method || '').toUpperCase());

const MUTATING_PATH_RE = /(?:submit|finali[sz]e|withdraw|delete|remove|cancelapplication|applicationapply|apply(?:now|application|candidate|[_-]now|[_-]application|[_-]candidate)|(?:^|[\/_-])cancel(?:$|[\/_-]))/i;
const MUTATING_ROUTE_RE = /(?:^|\/)(?:application)?save(?:\/|$)/i;
const MUTATING_QUERY_KEY_RE = /^(?:action|cmd|command|do|intent|operation|task|submit|send|save|withdraw|delete|remove|cancel)$/i;

/** A GET whose URL describes an application mutation is never a passive read. */
export function isMutatingGetUrl(value) {
  let url;
  try { url = value instanceof URL ? value : new URL(String(value || '')); }
  catch { return true; }

  let pathname = url.pathname;
  try {
    for (let round = 0; round < 5; round += 1) {
      const decoded = decodeURIComponent(pathname).replace(/\\/g, '/');
      if (decoded === pathname) break;
      pathname = decoded;
    }
  } catch {
    return true;
  }
  if (/%[0-9a-f]{2}/i.test(pathname)) return true;

  return MUTATING_PATH_RE.test(pathname)
    || MUTATING_ROUTE_RE.test(pathname)
    || [...url.searchParams.keys()].some((key) => MUTATING_QUERY_KEY_RE.test(key));
}

function disableAlternateTransports() {
  for (const name of ['WebTransport', 'Worker', 'SharedWorker', 'RTCPeerConnection', 'webkitRTCPeerConnection']) {
    Object.defineProperty(globalThis, name, { value: undefined, configurable: false, writable: false });
  }
}

/**
 * Installs the replay fence before the first page is created. The browser may
 * read a public cross-origin ATS, but every request is DNS-checked and only
 * GET/HEAD/OPTIONS can continue. A caller can inject the resolver in tests.
 */
export async function installPortalReplayFence(context, {
  isPublicHost = resolvesToPublicHost,
  onBlocked = () => {},
} = {}) {
  if (!context || typeof context.route !== 'function' || typeof context.routeWebSocket !== 'function'
    || typeof context.addInitScript !== 'function' || typeof context.on !== 'function') {
    throw new Error('portal_replay_fence_unavailable');
  }

  const metrics = {
    blockedRequests: 0,
    blockedNonGet: 0,
    blockedMutationGets: 0,
    blockedUnsafeHosts: 0,
    blockedWebSockets: 0,
    unexpectedNonGetPassed: 0,
    finalClickAttempts: 0,
  };

  await context.routeWebSocket('**/*', (socket) => {
    metrics.blockedWebSockets += 1;
    onBlocked({ method: 'WEBSOCKET', reason: 'websocket' });
    socket.close();
  });
  await context.addInitScript(disableAlternateTransports);
  context.on('response', (response) => {
    try {
      if (!isReplayAllowedMethod(response.request().method())) {
        metrics.unexpectedNonGetPassed += 1;
      }
    } catch {
      metrics.unexpectedNonGetPassed += 1;
    }
  });

  await context.route('**/*', async (route) => {
    const request = route.request();
    const method = String(request.method() || '').toUpperCase();
    let url;
    try { url = new URL(request.url()); }
    catch {
      metrics.blockedRequests += 1;
      onBlocked({ method, reason: 'invalid_url' });
      return route.abort();
    }

    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      metrics.blockedRequests += 1;
      onBlocked({ method, reason: 'unsafe_url' });
      return route.abort();
    }
    if (!isReplayAllowedMethod(method)) {
      metrics.blockedRequests += 1;
      metrics.blockedNonGet += 1;
      onBlocked({ method, reason: 'non_get' });
      return route.abort();
    }
    if (method === 'GET' && isMutatingGetUrl(url)) {
      metrics.blockedRequests += 1;
      metrics.blockedMutationGets += 1;
      onBlocked({ method, reason: 'mutating_get' });
      return route.abort();
    }

    let publicHost = false;
    try { publicHost = await isPublicHost(url.href); } catch { publicHost = false; }
    if (!publicHost) {
      metrics.blockedRequests += 1;
      metrics.blockedUnsafeHosts += 1;
      onBlocked({ method, reason: 'unsafe_host' });
      return route.abort();
    }
    return route.continue();
  });

  return metrics;
}

/** Prevent runner-added route handlers from bypassing the installed fence with route.fetch(). */
export function sealPortalReplayContext(context, { firstNavigationUrl = '' } = {}) {
  if (!context || typeof context.route !== 'function') throw new Error('portal_replay_fence_unavailable');
  const sealRouteMutationMethods = (target, names) => {
    for (const name of names) {
      if (typeof target?.[name] !== 'function') continue;
      Object.defineProperty(target, name, { configurable: false, writable: false, value: async () => {} });
    }
  };
  sealRouteMutationMethods(context, ['route', 'routeFromHAR', 'routeWebSocket', 'unroute', 'unrouteAll']);
  if (typeof context.on === 'function') {
    context.on('page', (page) => sealRouteMutationMethods(page, ['route', 'routeFromHAR', 'routeWebSocket', 'unroute', 'unrouteAll']));
  }
  return new Proxy(context, {
    get(target, property) {
      if (['route', 'routeFromHAR', 'routeWebSocket', 'unroute', 'unrouteAll'].includes(property)
        && Object.getOwnPropertyDescriptor(target, property)?.configurable === false) {
        // Proxy invariants require the exact value of non-configurable own
        // methods; the methods were already replaced with sealed no-ops.
        return Reflect.get(target, property, target);
      }
      if (property === 'newPage') return async (...args) => {
        const page = await target.newPage(...args);
        if (firstNavigationUrl && typeof page?.goto === 'function') {
          const originalGoto = page.goto.bind(page);
          let firstNavigation = true;
          page.goto = (url, options) => {
            if (firstNavigation) {
              firstNavigation = false;
              return originalGoto(firstNavigationUrl, options);
            }
            return originalGoto(url, options);
          };
        }
        return page;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
