import { describe, expect, it } from 'vitest';
import http from 'node:http';
import { once } from 'node:events';
import { browserEgressTarget, createPublicAgentFetch, startBrowserEgress } from '../scripts/assisted-application/lib/browser-egress.mjs';

const through = (port: number, target: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
  const request = http.request({ host: '127.0.0.1', port, path: target, agent: false }, response => {
    let body = ''; response.on('data', chunk => { body += chunk; }); response.on('end', () => resolve({ status: response.statusCode!, body }));
  }); request.on('error', reject); request.end();
});

describe('private Mac browser egress', () => {
  it.each(['http://127.0.0.1/', 'http://10.0.0.1/', 'http://172.16.0.1/', 'http://192.168.1.1/',
    'http://169.254.169.254/', 'http://100.64.0.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/',
    'http://[64:ff9b::a00:1]/', 'http://localhost/', 'http://host.local/', 'http://user:password@public.example/',
    'http://2130706433/', 'http://0x7f000001/', 'file:///private/owner'])('rejects private or malformed target %s before connection', target => {
    expect(() => browserEgressTarget(target)).toThrow();
  });
  it('allows public HTTP and opaque HTTPS CONNECT on the standard ports only', () => {
    expect(browserEgressTarget('http://public.example/path')).toMatchObject({ host: 'public.example', port: 80, fixture: false });
    expect(browserEgressTarget('public.example:443', { connect: true })).toMatchObject({ host: 'public.example', port: 443 });
    expect(() => browserEgressTarget('public.example:22', { connect: true })).toThrow();
    expect(() => browserEgressTarget('public.example:443/private', { connect: true })).toThrow();
  });
  it('blocks a public-looking hostname resolving to a private/mixed DNS answer at connect time', async () => {
    let hits = 0; let resolutions = 0;
    const fixture = http.createServer((_request, response) => { hits++; response.end('fixture-only'); });
    fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening');
    const fixturePort = (fixture.address() as any).port;
    const lookupImpl = async () => { resolutions++; return [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]; };
    const gate = await startBrowserEgress({ lookupImpl });
    const localFixtureGate = await startBrowserEgress({ fixturePort });
    const agent = createPublicAgentFetch({ lookupImpl });
    try {
      expect((await through(gate.port, `http://127.0.0.1:${fixturePort}/`)).status).toBe(403);
      expect((await through(gate.port, 'http://public-looking.example/')).status).toBe(502);
      await expect(agent.fetch('http://public-looking.example/')).rejects.toThrow();
      expect(resolutions).toBeGreaterThanOrEqual(2); expect(hits).toBe(0);
      expect(await through(localFixtureGate.port, `http://127.0.0.1:${fixturePort}/`)).toEqual({ status: 200, body: 'fixture-only' });
      expect(hits).toBe(1);
      expect((await through(localFixtureGate.port, 'http://127.0.0.1:1/')).status).toBe(403);
    } finally { await Promise.all([gate.close(), localFixtureGate.close(), agent.close()]); fixture.closeAllConnections(); fixture.close(); }
  });
  it('bounds requests instead of allowing an unlimited local relay', async () => {
    const gate = await startBrowserEgress({ maxRequests: 1 });
    try { expect((await through(gate.port, 'http://localhost/')).status).toBe(403); expect((await through(gate.port, 'http://localhost/')).status).toBe(503); }
    finally { await gate.close(); }
  });
});
