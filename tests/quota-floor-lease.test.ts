import { describe, expect, it } from 'vitest';
import {
  acquireQuotaFloorLease,
  parseQuotaFloorLedger,
  quotaFloorFairnessDecision,
  quotaFloorLeaseDecision,
  quotaFloorLeaseExpiry,
  quotaFloorLeaseMarker,
  quotaFloorLeaseOwner,
  quotaFloorReleaseMarker,
  releaseQuotaFloorLease,
} from '../scripts/ci/quota-floor-lease.mjs';
import { quotaFloorLeaseAdmission } from '../scripts/ci/check-quota-backoff.mjs';

describe('shared quota-floor lease ledger', () => {
  const lease = quotaFloorLeaseMarker({
    kind: 'issue-fix',
    subject: 'issue-123',
    owner: 'issue-fix:issue-123:run-1:1',
    expiresAt: 2_000,
  });

  it('counts only unexpired, unreleased leases', () => {
    const ledger = parseQuotaFloorLedger([
      [{ id: 1, body: lease }],
      [{ id: 2, body: quotaFloorReleaseMarker('issue-fix:issue-123:run-1:1') }],
      [{ id: 3, body: quotaFloorLeaseMarker({
        kind: 'repair', subject: 'pr-456', owner: 'repair:pr-456:run-2:1', expiresAt: 999,
      }) }],
    ], { nowSec: 1_000 });

    expect(ledger).toMatchObject({
      ok: true,
      activeCounts: { repair: 0, 'issue-fix': 0 },
    });
    expect(ledger.activeLeases).toEqual([]);
    expect(ledger.leases).toHaveLength(2);
  });

  it('fails closed on an invalid marker instead of treating it as an empty ledger', () => {
    const ledger = parseQuotaFloorLedger([
      { body: '<!-- QUOTA_FLOOR_LEASE v1 kind=repair subject=pr-1 owner=bad value -->' },
    ], { nowSec: 1_000 });
    expect(ledger.ok).toBe(false);
    expect(ledger.activeLeases).toEqual([]);
  });

  it('fails closed when an owner is reused for a second active lease', () => {
    const duplicate = quotaFloorLeaseMarker({
      kind: 'repair',
      subject: 'pr-456',
      owner: 'repair:pr-456:run-1:1',
      expiresAt: 3_000,
    });
    const ledger = parseQuotaFloorLedger([
      { body: quotaFloorLeaseMarker({
        kind: 'repair', subject: 'pr-123', owner: 'repair:pr-456:run-1:1', expiresAt: 2_000,
      }) },
      { body: duplicate },
    ], { nowSec: 1_000 });
    expect(ledger.ok).toBe(false);
    expect(ledger.activeLeases).toEqual([]);
  });

  it('reuses one subject lease and rejects ambiguous concurrent reservations', () => {
    const first = parseQuotaFloorLedger([{ body: lease }], { nowSec: 1_000 });
    expect(quotaFloorLeaseDecision(first, { kind: 'issue-fix', subject: 'issue-123' }))
      .toMatchObject({ admit: true, existing: { owner: 'issue-fix:issue-123:run-1:1' } });

    const second = parseQuotaFloorLedger([
      { body: lease },
      { body: quotaFloorLeaseMarker({
        kind: 'issue-fix', subject: 'issue-123', owner: 'issue-fix:issue-123:run-2:1', expiresAt: 3_000,
      }) },
    ], { nowSec: 1_000 });
    expect(quotaFloorLeaseDecision(second, { kind: 'issue-fix', subject: 'issue-123' }))
      .toMatchObject({ admit: false, reason: 'multiple active quota floor leases for subject' });
  });

  it('keeps the peer fairness rule deterministic and fail-closed', () => {
    expect(quotaFloorFairnessDecision({ nowHour: 7, reservedHours: '7', peerQueue: 10, peerQueueMin: 10 }))
      .toMatchObject({ ok: true, hold: true });
    expect(quotaFloorFairnessDecision({ nowHour: 8, reservedHours: '7', peerQueue: 99, peerQueueMin: 10 }).hold)
      .toBe(false);
    expect(quotaFloorFairnessDecision({ nowHour: 7, reservedHours: '7', peerQueue: null, peerQueueMin: 10 }))
      .toMatchObject({ ok: false, hold: true });
    expect(quotaFloorFairnessDecision({ nowHour: 7, reservedHours: '7,not-an-hour', peerQueue: 10, peerQueueMin: 10 }))
      .toMatchObject({ ok: false, hold: true });
  });

  it('emits append-only acquire/release markers through the injected command', () => {
    const commands: string[][] = [];
    const owner = quotaFloorLeaseOwner({ kind: 'repair', subject: 'pr-9', runId: 'run-9', attempt: '1' });
    expect(acquireQuotaFloorLease({
      repo: 'owner/repo', ledgerIssue: '8306', kind: 'repair', subject: 'pr-9', owner, expiresAt: quotaFloorLeaseExpiry(1_000, 60),
      runCommand: (args) => { commands.push(args); },
    }).ok).toBe(true);
    expect(releaseQuotaFloorLease({
      repo: 'owner/repo', ledgerIssue: '8306', owner,
      runCommand: (args) => { commands.push(args); },
    }).ok).toBe(true);
    expect(commands).toHaveLength(2);
    expect(commands[0].join(' ')).toContain('QUOTA_FLOOR_LEASE');
    expect(commands[1].join(' ')).toContain('QUOTA_FLOOR_RELEASE');
  });

  it('gates the check-quota adapter before provider work and releases only its owner', () => {
    const owner = quotaFloorLeaseOwner({ kind: 'issue-fix', subject: 'issue-123', runId: 'run-1', attempt: '1' });
    const marker = quotaFloorLeaseMarker({ kind: 'issue-fix', subject: 'issue-123', owner, expiresAt: 2_000 });
    const commands: string[][] = [];
    const runJson = () => [{ id: 1, body: marker }];

    expect(quotaFloorLeaseAdmission({
      required: true,
      action: 'acquire',
      kind: 'issue-fix',
      repo: 'owner/repo',
      subject: 'issue-123',
      nowSec: 1_000,
      runId: 'run-1',
      attempt: '1',
      runJson,
      runCommand: (args) => { commands.push(args); },
    })).toMatchObject({ admit: true, acquired: true, owner });
    expect(commands).toHaveLength(0);

    expect(quotaFloorLeaseAdmission({
      required: true,
      action: 'release',
      kind: 'issue-fix',
      repo: 'owner/repo',
      subject: 'issue-123',
      owner,
      nowSec: 1_000,
      runJson,
      runCommand: (args) => { commands.push(args); },
    })).toMatchObject({ admit: true, reason: 'lease released' });
    expect(commands).toHaveLength(1);
    expect(commands[0].join(' ')).toContain('QUOTA_FLOOR_RELEASE');

    expect(quotaFloorLeaseAdmission({
      required: true,
      action: 'release',
      kind: 'issue-fix',
      repo: 'owner/repo',
      subject: 'issue-123',
      owner: 'issue-fix:issue-123:other:1',
      nowSec: 1_000,
      runJson,
    })).toMatchObject({ admit: false, reason: 'quota floor release owner mismatch' });
  });
});
