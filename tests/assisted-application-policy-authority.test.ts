import { describe, expect, it } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { createAnswerSourceGuard } from '../functions/src/assistedApplicationAnswerSourceGuard.js';
import { applicationPolicyAuthority } from '../functions/src/lib/assistedApplicationPolicyAuthority.js';

const now = Date.now();
const order = { paymentStatus: 'paid', consentVersion: 'assisted-application-v2', consentedAt: now - 2000, cvUploadedAt: now - 1000 };
const input = { orderId: 'synthetic-order', order, flow: { round: 2, state: 'owner_takeover' }, nowMs: now };

describe('server application policy authority', () => {
  it.each(['assisted-application-v1', 'assisted-application-v2'])('describes only the actual retained paid mandate %s', consentVersion => {
    const authority = applicationPolicyAuthority({ ...input, order: { ...order, consentVersion } });
    expect(authority).toEqual({ version: 'server-application-policy-authority-v1', orderId: input.orderId, round: 2,
      consentVersion, consentedAt: now - 2000, paid: true,
      scopes: ['application_consent', 'optional_consent_refusal', 'individual_application_origin', 'operational_preference'],
      operationalPreferencesVersion: 'operational-preferences-v1' });
    expect(Object.isFrozen(authority)).toBe(true);
    expect(Object.isFrozen(authority?.scopes)).toBe(true);
    expect(authority).not.toHaveProperty('question');
    expect(authority).not.toHaveProperty('answer');
  });
  it.each([new Date(now - 2000), { toMillis: () => now - 2000 }])('uses the source timestamp representation without inventing a confirmation', consentedAt => {
    expect(applicationPolicyAuthority({ ...input, order: { ...order, consentedAt } })?.consentedAt).toBe(now - 2000);
  });
  it.each([
    { paymentStatus: 'pending' }, ...['pending', 'completed', 'succeeded', 'refunded'].map(refundStatus => ({ refundStatus })), { consentVersion: 'unknown' }, { consentedAt: null }, { consentedAt: NaN },
    { consentedAt: now + 1 }, { refundedAt: now }, { withdrawnAt: now },
    { cvUploadedAt: null }, { cvUploadedAt: now - 90 * 86400000 },
    { retentionPurgingAt: now }, { retentionPurgedAt: now }, { retentionPayloadPurgedAt: now },
  ])('does not create policy authority from an ineligible source: %j', patch => {
    expect(applicationPolicyAuthority({ ...input, order: { ...order, ...patch } })).toBeNull();
  });
  it('fences the actual refund reservation before the payment/refundedAt fields change', async () => {
    const source = { ...order }; const flow = { round: 1, state: 'owner_takeover' }; const draft = { round: 1, questions: [] };
    const path = 'assisted_applications/policy-source';
    const f = createMemoryFirestore({ [path]: source, [`${path}/automation/flow`]: flow, [`${path}/ai_drafts/current`]: draft });
    const guard = createAnswerSourceGuard({ db: f.db, orderId: 'policy-source', order: source, flow, draft, intake: null, profileRecord: {}, nowMs: now });
    f.read(path).refundStatus = 'pending';
    await expect(f.db.runTransaction((tx: any) => guard.assertInTransaction(tx))).rejects.toMatchObject({ code: 'evidence_source_changed' });
  });
  it('keeps retention and current mandate checks independent of talent-pool retention', () => {
    expect(applicationPolicyAuthority({ ...input, order: { ...order, cvUploadedAt: null, talentPoolConsent: true } })).not.toBeNull();
    expect(applicationPolicyAuthority({ ...input, order: { ...order, talentPoolConsent: true, consentVersion: null } })).toBeNull();
  });
  it('refuses malformed binding, withdrawal and unknown clocks', () => {
    expect(applicationPolicyAuthority({ ...input, flow: { round: 2, state: 'withdrawn' } })).toBeNull();
    expect(applicationPolicyAuthority({ ...input, flow: { round: 0 } })).toBeNull();
    expect(applicationPolicyAuthority({ ...input, orderId: '' })).toBeNull();
    expect(applicationPolicyAuthority({ ...input, nowMs: NaN })).toBeNull();
    expect(applicationPolicyAuthority({ ...input, order: null, flow: null })).toBeNull();
  });
});
