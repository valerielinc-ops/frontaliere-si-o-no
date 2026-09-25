import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AI_MODELS,
  __installScoreStoreForTests,
  callLLM,
  classifyExhaustionCause,
  getScoreBoard,
  isModelAvailable,
  resetState,
} from '../../scripts/lib/ai-models.mjs';

/**
 * Il client della lane Codex (`_requestCodexExecution`) davanti al broker del
 * job. Il broker esegue una richiesta alla volta: il client deve misurare il
 * timeout di esecuzione dal segnale di avvio (\x01), non dalla connect(), e i
 * guasti del canale non devono pesare sullo score del modello
 * (send-newsletter run 36116142119: coda, TTL e socket sparito avevano portato
 * lo score di codex-cli da 676 a 573 senza una sola risposta del modello).
 */
const CODEX = AI_MODELS.CODEX_CLI_PRIMARY;
const ENV_KEYS = [
  'ENABLE_CODEX_ARTICLE_FALLBACK',
  'CODEX_AUTH_BROKER_SOCKET',
  'CODEX_CLI_TIMEOUT_MS',
  'CODEX_BROKER_QUEUE_WAIT_MS',
  'AI_MODELS_PREFER',
  'AI_MODELS_FORCE_CHAIN',
  'AI_MODELS_SCHEMA_MODE',
] as const;

type Behavior = (client: net.Socket, request: Record<string, unknown>) => void;

describe('client del broker Codex', () => {
  const saved: Record<string, string | undefined> = {};
  let tempDir = '';
  let socketPath = '';
  let server: net.Server | null = null;
  let behavior: Behavior = () => {};
  let requests: Array<Record<string, unknown>> = [];
  const sockets: net.Socket[] = [];

  beforeAll(() => {
    __installScoreStoreForTests(null);
  });

  beforeEach(async () => {
    resetState();
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    process.env.ENABLE_CODEX_ARTICLE_FALLBACK = '1';
    process.env.CODEX_CLI_TIMEOUT_MS = '15000';
    delete process.env.CODEX_BROKER_QUEUE_WAIT_MS;
    delete process.env.AI_MODELS_PREFER;
    delete process.env.AI_MODELS_FORCE_CHAIN;
    delete process.env.AI_MODELS_SCHEMA_MODE;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-broker-client-'));
    socketPath = path.join(tempDir, 'auth.sock');
    requests = [];
    behavior = () => {};
    server = net.createServer({ allowHalfOpen: true }, (client) => {
      sockets.push(client);
      let buffer = '';
      client.setEncoding('utf8');
      client.on('error', () => {});
      client.on('data', (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const parsed = JSON.parse(buffer.slice(0, newline));
        requests.push(parsed);
        behavior(client, parsed);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(socketPath, () => resolve());
    });
    process.env.CODEX_AUTH_BROKER_SOCKET = socketPath;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const socket of sockets.splice(0)) socket.destroy();
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
    resetState();
  });

  const messages = [{ role: 'user', content: 'ping' }];
  const callCodex = (opts: Record<string, unknown> = {}) => callLLM(messages, {
    model: CODEX,
    chain: [CODEX],
    prefer: [CODEX],
    bypassForceChain: true,
    maxRetriesPerModel: 1,
    ...opts,
  });
  const codexScore = () => getScoreBoard().find((entry) => entry.model === CODEX)?.score ?? 0;
  const warnings = () => {
    const spy = vi.spyOn(console, 'warn');
    return () => spy.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
  };

  it('chiede il segnale di avvio e toglie i byte di controllo prima della risposta', async () => {
    behavior = (client) => {
      // Ordine realistico: avvio subito, sonda del half-close subito dopo.
      client.write('\x01');
      client.write('\0');
      setTimeout(() => client.end(`${JSON.stringify({ ok: true, result: 'PONG' })}\n`), 20);
    };
    await expect(callCodex()).resolves.toBe('PONG');
    expect(requests[0]).toMatchObject({ op: 'exec', notifyStart: true });
  });

  it('una richiesta mai partita scade come attesa in coda, senza toccare lo score', async () => {
    const log = warnings();
    // Il broker accetta e tiene la richiesta in coda: nessun \x01, nessuna risposta.
    behavior = (client) => { client.write('\0'); };
    await expect(callCodex({ deadlineMs: Date.now() + 1500 })).rejects.toThrow(/queue wait timed out after \d+s before Codex started/);
    expect(log()).toMatch(/guasto di trasporto, score invariato/);
    expect(codexScore()).toBe(0);
  });

  it('dopo il segnale di avvio lo scadere del budget e\' un timeout del socket, sempre di trasporto', async () => {
    const log = warnings();
    behavior = (client) => { client.write('\x01'); };
    await expect(callCodex({ deadlineMs: Date.now() + 1500 })).rejects.toThrow(/Codex auth broker socket timed out/);
    expect(log()).toMatch(/guasto di trasporto, score invariato/);
    expect(codexScore()).toBe(0);
  });

  it('un broker sparito spegne la lane per il processo al primo ENOENT', async () => {
    const log = warnings();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    fs.rmSync(socketPath, { force: true });
    expect(isModelAvailable(CODEX)).toBe(true);

    await expect(callCodex()).rejects.toThrow(/ENOENT/);
    expect(log()).toMatch(/broker non raggiungibile \(ENOENT\)/);
    expect(log()).toMatch(/guasto di trasporto, score invariato/);
    expect(isModelAvailable(CODEX)).toBe(false);
    await expect(callCodex()).rejects.toThrow(/codex-cli\/gpt-5\.6-luna: skipped — Codex auth broker temporarily unavailable \(socket gone for this job\)/);
    expect(codexScore()).toBe(0);

    // Un socket diverso (un altro broker) riapre la lane.
    process.env.CODEX_AUTH_BROKER_SOCKET = path.join(tempDir, 'other.sock');
    expect(isModelAvailable(CODEX)).toBe(true);
  });

  // Quando tutta la catena fallisce, il testo degli errori decide fra
  // differimento (transitorio) e Workflow Failure (persistente). Una coda o un
  // broker sparito si riparano al run successivo: devono votare transitorio,
  // non restare ambigui ne' finire nel secchio di «no API key».
  it('ogni guasto del canale broker vota transitorio nel tally di esaurimento', async () => {
    const rows: string[] = [];
    const collect = (error: unknown) => { rows.push(String((error as Error).message)); };
    behavior = (client) => { client.write('\0'); };
    await callCodex({ deadlineMs: Date.now() + 1200 }).catch(collect);
    behavior = (client) => { client.end(); };
    await callCodex().catch(collect);
    for (const socket of sockets.splice(0)) socket.destroy();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    fs.rmSync(socketPath, { force: true });
    await callCodex().catch(collect);
    await callCodex().catch(collect);

    const codexRows = rows.map((message) => message.match(/Errors: (.*)$/s)?.[1] ?? message);
    expect(codexRows).toHaveLength(4);
    const tally = classifyExhaustionCause(codexRows);
    expect({ transient: tally.transient, persistent: tally.persistent }, codexRows.join('\n'))
      .toEqual({ transient: 4, persistent: 0 });
  });

  it('un broker che chiude senza risposta e\' un guasto di trasporto', async () => {
    const log = warnings();
    behavior = (client) => { client.end(); };
    await expect(callCodex()).rejects.toThrow(/closed without a response/);
    expect(log()).toMatch(/guasto di trasporto, score invariato/);
    expect(codexScore()).toBe(0);
  });

  it('il SIGKILL a budget del broker non pesa sullo score, un errore di Codex si', async () => {
    behavior = (client) => {
      client.end(`${JSON.stringify({ ok: false, error: 'Codex CLI timed out after 15000ms' })}\n`);
    };
    await expect(callCodex()).rejects.toThrow(/Codex CLI timed out after 15000ms/);
    expect(codexScore()).toBe(0);

    behavior = (client) => {
      client.end(`${JSON.stringify({ ok: false, error: 'Codex CLI exited with code 1: boom' })}\n`);
    };
    await expect(callCodex()).rejects.toThrow(/Codex CLI exited with code 1: boom/);
    expect(codexScore()).toBeLessThan(0);
  });
});
