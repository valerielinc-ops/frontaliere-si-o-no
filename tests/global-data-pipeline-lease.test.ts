import fs from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GLOBAL_DATA_PIPELINE_LEASE_BUSY_EXIT,
  GLOBAL_DATA_PIPELINE_LEASE_POLL_MS,
  GLOBAL_DATA_PIPELINE_LEASE_TTL_MS,
  GLOBAL_DATA_PIPELINE_LEASE_WAIT_MS,
  acquireLease,
  describeLeaseBusy,
  firestoreDocumentName,
  isRetryableLeaseError,
  leaseDecision,
  releaseLease,
} from '../scripts/lib/global-data-pipeline-lease.mjs';

const NOW = Date.parse('2026-09-14T12:00:00.000Z');

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
  });

  it('ritenta timeout e transient Firestore, ma non errori permanenti', () => {
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    expect(isRetryableLeaseError(timeout)).toBe(true);
    expect(isRetryableLeaseError({ status: 503 })).toBe(true);
    expect(isRetryableLeaseError({ body: { error: { status: 'ABORTED' } } })).toBe(true);
    expect(isRetryableLeaseError({ status: 401 })).toBe(false);
    expect(isRetryableLeaseError(new Error('service account project_id is missing'))).toBe(false);
  });

  it('usa il resource name Firestore nei write di transazione, non l URL REST', () => {
    expect(firestoreDocumentName('frontaliere-ticino')).toBe(
      'projects/frontaliere-ticino/databases/(default)/documents/ci_leases/jobs-data-pipeline',
    );
    expect(firestoreDocumentName('frontaliere-ticino')).not.toContain('https://');
  });

  describe('busy acquire result', () => {
    const credentials = {
      project_id: 'frontaliere-ticino',
      client_email: 'lease-test@example.iam.gserviceaccount.com',
      private_key: generateKeyPairSync('rsa', { modulusLength: 2048 })
        .privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    };
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

      const result = await acquireLease({ credentials, owner: 'other-run', leaseDoc: 'ci_leases/test', waitMs: 0, ttlMs: 60_000 });
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

      const result = await acquireLease({ credentials, owner: 'this-run', waitMs: 0, ttlMs: 60_000 });

      expect(result.busy).toBe(true);
      expect(calls.some((url) => url.endsWith(':beginTransaction'))).toBe(false);
      expect(calls.some((url) => url.endsWith(':rollback'))).toBe(false);
      expect(calls.some((url) => url.includes('?transaction='))).toBe(false);
      expect(calls.some((url) => url.endsWith('/ci_leases/jobs-data-pipeline'))).toBe(true);
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

    it('distingue un errore Firestore transitorio da un lease occupato', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      stubFirestore(() => json(503, { error: { status: 'UNAVAILABLE' } }));

      const result = await acquireLease({ credentials, owner: 'other-run', leaseDoc: 'ci_leases/test', waitMs: 0, ttlMs: 60_000 });
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

      const result = await acquireLease({ credentials, owner: 'this-run', leaseDoc: 'ci_leases/test', waitMs: 0, ttlMs: 60_000 });

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

      const result = await acquireLease({ credentials, owner: 'this-run', leaseDoc: 'ci_leases/test', waitMs: 0, ttlMs: 60_000 });

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

      const result = await acquireLease({ credentials, owner: 'this-run', leaseDoc: 'ci_leases/test', waitMs: 0, ttlMs: 60_000 });

      expect(result).toMatchObject({ acquired: true, busy: false });
      expect(calls.filter((url) => url.endsWith(':beginTransaction'))).toHaveLength(2);
      expect(calls.filter((url) => url.endsWith(':rollback'))).toHaveLength(1);
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

      const result = await releaseLease({ credentials, owner: 'this-run', leaseDoc: 'ci_leases/test', ttlMs: 60_000 });

      expect(result).toMatchObject({ released: false, busy: false, notOwner: true });
      expect(calls.filter((url) => url.endsWith(':rollback'))).toHaveLength(1);
    });

    it('conserva l errore di commit se anche il rollback fallisce', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const calls: string[] = [];
      const expiredAt = new Date(Date.now() - 60_000).toISOString();
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        calls.push(url);
        if (url.startsWith('https://oauth2.googleapis.com/')) return json(200, { access_token: 'token' });
        if (url.endsWith(':beginTransaction')) return json(200, { transaction: 'tx-commit-error' });
        if (url.endsWith(':rollback')) return json(503, { error: { status: 'UNAVAILABLE' } });
        if (url.endsWith(':commit')) return json(400, { error: { status: 'INVALID_ARGUMENT' } });
        return json(200, {
          updateTime: '2026-09-14T12:00:00.000Z',
          fields: { owner: { stringValue: 'expired-owner' }, expiresAt: { timestampValue: expiredAt } },
        });
      }));

      await expect(acquireLease({ credentials, owner: 'this-run', leaseDoc: 'ci_leases/test', waitMs: 0, ttlMs: 60_000 }))
        .rejects.toThrow('Firestore REST request failed: 400');
      expect(calls.filter((url) => url.endsWith(':rollback'))).toHaveLength(1);
    });
  });
});
