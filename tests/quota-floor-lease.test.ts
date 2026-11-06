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
  QUOTA_FLOOR_LEDGER_ISSUE,
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

  it('posts one lease comment and deletes that exact comment on release', () => {
    const commands: string[][] = [];
    const owner = quotaFloorLeaseOwner({ kind: 'repair', subject: 'pr-9', runId: 'run-9', attempt: '1' });
    const acquired = acquireQuotaFloorLease({
      repo: 'owner/repo', kind: 'repair', subject: 'pr-9', owner, expiresAt: quotaFloorLeaseExpiry(1_000, 60),
      runCommand: (args) => { commands.push(args); return JSON.stringify({ id: 91 }); },
    });
    const released = releaseQuotaFloorLease({
      repo: 'owner/repo', owner, commentId: acquired.commentId,
      runCommand: (args) => { commands.push(args); },
    });
    expect(acquired.ok).toBe(true);
    expect(released.ok).toBe(true);
    expect(commands).toEqual([
      [
        'api', '--method', 'POST', `repos/owner/repo/issues/${QUOTA_FLOOR_LEDGER_ISSUE}/comments`, '--raw-field',
        `body=${acquired.marker}`,
      ],
      [
        'api', '--method', 'DELETE', 'repos/owner/repo/issues/comments/91',
      ],
    ]);
  });

  it('fails closed when GitHub does not return the created comment id', () => {
    expect(acquireQuotaFloorLease({
      repo: 'owner/repo', kind: 'repair', subject: 'pr-9',
      owner: 'repair:pr-9:run-9:1', expiresAt: 2_000,
      runCommand: () => '{}',
    })).toMatchObject({ ok: false, reason: expect.stringContaining('commentId') });
  });

  it('does not release a reservation reused from another run', () => {
    const winnerOwner = quotaFloorLeaseOwner({ kind: 'issue-fix', subject: 'issue-123', runId: 'winner', attempt: '1' });
    const marker = quotaFloorLeaseMarker({ kind: 'issue-fix', subject: 'issue-123', owner: winnerOwner, expiresAt: 2_000 });
    const commands: string[][] = [];
    const runJson = () => [{ id: 1, body: marker }];

    expect(quotaFloorLeaseAdmission({
      required: true,
      action: 'acquire',
      kind: 'issue-fix',
      repo: 'owner/repo',
      subject: 'issue-123',
      nowSec: 1_000,
      runId: 'loser',
      attempt: '1',
      runJson,
      runCommand: (args) => { commands.push(args); },
    })).toMatchObject({ admit: true, acquired: false, owned: false, reused: true, owner: winnerOwner });
    expect(commands).toHaveLength(0);

    expect(quotaFloorLeaseAdmission({
      required: true,
      action: 'release',
      kind: 'issue-fix',
      repo: 'owner/repo',
      subject: 'issue-123',
      owner: winnerOwner,
      nowSec: 1_000,
      runId: 'loser',
      attempt: '1',
      runJson,
      runCommand: (args) => { commands.push(args); },
    })).toMatchObject({ admit: false, reason: 'quota floor release owner mismatch' });
    expect(commands).toHaveLength(0);
  });

  it('gates provider work and releases only a lease acquired by the current run', () => {
    const owner = quotaFloorLeaseOwner({ kind: 'issue-fix', subject: 'issue-123', runId: 'run-1', attempt: '1' });
    const marker = quotaFloorLeaseMarker({ kind: 'issue-fix', subject: 'issue-123', owner, expiresAt: 2_000 });
    const commands: string[][] = [];

    expect(quotaFloorLeaseAdmission({
      required: true,
      action: 'acquire',
      kind: 'issue-fix',
      repo: 'owner/repo',
      subject: 'issue-123',
      nowSec: 1_000,
      runId: 'run-1',
      attempt: '1',
      runJson: () => [],
      runCommand: (args) => { commands.push(args); return JSON.stringify({ id: 77 }); },
    })).toMatchObject({ admit: true, acquired: true, owned: true, reused: false, owner });
    expect(commands).toHaveLength(1);

    expect(quotaFloorLeaseAdmission({
      required: true,
      action: 'release',
      kind: 'issue-fix',
      repo: 'owner/repo',
      subject: 'issue-123',
      owner,
      nowSec: 1_000,
      runId: 'run-1',
      attempt: '1',
      runJson: () => [{ id: 1, body: marker }],
      runCommand: (args) => { commands.push(args); },
    })).toMatchObject({ admit: true, reason: 'lease released' });
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(['api', '--method', 'DELETE', 'repos/owner/repo/issues/comments/1']);

    expect(quotaFloorLeaseAdmission({
      required: true,
      action: 'release',
      kind: 'issue-fix',
      repo: 'owner/repo',
      subject: 'issue-123',
      owner: 'issue-fix:issue-123:other:1',
      nowSec: 1_000,
      runJson: () => [{ id: 1, body: marker }],
    })).toMatchObject({ admit: false, reason: 'quota floor release owner mismatch' });
  });
});
