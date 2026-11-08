import { describe, expect, it, vi } from 'vitest';
import { FieldValue } from 'firebase-admin/firestore';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import {
  conciergeMatchingRuntimeRef,
  mergeConciergeMatchingRuntime,
  updateConciergeMatchingRuntime,
} from '../functions/src/applicationConciergeRuntime.js';

const SERVICE_PATH = 'application_concierge_services/service-1';

vi.mock('firebase-admin/firestore', () => {
  class DeleteTransform {}
  return {
    FieldValue: {
      delete: () => new DeleteTransform(),
      serverTimestamp: () => '__server_timestamp__',
      increment: (value: number) => ({ __increment: value }),
    },
    Timestamp: { now: () => new Date(), fromMillis: (value: number) => new Date(value) },
  };
});

describe('application concierge matching runtime document', () => {
  it('keeps legacy parent fields readable before a runtime document exists', () => {
    const legacy = {
      matchingScanCursor: 'legacy-cursor',
      matchingOpenProposalCount: 2,
      proposalRefreshWorkerLeaseId: 'legacy-lease',
    };

    expect(mergeConciergeMatchingRuntime(legacy)).toEqual(legacy);
  });

  it('keeps parent fallbacks readable while migrating an older runtime schema', async () => {
    const store = createMemoryFirestore({
      [SERVICE_PATH]: {
        matchingOpenProposalCount: 4,
        matchingEligibilityRecoveryCount: 4,
        matchingEligibilityRecoveryDurationMsTotal: 1200,
      },
      [`${SERVICE_PATH}/runtime/matching`]: {
        schemaVersion: 1,
        matchingOpenProposalCount: 1,
        matchingEligibilityRecoveryCount: 7,
        matchingScanCursor: 'old-runtime-cursor',
      },
    });
    const serviceRef = store.db.collection('application_concierge_services').doc('service-1');

    expect(mergeConciergeMatchingRuntime(store.read(SERVICE_PATH), store.read(`${SERVICE_PATH}/runtime/matching`)))
      .toMatchObject({ matchingOpenProposalCount: 1, matchingEligibilityRecoveryCount: 7, matchingScanCursor: 'old-runtime-cursor' });

    await updateConciergeMatchingRuntime({ db: store.db, serviceRef, patch: { matchingScanContext: 'new-context' } });

    expect(store.read(`${SERVICE_PATH}/runtime/matching`)).toMatchObject({
      schemaVersion: 3,
      matchingOpenProposalCount: 1,
      matchingEligibilityRecoveryCount: 7,
      matchingEligibilityRecoveryDurationMsTotal: 1200,
      matchingScanCursor: 'old-runtime-cursor',
      matchingScanContext: 'new-context',
    });
    expect(store.read(SERVICE_PATH)).toMatchObject({ matchingOpenProposalCount: 4 });
    expect(store.read(SERVICE_PATH)).not.toHaveProperty('matchingEligibilityRecoveryCount');
  });

  it('lazily migrates operational fields and keeps the parent proposal count as a compatibility mirror', async () => {
    const store = createMemoryFirestore({
      [SERVICE_PATH]: {
        matchingStatus: 'running',
        matchingScanCursor: 'legacy-cursor',
        matchingScanContext: 'legacy-context',
        matchingOpenProposalCount: 2,
        proposalRefreshWorkerLeaseId: 'legacy-lease',
      },
    });
    const serviceRef = store.db.collection('application_concierge_services').doc('service-1');

    await updateConciergeMatchingRuntime({
      db: store.db,
      serviceRef,
      patch: { matchingScanCursor: 'current-cursor', proposalRefreshWorkerLeaseId: FieldValue.delete() },
    });

    const parent = store.read(SERVICE_PATH)!;
    const runtime = store.read(`${SERVICE_PATH}/runtime/matching`)!;
    expect(parent).toMatchObject({ matchingStatus: 'running', matchingOpenProposalCount: 2 });
    expect(parent).not.toHaveProperty('matchingScanCursor');
    expect(parent).not.toHaveProperty('matchingScanContext');
    expect(parent).not.toHaveProperty('proposalRefreshWorkerLeaseId');
    expect(runtime).toMatchObject({ schemaVersion: 3, matchingOpenProposalCount: 2, matchingScanCursor: 'current-cursor' });
    expect(runtime).not.toHaveProperty('proposalRefreshWorkerLeaseId');
    expect(mergeConciergeMatchingRuntime(parent, runtime)).toMatchObject({
      matchingStatus: 'running', matchingOpenProposalCount: 2, matchingScanCursor: 'current-cursor',
    });
    expect(mergeConciergeMatchingRuntime(parent, runtime)).not.toHaveProperty('proposalRefreshWorkerLeaseId');
    expect(conciergeMatchingRuntimeRef(serviceRef).path).toBe(`${SERVICE_PATH}/runtime/matching`);
  });

  it('overlays a transient runtime running state while preserving the parent terminal state', () => {
    const parent = { matchingStatus: 'complete', matchingError: null };
    expect(mergeConciergeMatchingRuntime(parent, {
      schemaVersion: 3,
      matchingRunStatus: 'running',
    })).toMatchObject({ matchingStatus: 'running' });
    expect(mergeConciergeMatchingRuntime(parent, {
      schemaVersion: 3,
    })).toMatchObject({ matchingStatus: 'complete' });
  });

  it('migrates completion and notice markers off the parent and clears only the transient run state', async () => {
    const store = createMemoryFirestore({
      [SERVICE_PATH]: {
        matchingStatus: 'complete',
        proposalRefreshCompletedRequestId: 'legacy-request',
        proposalRefreshLastError: 'matching_failed',
        pendingProposalNotice: { key: 'legacy-notice', proposalIds: ['proposal-1'] },
      },
    });
    const serviceRef = store.db.collection('application_concierge_services').doc('service-1');
    const runtimePath = `${SERVICE_PATH}/runtime/matching`;

    await updateConciergeMatchingRuntime({ db: store.db, serviceRef, patch: { matchingRunStatus: 'running' } });

    expect(store.read(SERVICE_PATH)).not.toHaveProperty('pendingProposalNotice');
    expect(store.read(SERVICE_PATH)).not.toHaveProperty('proposalRefreshCompletedRequestId');
    expect(store.read(SERVICE_PATH)).not.toHaveProperty('proposalRefreshLastError');
    expect(store.read(SERVICE_PATH)).toMatchObject({ matchingStatus: 'complete' });
    expect(store.read(runtimePath)).toMatchObject({
      schemaVersion: 3,
      matchingRunStatus: 'running',
      proposalRefreshCompletedRequestId: 'legacy-request',
      proposalRefreshLastError: 'matching_failed',
      pendingProposalNotice: { key: 'legacy-notice', proposalIds: ['proposal-1'] },
    });
    expect(mergeConciergeMatchingRuntime(store.read(SERVICE_PATH), store.read(runtimePath)))
      .toMatchObject({ matchingStatus: 'running', pendingProposalNotice: { key: 'legacy-notice' } });

    await updateConciergeMatchingRuntime({
      db: store.db,
      serviceRef,
      patch: { matchingRunStatus: FieldValue.delete() },
    });

    expect(mergeConciergeMatchingRuntime(store.read(SERVICE_PATH), store.read(runtimePath)))
      .toMatchObject({ matchingStatus: 'complete', pendingProposalNotice: { key: 'legacy-notice' } });
  });

  it('upgrades an existing schema v2 runtime without replacing its newer operational values', async () => {
    const store = createMemoryFirestore({
      [SERVICE_PATH]: {
        matchingStatus: 'complete',
        matchingOpenProposalCount: 2,
        proposalRefreshCompletedRequestId: 'legacy-v2-request',
        pendingProposalNotice: { key: 'legacy-v2-notice', proposalIds: ['proposal-2'] },
      },
      [`${SERVICE_PATH}/runtime/matching`]: {
        schemaVersion: 2,
        matchingOpenProposalCount: 1,
        matchingScanCursor: 'newer-runtime-cursor',
      },
    });
    const serviceRef = store.db.collection('application_concierge_services').doc('service-1');
    const runtimePath = `${SERVICE_PATH}/runtime/matching`;

    await updateConciergeMatchingRuntime({ db: store.db, serviceRef, patch: { matchingRunStatus: 'running' } });

    expect(store.read(runtimePath)).toMatchObject({
      schemaVersion: 3,
      matchingOpenProposalCount: 1,
      matchingScanCursor: 'newer-runtime-cursor',
      matchingRunStatus: 'running',
      proposalRefreshCompletedRequestId: 'legacy-v2-request',
      pendingProposalNotice: { key: 'legacy-v2-notice', proposalIds: ['proposal-2'] },
    });
    expect(store.read(SERVICE_PATH)).toMatchObject({ matchingOpenProposalCount: 2, matchingStatus: 'complete' });
    expect(store.read(SERVICE_PATH)).not.toHaveProperty('pendingProposalNotice');
    expect(mergeConciergeMatchingRuntime(store.read(SERVICE_PATH), store.read(runtimePath)))
      .toMatchObject({ matchingStatus: 'running', matchingOpenProposalCount: 1 });
  });
});
