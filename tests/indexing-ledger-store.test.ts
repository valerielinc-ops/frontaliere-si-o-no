// @vitest-environment node
/**
 * The Indexing API ledger must survive between runs (Firestore), never be
 * overwritten by a run that did not read it, and never be read torn.
 * Context: with the ledger in the Actions cache every run started empty
 * ("Cache not found") and 143 of the 211 URLs sent on 2026-11-09 had already
 * been sent on 2026-11-07.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHUNK_BYTES,
  CHUNK_DOC_PREFIX,
  LEDGER_DOC,
  MAX_CHUNKS,
  MAX_COMMIT_REQUEST_BYTES,
  assertCommitFits,
  buildCommitWrites,
  commitRequestBytes,
  parseCli,
  decodeLedger,
  encodeLedger,
  receiptPath,
  runCli,
} from '../scripts/lib/indexing-ledger-store.mjs';

const PROJECT = 'test-project';
const DOCS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

/** A ledger shaped like production: many sitemap URLs, incompressible-ish slugs. */
function bigLedger(n: number) {
  const urls: Record<string, object> = {};
  for (let i = 0; i < n; i++) {
    const slug = `${i.toString(36)}-${(i * 2654435761 % 4294967296).toString(36)}-${(i * 40503 % 65536).toString(16)}`;
    urls[`https://frontaliereticino.ch/cerca-lavoro-ticino/job-${slug}/`] = { f: '2026-11-01', m: '2026-11-0' + (i % 9 + 1), ...(i % 3 ? { s: '2026-11-02' } : {}) };
  }
  return JSON.stringify({ version: 1, createdAt: '2026-11-01', days: { '2026-11-09': 211 }, urls, notifications: {} });
}

describe('encode/decode', () => {
  it('round-trips a production-sized ledger across several chunks', () => {
    const json = bigLedger(120_000);
    const enc = encodeLedger(json);
    expect(enc.chunks.length).toBeGreaterThan(1);
    for (const c of enc.chunks) expect(Buffer.from(c, 'base64').length).toBeLessThanOrEqual(CHUNK_BYTES);
    expect(decodeLedger(enc.chunks, enc.sha256)).toBe(json);
  });

  it('detects a torn or corrupt read instead of returning a wrong ledger', () => {
    const a = encodeLedger(bigLedger(10));
    const b = encodeLedger(bigLedger(11));
    expect(() => decodeLedger(b.chunks, a.sha256)).toThrow(/sha256 mismatch/);
  });
});

/** A ledger whose gzip needs `chunks` chunks: random bytes do not compress. */
function incompressibleLedger(chunks: number) {
  // base64 of random bytes gzips to ~76% of its length.
  const pad = randomBytes(Math.ceil((chunks - 0.5) * CHUNK_BYTES)).toString('base64');
  return JSON.stringify({ version: 1, createdAt: '2026-11-01', days: {}, urls: {}, notifications: {}, pad });
}

describe('Firestore commit size limit (10 MiB per request)', () => {
  it('a commit with the maximum number of full chunks fits the request limit', () => {
    const full = randomBytes(CHUNK_BYTES).toString('base64');
    const encoded = { chunks: Array.from({ length: MAX_CHUNKS }, () => full), sha256: 'a'.repeat(64), rawBytes: 1, gzBytes: 1 };
    const writes = buildCommitWrites({
      projectId: PROJECT, encoded, previousChunks: MAX_CHUNKS, precondition: { exists: false }, writer: 'w', urlCount: 1,
    });
    expect(MAX_COMMIT_REQUEST_BYTES).toBeLessThan(10 * 1024 * 1024);
    expect(commitRequestBytes(writes)).toBeLessThanOrEqual(MAX_COMMIT_REQUEST_BYTES);
    expect(() => assertCommitFits(writes)).not.toThrow();
  });

  it('12 chunks (over 10 MiB once base64 + JSON) are refused by the size guard', () => {
    const full = randomBytes(CHUNK_BYTES).toString('base64');
    const encoded = { chunks: Array.from({ length: 12 }, () => full), sha256: 'a'.repeat(64), rawBytes: 1, gzBytes: 1 };
    const writes = buildCommitWrites({
      projectId: PROJECT, encoded, previousChunks: 0, precondition: { exists: false }, writer: 'w', urlCount: 1,
    });
    expect(() => assertCommitFits(writes)).toThrow(/above .*10 MiB/);
  });

  it('encodeLedger refuses a ledger that needs 12 chunks', () => {
    expect(() => encodeLedger(incompressibleLedger(12))).toThrow(/need 12 chunks .*max 10/);
  });
});

describe('CLI arguments', () => {
  it('accepts exactly one --ledger and rejects duplicates, unknown options and a missing path', () => {
    expect(parseCli(['pull', '--ledger', '/tmp/a.json'])).toMatchObject({ command: 'pull', ledger: '/tmp/a.json', error: null });
    expect(parseCli(['pull', '--ledger', '/tmp/a.json', '--ledger', '/tmp/b.json']).error).toMatch(/more than once/);
    expect(parseCli(['push', '--ledgr', '/tmp/a.json']).error).toMatch(/unknown option/);
    expect(parseCli(['push', '--ledger']).error).toMatch(/needs a path/);
  });
});

describe('buildCommitWrites', () => {
  it('writes chunks + meta in one commit, conditioned on the version pulled, and drops stale chunks', () => {
    const enc = encodeLedger('{"version":1}');
    const writes = buildCommitWrites({
      projectId: PROJECT, encoded: enc, previousChunks: 3,
      precondition: { updateTime: '2026-11-10T08:20:00.000000Z' }, writer: 'test', urlCount: 0,
    });
    expect(writes[0].update.name).toMatch(new RegExp(`${CHUNK_DOC_PREFIX}0$`));
    expect(writes.filter((w: any) => w.delete).map((w: any) => w.delete.split('-chunk-')[1])).toEqual(['1', '2']);
    const meta = writes[writes.length - 1];
    expect(meta.update.name).toMatch(new RegExp(`${LEDGER_DOC}$`));
    expect(meta.currentDocument).toEqual({ updateTime: '2026-11-10T08:20:00.000000Z' });
  });
});

/** In-memory Firestore REST + OAuth token endpoint. */
function fakeGoogle() {
  const docs = new Map<string, { fields: any; updateTime: string }>();
  let clock = 0;
  const commits: any[] = [];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url === 'https://oauth2.googleapis.com/token') return json(200, { access_token: 'tok' });
    if (url === `${DOCS}:commit`) {
      const { writes } = JSON.parse(String(init.body));
      commits.push(writes);
      for (const w of writes) {
        const name = (w.update?.name || w.delete).split('/documents/')[1];
        const cur = docs.get(name);
        const pre = w.currentDocument;
        if (pre?.exists === false && cur) return json(400, { error: { message: 'FAILED_PRECONDITION: exists' } });
        if (pre?.updateTime && cur?.updateTime !== pre.updateTime) return json(400, { error: { message: 'FAILED_PRECONDITION: stale' } });
      }
      clock += 1;
      for (const w of writes) {
        const name = (w.update?.name || w.delete).split('/documents/')[1];
        if (w.delete) docs.delete(name); else docs.set(name, { fields: w.update.fields, updateTime: `t${clock}` });
      }
      return json(200, {});
    }
    const name = url.split('/documents/')[1];
    const doc = docs.get(name);
    return doc ? json(200, { name, ...doc }) : json(404, { error: { message: 'not found' } });
  });
  return { docs, commits, fetchImpl };
}

describe('pull / push CLI against Firestore', () => {
  let dir: string;
  let env: Record<string, string>;
  let google: ReturnType<typeof fakeGoogle>;
  const ledgerPath = () => join(dir, 'ledger.json');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'idx-ledger-'));
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const sa = join(dir, 'sa.json');
    writeFileSync(sa, JSON.stringify({
      project_id: PROJECT, client_email: 'ci@test.iam.gserviceaccount.com',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    }));
    env = { GOOGLE_APPLICATION_CREDENTIALS: sa, GITHUB_RUN_ID: '1', GITHUB_WORKFLOW: 'test' };
    google = fakeGoogle();
    vi.stubGlobal('fetch', google.fetchImpl);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('survives between runs: what one run pushes, the next run pulls', async () => {
    // Run 1: nothing stored yet → no ledger file (the submitter bootstraps it).
    expect(await runCli(['pull', '--ledger', ledgerPath()], env)).toBe(0);
    expect(existsSync(ledgerPath())).toBe(false);
    const ledger = bigLedger(40_000);
    writeFileSync(ledgerPath(), ledger);
    expect(await runCli(['push', '--ledger', ledgerPath()], env)).toBe(0);

    // Run 2, on a fresh runner.
    rmSync(ledgerPath());
    rmSync(receiptPath(ledgerPath()));
    expect(await runCli(['pull', '--ledger', ledgerPath()], env)).toBe(0);
    expect(readFileSync(ledgerPath(), 'utf8')).toBe(ledger);
  });

  it('refuses to push without the receipt of a pull, before any network call', async () => {
    writeFileSync(ledgerPath(), bigLedger(3));
    expect(await runCli(['push', '--ledger', ledgerPath()], env)).toBe(1);
    expect(google.fetchImpl).not.toHaveBeenCalled();
  });

  it('a run that pulled a version since replaced cannot overwrite the newer spend', async () => {
    await runCli(['pull', '--ledger', ledgerPath()], env);
    writeFileSync(ledgerPath(), bigLedger(5));
    expect(await runCli(['push', '--ledger', ledgerPath()], env)).toBe(0);

    // Two runs pull the same version; the first push wins, the second fails.
    const other = join(dir, 'other.json');
    await runCli(['pull', '--ledger', ledgerPath()], env);
    await runCli(['pull', '--ledger', other], env);
    writeFileSync(ledgerPath(), bigLedger(6));
    expect(await runCli(['push', '--ledger', ledgerPath()], env)).toBe(0);
    writeFileSync(other, bigLedger(7));
    expect(await runCli(['push', '--ledger', other], env)).toBe(1);

    await runCli(['pull', '--ledger', other], env);
    expect(readFileSync(other, 'utf8')).toBe(bigLedger(6));
  });

  it('an unchanged ledger is not rewritten', async () => {
    await runCli(['pull', '--ledger', ledgerPath()], env);
    writeFileSync(ledgerPath(), bigLedger(4));
    await runCli(['push', '--ledger', ledgerPath()], env);
    await runCli(['pull', '--ledger', ledgerPath()], env);
    const before = google.commits.length;
    expect(await runCli(['push', '--ledger', ledgerPath()], env)).toBe(0);
    expect(google.commits.length).toBe(before);
  });

  it('a ledger needing 12 chunks is refused locally: exit 1, a size error, no Firestore call at all', async () => {
    await runCli(['pull', '--ledger', ledgerPath()], env);
    google.fetchImpl.mockClear();
    writeFileSync(ledgerPath(), incompressibleLedger(12));
    expect(await runCli(['push', '--ledger', ledgerPath()], env)).toBe(1);
    expect(google.fetchImpl).not.toHaveBeenCalled();
    expect(google.commits).toHaveLength(0);
    const logged = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat().join('\n');
    expect(logged).toMatch(/refused before any Firestore call: ledger too large/);
  });

  it('a truncated pull receipt is an ::error:: exit 1, not an unhandled exception', async () => {
    writeFileSync(ledgerPath(), bigLedger(3));
    writeFileSync(receiptPath(ledgerPath()), '{"exists":tr');
    expect(await runCli(['push', '--ledger', ledgerPath()], env)).toBe(1);
    expect(google.fetchImpl).not.toHaveBeenCalled();
  });

  it('a duplicated --ledger is a usage error before any network call', async () => {
    expect(await runCli(['pull', '--ledger', ledgerPath(), '--ledger', join(dir, 'x.json')], env)).toBe(2);
    expect(google.fetchImpl).not.toHaveBeenCalled();
  });

  it('missing credentials are a configuration error (exit 2), not a silent skip', async () => {
    expect(await runCli(['pull', '--ledger', ledgerPath()], {})).toBe(2);
  });
});
