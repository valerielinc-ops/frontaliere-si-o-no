/**
 * cf-purge-cache — the real Cloudflare failure reaches the log, and only
 * temporary failures are retried.
 *
 * Run 45731526939 failed the «Purge exact cache entry for the Pages home» step
 * with «Cannot resolve zone id (token scope?)»: a bare `catch` had dropped the
 * error, so the log could not tell auth from quota from network. The script
 * tests below run the real file as a process with a fake `fetch`: no request
 * leaves the machine and nothing is purged.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  describeCfError,
  isTransientCfError,
  resolveZoneId,
  withCfRetry,
} from '../scripts/lib/cf-analytics.mjs';

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'cf-purge-cache.mjs');
const TOKEN = 'test-token-not-a-real-credential';
const quiet = () => {};

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });
const networkError = () => new TypeError('fetch failed', {
  cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
});

describe('isTransientCfError', () => {
  it('retries network errors, deadlines, 429 and 5xx', () => {
    for (const error of [
      networkError(),
      new TypeError('terminated'),
      Object.assign(new Error('deadline'), { name: 'TimeoutError' }),
      httpError(429),
      httpError(500),
      httpError(503),
    ]) {
      expect(isTransientCfError(error), error.message).toBe(true);
    }
  });

  it('stays fail-closed on auth, other HTTP answers and unknown errors', () => {
    for (const error of [
      httpError(200),
      httpError(400),
      httpError(401),
      httpError(403),
      httpError(404),
      new TypeError('Headers.append: "Bearer x" is an invalid header value.'),
      new Error('anything else'),
    ]) {
      expect(isTransientCfError(error), error.message).toBe(false);
    }
  });
});

describe('withCfRetry', () => {
  it('backs off 1s then 2s and rethrows the last error after three attempts', async () => {
    const operation = vi.fn(async () => { throw httpError(503); });
    const sleepImpl = vi.fn(async () => {});

    await expect(withCfRetry(operation, { sleepImpl, log: quiet })).rejects.toThrow('HTTP 503');
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleepImpl.mock.calls).toEqual([[1000], [2000]]);
  });

  it('does not retry a 403', async () => {
    const operation = vi.fn(async () => { throw httpError(403); });
    const sleepImpl = vi.fn(async () => {});

    await expect(withCfRetry(operation, { sleepImpl, log: quiet })).rejects.toThrow('HTTP 403');
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleepImpl).not.toHaveBeenCalled();
  });
});

describe('describeCfError', () => {
  it('keeps the network cause', () => {
    expect(describeCfError(networkError(), TOKEN)).toBe('fetch failed (cause: ECONNRESET socket hang up)');
  });

  it('removes the token, also when undici quotes an invalid header value', () => {
    const error = new TypeError(`Headers.append: "Bearer ${TOKEN}\n" is an invalid header value.`);
    const text = describeCfError(error, `${TOKEN}\n`);
    expect(text).not.toContain(TOKEN);
    expect(text).toContain('[redacted]');
    expect(text).not.toContain('\n');
  });
});

describe('resolveZoneId keeps the HTTP status on its errors', () => {
  const lookup = (status: number, body: unknown) => resolveZoneId(
    TOKEN, 'example.test', undefined,
    (async () => ({ status, json: async () => body })) as unknown as typeof fetch,
  ).then(() => null, (e: Error & { status?: number }) => e);

  it('403 points at the token scope', async () => {
    const error = await lookup(403, { success: false, errors: [{ message: 'Authentication error' }] });
    expect(error).toMatchObject({ status: 403 });
    expect(error!.message).toContain('check token scope: Authentication error');
  });

  it('429 and a non-JSON 502 do not blame the token', async () => {
    const limited = await lookup(429, { success: false, errors: [{ message: 'rate limited' }] });
    expect(limited).toMatchObject({ status: 429 });
    expect(limited!.message).not.toContain('token scope');
    expect(await lookup(502, null)).toMatchObject({ status: 502 });
  });
});

describe('cf-purge-cache.mjs as a process (fake fetch)', () => {
  let dir: string;
  let preload: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-purge-retry-'));
    preload = path.join(dir, 'fake-fetch.mjs');
    // FAKE_CF_PLAN is a JSON list of answers, consumed one per request; the
    // last one repeats.
    fs.writeFileSync(preload, `
      import fs from 'node:fs';
      const plan = JSON.parse(process.env.FAKE_CF_PLAN);
      let calls = 0;
      globalThis.fetch = async (url, init = {}) => {
        const step = plan[Math.min(calls++, plan.length - 1)];
        fs.appendFileSync(process.env.FAKE_CF_LOG, (init.method || 'GET') + ' ' + new URL(url).pathname + '\\n');
        if (step.network) {
          throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo'), { code: step.network }) });
        }
        return { status: step.status, json: async () => step.body };
      };
    `);
  });

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  function run(name: string, plan: unknown[], zoneId = '') {
    const log = path.join(dir, `${name}.log`);
    const result = spawnSync(
      process.execPath,
      ['--import', pathToFileURL(preload).href, SCRIPT, '--files=https://frontaliereticino.ch/sitemap.xml'],
      {
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          PATH: process.env.PATH,
          CF_API_TOKEN: TOKEN,
          CF_ZONE_ID: zoneId,
          FAKE_CF_PLAN: JSON.stringify(plan),
          FAKE_CF_LOG: log,
        },
      },
    );
    const requests = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
    return { ...result, output: `${result.stdout}\n${result.stderr}`, requests };
  }

  const ZONE_OK = { status: 200, body: { success: true, result: [{ id: 'zone-1' }] } };
  const PURGE_OK = { status: 200, body: { success: true } };
  const denied = (status: number) => ({
    status, body: { success: false, errors: [{ code: 10000, message: 'Authentication error' }] },
  });

  for (const status of [401, 403]) {
    it(`zone lookup ${status}: one request, exit 1, real error in log and annotation`, () => {
      const r = run(`lookup-${status}`, [denied(status)]);
      expect(r.status).toBe(1);
      expect(r.requests).toHaveLength(1);
      expect(r.stderr).toContain(`HTTP ${status}; check token scope: Authentication error`);
      expect(r.stdout).toMatch(new RegExp(`::warning title=Cloudflare cache purge failed::.*HTTP ${status}`));
      expect(r.output).not.toContain(TOKEN);
    });
  }

  it('zone lookup that never reaches Cloudflare: three attempts, then the network cause', () => {
    const r = run('lookup-network', [{ network: 'ENOTFOUND' }]);
    expect(r.status).toBe(1);
    expect(r.requests).toHaveLength(3);
    expect(r.stderr).toContain('Cannot resolve zone id for frontaliereticino.ch: fetch failed (cause: ENOTFOUND getaddrinfo)');
    expect(r.output).not.toContain('token scope?');
  });

  it('recovers from a 429 on the lookup and a 503 on the purge', () => {
    const r = run('recovers', [
      { status: 429, body: { success: false, errors: [{ message: 'rate limited' }] } },
      ZONE_OK,
      { status: 503, body: null },
      PURGE_OK,
    ]);
    expect(r.status, r.output).toBe(0);
    // 2 lookups, 1 failed purge, then one successful POST per cache variant.
    expect(r.requests.filter((line) => line.startsWith('GET '))).toHaveLength(2);
    expect(r.requests.filter((line) => line.startsWith('POST ')).length).toBeGreaterThanOrEqual(3);
    expect(r.stdout).toContain('Cloudflare edge cache purged');
  });

  it('purge POST 403: no retry, fail-closed, with the status', () => {
    const r = run('purge-403', [denied(403)], 'zone-from-env');
    expect(r.status).toBe(1);
    expect(r.requests).toEqual(['POST /client/v4/zones/zone-from-env/purge_cache']);
    expect(r.stderr).toContain('HTTP 403: [{"code":10000,"message":"Authentication error"}]');
  });

  it('purge POST that stays 502: three attempts, exit 1', () => {
    const r = run('purge-502', [{ status: 502, body: null }], 'zone-from-env');
    expect(r.status).toBe(1);
    expect(r.requests).toHaveLength(3);
    expect(r.stderr).toContain('HTTP 502: non-JSON response');
  });
});
