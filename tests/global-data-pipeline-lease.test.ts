import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  GLOBAL_DATA_PIPELINE_LEASE_BUSY_EXIT,
  GLOBAL_DATA_PIPELINE_LEASE_POLL_MS,
  GLOBAL_DATA_PIPELINE_LEASE_TTL_MS,
  GLOBAL_DATA_PIPELINE_LEASE_WAIT_MS,
  firestoreDocumentName,
  isRetryableLeaseError,
  leaseDecision,
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
});
