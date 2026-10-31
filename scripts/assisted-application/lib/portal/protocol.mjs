/** Primary portal metadata. Numeric path components never identify a job without this proof. */
export function readPortalProtocolInPage() {
  const meta = name => {
    const nodes = document.querySelectorAll(`meta[name="${name}"]`);
    return nodes.length === 1 ? String(nodes[0].getAttribute('content') || '').trim() : '';
  };
  const portalId = meta('avature.portal.id');
  const urlPath = meta('avature.portal.urlPath');
  const page = meta('avature.portal.page');
  const boot = document.querySelectorAll('portal-data#synapserBootstrap');
  if (!/^[1-9]\d{0,15}$/.test(portalId) || !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(urlPath)
    || !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(page) || boot.length !== 1) return null;
  const applicationName = boot[0].getAttribute('data-applicationName') || '';
  const applicationCode = boot[0].getAttribute('data-applicationCode') || '';
  if (applicationName !== 'customPortal' || applicationCode !== `customPortal_${portalId}`) return null;
  const namespace = `/${urlPath}`;
  if (location.protocol !== 'https:' || !location.pathname.startsWith(`${namespace}/`)
    || location.pathname.slice(namespace.length + 1).split('/')[0] !== page) return null;
  return { vendor: 'avature', portalId, namespace, page, origin: location.origin, path: location.pathname,
    quoted: { portalId, urlPath, page, applicationName, applicationCode } };
}

export function avatureProtocolMatches(protocol, value) {
  try {
    const url = new URL(value); const quote = protocol?.quoted;
    return Boolean(protocol?.vendor === 'avature' && /^[1-9]\d{0,15}$/.test(protocol.portalId)
      && /^\/[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(protocol.namespace) && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(protocol.page)
      && quote?.portalId === protocol.portalId && `/${quote.urlPath}` === protocol.namespace && quote.page === protocol.page
      && quote.applicationName === 'customPortal' && quote.applicationCode === `customPortal_${protocol.portalId}`
      && url.protocol === 'https:' && !url.username && !url.password && url.origin === protocol.origin && url.pathname === protocol.path
      && url.pathname.startsWith(`${protocol.namespace}/`) && url.pathname.slice(protocol.namespace.length + 1).split('/')[0] === protocol.page);
  } catch { return false; }
}

export function avaturePostingJobKey(value, protocol) {
  if (protocol?.page !== 'JobDetail' || !avatureProtocolMatches(protocol, value)) return null;
  const match = new RegExp(`^${protocol.namespace}/JobDetail/[^/]+/([1-9][0-9]{0,15})/?$`).exec(new URL(value).pathname);
  return match?.[1] || null;
}

export function avaturePortalDirectory(value, protocol) {
  try {
    const url = new URL(value);
    return avatureProtocolMatches(protocol, `${protocol.origin}${protocol.path}`) && url.origin === protocol.origin
      && url.pathname.startsWith(`${protocol.namespace}/`) ? `${protocol.namespace}/` : null;
  } catch { return null; }
}

export function sameAvaturePortal(source, current, url) {
  return avatureProtocolMatches(source, `${source?.origin}${source?.path}`) && avatureProtocolMatches(current, url)
    && source.portalId === current.portalId && source.namespace === current.namespace && source.origin === current.origin;
}

/** Scripts/resources in the public HTML are never run. Only our metadata reader is evaluated. */
export async function portalProtocolFromHtml(html, url) {
  const { JSDOM, VirtualConsole } = await import('jsdom');
  const dom = new JSDOM(String(html), { url, runScripts: 'outside-only', virtualConsole: new VirtualConsole() });
  try {
    const protocol = dom.window.eval(`(${readPortalProtocolInPage.toString()})()`);
    return protocol && avatureProtocolMatches(protocol, url) ? JSON.parse(JSON.stringify(protocol)) : null;
  } finally { dom.window.close(); }
}

/** One bounded GET of the candidate's original public posting, never an apply/commit route. */
export async function readPublicPortalProtocol(value, { fetchImpl, lookupImpl } = {}) {
  let policy; let response; let onAbort;
  const signal = AbortSignal.timeout(15_000);
  try {
    const url = new URL(value);
    // This shape only permits a public read. It grants no job identity: the
    // response must independently attest Avature, namespace and JobDetail.
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search
      || !/^\/[A-Za-z][A-Za-z0-9_-]{0,79}\/JobDetail\/[^/]+\/[1-9][0-9]{0,15}\/?$/.test(url.pathname)) return null;
    const { createSpecUrlPolicy, resolveProspectorFetch } = await import('../../../lib/prospector/public-fetch-policy.mjs');
    const resolve = lookupImpl || (await import('node:dns/promises')).lookup;
    let resolved;
    // The preflight and socket dispatcher share one DNS result. The existing
    // public-network policy validates every address; no second DNS lookup can
    // change the destination between approval and connection.
    policy = createSpecUrlPolicy({ seedUrls: [url.href] }, {
      lookupImpl: (host, options) => (resolved ||= new Promise((accept, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) return onAbort();
        Promise.resolve(resolve(host, options)).then(accept, reject);
      })),
    });
    await policy(url.href);
    signal.throwIfAborted();
    await new Promise((accept, reject) => policy.connectionLookup(url.hostname, { all: true }, (error, addresses) => error ? reject(error) : accept(addresses)));
    response = await resolveProspectorFetch(fetchImpl)(url.href, { method: 'GET', redirect: 'error', signal, dispatcher: policy.dispatcher, headers: { accept: 'text/html' } });
    if (response.status !== 200 || response.redirected || (response.url && response.url !== url.href)
      || !/text\/html/i.test(response.headers.get('content-type') || '') || Number(response.headers.get('content-length') || 0) > 524288) return null;
    const reader = response.body?.getReader();
    if (!reader) return null;
    const chunks = []; let bytes = 0;
    try {
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        bytes += chunk.byteLength;
        if (bytes > 524288) { await reader.cancel(); return null; }
        chunks.push(Buffer.from(chunk));
      }
    } finally { reader.releaseLock(); }
    return await portalProtocolFromHtml(Buffer.concat(chunks).toString('utf8'), url.href);
  } catch { return null; }
  finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
    await response?.body?.cancel().catch(() => {});
    await policy?.dispatcher.close();
  }
}
