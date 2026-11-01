import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEDGER_UNAVAILABLE, notifyGoogleIndexing } from '../scripts/lib/indexing-api.mjs';
import { createLedger, quotaDayKey } from '../scripts/lib/indexing-jobs-planner.mjs';

const tokenMock = vi.hoisted(() => ({ exchange: vi.fn(async () => 'token') }));
vi.mock('../scripts/lib/google-service-account-token.mjs', () => ({
  createJwtAssertion: () => 'jwt',
  exchangeAssertionForToken: tokenMock.exchange,
}));

const URLS = ['https://frontaliereticino.ch/a/', 'https://frontaliereticino.ch/b/'];

describe('notifyGoogleIndexing shared ledger', () => {
  let dir: string;
  let ledgerPath: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  const writeLedger = (spent: number) => {
    const ledger = createLedger('2026-01-01');
    ledger.days[quotaDayKey()] = spent;
    const raw = JSON.stringify(ledger);
    fs.writeFileSync(ledgerPath, raw);
    return raw;
  };
  const expectNoGoogleRequest = () => {
    expect(fetchMock).not.toHaveBeenCalled();
    expect(tokenMock.exchange).not.toHaveBeenCalled();
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'indexing-api-'));
    ledgerPath = path.join(dir, 'ledger.json');
    vi.stubEnv('FIREBASE_SERVICE_ACCOUNT_JSON', '{"client_email":"sa@example.test"}');
    fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    tokenMock.exchange.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('sends nothing when the read of a 1,999 ledger fails, and keeps the file', async () => {
    const raw = writeLedger(1999);
    const real = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: never[]) => {
      if (file === ledgerPath) throw new Error('EIO: forced read failure');
      return (real as (...a: unknown[]) => unknown)(file, ...rest);
    }) as typeof fs.readFileSync);

    const results = await notifyGoogleIndexing(URLS, { ledgerPath });
    vi.mocked(fs.readFileSync).mockRestore();

    expectNoGoogleRequest();
    expect(results).toEqual(URLS.map((url) => ({ url, ok: false, error: LEDGER_UNAVAILABLE })));
    expect(fs.readFileSync(ledgerPath, 'utf8')).toBe(raw);
  });

  it.each(['writeFileSync', 'renameSync'] as const)(
    'sends nothing when %s fails on a 1,999 ledger, and keeps the file',
    async (method) => {
      const raw = writeLedger(1999);
      vi.spyOn(fs, method).mockImplementation(() => { throw new Error('ENOSPC: forced write failure'); });

      const results = await notifyGoogleIndexing(URLS, { ledgerPath });
      vi.mocked(fs[method]).mockRestore();

      expectNoGoogleRequest();
      expect(results).toEqual(URLS.map((url) => ({ url, ok: false, error: LEDGER_UNAVAILABLE })));
      expect(fs.readFileSync(ledgerPath, 'utf8')).toBe(raw);
      expect(fs.readdirSync(dir)).toEqual(['ledger.json']);
    },
  );

  it('stops the batch when a reservation cannot be persisted mid-run', async () => {
    writeLedger(0);
    const real = fs.renameSync;
    let renames = 0;
    vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      renames += 1;
      // preflight, reservation and outcome of URL a succeed; reservation of b fails.
      if (renames > 3) throw new Error('ENOSPC: forced write failure');
      real(from, to);
    }) as typeof fs.renameSync);

    const results = await notifyGoogleIndexing(URLS, { ledgerPath });
    vi.mocked(fs.renameSync).mockRestore();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.ok)).toEqual([true, false]);
    expect(results[1].error).toBe(LEDGER_UNAVAILABLE);
    expect(JSON.parse(fs.readFileSync(ledgerPath, 'utf8')).days[quotaDayKey()]).toBe(1);
  });

  it('sends nothing and creates no ledger when it is missing', async () => {
    const results = await notifyGoogleIndexing(URLS, { ledgerPath });

    expectNoGoogleRequest();
    expect(results.every((r) => r.error === LEDGER_UNAVAILABLE)).toBe(true);
    expect(fs.existsSync(ledgerPath)).toBe(false);
  });

  it('sends nothing and keeps the file when the ledger is invalid', async () => {
    fs.writeFileSync(ledgerPath, '{"version":1,"truncat');

    const results = await notifyGoogleIndexing(URLS, { ledgerPath });

    expectNoGoogleRequest();
    expect(results.every((r) => r.error === LEDGER_UNAVAILABLE)).toBe(true);
    expect(fs.readFileSync(ledgerPath, 'utf8')).toBe('{"version":1,"truncat');
  });

  it('persists the reservation before the only POST the budget still allows', async () => {
    writeLedger(1999);
    let spentAtPost = 0;
    fetchMock.mockImplementation(async () => {
      spentAtPost = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')).days[quotaDayKey()];
      return new Response('{}', { status: 200 });
    });

    const results = await notifyGoogleIndexing(URLS, { ledgerPath });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(spentAtPost).toBe(2000);
    expect(results).toEqual([{ url: URLS[0], ok: true, status: 200 }]);
    expect(JSON.parse(fs.readFileSync(ledgerPath, 'utf8')).notifications[URLS[0]].sent).toBe(quotaDayKey());
  });
});

describe('submit-google-indexing-jobs ledger ownership', () => {
  it('stops without replacing a ledger that exists but is invalid', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'indexing-owner-'));
    const ledgerPath = path.join(dir, 'ledger.json');
    fs.writeFileSync(ledgerPath, 'truncat');
    try {
      // --dry-run and a credential-free env are not optional: on a developer
      // machine GOOGLE_APPLICATION_CREDENTIALS is the production service
      // account, so a regression here would otherwise publish real URLs.
      const run = spawnSync(
        process.execPath,
        [fileURLToPath(new URL('../scripts/submit-google-indexing-jobs.js', import.meta.url)), '--ledger', ledgerPath, '--dry-run'],
        { encoding: 'utf8', env: { PATH: process.env.PATH } },
      );

      expect(run.status).toBe(1);
      expect(run.stdout).toContain('is invalid');
      expect(fs.readFileSync(ledgerPath, 'utf8')).toBe('truncat');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
