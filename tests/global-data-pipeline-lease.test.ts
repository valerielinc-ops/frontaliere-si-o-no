import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  GLOBAL_DATA_PIPELINE_LEASE_BUSY_EXIT,
  GLOBAL_DATA_PIPELINE_LEASE_POLL_MS,
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
    expect(GLOBAL_DATA_PIPELINE_LEASE_WAIT_MS).toBe(300_000);
    expect(GLOBAL_DATA_PIPELINE_LEASE_POLL_MS).toBe(5_000);
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
