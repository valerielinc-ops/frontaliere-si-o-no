import { describe, expect, it, vi } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { requestPortalVerification, executePortalVerification, verificationBinding } from '../scripts/assisted-application/verify-portal.mjs';
import { safeSigninAction, verificationTarget } from '../scripts/assisted-application/lib/portal/verify.mjs';
import { encryptJson } from '../scripts/assisted-application/lib/secure-run.mjs';

const now = Date.now();
const version = 'b'.repeat(64);
const nonce = 'test-verification-nonce';
const orderId = 'test_opaque_order';
const base = `assisted_applications/${orderId}`;
const applyUrl = 'https://careers.example/ApplicationMethods?jobId=42';
const targetUrl = 'https://careers.example/ApplicationReview?jobId=42';
function fixture() {
  return createMemoryFirestore({
    [base]: { paymentStatus: 'paid', submissionStatus: 'in_progress' },
    [`${base}/automation/flow`]: { state: 'owner_takeover', round: 1, heldBy: ['portal_ambiguous'], dispatch: { mode: 'submit', round: 1, requestedAt: now - 5000 } },
    [`${base}/ai_drafts/current`]: { status: 'ready', round: 1, channel: { type: 'employer_site', applyUrl }, sentAttempt: { at: now - 1000 }, job: { title: 'Test Infrastructure Manager' } },
    [`${base}/automation/submission`]: { r1: { state: 'sending', channel: 'portal', startedAt: now - 2000, clickedAt: now - 1000 } },
  });
}

describe('protected read-only portal inspection', () => {
  it('requests once per source version and never releases a legacy clicked claim', async () => {
    const store = fixture();
    const before = structuredClone([...store.docs]);
    expect(await requestPortalVerification({ db: store.db, orderId, round: 1, version, nonce, nowMs: now })).toMatchObject({ requested: true, nonce });
    expect(await requestPortalVerification({ db: store.db, orderId, round: 1, version, nonce, nowMs: now })).toMatchObject({ requested: false });
    for (const [path, data] of before) expect(store.read(path)).toEqual(data);
    expect(store.read(`${base}/automation/submission`).r1.clickedAt).toBe(now - 1000);
  });

  it.each(['withdrawn', 'refunded', 'purged', 'other_round', 'sent', 'other_dispatch', 'expired', 'other_nonce', 'other_version'])('does not inspect a superseded or unsafe request: %s', async kind => {
    const store = fixture();
    await requestPortalVerification({ db: store.db, orderId, round: 1, version, nonce, nowMs: now });
    if (kind === 'withdrawn') store.docs.set(base, { ...store.read(base), withdrawnAt: now });
    if (kind === 'refunded') store.docs.set(base, { ...store.read(base), refundStatus: 'pending' });
    if (kind === 'purged') store.docs.set(base, { ...store.read(base), retentionPurgedAt: now });
    if (kind === 'other_round') store.docs.set(`${base}/automation/flow`, { ...store.read(`${base}/automation/flow`), round: 2 });
    if (kind === 'other_dispatch') store.docs.set(`${base}/automation/flow`, { ...store.read(`${base}/automation/flow`), dispatch: { mode: 'submit', requestedAt: now } });
    if (kind === 'sent') store.docs.set(`${base}/automation/submission`, { r1: { ...store.read(`${base}/automation/submission`).r1, state: 'sent' } });
    const inspect = vi.fn();
    const result = await executePortalVerification({ db: store.db, bucket: {} as any, orderId, round: 1,
      nonce: kind === 'other_nonce' ? 'different-request-nonce' : nonce, version: kind === 'other_version' ? 'c'.repeat(64) : version,
      key: Buffer.alloc(32), nowMs: kind === 'expired' ? now + 31 * 60_000 : now + 10, inspect });
    expect(result).toMatchObject({ inspected: false, reason: 'superseded' });
    expect(inspect).not.toHaveBeenCalled();
  });

  it('retains every send ledger, approval and attempt after a verified review page is read', async () => {
    const store = fixture();
    const originals = structuredClone([...store.docs]);
    await requestPortalVerification({ db: store.db, orderId, round: 1, version, nonce, nowMs: now });
    const key = Buffer.alloc(32, 7);
    const source = { applyUrl, event: { type: 'submit_failed', error: 'portal_ambiguous' }, evidence: { finalUrl: targetUrl, finalOutcomes: ['ambiguous'] } };
    const saves = new Map<string, string>();
    const bucket = { file: (name: string) => ({ download: async () => [Buffer.from(JSON.stringify(encryptJson(source, key)))], save: async (data: string) => { saves.set(name, data); } }) };
    const inspect = vi.fn(async () => ({ pages: [{ stage: 'final_review', text: 'Please select Submit to finalise your application.' }], conclusion: 'unknown' }));
    expect(await executePortalVerification({ db: store.db, bucket, orderId, round: 1, nonce, version, key, nowMs: now + 10, inspect })).toEqual({ inspected: true, recorded: true, conclusion: 'unknown' });
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(saves.size).toBe(1);
    for (const [path, data] of originals) expect(store.read(path)).toEqual(data);
    expect(store.read(`${base}/automation/portal_verification`)).toMatchObject({ state: 'completed', conclusion: 'unknown', nonce, round: 1, version });
    expect(await executePortalVerification({ db: store.db, bucket, orderId, round: 1, nonce, version, key, nowMs: now + 20, inspect })).toMatchObject({ inspected: false });
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it('permits only the native sign-in endpoint for the sole authentication POST', () => {
    expect(safeSigninAction('https://careers.example/Login?jobId=42', applyUrl)).toBe(true);
    for (const action of ['https://careers.example/ApplicationSubmit?jobId=42', 'https://careers.example/submit?jobId=42', 'https://careers.example/Login/ApplicationSubmit?jobId=42', 'https://careers.example/Login?action=withdraw', 'https://foreign.example/Login', 'https://careers.example/apply']) expect(safeSigninAction(action, applyUrl)).toBe(false);
  });

  it('uses only the previously observed review URL for the exact posting', () => {
    expect(verificationTarget({ applyUrl, evidence: { finalUrl: targetUrl } })).toBe(targetUrl);
    for (const finalUrl of [targetUrl.replace('42', '43'), targetUrl + '&submit=true', targetUrl.replace('Review', 'Submit'), targetUrl.replace('careers.example', 'other.example')]) {
      expect(verificationTarget({ applyUrl, evidence: { finalUrl } })).toBeNull();
    }
    expect(verificationBinding({ flow: { round: 1 }, submission: { r1: { clickedAt: 1 } } })).not.toBe(verificationBinding({ flow: { round: 1 }, submission: { r1: { clickedAt: 2 } } }));
  });
});
