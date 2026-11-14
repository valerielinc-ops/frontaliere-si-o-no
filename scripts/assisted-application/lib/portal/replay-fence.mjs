/** Network fence for a public, read-only portal replay. */
import { resolvesToPublicHost } from '../../../../functions/src/assistedApplicationAiJob.js';
import { lookup } from 'node:dns/promises';
import { createServer } from 'node:http';
import { connect as connectSocket } from 'node:net';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { isFetchablePublicUrl, isPrivateAddress } from '../../../../functions/src/assistedApplicationAiJob.js';

const REPLAY_ALLOWED_METHODS = Object.freeze(['GET', 'HEAD', 'OPTIONS']);
const isReplayAllowedMethod = (method) => REPLAY_ALLOWED_METHODS.includes(String(method || '').toUpperCase());

const MUTATING_PATH_RE = /(?:submit|finali[sz]e|withdraw|delete|remove|update|autosave|auto[_-]?save|mutate|persist|insert|upsert|cancelapplication|applicationapply|apply(?:now|application|candidate|[_-]now|[_-]application|[_-]candidate)|(?:^|[\/_-])cancel(?:$|[\/_-]))/i;
const MUTATING_ROUTE_RE = /(?:^|\/)(?:application)?save(?:\/|$)/i;
const MUTATING_QUERY_KEY_RE = /^(?:action|cmd|command|do|intent|operation|task|submit|send|save|withdraw|delete|remove|update|cancel|email|e-?mail|mail|phone|telephone|tel|mobile|name|full_?name|given_?name|middle_?name|family_?name|sur_?name|first_?name|last_?name|candidate(?:_?id)?|applicant(?:_?id)?|resume|cv|profile(?:_?id)?|application(?:_?id)?|user(?:_?id)?|person(?:_?id)?|contact(?:_?id)?|data|payload|content|fields?|form|values?|variables?|params?|body|json|formdata|answers?|birthdate|date_?of_?birth|dob|nationality|permit|work_?permit|salary|address|city|postal_?code)$/i;
const MUTATING_QUERY_KEY_PREFIX_RE = /^(?:candidate|applicant|profile|application|user|person|contact|resume|cv|email|e-?mail|mail|phone|telephone|tel(?:phone|_?number|_?no|_?nr)|mobile|address|birth|nationality|permit|salary)/i;
const CANDIDATE_DATA_ROUTE_RE = /(?:^|\/)(?:apply|application|applications|candidate|candidates|applicant|applicants|profile|resume|cv)(?:\/|$)/i;
const SAFE_NAVIGATION_QUERY_KEY_RE = /^(?:id|lang(?:uage)?|locale|design|theme|view|tab|step|job(?:_?id)?|requisition(?:_?id)?|req_?id|vacancy_?id|posting_?id|position_?id)$/i;
const SAFE_LANGUAGE_CODES = new Set(['ar', 'bg', 'ca', 'cs', 'da', 'de', 'el', 'en', 'es', 'et', 'fi', 'fr', 'he', 'hr', 'hu', 'id', 'it', 'ja', 'ko', 'lt', 'lv', 'nb', 'nl', 'no', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sr', 'sv', 'th', 'tr', 'uk', 'vi', 'zh']);
const SAFE_THEME_VALUES = new Set(['belize', 'default', 'fiori', 'fiori_3', 'horizon', 'quartz', 'sap_fiori_3', 'sap_horizon', 'standard']);
const SAFE_VIEW_VALUES = new Set(['application', 'card', 'detail', 'grid', 'job', 'jobs', 'list', 'map', 'overview', 'posting', 'search', 'table']);
const SAFE_TAB_VALUES = new Set(['application', 'details', 'documents', 'job', 'jobs', 'search']);
const SAFE_STEP_VALUES = new Set(['account', 'application', 'details', 'documents', 'review', 'start']);
const SAFE_JOB_ID_VALUE_RE = /^(?:\d{1,20}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|(?=[a-z0-9_-]{2,64}$)(?=.*\d)[a-z0-9]+(?:[-_][a-z0-9]+)*)$/i;

function decodedQueryKey(value) {
  let key = String(value || '');
  try {
    for (let round = 0; round < 5; round += 1) {
      const decoded = decodeURIComponent(key.replace(/\+/g, ' '));
      if (decoded === key) break;
      key = decoded;
    }
  } catch {
    return '';
  }
  if (/%[0-9a-f]{2}/i.test(key)) return '';
  return key;
}

function hasMutatingQueryKeySegment(value) {
  const decoded = decodedQueryKey(value);
  if (!decoded) return true;
  return decoded.split(/[.[\]]+/u).filter(Boolean).some((segment) =>
    MUTATING_QUERY_KEY_RE.test(segment) || MUTATING_QUERY_KEY_PREFIX_RE.test(segment));
}

const POSTING_QUERY_KEYS = new Set(['id', 'job', 'jobid', 'requisition', 'requisitionid', 'reqid', 'vacancyid', 'postingid', 'positionid']);
const normalizeNavigationQueryKey = (value) => String(value || '').toLowerCase().replace(/[-_]/g, '');
const postingQueryPair = (origin, key, value) => JSON.stringify([String(origin || '').toLowerCase(), normalizeNavigationQueryKey(key), String(value || '')]);

/** Capture only job identifiers already present in the sampled public listing/apply URLs. */
export function portalReplayQueryAllowlist(values = []) {
  const allowed = new Set();
  for (const value of values) {
    let url;
    try { url = value instanceof URL ? value : new URL(String(value || '')); }
    catch { continue; }
    if (url.protocol !== 'https:' || url.username || url.password) continue;
    for (const [rawKey, queryValue] of url.searchParams.entries()) {
      const key = decodedQueryKey(rawKey);
      const normalizedKey = normalizeNavigationQueryKey(key);
      if (POSTING_QUERY_KEYS.has(normalizedKey) && SAFE_JOB_ID_VALUE_RE.test(queryValue)) {
        allowed.add(postingQueryPair(url.origin, key, queryValue));
      }
    }
  }
  return allowed;
}

function safeNavigationQueryValue(url, key, value, allowedPostingQueryParams) {
  const normalizedKey = String(key || '').toLowerCase().replace(/[-_]/g, '');
  const normalizedValue = String(value || '').trim();
  if (['lang', 'language', 'locale'].includes(normalizedKey)) {
    const parts = normalizedValue.toLowerCase().replace(/_/g, '-').split('-');
    return SAFE_LANGUAGE_CODES.has(parts[0]) && parts.slice(1).every((part) => /^[a-z0-9]{2,8}$/i.test(part));
  }
  if (['id', 'job', 'jobid', 'requisition', 'requisitionid', 'reqid', 'vacancyid', 'postingid', 'positionid'].includes(normalizedKey)) {
    return SAFE_JOB_ID_VALUE_RE.test(normalizedValue)
      && allowedPostingQueryParams?.has(postingQueryPair(url.origin, key, value)) === true;
  }
  if (normalizedKey === 'design') return /^\d{1,6}$/.test(normalizedValue) || SAFE_THEME_VALUES.has(normalizedValue.toLowerCase());
  if (normalizedKey === 'theme') return SAFE_THEME_VALUES.has(normalizedValue.toLowerCase());
  if (normalizedKey === 'view') return SAFE_VIEW_VALUES.has(normalizedValue.toLowerCase());
  if (normalizedKey === 'tab') return /^\d{1,2}$/.test(normalizedValue) || SAFE_TAB_VALUES.has(normalizedValue.toLowerCase());
  if (normalizedKey === 'step') return /^\d{1,3}$/.test(normalizedValue) || SAFE_STEP_VALUES.has(normalizedValue.toLowerCase());
  return false;
}

/** A GET whose URL describes an application mutation is never a passive read. */
export function isMutatingGetUrl(value, { allowedPostingQueryParams = new Set() } = {}) {
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

  const queryEntries = [...url.searchParams.entries()].map(([key, queryValue]) => ({
    key: decodedQueryKey(key),
    mutating: hasMutatingQueryKeySegment(key),
    rawKey: key,
    value: String(queryValue || ''),
  }));
  const unsafePostingIdentityQuery = queryEntries.some(({ key, value }) =>
    POSTING_QUERY_KEYS.has(normalizeNavigationQueryKey(key))
      && !safeNavigationQueryValue(url, key, value, allowedPostingQueryParams));
  const candidateDataRouteHasUnsafeQuery = url.search !== '' && CANDIDATE_DATA_ROUTE_RE.test(pathname)
    && queryEntries.some(({ key, rawKey, value }) => !key || !SAFE_NAVIGATION_QUERY_KEY_RE.test(key)
      || !safeNavigationQueryValue(url, key, value, allowedPostingQueryParams));
  return MUTATING_PATH_RE.test(pathname)
    || MUTATING_ROUTE_RE.test(pathname)
    || unsafePostingIdentityQuery
    || candidateDataRouteHasUnsafeQuery
    || queryEntries.some(({ key, mutating }) => !key || mutating);
}

/**
 * Deny Node-side egress while PR runner modules execute. The trusted caller
 * creates the pinned browser proxy and Chromium first, then permits only the
 * Codex broker's exact Unix socket for the runner's agent calls.
 */
export function installPortalReplayNodeEgressFence({ allowedUnixSocket = '', onBlocked = () => {} } = {}) {
  if (!allowedUnixSocket || !String(allowedUnixSocket).startsWith('/')) throw new Error('portal_replay_broker_socket_required');
  const require = createRequire(import.meta.url);
  const net = require('node:net');
  const http = require('node:http');
  const https = require('node:https');
  const tls = require('node:tls');
  const http2 = require('node:http2');
  const dgram = require('node:dgram');
  const dns = require('node:dns');
  const dnsPromises = require('node:dns/promises');
  const childProcess = require('node:child_process');
  const workerThreads = require('node:worker_threads');
  const inspector = require('node:inspector');
  const originals = [];
  const trustedSocketConnect = net.Socket.prototype.connect;
  const metrics = { blockedAttempts: 0 };
  const blocked = (api) => {
    metrics.blockedAttempts += 1;
    try { onBlocked({ api, reason: 'node_egress' }); } catch { /* metrics stay fail-closed */ }
    return Object.assign(new Error('portal_replay_node_egress_blocked'), { code: 'portal_replay_node_egress_blocked' });
  };
  const loopbackOnlyLookup = (original, api) => function guardedPortalReplayLookup(...args) {
    const hostname = String(args[0] || '').replace(/^\[|\]$/gu, '').toLowerCase();
    if (hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost') return original.apply(this, args);
    throw blocked(api);
  };
  const replace = (target, key, value) => {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    originals.push({ target, key, descriptor, value: target[key] });
    Object.defineProperty(target, key, { configurable: true, enumerable: descriptor?.enumerable ?? true, writable: true, value });
  };
  const deny = (api) => function deniedPortalReplayEgress() { throw blocked(api); };
  const socketOptions = (args) => {
    const first = args[0];
    return first && typeof first === 'object'
      ? first
      : typeof first === 'string' ? { path: first } : args[1] && typeof args[1] === 'object' ? args[1] : {};
  };
  const connectBrokerSocket = (receiver, args) => {
    const socket = receiver instanceof net.Socket ? receiver : new net.Socket();
    const listener = args.find((argument) => typeof argument === 'function');
    if (listener) socket.once('connect', listener);
    return trustedSocketConnect.call(socket, { path: allowedUnixSocket });
  };
  const denyConnect = (api) => function guardedPortalReplayConnect(...args) {
    const options = socketOptions(args);
    if (options.path === allowedUnixSocket && options.port === undefined && options.host === undefined) return connectBrokerSocket(this, args);
    throw blocked(api);
  };

  for (const [target, key, api, replacement] of [
    [http, 'request', 'http.request'], [http, 'get', 'http.get'],
    [https, 'request', 'https.request'], [https, 'get', 'https.get'],
    [tls, 'connect', 'tls.connect'],
    [http2, 'connect', 'http2.connect'], [dgram, 'createSocket', 'dgram.createSocket'],
    [inspector, 'open', 'inspector.open'],
    [dns, 'lookup', 'dns.lookup', loopbackOnlyLookup(dns.lookup, 'dns.lookup')], [dns, 'lookupService', 'dns.lookupService'],
    [dns, 'resolve', 'dns.resolve'], [dns, 'resolve4', 'dns.resolve4'], [dns, 'resolve6', 'dns.resolve6'],
    [dns, 'resolveAny', 'dns.resolveAny'], [dns, 'resolveCaa', 'dns.resolveCaa'], [dns, 'resolveCname', 'dns.resolveCname'],
    [dns, 'resolveMx', 'dns.resolveMx'], [dns, 'resolveNaptr', 'dns.resolveNaptr'], [dns, 'resolveNs', 'dns.resolveNs'],
    [dns, 'resolvePtr', 'dns.resolvePtr'], [dns, 'resolveSoa', 'dns.resolveSoa'], [dns, 'resolveSrv', 'dns.resolveSrv'],
    [dns, 'resolveTxt', 'dns.resolveTxt'], [dns, 'reverse', 'dns.reverse'],
    [dnsPromises, 'lookup', 'dns.promises.lookup', loopbackOnlyLookup(dnsPromises.lookup, 'dns.promises.lookup')], [dnsPromises, 'lookupService', 'dns.promises.lookupService'],
    [dnsPromises, 'resolve', 'dns.promises.resolve'], [dnsPromises, 'resolve4', 'dns.promises.resolve4'],
    [dnsPromises, 'resolve6', 'dns.promises.resolve6'], [dnsPromises, 'resolveAny', 'dns.promises.resolveAny'],
    [dnsPromises, 'resolveCaa', 'dns.promises.resolveCaa'], [dnsPromises, 'resolveCname', 'dns.promises.resolveCname'],
    [dnsPromises, 'resolveMx', 'dns.promises.resolveMx'], [dnsPromises, 'resolveNaptr', 'dns.promises.resolveNaptr'],
    [dnsPromises, 'resolveNs', 'dns.promises.resolveNs'], [dnsPromises, 'resolvePtr', 'dns.promises.resolvePtr'],
    [dnsPromises, 'resolveSoa', 'dns.promises.resolveSoa'], [dnsPromises, 'resolveSrv', 'dns.promises.resolveSrv'],
    [dnsPromises, 'resolveTxt', 'dns.promises.resolveTxt'], [dnsPromises, 'reverse', 'dns.promises.reverse'],
  ]) {
    if (typeof target[key] === 'function') replace(target, key, replacement || deny(api));
  }
  replace(net, 'connect', denyConnect('net.connect'));
  replace(net, 'createConnection', denyConnect('net.createConnection'));
  replace(net.Socket.prototype, 'connect', denyConnect('net.Socket.prototype.connect'));
  for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    if (typeof childProcess[key] === 'function') replace(childProcess, key, deny(`child_process.${key}`));
  }
  if (typeof workerThreads.Worker === 'function') replace(workerThreads, 'Worker', deny('worker_threads.Worker'));
  if (typeof globalThis.fetch === 'function') replace(globalThis, 'fetch', (...args) => Promise.reject(blocked('fetch')));
  if (typeof globalThis.WebSocket === 'function') replace(globalThis, 'WebSocket', deny('WebSocket'));
  syncBuiltinESMExports();

  let restored = false;
  return {
    metrics,
    restore() {
      if (restored) return;
      restored = true;
      for (const item of originals.reverse()) {
        if (item.descriptor) Object.defineProperty(item.target, item.key, item.descriptor);
        else Object.defineProperty(item.target, item.key, { configurable: true, writable: true, value: item.value });
      }
      syncBuiltinESMExports();
    },
  };
}

/**
 * A CONNECT proxy that connects to the public IP it just validated. Chromium
 * keeps the original host for TLS/SNI, while DNS rebinding cannot change the
 * address used by the socket after validation.
 */
export async function createPinnedPublicHttpsProxy({
  resolve = lookup,
  isPublicUrl = isFetchablePublicUrl,
  isPrivate = isPrivateAddress,
  connect = connectSocket,
  onBlocked = () => {},
} = {}) {
  const sockets = new Set();
  const server = createServer((_request, response) => {
    response.writeHead(405, { connection: 'close' });
    response.end();
  });
  server.on('connect', (request, client, head) => {
    sockets.add(client);
    client.once('close', () => sockets.delete(client));
    void (async () => {
      let upstream;
      try {
        const target = new URL(`https://${String(request.url || '')}`);
        if (target.protocol !== 'https:' || target.username || target.password || target.port && target.port !== '443'
          || !await isPublicUrl(`https://${target.hostname}/`)) throw new Error('unsafe_target');
        const addresses = await resolve(target.hostname, { all: true, verbatim: true });
        if (!Array.isArray(addresses) || !addresses.length
          || addresses.some((entry) => !entry?.address || isPrivate(entry.address))) throw new Error('unsafe_address');
        const pinned = addresses[0];
        upstream = connect({ host: pinned.address, family: pinned.family, port: 443 });
        sockets.add(upstream);
        upstream.once('close', () => sockets.delete(upstream));
        upstream.once('connect', () => {
          if (client.destroyed) return upstream.destroy();
          client.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: portal-replay\r\n\r\n');
          if (head?.length) upstream.write(head);
          client.pipe(upstream);
          upstream.pipe(client);
        });
        upstream.once('error', () => {
          onBlocked({ method: 'CONNECT', reason: 'upstream_error' });
          if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
        });
        client.once('error', () => upstream.destroy());
        client.once('close', () => upstream.destroy());
      } catch {
        onBlocked({ method: 'CONNECT', reason: 'unsafe_host' });
        if (!client.destroyed) client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        upstream?.destroy();
      }
    })();
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise((resolveServer, rejectServer) => {
    server.once('error', rejectServer);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', rejectServer);
      resolveServer();
    });
  });
  const address = server.address();
  return {
    server: `http://127.0.0.1:${address.port}`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise((resolveClose) => server.close(resolveClose));
    },
  };
}

function disableAlternateTransports() {
  for (const name of ['WebTransport', 'Worker', 'SharedWorker', 'RTCPeerConnection', 'webkitRTCPeerConnection']) {
    Object.defineProperty(globalThis, name, { value: undefined, configurable: false, writable: false });
  }
}

/** Trusted in-page capture for final application clicks; it blocks before portal handlers run. */
export function capturePortalReplayFinalClicksInPage() {
  const document = globalThis.document;
  const view = document?.defaultView || globalThis.window;
  if (!document || !view || view.__frontalierePortalReplayFinalClickCapture) return;
  Object.defineProperty(view, '__frontalierePortalReplayFinalClickCapture', { value: true });
  const finalLabel = /(?:submit(?: application)?|^send$|send (?:my )?application|apply now|^apply(?:\s+for\s+(?:this|the)\s+(?:job|position|role))?$|confirm and (?:apply|send|submit)|absenden|abschicken|bewerbung (?:absenden|senden|abschicken|einreichen)|jetzt bewerben|^bewerben$|invia(?: la)? candidatura|candidati ora|^candidati$|^applica$|envoyer(?: ma)? candidature|^envoyer$|postuler|soumettre)/i;
  const notFinalLabel = /^(?:next|continue|proceed|sign in|log in|login|register|create account|verify|accept|reject|save preferences|cookie preferences)$/i;
  const pending = new WeakSet();
  const compact = (value) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  const labelOf = (node) => compact(node?.getAttribute?.('aria-label') || node?.getAttribute?.('title')
    || node?.value || node?.innerText || node?.textContent || '');
  const ownerOf = (node) => node?.form || node?.closest?.('form') || null;
  const isFinalControl = (node, owner) => {
    if (!node || owner?.querySelector?.('input[type="password"], input[autocomplete="current-password"], input[autocomplete="new-password"]')) return false;
    const label = labelOf(node);
    if (!label || notFinalLabel.test(label) || !finalLabel.test(label)) return false;
    const fields = [...(owner?.querySelectorAll?.('input, textarea, select') || document.querySelectorAll('input, textarea, select'))];
    if (fields.some((field) => String(field.type || '').toLowerCase() === 'search'
      || /^(?:search|query)$/i.test(String(field.name || field.id || '').trim()))) return false;
    const candidateFields = fields.filter((field) => /(?:e-?mail|first.?name|last.?name|phone|mobile|resume|curriculum|cover.?letter|candidate|applicant|work.?permit|salary|address)/i
      .test([field.name, field.id, field.getAttribute?.('autocomplete'), field.getAttribute?.('aria-label'), field.getAttribute?.('placeholder')].filter(Boolean).join(' ')));
    const formMarker = /(?:application|candidate|applicant|resume|curriculum|bewerbung|candidature|candidatura)/i
      .test([owner?.name, owner?.id, owner?.getAttribute?.('aria-label'), owner?.getAttribute?.('data-testid')].filter(Boolean).join(' '));
    return candidateFields.length > 0 && (Boolean(owner) || candidateFields.length >= 2) || (formMarker && fields.length >= 2);
  };
  const blockAndRecord = (event, node) => {
    if (pending.has(node)) return;
    pending.add(node);
    view.queueMicrotask(() => pending.delete(node));
    try { globalThis.__frontalierePortalReplayFinalClickAttempt?.(); } catch { /* a missing binding still blocks the click */ }
    event?.preventDefault?.();
    event?.stopPropagation?.();
    event?.stopImmediatePropagation?.();
  };
  document.addEventListener('click', (event) => {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
    const node = path.find((item) => item?.nodeType === 1 && item.matches?.('button, input[type="submit"], input[type="button"], [role="button"], a[href]'));
    const guarded = Object.values(view.__frontaliereFinalFormGuards || {}).find((state) => state?.button
      && (path.includes(state.button) || state.button.contains?.(event.target)));
    if (guarded) return blockAndRecord(event, guarded.button);
    if (isFinalControl(node, ownerOf(node))) blockAndRecord(event, node);
  }, true);
  document.addEventListener('submit', (event) => {
    const owner = event.target;
    const submitter = event.submitter || owner?.querySelector?.('button[type="submit"], input[type="submit"]');
    if (isFinalControl(submitter, owner)) blockAndRecord(event, submitter);
  }, true);
  const formPrototype = view.HTMLFormElement?.prototype;
  if (formPrototype && typeof formPrototype.submit === 'function') {
    const originalSubmit = formPrototype.submit;
    formPrototype.submit = function guardedReplaySubmit(...args) {
      const submitter = this.querySelector?.('button[type="submit"], input[type="submit"]');
      if (isFinalControl(submitter, this)) {
        blockAndRecord(null, submitter);
        return;
      }
      return originalSubmit.apply(this, args);
    };
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
  allowedPostingQueryParams = new Set(),
} = {}) {
  if (!context || typeof context.route !== 'function' || typeof context.routeWebSocket !== 'function'
    || typeof context.addInitScript !== 'function' || typeof context.exposeBinding !== 'function' || typeof context.on !== 'function') {
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
  await context.exposeBinding('__frontalierePortalReplayFinalClickAttempt', () => {
    metrics.finalClickAttempts += 1;
  });
  await context.addInitScript(disableAlternateTransports);
  await context.addInitScript(capturePortalReplayFinalClicksInPage);
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

    if (url.protocol !== 'https:' || url.username || url.password) {
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
    if (method === 'GET' && isMutatingGetUrl(url, { allowedPostingQueryParams })) {
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

/** Seal Playwright escape hatches and pin the runner's first navigation to the sampled listing. */
export function sealPortalReplayContext(context, { firstNavigationUrl = '' } = {}) {
  if (!context || typeof context.route !== 'function') throw new Error('portal_replay_fence_unavailable');
  let safeContext;
  let firstNavigationPending = Boolean(firstNavigationUrl);
  const wrapFrame = (frame) => {
    if (!frame || typeof frame !== 'object') return frame;
    return new Proxy(frame, {
      get(target, property) {
        if (property === 'page') return () => wrapPage(target.page());
        if (property === 'parentFrame') return () => wrapFrame(target.parentFrame());
        if (property === 'childFrames') return () => target.childFrames().map(wrapFrame);
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  const wrapPage = (page) => {
    if (!page || typeof page !== 'object') return page;
    return new Proxy(page, {
      get(target, property) {
        if (['route', 'routeFromHAR', 'routeWebSocket', 'unroute', 'unrouteAll', 'off', 'removeListener', 'removeAllListeners'].includes(property)) {
          return async () => {};
        }
        if (property === 'context') return () => safeContext;
        if (property === 'opener') return () => target.opener().then(wrapPage);
        if (property === 'frames') return () => target.frames().map(wrapFrame);
        if (property === 'mainFrame') return () => wrapFrame(target.mainFrame());
        if (property === 'frame') return (...args) => wrapFrame(target.frame(...args));
        if (property === 'on') return (event, listener) => target.on(event, (...args) => listener(...args.map((item) => event === 'popup' ? wrapPage(item) : item)));
        if (property === 'waitForEvent') return (...args) => target.waitForEvent(...args).then((item) => args[0] === 'popup' ? wrapPage(item) : item);
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  safeContext = new Proxy(context, {
    get(target, property) {
      if (property === 'request' || property === 'browser' || property === 'newCDPSession') return undefined;
      if (['route', 'routeFromHAR', 'routeWebSocket', 'unroute', 'unrouteAll', 'off', 'removeListener', 'removeAllListeners'].includes(property)) {
        return async () => {};
      }
      if (property === 'newPage') return async (...args) => {
        const page = await target.newPage(...args);
        if (firstNavigationUrl && typeof page?.goto === 'function') {
          const originalGoto = page.goto.bind(page);
          page.goto = (url, options) => {
            if (firstNavigationPending) {
              firstNavigationPending = false;
              return originalGoto(firstNavigationUrl, options);
            }
            return originalGoto(url, options);
          };
        }
        return wrapPage(page);
      };
      if (property === 'pages') return (...args) => target.pages(...args).map(wrapPage);
      if (property === 'on') return (event, listener) => target.on(event, (...args) => listener(...args.map((item) => event === 'page' ? wrapPage(item) : item)));
      if (property === 'waitForEvent') return (...args) => target.waitForEvent(...args).then((item) => args[0] === 'page' ? wrapPage(item) : item);
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return safeContext;
}
