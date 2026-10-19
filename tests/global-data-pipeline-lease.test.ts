import fs from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GLOBAL_DATA_PIPELINE_LEASE_BUSY_EXIT,
  GLOBAL_DATA_PIPELINE_LEASE_POLL_MS,
  GLOBAL_DATA_PIPELINE_LEASE_TRANSIENT_ERROR_EXIT,
  GLOBAL_DATA_PIPELINE_LEASE_TRANSIENT_ERROR_LIMIT,
  GLOBAL_DATA_PIPELINE_LEASE_TTL_MS,
  GLOBAL_DATA_PIPELINE_LEASE_WAIT_MS,
  acquireLease,
  describeLeaseBusy,
  describeLeaseRelease,
  firestoreDocumentName,
  isRetryableLeaseError,
  leaseDecision,
  leasePollDelayMs,
  releaseLease,
} from '../scripts/lib/global-data-pipeline-lease.mjs';

const NOW = Date.parse('2026-09-14T12:00:00.000Z');
const CREDENTIALS = {
  project_id: 'frontaliere-ticino',
  client_email: 'lease-test@example.iam.gserviceaccount.com',
  private_key: generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
};

function firestoreResponse(status: number, body: unknown = null) {
  return new Response(body == null ? '' : JSON.stringify(body), { status });
}

function leaseDocument(lease: Record<string, string>, updateTime: string) {
  const fields: Record<string, { stringValue?: string; timestampValue?: string }> = {};
  for (const [key, value] of Object.entries(lease)) {
    fields[key] = key === 'expiresAt' || key.endsWith('At')
      ? { timestampValue: value }
      : { stringValue: value };
  }
  return { updateTime, fields };
}

/**
 * A local Firestore REST double with pessimistic transaction locks. A
 * transactional GET waits for the document lock until commit/rollback or a
 * short server-side deadline, while a write acquires the same lock when it
 * commits. Active-owner polling must stay on the simple GET path; candidates
 * still use the transactional GET to recheck the snapshot atomically.
 */
class PessimisticFirestore {
  lease: Record<string, string> | null;
  updateTime = '2026-09-14T11:59:00.000Z';
  locked = false;
  private unlockWaiters: Array<() => void> = [];
  private transactions = new Map<string, { open: boolean; holdsLock: boolean }>();
  private transactionSequence = 0;
  private updateSequence = 0;
  private readonly serverLockTimeoutMs = 25;
  failNextCommitTimeout = false;
  failNextCommitConflict = false;
  getStatus: number | null = null;
  getCount = 0;
  beginCount = 0;
  commitCount = 0;
  rollbackCount = 0;
  transactionalReadCount = 0;

  constructor(lease: Record<string, string> | null) {
    this.lease = lease;
  }

  private releaseLock() {
    this.locked = false;
    this.unlockWaiters.shift()?.();
  }

  private waitForUnlock() {
    return new Promise<boolean>((resolve) => {
      let done = false;
      const waiter = () => {
        if (done) return;
        done = true;
        resolve(true);
      };
      this.unlockWaiters.push(waiter);
      setTimeout(() => {
        if (done) return;
        done = true;
        const index = this.unlockWaiters.indexOf(waiter);
        if (index >= 0) this.unlockWaiters.splice(index, 1);
        resolve(false);
      }, this.serverLockTimeoutMs);
    });
  }

  private async acquireDocumentLock(transaction: string) {
    const state = this.transactions.get(transaction);
    if (!state?.open) return false;
    if (state.holdsLock) return true;
    while (this.locked) {
      if (!(await this.waitForUnlock())) return false;
    }
    this.locked = true;
    state.holdsLock = true;
    return true;
  }

  private async begin() {
    const transaction = `tx-${++this.transactionSequence}`;
    this.transactions.set(transaction, { open: true, holdsLock: false });
    return firestoreResponse(200, { transaction });
  }

  private transactionBody(init: RequestInit | undefined) {
    return JSON.parse(String(init?.body || '{}')) as {
      transaction?: string;
      writes?: Array<{
        delete?: string;
        update?: { fields?: Record<string, unknown> };
        currentDocument?: { updateTime?: string; exists?: boolean };
      }>;
    };
  }

  private async commit(init: RequestInit | undefined) {
    this.commitCount += 1;
    const body = this.transactionBody(init);
    const state = body.transaction ? this.transactions.get(body.transaction) : undefined;
    if (!state?.open) return firestoreResponse(400, { error: { status: 'FAILED_PRECONDITION' } });
    if (!(await this.acquireDocumentLock(body.transaction!))) {
      state.open = false;
      this.transactions.delete(body.transaction!);
      return firestoreResponse(409, { error: { status: 'DEADLINE_EXCEEDED' } });
    }
    if (this.failNextCommitTimeout) {
      this.failNextCommitTimeout = false;
      const error = new Error('The operation was aborted due to timeout');
      error.name = 'TimeoutError';
      throw error;
    }
    if (this.failNextCommitConflict) {
      this.failNextCommitConflict = false;
      state.open = false;
      this.transactions.delete(body.transaction!);
      this.releaseLock();
      return firestoreResponse(409, { error: { status: 'ABORTED' } });
    }

    const write = body.writes?.[0];
    const precondition = write?.currentDocument;
    const matches = precondition?.exists === false
      ? this.lease === null
      : precondition?.updateTime === this.updateTime;
    if (!matches) {
      state.open = false;
      this.transactions.delete(body.transaction!);
      this.releaseLock();
      return firestoreResponse(409, { error: { status: 'ABORTED' } });
    }

    if (write?.delete) {
      this.lease = null;
    } else {
      const fields = write?.update?.fields || {};
      const readField = (key: string) => {
        const field = fields[key] as { stringValue?: string; timestampValue?: string } | undefined;
        return field?.timestampValue || field?.stringValue || '';
      };
      this.lease = {
        owner: readField('owner'),
        repo: readField('repo'),
        workflow: readField('workflow'),
        runId: readField('runId'),
        acquiredAt: readField('acquiredAt'),
        heartbeatAt: readField('heartbeatAt'),
        expiresAt: readField('expiresAt'),
      };
    }
    this.updateTime = `2026-09-14T12:00:${String(++this.updateSequence).padStart(2, '0')}.000Z`;
    state.open = false;
    this.transactions.delete(body.transaction!);
    this.releaseLock();
    return firestoreResponse(200, { commitTime: this.updateTime });
  }

  private async rollback(init: RequestInit | undefined) {
    this.rollbackCount += 1;
    const body = this.transactionBody(init);
    const state = body.transaction ? this.transactions.get(body.transaction) : undefined;
    if (state?.open) {
      state.open = false;
      this.transactions.delete(body.transaction!);
      if (state.holdsLock) this.releaseLock();
    }
    return firestoreResponse(200);
  }

  holdLock(ms: number) {
    this.locked = true;
    setTimeout(() => this.releaseLock(), ms);
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit) {
    const url = String(input);
    if (url.startsWith('https://oauth2.googleapis.com/')) {
      return firestoreResponse(200, { access_token: 'token' });
    }
    if (url.endsWith(':beginTransaction')) {
      this.beginCount += 1;
      return this.begin();
    }
    if (url.endsWith(':commit')) return this.commit(init);
    if (url.endsWith(':rollback')) return this.rollback(init);
    if (url.includes('?transaction=')) {
      this.transactionalReadCount += 1;
      const transaction = new URL(url).searchParams.get('transaction') || '';
      const state = this.transactions.get(transaction);
      if (!state?.open || !(await this.acquireDocumentLock(transaction))) {
        return firestoreResponse(409, { error: { status: 'DEADLINE_EXCEEDED' } });
      }
      if (!this.lease) return firestoreResponse(404, { error: { status: 'NOT_FOUND' } });
      return firestoreResponse(200, leaseDocument(this.lease, this.updateTime));
    }
    this.getCount += 1;
    if (this.getStatus !== null) {
      return firestoreResponse(this.getStatus, { error: { status: 'UNAVAILABLE' } });
    }
    if (!this.lease) return firestoreResponse(404, { error: { status: 'NOT_FOUND' } });
    return firestoreResponse(200, leaseDocument(this.lease, this.updateTime));
  }
}

describe('global data pipeline lease', () => {
  it('ammette un lease assente o scaduto', () => {
    expect(leaseDecision(null, 'run-a', NOW).action).toBe('acquire');
    expect(leaseDecision({
      owner: 'run-b',
      expiresAt: '2026-09-14T11:59:00.000Z',
    }, 'run-a', NOW).action).toBe('acquire');
  });

  it('blocca il takeover quando un lease presente ha una scadenza malformata', () => {
    for (const expiresAt of [undefined, null, '', 'not-a-timestamp']) {
      expect(leaseDecision({
        owner: 'run-b',
        expiresAt,
      }, 'run-a', NOW)).toMatchObject({
        action: 'busy',
        reason: 'malformed_expiry',
        expiresAt: null,
      });
    }
  });

  it('rinnova solo il proprio lease e blocca un writer ancora attivo', () => {
    const current = { owner: 'run-a', expiresAt: '2026-09-14T12:10:00.000Z' };
    expect(leaseDecision(current, 'run-a', NOW)).toMatchObject({ action: 'renew' });
    expect(leaseDecision(current, 'run-b', NOW)).toMatchObject({ action: 'busy' });
  });

  it('mantiene distinto il blocco del lease dalla contesa del push', () => {
    expect(GLOBAL_DATA_PIPELINE_LEASE_BUSY_EXIT).toBe(44);
    // L'attesa EGUAGLIA il TTL, e non e' un numero arbitrario: l'unico caso in
    // cui rinunciare e' corretto e' un owner morto, che diventa prendibile
    // esattamente a `expiresAt` — dove `leaseDecision` rende gia'
    // `{action: 'acquire', reason: 'expired'}`, come asserito qui sopra. Un
    // waiter non deve quindi mai abbandonare PRIMA che il lease sia
    // dimostrabilmente prendibile.
    //
    // Il valore precedente (5 min) affamava il convoglio: 23 gruppi arrivano al
    // commit in una banda di ~48 min e un hold misurato di 2m23s fa ~55 min di
    // domanda serializzata, quindi entravano solo i primi 2-4 e gli altri
    // scartavano un crawl finito. Misurato: 23/23 gruppi al giorno fino al
    // 2026-09-13, poi 2, 0, 4, 6, 2 (corpus #1573).
    expect(GLOBAL_DATA_PIPELINE_LEASE_WAIT_MS).toBe(GLOBAL_DATA_PIPELINE_LEASE_TTL_MS);
    expect(GLOBAL_DATA_PIPELINE_LEASE_WAIT_MS).toBe(3_600_000);
    // Il poll e' salito con l'attesa perche' i due si MOLTIPLICANO: ogni poll e'
    // una transazione Firestore, e a 5s un'attesa di 60 min ne fa 720 per
    // writer, ~16'500 per ondata, ~33'000/giorno — si scambierebbe un'outage
    // con un'altra. A 15s il caso peggiore e' 240 per writer.
    expect(GLOBAL_DATA_PIPELINE_LEASE_POLL_MS).toBe(15_000);
    expect(GLOBAL_DATA_PIPELINE_LEASE_WAIT_MS / GLOBAL_DATA_PIPELINE_LEASE_POLL_MS).toBe(240);
    const shell = fs.readFileSync('scripts/lib/git-commit-data.sh', 'utf8');
    expect(shell).toContain('global-data-pipeline-lease.mjs');
    expect(shell).toContain('global_data_pipeline_lease_cleanup');
    expect(shell).toContain('trap global_data_pipeline_lease_cleanup EXIT');
    expect(shell).toContain('node "$lease_script" release');
    expect(shell).toContain('global data-pipeline lease remained busy after the bounded wait');
    expect(shell).toContain('global data pipeline lease stopped after consecutive transient Firestore errors');
    expect(shell).toContain('lease_status" -eq 45');
  });

  it('ritenta timeout e transient Firestore, ma non errori permanenti', () => {
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    expect(isRetryableLeaseError(timeout)).toBe(true);
    expect(isRetryableLeaseError({ status: 429 })).toBe(true);
    expect(isRetryableLeaseError({ status: 503 })).toBe(true);
    expect(isRetryableLeaseError({ status: 500 })).toBe(true);
    expect(isRetryableLeaseError({ body: { error: { status: 'ABORTED' } } })).toBe(true);
    expect(isRetryableLeaseError({ status: 400, body: { error: { status: 'FAILED_PRECONDITION' } } })).toBe(true);
    expect(isRetryableLeaseError({ status: 400, body: { error: { status: 'INVALID_ARGUMENT' } } })).toBe(false);
    expect(isRetryableLeaseError({ status: 401 })).toBe(false);
    expect(isRetryableLeaseError(new Error('service account project_id is missing'))).toBe(false);
  });

  it('usa il resource name Firestore nei write di transazione, non l URL REST', () => {
    expect(firestoreDocumentName('frontaliere-ticino')).toBe(
      'projects/frontaliere-ticino/databases/(default)/documents/ci_leases/jobs-data-pipeline',
    );
    expect(firestoreDocumentName('frontaliere-ticino')).not.toContain('https://');
  });

  it('applica jitter deterministico ±20% e lo rende iniettabile', () => {
    expect(leasePollDelayMs(100, { owner: 'writer-a', jitter: () => 0 })).toBe(80);
    expect(leasePollDelayMs(100, { owner: 'writer-a', jitter: () => 0.5 })).toBe(100);
    expect(leasePollDelayMs(100, { owner: 'writer-a', jitter: () => 1 })).toBe(120);
    expect(leasePollDelayMs(100, { owner: 'writer-a' })).toBe(
      leasePollDelayMs(100, { owner: 'writer-a' }),
    );
  });

  describe('busy acquire result', () => {
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    function stubFirestore(documentResponse: () => Response) {
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (url.startsWith('https://oauth2.googleapis.com/')) return json(200, { access_token: 'token' });
        if (url.endsWith(':beginTransaction')) return json(200, { transaction: 'tx' });
        return documentResponse();
      }));
    }

    it('riporta owner, run e scadenza di chi detiene il lease', async () => {
      const expiresAt = new Date(Date.now() + 90 * 60_000).toISOString();
      stubFirestore(() => json(200, {
        updateTime: '2026-09-14T12:00:00.000Z',
        fields: {
          owner: { stringValue: 'org/repo:Crawler Group 19:123456:1' },
          repo: { stringValue: 'org/repo' },
          workflow: { stringValue: 'Crawler Group 19' },
          runId: { stringValue: '123456' },
          acquiredAt: { timestampValue: '2026-09-14T12:00:00.000Z' },
          expiresAt: { timestampValue: expiresAt },
        },
      }));

      const result = await acquireLease({ credentials: CREDENTIALS, owner: 'other-run', leaseDoc: 'ci_leases/test', waitMs: 0, ttlMs: 60_000 });
      expect(result).toMatchObject({
        busy: true,
        reason: 'active_owner',
        holder: { owner: 'org/repo:Crawler Group 19:123456:1', runId: '123456', workflow: 'Crawler Group 19', expiresAt },
      });
      expect(result.transientError).toBeUndefined();
      const message = describeLeaseBusy(result);
      expect(message).toContain('reason=active_owner');
      expect(message).toContain('run=https://github.com/org/repo/actions/runs/123456');
      expect(message).toContain(`expiresAt=${expiresAt} (90 min left)`);
    });

    it('usa una lettura senza lock mentre il lease resta attivo', async () => {
      const calls: string[] = [];
      const expiresAt = new Date(Date.now() + 90 * 60_000).toISOString();
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        calls.push(url);
        if (url.startsWith('https://oauth2.googleapis.com/')) return json(200, { access_token: 'token' });
        return json(200, {
          updateTime: '2026-09-14T12:00:00.000Z',
          fields: {
            owner: { stringValue: 'other-run' },
            expiresAt: { timestampValue: expiresAt },
          },
        });
      }));

      const result = await acquireLease({ credentials: CREDENTIALS, owner: 'this-run', waitMs: 0, ttlMs: 60_000 });

      expect(result.busy).toBe(true);
      expect(calls.some((url) => url.endsWith(':beginTransaction'))).toBe(false);
      expect(calls.some((url) => url.endsWith(':rollback'))).toBe(false);
      expect(calls.some((url) => url.includes('?transaction='))).toBe(false);
      expect(calls.some((url) => url.endsWith('/ci_leases/jobs-data-pipeline'))).toBe(true);
    });

    it('distingue un errore Firestore transitorio da un lease occupato', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      stubFirestore(() => json(503, { error: { status: 'UNAVAILABLE' } }));

      const result = await acquireLease({ credentials: CREDENTIALS, owner: 'other-run', leaseDoc: 'ci_leases/test', waitMs: 0, ttlMs: 60_000 });
      expect(result).toMatchObject({
        busy: true,
        transientError: true,
        reason: 'transient_error',
        error: 'Firestore REST request failed: 503',
      });
      expect(result.holder).toBeUndefined();
      expect(describeLeaseBusy(result)).toContain('this is not a lease conflict');
    });

    it('esegue rollback se il lease diventa attivo dopo lo snapshot lock-free', async () => {
      const requests: Array<{ url: string; body?: string }> = [];
      const expiresAt = new Date(Date.now() + 90 * 60_000).toISOString();
      const expiredAt = new Date(Date.now() - 60_000).toISOString();
      vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
        requests.push({ url, body: typeof init.body === 'string' ? init.body : undefined });
        if (url.startsWith('https://oauth2.googleapis.com/')) return json(200, { access_token: 'token' });
        if (url.endsWith(':beginTransaction')) return json(200, { transaction: 'tx-busy' });
        if (url.endsWith(':rollback')) return json(200, {});
        return json(200, {
          updateTime: '2026-09-14T12:00:00.000Z',
          fields: {
            owner: { stringValue: url.includes('?transaction=') ? 'other-run' : 'expired-owner' },
            expiresAt: { timestampValue: url.includes('?transaction=') ? expiresAt : expiredAt },
          },
        });
      }));

      const result = await acquireLease({ credentials: CREDENTIALS, owner: 'this-run', leaseDoc: 'ci_leases/test', waitMs: 0, ttlMs: 60_000 });

      expect(result.busy).toBe(true);
      const rollbacks = requests.filter(({ url }) => url.endsWith(':rollback'));
      expect(rollbacks).toHaveLength(1);
      expect(JSON.parse(rollbacks[0].body || '{}')).toEqual({ transaction: 'tx-busy' });
    });

    it('esegue rollback anche quando la lettura transazionale va in timeout', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const requests: string[] = [];
      const expiredAt = new Date(Date.now() - 60_000).toISOString();
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        requests.push(url);
        if (url.startsWith('https://oauth2.googleapis.com/')) return json(200, { access_token: 'token' });
        if (url.endsWith(':beginTransaction')) return json(200, { transaction: 'tx-error' });
        if (url.endsWith(':rollback')) return json(200, {});
        if (!url.includes('?transaction=')) {
          return json(200, {
            updateTime: '2026-09-14T12:00:00.000Z',
            fields: { owner: { stringValue: 'expired-owner' }, expiresAt: { timestampValue: expiredAt } },
          });
        }
        return json(503, { error: { status: 'UNAVAILABLE' } });
      }));

      const result = await acquireLease({ credentials: CREDENTIALS, owner: 'this-run', leaseDoc: 'ci_leases/test', waitMs: 0, ttlMs: 60_000 });

      expect(result).toMatchObject({ busy: true, transientError: true, reason: 'transient_error' });
      expect(requests.filter((url) => url.endsWith(':rollback'))).toHaveLength(1);
    });

    it('ritenta un conflitto con una transazione nuova e rilascia quella abortita', async () => {
      const calls: string[] = [];
      const expiredAt = new Date(Date.now() - 60_000).toISOString();
      let commitAttempts = 0;
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        calls.push(url);
        if (url.startsWith('https://oauth2.googleapis.com/')) return json(200, { access_token: 'token' });
        if (url.endsWith(':beginTransaction')) return json(200, { transaction: `tx-${calls.filter((item) => item.endsWith(':beginTransaction')).length}` });
        if (url.endsWith(':rollback')) return json(200, {});
        if (url.endsWith(':commit')) {
          commitAttempts += 1;
          return commitAttempts === 1
            ? json(409, { error: { status: 'ABORTED' } })
            : json(200, {});
        }
        return json(200, {
          updateTime: '2026-09-14T12:00:00.000Z',
          fields: { owner: { stringValue: 'expired-owner' }, expiresAt: { timestampValue: expiredAt } },
        });
      }));

      const result = await acquireLease({ credentials: CREDENTIALS, owner: 'this-run', leaseDoc: 'ci_leases/test', waitMs: 0, ttlMs: 60_000 });

      expect(result).toMatchObject({ acquired: true, busy: false });
      expect(calls.filter((url) => url.endsWith(':beginTransaction'))).toHaveLength(2);
      expect(calls.filter((url) => url.endsWith(':rollback'))).toHaveLength(1);
    });

    it('ritenta la gara acquire quando la precondizione stantia restituisce 400', async () => {
      const expiredAt = new Date(NOW - 60_000).toISOString();
      const initialUpdateTime = '2026-09-14T11:59:00.000Z';
      const committedUpdateTime = '2026-09-14T12:00:01.000Z';
      let snapshotReads = 0;
      let transactions = 0;
      let transactionalReads = 0;
      let commitAttempts = 0;
      let winner = '';
      let releaseSnapshots: () => void = () => {};
      let releaseTransactionalReads: () => void = () => {};
      const snapshotsReady = new Promise<void>((resolve) => {
        releaseSnapshots = resolve;
      });
      const transactionalReadsReady = new Promise<void>((resolve) => {
        releaseTransactionalReads = resolve;
      });
      const expiredLease = {
        owner: 'expired-owner',
        repo: 'org/repo',
        workflow: 'lease-test',
        runId: 'expired-run',
        acquiredAt: '2026-09-14T11:00:00.000Z',
        heartbeatAt: '2026-09-14T11:59:00.000Z',
        expiresAt: expiredAt,
      };
      const activeLease = {
        ...expiredLease,
        expiresAt: new Date(NOW + 60_000).toISOString(),
      };

      vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
        if (url.startsWith('https://oauth2.googleapis.com/')) return json(200, { access_token: 'token' });
        if (url.endsWith(':beginTransaction')) {
          return json(200, { transaction: `tx-${++transactions}` });
        }
        if (url.endsWith(':rollback')) return json(200, {});
        if (url.endsWith(':commit')) {
          commitAttempts += 1;
          if (commitAttempts === 1) {
            const body = JSON.parse(String(init.body || '{}')) as {
              writes?: Array<{
                update?: {
                  fields?: Record<string, { stringValue?: string }>;
                };
              }>;
            };
            winner = body.writes?.[0]?.update?.fields?.owner?.stringValue || '';
            return json(200, { commitTime: committedUpdateTime });
          }
          return json(400, { error: { status: 'FAILED_PRECONDITION' } });
        }
        if (url.includes('?transaction=')) {
          transactionalReads += 1;
          if (transactionalReads <= 2) {
            if (transactionalReads === 2) releaseTransactionalReads();
            await transactionalReadsReady;
            return json(200, leaseDocument(expiredLease, initialUpdateTime));
          }
          return json(200, leaseDocument({ ...activeLease, owner: winner }, committedUpdateTime));
        }
        snapshotReads += 1;
        if (snapshotReads === 2) releaseSnapshots();
        await snapshotsReady;
        return json(200, leaseDocument(expiredLease, initialUpdateTime));
      }));

      const results = await Promise.allSettled([
        acquireLease({
          credentials: CREDENTIALS,
          owner: 'acquire-a',
          leaseDoc: 'ci_leases/test',
          now: NOW,
          waitMs: 0,
          ttlMs: 60_000,
          sleep: async () => {},
        }),
        acquireLease({
          credentials: CREDENTIALS,
          owner: 'acquire-b',
          leaseDoc: 'ci_leases/test',
          now: NOW,
          waitMs: 0,
          ttlMs: 60_000,
          sleep: async () => {},
        }),
      ]);
      const values = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);

      expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
      expect(values.filter((result) => result.acquired)).toHaveLength(1);
      expect(values.filter((result) => result.busy)).toHaveLength(1);
      expect(commitAttempts).toBe(2);
    });

    it('rilascia il lock di release non-owner', async () => {
      const calls: string[] = [];
      const expiresAt = new Date(Date.now() + 90 * 60_000).toISOString();
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        calls.push(url);
        if (url.startsWith('https://oauth2.googleapis.com/')) return json(200, { access_token: 'token' });
        if (url.endsWith(':beginTransaction')) return json(200, { transaction: 'tx-release' });
        if (url.endsWith(':rollback')) return json(200, {});
        return json(200, {
          updateTime: '2026-09-14T12:00:00.000Z',
          fields: { owner: { stringValue: 'other-run' }, expiresAt: { timestampValue: expiresAt } },
        });
      }));

      const result = await releaseLease({ credentials: CREDENTIALS, owner: 'this-run', leaseDoc: 'ci_leases/test', ttlMs: 60_000 });

      expect(result).toMatchObject({ released: false, busy: false, notOwner: true, contended: true });
      expect(calls.filter((url) => url.endsWith(':rollback'))).toHaveLength(1);
    });

    it('segnala una scadenza malformata invece di una scadenza inventata', () => {
      const message = describeLeaseBusy({
        busy: true,
        reason: 'malformed_expiry',
        holder: { owner: 'run-b', runId: 'abc', expiresAt: 'not-a-timestamp' },
      });
      expect(message).toContain('reason=malformed_expiry');
      expect(message).toContain('expiresAt="not-a-timestamp" (malformed');
      expect(message).not.toContain('run=https://');
    });

    it('conserva l errore di commit se anche il rollback fallisce', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const calls: string[] = [];
      const expiredAt = new Date(Date.now() - 60_000).toISOString();
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        calls.push(url);
        if (url.startsWith('https://oauth2.googleapis.com/')) return firestoreResponse(200, { access_token: 'token' });
        if (url.endsWith(':beginTransaction')) return firestoreResponse(200, { transaction: 'tx-commit-error' });
        if (url.endsWith(':rollback')) return firestoreResponse(503, { error: { status: 'UNAVAILABLE' } });
        if (url.endsWith(':commit')) return firestoreResponse(400, { error: { status: 'INVALID_ARGUMENT' } });
        return firestoreResponse(200, leaseDocument({
          owner: 'expired-owner',
          expiresAt: expiredAt,
        }, '2026-09-14T12:00:00.000Z'));
      }));

      await expect(acquireLease({ credentials: CREDENTIALS, owner: 'this-run', leaseDoc: 'ci_leases/test', waitMs: 0, ttlMs: 60_000 }))
        .rejects.toThrow('Firestore REST request failed: 400');
      expect(calls.filter((url) => url.endsWith(':rollback'))).toHaveLength(1);
    });

    it('interrompe dopo tre errori transitori consecutivi e conserva l ultimo holder', async () => {
      const expiresAt = new Date(NOW + 60_000).toISOString();
      let documentReads = 0;
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (url.startsWith('https://oauth2.googleapis.com/')) return json(200, { access_token: 'token' });
        if (url.endsWith(':beginTransaction')) return json(200, { transaction: 'tx' });
        documentReads += 1;
        if (documentReads === 1) {
          return json(200, {
            updateTime: '2026-09-14T12:00:00.000Z',
            fields: {
              owner: { stringValue: 'active-owner' },
              expiresAt: { timestampValue: expiresAt },
            },
          });
        }
        return json(503, { error: { status: 'UNAVAILABLE' } });
      }));

      const result = await acquireLease({
        credentials: CREDENTIALS,
        owner: 'waiting-owner',
        leaseDoc: 'ci_leases/test',
        now: NOW,
        waitMs: 60_000,
        pollMs: 1,
        sleep: async () => {},
        jitter: () => 0.5,
        transientErrorLimit: GLOBAL_DATA_PIPELINE_LEASE_TRANSIENT_ERROR_LIMIT,
      });

      expect(result).toMatchObject({
        busy: true,
        transientError: true,
        reason: 'transient_error',
        transientErrorCount: GLOBAL_DATA_PIPELINE_LEASE_TRANSIENT_ERROR_LIMIT,
        lastHolder: { owner: 'active-owner', expiresAt },
      });
      expect(describeLeaseBusy(result, NOW)).toContain('owner=active-owner');
      expect(describeLeaseBusy(result, NOW)).toContain(`expiresAt=${expiresAt}`);
      expect(describeLeaseBusy(result, NOW)).toContain('expired=no');
      expect(GLOBAL_DATA_PIPELINE_LEASE_TRANSIENT_ERROR_EXIT).toBe(45);
    });

    it('ritenta il release entro la finestra e indica la contesa', async () => {
      const server = new PessimisticFirestore({
        owner: 'release-owner',
        repo: 'org/repo',
        workflow: 'active-workflow',
        runId: 'active-run',
        acquiredAt: '2026-09-14T11:00:00.000Z',
        heartbeatAt: '2026-09-14T11:59:00.000Z',
        expiresAt: '2026-09-14T13:00:00.000Z',
      });
      server.failNextCommitConflict = true;
      vi.stubGlobal('fetch', server.fetch.bind(server));

      const released = await releaseLease({
        credentials: CREDENTIALS,
        owner: 'release-owner',
        leaseDoc: 'ci_leases/test',
        waitMs: 60,
        pollMs: 1,
        sleep: async () => {},
      });

      expect(released).toMatchObject({ released: true, attempts: 2, contended: true });
      expect(server.lease).toBeNull();
      expect(describeLeaseRelease(released)).toContain('contended=yes');
    });

    it('ritenta il release quando lo scambio OAuth risponde con HTTP 503', async () => {
      const server = new PessimisticFirestore({
        owner: 'release-owner',
        repo: 'org/repo',
        workflow: 'active-workflow',
        runId: 'active-run',
        acquiredAt: '2026-09-14T11:00:00.000Z',
        heartbeatAt: '2026-09-14T11:59:00.000Z',
        expiresAt: '2026-09-14T13:00:00.000Z',
      });
      let tokenRequests = 0;
      vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        if (url.startsWith('https://oauth2.googleapis.com/')) {
          tokenRequests += 1;
          if (tokenRequests === 1) return json(503, { error: 'temporarily_unavailable' });
        }
        return server.fetch(url, init);
      }));

      const released = await releaseLease({
        credentials: CREDENTIALS,
        owner: 'release-owner',
        leaseDoc: 'ci_leases/test',
        waitMs: 60,
        pollMs: 1,
        sleep: async () => {},
      });

      expect(released).toMatchObject({ released: true, attempts: 2 });
      expect(tokenRequests).toBe(2);
      expect(server.lease).toBeNull();
    });

    it('ritenta il release oltre tre conflitti fino al quarto commit entro 60 secondi', async () => {
      let clock = NOW;
      const sleepDelays: number[] = [];
      let commitAttempts = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => clock);
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (url.startsWith('https://oauth2.googleapis.com/')) return json(200, { access_token: 'token' });
        if (url.endsWith(':beginTransaction')) return json(200, { transaction: `tx-${commitAttempts + 1}` });
        if (url.endsWith(':rollback')) return json(200, {});
        if (url.endsWith(':commit')) {
          commitAttempts += 1;
          return commitAttempts <= 3
            ? json(400, { error: { status: 'FAILED_PRECONDITION' } })
            : json(200, {});
        }
        return json(200, leaseDocument({
          owner: 'release-owner',
          repo: 'org/repo',
          workflow: 'active-workflow',
          runId: 'active-run',
          acquiredAt: '2026-09-14T11:00:00.000Z',
          heartbeatAt: '2026-09-14T11:59:00.000Z',
          expiresAt: '2026-09-14T13:00:00.000Z',
        }, '2026-09-14T11:59:00.000Z'));
      }));

      const released = await releaseLease({
        credentials: CREDENTIALS,
        owner: 'release-owner',
        leaseDoc: 'ci_leases/test',
        waitMs: 60_000,
        pollMs: 2_000,
        jitter: () => 0.5,
        sleep: async (delay: number) => {
          sleepDelays.push(delay);
          clock += delay;
        },
      });

      expect(released).toMatchObject({ released: true, attempts: 4, contended: true });
      expect(commitAttempts).toBe(4);
      expect(sleepDelays).toEqual([2_000, 2_000, 2_000]);
      expect(clock - NOW).toBeLessThan(60_000);
      expect(released.releaseFailed).toBeUndefined();
    });
  });
});
