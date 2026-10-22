import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchMyAssistedApplications } from '../services/assistedApplicationCandidateStatus';
import {
  candidateStatusForAssistedApplication,
  handleListMyAssistedApplications,
} from '../functions/src/assistedApplicationCandidateStatus.js';

function makeDoc(id: string, data: Record<string, unknown>) {
  return { id, data: () => data };
}

describe('candidate assisted-application status', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('maps only candidate-actionable states to a request for the candidate', () => {
    expect(candidateStatusForAssistedApplication({ automationState: 'candidate_review' })).toBe('needs_candidate');
    expect(candidateStatusForAssistedApplication({ automationState: 'needs_candidate_action' })).toBe('needs_candidate');
    expect(candidateStatusForAssistedApplication({ automationState: 'candidate_handoff' })).toBe('needs_candidate');
  });

  it('keeps internal automation states behind a candidate-safe status vocabulary', () => {
    expect(candidateStatusForAssistedApplication({ submissionStatus: 'submitted', automationState: 'submitted' })).toBe('submitted');
    expect(candidateStatusForAssistedApplication({ submissionStatus: 'blocked', automationState: 'owner_takeover' })).toBe('under_review');
    expect(candidateStatusForAssistedApplication({ submissionStatus: 'awaiting_upload', cvStorageKey: null })).toBe('awaiting_materials');
    expect(candidateStatusForAssistedApplication({ submissionStatus: 'awaiting_upload', cvStorageKey: 'private/cv' })).toBe('in_progress');
    expect(candidateStatusForAssistedApplication({ submissionStatus: 'refunded' })).toBe('refunded');
  });

  it('lists only the authenticated owner’s paid orders and returns a PII-safe projection', async () => {
    const docs = [
      makeDoc('single-waiting', {
        userId: 'owner', paymentStatus: 'paid', billingMode: 'single', submissionStatus: 'awaiting_upload',
        jobTitle: 'Contabile', companyName: 'Azienda A', createdAt: new Date('2026-10-01T10:00:00Z'),
      }),
      makeDoc('concierge-review', {
        userId: 'owner', paymentStatus: 'paid', billingMode: 'application_concierge', submissionStatus: 'in_progress',
        automationState: 'candidate_review', jobTitle: 'Analista', companyName: 'Azienda B',
        cvStorageKey: 'assisted-application-uploads/private/cv.pdf', customerEmail: 'hidden',
        automationUpdatedAt: new Date('2026-10-01T10:00:00Z'),
        updatedAt: new Date('2026-10-03T10:00:00Z'),
        statusChangedAt: new Date('2026-10-04T10:00:00Z'),
      }),
      makeDoc('refunded', {
        userId: 'owner', paymentStatus: 'refunded', submissionStatus: 'refunded',
        jobTitle: 'Tecnico', companyName: 'Azienda C', updatedAt: new Date('2026-10-02T10:00:00Z'),
      }),
      makeDoc('unpaid', { userId: 'owner', paymentStatus: 'pending', submissionStatus: 'awaiting_upload' }),
      makeDoc('other-owner', { userId: 'someone-else', paymentStatus: 'paid', submissionStatus: 'submitted' }),
    ];
    let query: unknown[] = [];
    const response = await handleListMyAssistedApplications(
      { method: 'GET' },
      {
        verify: async () => ({ uid: 'owner' }),
        getDb: () => ({
          collection: (name: string) => {
            expect(name).toBe('assisted_applications');
            return {
              where: (...args: unknown[]) => {
                query = args;
                return { get: async () => ({ docs }) };
              },
            };
          },
        }) as never,
      },
    );

    expect(query).toEqual(['userId', '==', 'owner']);
    expect(response.status).toBe(200);
    expect(response.body.applications).toEqual([
      expect.objectContaining({
        orderId: 'concierge-review',
        source: 'concierge',
        status: 'needs_candidate',
        updatedAt: '2026-10-04T10:00:00.000Z',
      }),
      expect.objectContaining({ orderId: 'refunded', status: 'refunded' }),
      expect.objectContaining({ orderId: 'single-waiting', source: 'single', status: 'awaiting_materials', requiresCvUpload: true }),
    ]);
    expect(JSON.stringify(response.body)).not.toContain('cvStorageKey');
    expect(JSON.stringify(response.body)).not.toContain('customerEmail');
    expect(JSON.stringify(response.body)).not.toContain('hidden');
  });

  it('requires a verified account and rejects non-GET requests', async () => {
    const unauthenticated = await handleListMyAssistedApplications(
      { method: 'GET' },
      { verify: async () => null },
    );
    const wrongMethod = await handleListMyAssistedApplications(
      { method: 'POST' },
      { verify: async () => ({ uid: 'owner' }) },
    );
    expect(unauthenticated).toMatchObject({ status: 401, body: { ok: false, error: 'unauthenticated' } });
    expect(wrongMethod).toMatchObject({ status: 405, body: { ok: false, error: 'method_not_allowed' } });
  });

  it('validates the client response before returning rows to the profile page', async () => {
    const user = { getIdToken: async () => 'token' };
    const application = {
      orderId: 'order-1', jobTitle: 'Contabile', companyName: 'Azienda A', source: 'single',
      status: 'in_progress', updatedAt: '2026-10-20T09:30:00.000Z', requiresCvUpload: false,
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, applications: [application] }), { status: 200 })));
    await expect(fetchMyAssistedApplications(user)).resolves.toEqual([application]);

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      applications: [{ ...application, status: 'internal_owner_takeover' }],
    }), { status: 200 })));
    await expect(fetchMyAssistedApplications(user)).rejects.toThrow('assisted_applications_invalid_response');
  });
});
