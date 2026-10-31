/** Private loopback egress gate. TLS stays opaque; DNS is validated at connect time. */
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { createPublicConnectionLookup, isPrivateOrLocalAddress } from '../../lib/prospector/public-fetch-policy.mjs';
import { Agent, fetch as publicFetch } from 'undici';

const PRIVATE_NAMES = /(^|\.)(?:localhost|local|internal)$/i;
export function browserEgressTarget(raw, { connect = false, fixturePort = null } = {}) {
  const url = new URL(connect ? `https://${raw}` : raw);
  if (url.username || url.password || url.hash || !['http:', 'https:'].includes(url.protocol)
    || (connect && (url.pathname !== '/' || url.search))) throw new Error('browser_egress_target_invalid');
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  const fixture = Number.isInteger(fixturePort) && host === '127.0.0.1' && port === fixturePort && url.protocol === 'http:';
  if (!fixture && ((!connect && url.protocol !== 'http:') || (connect && port !== 443) || (!connect && port !== 80)
    || PRIVATE_NAMES.test(host) || isPrivateOrLocalAddress(host))) throw new Error('browser_egress_target_denied');
  return { url, host, port, fixture };
}

/** Untrusted posting URLs in the deterministic agent need the same IP pinning. */
export function createPublicAgentFetch({ lookupImpl } = {}) {
  const dispatcher = new Agent({ connect: { lookup: createPublicConnectionLookup(lookupImpl), timeout: 10_000 },
    headersTimeout: 20_000, bodyTimeout: 30_000 });
  return { async fetch(raw, options = {}) {
    const url = new URL(String(raw));
    if (url.username || url.password) throw new Error('browser_egress_target_invalid');
    browserEgressTarget(url.protocol === 'https:' ? url.host : url.href, { connect: url.protocol === 'https:' });
    return publicFetch(url, { ...options, signal: options.signal || AbortSignal.timeout(30_000), dispatcher, redirect: 'manual' });
  }, close: () => dispatcher.close() };
}

export async function startBrowserEgress({ fixturePort = null, lookupImpl, maxConnections = 32,
  maxBytes = 256 * 1024 * 1024, maxConnectionBytes = 64 * 1024 * 1024, maxRequests = 512 } = {}) {
  const lookup = createPublicConnectionLookup(lookupImpl);
  const sockets = new Set(); let bytes = 0; let requests = 0; let closing = false;
  const track = socket => {
    if (closing || sockets.size >= maxConnections * 2) { socket.destroy(); return false; }
    sockets.add(socket);
    socket.setTimeout(60_000, () => socket.destroy());
    const timer = setTimeout(() => socket.destroy(), 5 * 60_000); timer.unref();
    let connectionBytes = 0;
    socket.on('data', buffer => {
      bytes += buffer.length; connectionBytes += buffer.length;
      if (bytes > maxBytes || connectionBytes > maxConnectionBytes) socket.destroy();
    });
    socket.once('close', () => { clearTimeout(timer); sockets.delete(socket); });
    socket.on('error', () => {});
    return true;
  };
  const headersOf = (headers, host = null) => Object.fromEntries(Object.entries({ ...headers, ...(host ? { host } : {}) }).filter(([name]) =>
    !['proxy-authorization', 'proxy-connection', 'connection', 'keep-alive', 'upgrade', 'te', 'trailer'].includes(name.toLowerCase())));
  const handler = (request, response) => {
    if (++requests > maxRequests || closing) { response.writeHead(503).end(); return; }
    let target;
    try { target = browserEgressTarget(request.url, { fixturePort }); }
    catch { response.writeHead(403).end(); return; }
    const upstream = http.request({ hostname: target.host, port: target.port,
      path: `${target.url.pathname}${target.url.search}`, method: request.method,
      headers: headersOf(request.headers, target.url.host), agent: false,
      ...(target.fixture ? {} : { lookup }) }, result => {
      response.writeHead(result.statusCode || 502, headersOf(result.headers));
      result.pipe(response);
    });
    upstream.on('socket', socket => track(socket));
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    response.once('close', () => upstream.destroy());
    request.pipe(upstream);
  };
  const makeServer = () => {
    const server = http.createServer({ requestTimeout: 60_000, headersTimeout: 10_000, maxHeaderSize: 32 * 1024 }, handler);
    server.on('connection', socket => track(socket));
    server.on('connect', (request, client, head) => {
      if (++requests > maxRequests || closing) { client.destroy(); return; }
      let target;
      try { target = browserEgressTarget(request.url, { connect: true }); }
      catch { client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
      const remote = net.connect({ host: target.host, port: target.port, lookup });
      track(remote);
      remote.once('connect', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) remote.write(head); client.pipe(remote); remote.pipe(client); });
      remote.once('error', () => client.destroy());
      client.once('close', () => remote.destroy()); remote.once('close', () => client.destroy());
    });
    return server;
  };
  const ipv4 = makeServer(); const ipv6 = makeServer();
  try {
    ipv4.listen(0, '127.0.0.1'); await once(ipv4, 'listening');
    const port = ipv4.address().port;
    // Occupy both meanings of Seatbelt's localhost:port. Never bind a public interface.
    ipv6.listen(port, '::1'); await once(ipv6, 'listening');
    return { server: `http://127.0.0.1:${port}`, port, async close() {
      closing = true; for (const socket of sockets) socket.destroy();
      await Promise.all([ipv4, ipv6].map(server => new Promise(resolve => server.close(resolve))));
    } };
  } catch (error) {
    closing = true; for (const socket of sockets) socket.destroy(); ipv4.close(); ipv6.close(); throw error;
  }
}
