import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const documents = new Map<string, Record<string, unknown>>();
  const files = new Set<string>();
  let childSequence = 0;

  function pathKey(path: string) {
    return path.replace(/^\/+|\/+$/g, '');
  }

  function mergeData(path: string, data: Record<string, unknown>, merge = false) {
    const normalized = pathKey(path);
    const current = documents.get(normalized) || {};
    const next = merge ? { ...current } : {};
    for (const [field, value] of Object.entries(data)) {
      if (value && typeof value === 'object' && (value as any).__increment !== undefined) {
        next[field] = Number(next[field] || 0) + Number((value as any).__increment);
      } else {
        next[field] = value;
      }
    }
    documents.set(normalized, next);
  }

  function makeDocRef(path: string) {
    const normalized = pathKey(path);
    const parts = normalized.split('/');
    return {
      id: parts[parts.length - 1],
      data: () => documents.get(normalized),
      async get() {
        const data = documents.get(normalized);
        return { id: parts[parts.length - 1], exists: Boolean(data), data: () => data };
      },
      set(data: Record<string, unknown>, options?: { merge?: boolean }) {
        mergeData(normalized, data, options?.merge === true);
      },
      collection(name: string) {
        return makeCollection(normalized + '/' + name);
      },
    };
  }

  function makeCollection(path: string) {
    const normalized = pathKey(path);
    return {
      doc(id?: string) {
        const value = id || 'child-' + (++childSequence);
        return makeDocRef(normalized + '/' + value);
      },
      async get() {
        const prefix = normalized + '/';
        const docs = [...documents.entries()]
          .filter(([key]) => key.startsWith(prefix) && !key.slice(prefix.length).includes('/'))
          .map(([key, data]) => makeDocRef(key));
        return { docs };
      },
    };
  }

  const firestore = {
    collection: (name: string) => makeCollection(name),
    async runTransaction(callback: (transaction: any) => Promise<unknown>) {
      return callback({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: Record<string, unknown>, options?: { merge?: boolean }) => ref.set(data, options),
      });
    },
    batch() {
      const operations: Array<() => void> = [];
      return {
        set(ref: any, data: Record<string, unknown>, options?: { merge?: boolean }) {
          operations.push(() => ref.set(data, options));
        },
        async commit() {
          operations.forEach((operation) => operation());
        },
      };
    },
  };

  const bucket = {
    file(path: string) {
      return {
        path,
        async exists() {
          return [files.has(path)];
        },
        async getMetadata() {
          return [{ size: 100, contentType: 'application/pdf' }];
        },
        async copy(target: { path: string }) {
          files.add(target.path);
        },
        async delete() {
          files.delete(path);
        },
      };
    },
  };

  return {
    documents,
    files,
    firestore,
    bucket,
    getAdminDb: vi.fn(() => firestore),
    getStorage: vi.fn(() => ({ bucket: () => bucket })),
    verifyCaller: vi.fn(async () => ({ uid: 'candidate-42' })),
    assertAdmin: vi.fn(async () => ({ ok: true, adminEmail: 'owner@example.test' })),
    reset() {
      documents.clear();
      files.clear();
      childSequence = 0;
    },
  };
});

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => '__server_timestamp__',
    increment: (value: number) => ({ __increment: value }),
  },
  Timestamp: {
    now: () => new Date(),
  },
}));

vi.mock('firebase-admin/storage', () => ({
  getStorage: mocks.getStorage,
}));

vi.mock('../functions/src/newsletterResendWebhookCore.js', () => ({
  getAdminDb: mocks.getAdminDb,
}));

vi.mock('../functions/src/adminEmployerInsights.js', () => ({
  assertAdmin: mocks.assertAdmin,
}));

vi.mock('../functions/src/stripePublisherCore.js', () => ({
  verifyCaller: mocks.verifyCaller,
}));

vi.mock('../functions/src/assistedApplicationCheckout.js', () => ({
  ASSISTED_APPLICATION_CONSENT_VERSION: 'assisted-application-v1',
}));

vi.mock('../functions/src/assistedApplicationConstants.js', () => ({
  ASSISTED_APPLICATIONS_COLLECTION: 'assisted_applications',
}));

vi.mock('../functions/src/assistedApplicationCvCheck.js', () => ({
  ASSISTED_APPLICATION_STORAGE_BUCKET: 'test-bucket',
}));

const { handleApplicationConcierge } = await import('../functions/src/applicationConciergeCore.js');

function seedService() {
  mocks.documents.set('application_concierge_services/service-1', {
    userId: 'candidate-42',
    paymentStatus: 'paid',
    serviceStatus: 'active',
    renewal: false,
    maxPositions: 10,
    acceptedPositionsCount: 0,
    currency: 'eur',
    customerEmail: 'candidate@example.test',
    applicantName: 'Candidate Example',
    applicantEmail: 'candidate@example.test',
    consentVersion: 'application-concierge-v1',
    consentedAt: new Date(),
    cvStorageKey: 'application-concierge-uploads/service-1/cv.pdf',
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
  mocks.documents.set('application_concierge_services/service-1/proposals/proposal-1', {
    jobId: 'job-1',
    jobUrl: 'https://jobs.example.test/job-1',
    companyId: 'company-1',
    companyName: 'Example SA',
    jobTitle: 'Software Developer',
    location: 'Lugano',
    applyMode: 'portal',
    status: 'proposed',
  });
  mocks.files.add('application-concierge-uploads/service-1/cv.pdf');
}

beforeEach(() => {
  mocks.reset();
  seedService();
});

describe('application concierge candidate API', () => {
  it('creates a child assisted application only after explicit proposal acceptance', async () => {
    const result = await handleApplicationConcierge({
      method: 'POST',
      body: {
        serviceId: 'service-1',
        action: 'acceptProposal',
        proposalId: 'proposal-1',
      },
      get: () => 'Bearer candidate-token',
    });

    expect(result.status).toBe(200);
    expect((result.body as any).childApplicationId).toBe('child-1');
    expect(mocks.documents.get('application_concierge_services/service-1')).toEqual(expect.objectContaining({
      acceptedPositionsCount: 1,
    }));
    expect(mocks.documents.get('application_concierge_services/service-1/proposals/proposal-1')).toEqual(expect.objectContaining({
      status: 'accepted',
      childApplicationId: 'child-1',
    }));
    expect(mocks.documents.get('assisted_applications/child-1')).toEqual(expect.objectContaining({
      billingMode: 'application_concierge',
      parentServiceId: 'service-1',
      parentProposalId: 'proposal-1',
      paymentStatus: 'paid',
      submissionStatus: 'awaiting_upload',
      jobId: 'job-1',
    }));
    expect([...mocks.files].some((path) => path.startsWith('assisted-application-uploads/child-1/'))).toBe(true);
  });

  it('does not create a child application for a declined proposal', async () => {
    const result = await handleApplicationConcierge({
      method: 'POST',
      body: {
        serviceId: 'service-1',
        action: 'declineProposal',
        proposalId: 'proposal-1',
      },
      get: () => 'Bearer candidate-token',
    });

    expect(result.status).toBe(200);
    expect(mocks.documents.get('application_concierge_services/service-1/proposals/proposal-1')).toEqual(expect.objectContaining({
      status: 'declined',
    }));
    expect([...mocks.documents.keys()].some((path) => path.startsWith('assisted_applications/'))).toBe(false);
  });

  it('requires explicit consent even when the caller supplies the contract version', async () => {
    const service = mocks.documents.get('application_concierge_services/service-1')!;
    service.consentVersion = null;

    const result = await handleApplicationConcierge({
      method: 'POST',
      body: {
        serviceId: 'service-1',
        action: 'saveProfile',
        applicantName: 'Candidate Example',
        applicantEmail: 'candidate@example.test',
        consentVersion: 'application-concierge-v1',
        consent: false,
      },
      get: () => 'Bearer candidate-token',
    });

    expect(result).toEqual({
      status: 400,
      body: { ok: false, error: 'consent_required' },
    });
  });

  it('saves editable candidate details without rewriting an existing consent', async () => {
    const result = await handleApplicationConcierge({
      method: 'POST',
      body: {
        serviceId: 'service-1',
        action: 'saveProfile',
        applicantName: 'Candidate Updated',
        applicantEmail: 'updated@example.test',
        applicantPhone: '+41 79 000 00 00',
      },
      get: () => 'Bearer candidate-token',
    });

    expect(result.status).toBe(200);
    expect(mocks.documents.get('application_concierge_services/service-1')).toEqual(expect.objectContaining({
      applicantName: 'Candidate Updated',
      applicantEmail: 'updated@example.test',
      consentVersion: 'application-concierge-v1',
    }));
  });

  it('records concierge consent as a separate idempotent action', async () => {
    const service = mocks.documents.get('application_concierge_services/service-1')!;
    service.consentVersion = null;
    service.consentedAt = null;

    const result = await handleApplicationConcierge({
      method: 'POST',
      body: {
        serviceId: 'service-1',
        action: 'recordConsent',
        applicantName: 'Candidate Example',
        applicantEmail: 'candidate@example.test',
        consent: true,
      },
      get: () => 'Bearer candidate-token',
    });

    expect(result.status).toBe(200);
    expect((result.body as any).service.hasConsent).toBe(true);
    const firstConsent = mocks.documents.get('application_concierge_services/service-1')!.consentedAt;

    const second = await handleApplicationConcierge({
      method: 'POST',
      body: {
        serviceId: 'service-1',
        action: 'recordConsent',
        applicantName: 'Candidate Example',
        applicantEmail: 'candidate@example.test',
        consent: true,
      },
      get: () => 'Bearer candidate-token',
    });
    expect(second.status).toBe(200);
    expect(mocks.documents.get('application_concierge_services/service-1')!.consentedAt).toBe(firstConsent);
  });

  it('lists the candidate-owned services when no service id is supplied', async () => {
    const result = await handleApplicationConcierge({
      method: 'GET',
      query: {},
      get: () => 'Bearer candidate-token',
    });

    expect(result.status).toBe(200);
    expect((result.body as any).services).toHaveLength(1);
    expect((result.body as any).services[0].serviceId).toBe('service-1');
  });
});
