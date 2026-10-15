import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const { requestCodexBrokerJson } = await import('../../scripts/lib/ai-models.mjs');

const servers: net.Server[] = [];
const roots: string[] = [];
const saved = { socket: process.env.CODEX_AUTH_BROKER_SOCKET, max: process.env.CODEX_BROKER_MAX_TIMEOUT_MS };

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  if (saved.socket === undefined) delete process.env.CODEX_AUTH_BROKER_SOCKET;
  else process.env.CODEX_AUTH_BROKER_SOCKET = saved.socket;
  if (saved.max === undefined) delete process.env.CODEX_BROKER_MAX_TIMEOUT_MS;
  else process.env.CODEX_BROKER_MAX_TIMEOUT_MS = saved.max;
});

/** A broker that records the timeout it was asked for and answers at once. */
async function fakeBroker() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-broker-json-'));
  roots.push(root);
  const socketPath = path.join(root, 'auth.sock');
  const asked: number[] = [];
  const server = net.createServer({ allowHalfOpen: true }, (client) => {
    let request = '';
    client.setEncoding('utf8');
    client.on('data', (chunk) => { request += chunk; });
    client.on('end', () => {
      asked.push(Number(JSON.parse(request.split('\n')[0]).timeoutMs));
      client.end(`${JSON.stringify({ ok: true, result: '{"ok":true}' })}\n`);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  process.env.CODEX_AUTH_BROKER_SOCKET = socketPath;
  return asked;
}

describe('requestCodexBrokerJson timeout', () => {
  // Trial run 2026-09-30: a draft call at effort max ran past the 10-minute cap.
  it('asks for as long as the job broker allows, and 10 minutes otherwise', async () => {
    const asked = await fakeBroker();
    const halfHour = 30 * 60 * 1000;

    process.env.CODEX_BROKER_MAX_TIMEOUT_MS = String(halfHour);
    await expect(requestCodexBrokerJson({ prompt: 'p', schema: {}, timeoutMs: halfHour })).resolves.toEqual({ ok: true });

    delete process.env.CODEX_BROKER_MAX_TIMEOUT_MS;
    await requestCodexBrokerJson({ prompt: 'p', schema: {}, timeoutMs: halfHour });

    // Below the lanes' own cap it never shortens a request.
    process.env.CODEX_BROKER_MAX_TIMEOUT_MS = '1000';
    await requestCodexBrokerJson({ prompt: 'p', schema: {} });

    expect(asked).toEqual([halfHour, 600_000, 600_000]);
  });
});
