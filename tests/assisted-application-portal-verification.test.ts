import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { requestPortalVerification, executePortalVerification, verificationBinding } from '../scripts/assisted-application/verify-portal.mjs';
import { safeSigninAction, verificationTarget, verifyPortalApplication } from '../scripts/assisted-application/lib/portal/verify.mjs';
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
    [base]: { paymentStatus: 'paid', submissionStatus: 'in_progress', consentVersion: 'assisted-application-v2', consentedAt: now - 20000, cvUploadedAt: now - 10000 },
    [`${base}/automation/flow`]: { state: 'owner_takeover', round: 1, heldBy: ['portal_ambiguous'], dispatch: { mode: 'submit', round: 1, requestedAt: now - 5000 } },
    [`${base}/ai_drafts/current`]: { status: 'ready', round: 1, channel: { type: 'employer_site', applyUrl }, sentAttempt: { at: now - 1000 }, job: { title: 'Test Infrastructure Manager' } },
    [`${base}/automation/submission`]: { r1: { state: 'sending', channel: 'portal', startedAt: now - 2000, clickedAt: now - 1000 } },
  });
}

describe('protected read-only portal inspection', () => {
  it('keeps an active one-use request exclusive and never releases a legacy clicked claim', async () => {
    const store = fixture();
    const before = structuredClone([...store.docs]);
    expect(await requestPortalVerification({ db: store.db, orderId, round: 1, version, nonce, nowMs: now })).toMatchObject({ requested: true, nonce });
    expect(await requestPortalVerification({ db: store.db, orderId, round: 1, version, nonce, nowMs: now })).toMatchObject({ requested: false });
    for (const [path, data] of before) expect(store.read(path)).toEqual(data);
    expect(store.read(`${base}/automation/submission`).r1.clickedAt).toBe(now - 1000);
  });

  it.each(['withdrawn', 'expired_retention', 'no_consent', 'refunded', 'purged', 'other_round', 'sent', 'other_dispatch', 'expired', 'other_nonce', 'other_version'])('does not inspect a superseded or unsafe request: %s', async kind => {
    const store = fixture();
    await requestPortalVerification({ db: store.db, orderId, round: 1, version, nonce, nowMs: now });
    if (kind === 'expired_retention') store.docs.set(base, { ...store.read(base), cvUploadedAt: now - 91 * 86400000 });
    if (kind === 'no_consent') store.docs.set(base, { ...store.read(base), consentVersion: null });
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

  it('blocks service workers and alternate transports before visiting the protected page', async () => {
    const routeWebSocket = vi.fn(async () => {});
    const addInitScript = vi.fn(async (_fn: Function) => {});
    const close = vi.fn(async () => {});
    const context = { routeWebSocket, addInitScript, close, route: vi.fn(async () => {}),
      newPage: async () => ({ goto: async () => { throw new Error('test_stop_before_network'); } }) };
    const newContext = vi.fn(async () => context);
    await expect(verifyPortalApplication({ applyUrl, targetUrl, job: {}, accounts: {}, launch: async () => ({ newContext, close: async () => {} }) }))
      .rejects.toThrow('test_stop_before_network');
    expect(newContext).toHaveBeenCalledWith(expect.objectContaining({ serviceWorkers: 'block' }));
    expect(routeWebSocket).toHaveBeenCalledTimes(1);
    expect(addInitScript).toHaveBeenCalledTimes(1);
    const sandbox: Record<string, any> = Object.fromEntries(['WebTransport', 'Worker', 'SharedWorker', 'RTCPeerConnection', 'webkitRTCPeerConnection'].map(name => [name, function Transport() {}]));
    runInNewContext(`(${addInitScript.mock.calls[0][0].toString()})()`, sandbox);
    for (const name of Object.keys(sandbox)) {
      expect(sandbox[name]).toBeUndefined();
      expect(Object.getOwnPropertyDescriptor(sandbox, name)).toMatchObject({ writable: false, configurable: false });
    }
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('permits only the native sign-in endpoint for the sole authentication POST', () => {
    expect(safeSigninAction('https://careers.example/Login?jobId=42', applyUrl)).toBe(true);
    for (const action of ['https://careers.example/ApplicationSubmit?jobId=42', 'https://careers.example/submit?jobId=42', 'https://careers.example/Login/ApplicationSubmit?jobId=42', 'https://careers.example/Login?action=withdraw', 'https://foreign.example/Login', 'https://careers.example/apply']) expect(safeSigninAction(action, applyUrl)).toBe(false);
  });

  it.each(['inspect', 'store'])('does not resurrect evidence when retention changes during %s', async phase => {
    const store = fixture();
    await requestPortalVerification({ db: store.db, orderId, round: 1, version, nonce, nowMs: now });
    const key = Buffer.alloc(32, 7);
    const source = { applyUrl, event: { type: 'submit_failed', error: 'portal_ambiguous' }, evidence: { finalUrl: targetUrl, finalOutcomes: ['ambiguous'] } };
    const saves = new Map<string, string>();
    const deleted = vi.fn(async (name: string) => { saves.delete(name); });
    const purge = () => store.docs.set(base, { ...store.read(base), retentionPurgedAt: now });
    const bucket = { file: (name: string) => ({
      download: async () => [Buffer.from(JSON.stringify(encryptJson(source, key)))],
      save: async (data: string) => { saves.set(name, data); if (phase === 'store') purge(); },
      delete: async () => deleted(name),
    }) };
    const inspect = vi.fn(async () => { if (phase === 'inspect') purge(); return { conclusion: 'unknown', pages: [] }; });
    expect(await executePortalVerification({ db: store.db, bucket, orderId, round: 1, nonce, version, key, nowMs: now + 10, inspect }))
      .toMatchObject({ inspected: true, recorded: false });
    expect(saves.size).toBe(0);
    if (phase === 'store') expect(deleted).toHaveBeenCalledTimes(1);
    expect(store.read(`${base}/automation/submission`).r1).toMatchObject({ state: 'sending', clickedAt: now - 1000 });
    expect(store.read(`${base}/automation/flow`).state).toBe('owner_takeover');
  });

  it('removes the new encrypted proof when its final receipt transaction throws', async () => {
    const store = fixture();
    await requestPortalVerification({ db: store.db, orderId, round: 1, version, nonce, nowMs: now });
    const key = Buffer.alloc(32, 7);
    const source = { applyUrl, event: { type: 'submit_failed', error: 'portal_ambiguous' }, evidence: { finalUrl: targetUrl, finalOutcomes: ['ambiguous'] } };
    const saves = new Map<string, string>();
    const deleted = vi.fn(async (name: string) => { saves.delete(name); });
    const bucket = { file: (name: string) => ({
      download: async () => [Buffer.from(JSON.stringify(encryptJson(source, key)))],
      save: async (data: string) => { saves.set(name, data); store.db.runTransaction = async () => { throw new Error('receipt_transaction_unavailable'); }; },
      delete: async () => deleted(name),
    }) };
    const inspect = vi.fn(async () => ({ conclusion: 'unknown', pages: [] }));
    await expect(executePortalVerification({ db: store.db, bucket, orderId, round: 1, nonce, version, key, nowMs: now + 10, inspect }))
      .rejects.toThrow('receipt_transaction_unavailable');
    expect(saves.size).toBe(0);
    expect(deleted).toHaveBeenCalledTimes(1);
    expect(store.read(`${base}/automation/submission`).r1).toMatchObject({ state: 'sending', clickedAt: now - 1000 });
  });

  it('recovers an expired read-only lease with a new nonce, bounded per source, round and claim', async () => {
    const store = fixture();
    await requestPortalVerification({ db: store.db, orderId, round: 1, version, nonce, nowMs: now });
    const requestPath = `${base}/automation/portal_verification`;
    store.docs.set(requestPath, { ...store.read(requestPath), state: 'running' });
    expect(await requestPortalVerification({ db: store.db, orderId, round: 1, version, nonce: 'next-verification-nonce', nowMs: now + 31 * 60_000 })).toMatchObject({ requested: true });
    expect(store.read(requestPath).attempts).toBe(2);
    store.docs.set(requestPath, { ...store.read(requestPath), state: 'completed', attempts: 3 });
    expect(await requestPortalVerification({ db: store.db, orderId, round: 1, version, nonce, nowMs: now + 32 * 60_000 })).toMatchObject({ requested: false, reason: 'inspection_limit' });
    store.docs.set(`${base}/automation/flow`, { ...store.read(`${base}/automation/flow`), round: 2, dispatch: { mode: 'submit', round: 2 } });
    store.docs.set(`${base}/ai_drafts/current`, { ...store.read(`${base}/ai_drafts/current`), round: 2 });
    store.docs.set(`${base}/automation/submission`, { ...store.read(`${base}/automation/submission`), r2: { state: 'sending', channel: 'portal', clickedAt: now, startedAt: now - 1 } });
    expect(await requestPortalVerification({ db: store.db, orderId, round: 2, version, nonce, nowMs: now + 33 * 60_000 })).toMatchObject({ requested: true, round: 2 });
    expect(store.read(requestPath).attempts).toBe(1);
    expect(store.read(`${base}/automation/submission`).r1.clickedAt).toBe(now - 1000);
  });

  it('uses only the previously observed review URL for the exact posting', () => {
    expect(verificationTarget({ applyUrl, evidence: { finalUrl: targetUrl } })).toBe(targetUrl);
    for (const finalUrl of [targetUrl.replace('42', '43'), targetUrl + '&submit=true', targetUrl.replace('Review', 'Submit'), targetUrl.replace('careers.example', 'other.example')]) {
      expect(verificationTarget({ applyUrl, evidence: { finalUrl } })).toBeNull();
    }
    expect(verificationBinding({ flow: { round: 1 }, submission: { r1: { clickedAt: 1 } } })).not.toBe(verificationBinding({ flow: { round: 1 }, submission: { r1: { clickedAt: 2 } } }));
  });
});
