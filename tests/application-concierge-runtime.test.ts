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
      schemaVersion: 2,
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
    expect(runtime).toMatchObject({ schemaVersion: 2, matchingOpenProposalCount: 2, matchingScanCursor: 'current-cursor' });
    expect(runtime).not.toHaveProperty('proposalRefreshWorkerLeaseId');
    expect(mergeConciergeMatchingRuntime(parent, runtime)).toMatchObject({
      matchingStatus: 'running', matchingOpenProposalCount: 2, matchingScanCursor: 'current-cursor',
    });
    expect(mergeConciergeMatchingRuntime(parent, runtime)).not.toHaveProperty('proposalRefreshWorkerLeaseId');
    expect(conciergeMatchingRuntimeRef(serviceRef).path).toBe(`${SERVICE_PATH}/runtime/matching`);
  });
});
