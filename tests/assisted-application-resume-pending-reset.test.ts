import { describe, expect, it, vi } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';

const state = vi.hoisted(() => ({ snapshot: null as any }));
vi.mock('../scripts/assisted-application/lib/portal/fields.mjs', async importOriginal => ({
  ...await importOriginal<any>(), extractFields: async () => state.snapshot,
}));
import { recoverAccountPassword } from '../scripts/assisted-application/lib/portal/portal.mjs';
import { portalAccountStore } from '../scripts/assisted-application/lib/portal/account.mjs';
import { encryptJson } from '../scripts/assisted-application/lib/secure-run.mjs';

const HOST = 'recruitingapp-0000.umantis.com';
const ALIAS = 'maria.rossi.abcd@candidature.frontaliereticino.ch';
const LOGIN = `https://${HOST}/Vacancies/6604/Application/Login/1`;
const key = Buffer.alloc(32, 9);

describe('a reset e-mail that already arrived is used before a new reset is asked for', () => {
  const signInView = () => ({ fields: [{ id: 'p1', kind: 'text', inputType: 'password', label: 'Passwort:', frame: 0 }, { id: 'u1', kind: 'text', inputType: 'text', label: 'Benutzername:', frame: 0 }],
    buttons: [], links: [], dialogs: [], passwordVisible: true, errors: [], text: 'Anmelden' });
  const noSignIn = () => ({ fields: [], buttons: [], links: [], dialogs: [], passwordVisible: false, errors: [], text: 'Fehler' });

  function setup({ status = 'recovering', pending = { temporaryPassword: 'temp-one', messageId: 'm1', receivedAt: 2000 } as any, afterGoto = signInView, claim = { status: 'claimed' } as any } = {}) {
    let url = LOGIN;
    state.snapshot = afterGoto();
    const accounts: any = {
      pendingPasswordReset: vi.fn(async () => pending),
      claimPasswordReset: vi.fn(async () => claim),
      settlePasswordReset: vi.fn(async () => true),
      beginRecovery: vi.fn(async () => ({ status: 'cooldown', retryAt: 1 })),
      waitForPasswordReset: vi.fn(async () => null),
      completeRecovery: vi.fn(async () => true),
      abortRecovery: vi.fn(async () => true),
      load: vi.fn(async () => ({ email: ALIAS, password: 'staged' })),
    };
    const goto = vi.fn(async (target: string) => { url = target; });
    const page: any = { url: () => url, goto, waitForLoadState: async () => {}, waitForTimeout: async () => {}, evaluate: async () => '',
      frames: () => [page], mainFrame: () => page, locator: () => ({ first: () => ({ isVisible: async () => false, evaluate: async () => null }) }) };
    const finishRecovery = vi.fn(async (view: any) => ({ snapshot: view }));
    const run = () => recoverAccountPassword({ page, snapshot: signInView(), ctx: { candidate: { identity: { email: ALIAS } }, accounts, dryRun: false }, host: HOST,
      account: { email: ALIAS, password: 'staged', status, recoveryRequestedAt: Date.now() - 1000, recoveryRequestId: 'req' }, diagnostics: null, typedSecrets: null,
      registrationRestarts: new Map(), recoveryAttempts: new Set(), finishRecovery });
    return { run, accounts, finishRecovery, goto };
  }

  it('claims the link first, completes the pending reset, settles the claim, and asks for no new reset', async () => {
    const { run, accounts, finishRecovery } = setup();
    const result: any = await run();
    expect(result.accountRecovered).toBe(true);
    expect(accounts.claimPasswordReset).toHaveBeenCalledWith(HOST, 'm1', { owner: expect.stringMatching(/^[^:]+:[0-9a-f-]{36}$/) });
    const owner = accounts.claimPasswordReset.mock.calls[0][2].owner;
    expect(accounts.settlePasswordReset).toHaveBeenCalledWith(HOST, 'm1', owner);
    expect(accounts.completeRecovery).toHaveBeenCalledWith(HOST, { password: 'temp-one' });
    expect(accounts.beginRecovery).not.toHaveBeenCalled();
    expect(accounts.waitForPasswordReset).not.toHaveBeenCalled();
    expect(finishRecovery).toHaveBeenCalledTimes(1);
  });

  it('a caller that does not get the claim stops before any navigation', async () => {
    const { run, accounts, goto, finishRecovery } = setup({ claim: { status: 'held' } });
    const result: any = await run();
    expect(result.handoff).toBe('account_recovery_timeout');
    expect(result.accountRecovered).not.toBe(true);
    expect(goto).not.toHaveBeenCalled();
    expect(accounts.settlePasswordReset).not.toHaveBeenCalled();
    expect(accounts.completeRecovery).not.toHaveBeenCalled();
    expect(accounts.beginRecovery).not.toHaveBeenCalled();
    expect(finishRecovery).not.toHaveBeenCalled();
  });

  it('a link already consumed, or a store without claims, opens nothing and follows the normal path without waiting', async () => {
    for (const claim of [{ status: 'consumed' }, { status: 'missing' }]) {
      const { run, accounts, goto } = setup({ claim });
      const result: any = await run();
      expect(result.accountRecovered).not.toBe(true);
      expect(goto).not.toHaveBeenCalled();
      expect(accounts.settlePasswordReset).not.toHaveBeenCalled();
      expect(accounts.waitForPasswordReset).not.toHaveBeenCalled();
    }
  });

  it('an expired or refused pending reset is settled (consumed for good) and the normal path follows (never a wait for the same e-mail)', async () => {
    const { run, accounts } = setup({ afterGoto: noSignIn });
    const result: any = await run();
    expect(result.accountRecovered).not.toBe(true);
    expect(result.handoff).toBeTruthy();
    expect(accounts.settlePasswordReset).toHaveBeenCalledTimes(1);
    expect(accounts.completeRecovery).not.toHaveBeenCalled();
    expect(accounts.waitForPasswordReset).not.toHaveBeenCalled();
  });

  it('asks the store for a pending reset only when a recovery is in progress, and uses nothing when there is none', async () => {
    const created = setup({ status: 'created' });
    await created.run();
    expect(created.accounts.pendingPasswordReset).not.toHaveBeenCalled();
    const none = setup({ pending: null });
    await none.run();
    expect(none.accounts.pendingPasswordReset).toHaveBeenCalledTimes(1);
    expect(none.accounts.claimPasswordReset).not.toHaveBeenCalled();
  });
});

describe('the store finds the reset e-mail of the recovery in progress, once', () => {
  async function recovering() {
    let now = Date.UTC(2026, 10, 28, 8, 7, 0);
    const mem = createMemoryFirestore({ 'assisted_applications/order_pending_reset': { paymentStatus: 'paid' } });
    const store = portalAccountStore({ db: mem.db, orderId: 'order_pending_reset', key, nowMs: () => (now += 1000), sleep: async () => {} });
    await store.save(HOST, { email: ALIAS, password: 'valid-before' });
    const begun: any = await store.beginRecovery(HOST, { email: ALIAS, password: 'staged-never-applied' });
    const inbox = mem.db.collection('assisted_applications').doc('order_pending_reset').collection('inbox');
    const add = (over: Record<string, unknown>) => inbox.add({ passwordResetHost: HOST, passwordResetRequestId: begun.requestId, receivedAt: begun.requestedAt + 4000,
      passwordResetLinkEnc: encryptJson({ url: `https://${HOST}/?PasswordResetToken=abc&PersID=1` }, key), ...over });
    return { store, begun, add };
  }

  it('hands the link to one owner at a time, consumes it for good once settled, and frees it when a claim expires unused', async () => {
    const mem = createMemoryFirestore({ 'assisted_applications/order_claim_reset': { paymentStatus: 'paid' } });
    let now = Date.UTC(2026, 10, 28, 8, 7, 0);
    const store = portalAccountStore({ db: mem.db, orderId: 'order_claim_reset', key, nowMs: () => now, sleep: async () => { now += 2000; } });
    await store.save(HOST, { email: ALIAS, password: 'valid-before' });
    const begun: any = await store.beginRecovery(HOST, { email: ALIAS, password: 'staged-never-applied' });
    const inbox = mem.db.collection('assisted_applications').doc('order_claim_reset').collection('inbox');
    const ref = await inbox.add({ passwordResetHost: HOST, passwordResetRequestId: begun.requestId, receivedAt: begun.requestedAt + 4000,
      passwordResetLinkEnc: encryptJson({ url: `https://${HOST}/?PasswordResetToken=abc&PersID=1` }, key) });
    now += 10_000;
    // Two callers take the same message: exactly one gets it.
    const first = await store.claimPasswordReset(HOST, ref.id, { owner: 'run-1:a' });
    const second = await store.claimPasswordReset(HOST, ref.id, { owner: 'run-2:b' });
    expect(first).toMatchObject({ status: 'claimed' });
    expect(second).toMatchObject({ status: 'held' });
    // The same owner asking again keeps its claim; a stranger cannot settle it.
    expect(await store.claimPasswordReset(HOST, ref.id, { owner: 'run-1:a' })).toMatchObject({ status: 'claimed' });
    expect(await store.settlePasswordReset(HOST, ref.id, 'run-2:b')).toBe(false);
    // The claim expires without an outcome (a crash): the link is found again, never recorded as used, and taken by the retry.
    now += 11 * 60_000;
    expect(await store.pendingPasswordReset(HOST)).toMatchObject({ messageId: ref.id, url: `https://${HOST}/?PasswordResetToken=abc&PersID=1` });
    expect(await store.claimPasswordReset(HOST, ref.id, { owner: 'run-3:c' })).toMatchObject({ status: 'claimed' });
    // The outcome is known: consumed for good, whoever asks.
    expect(await store.settlePasswordReset(HOST, ref.id, 'run-3:c')).toBe(true);
    expect(await store.settlePasswordReset(HOST, ref.id, 'run-3:c')).toBe(false);
    expect(await store.claimPasswordReset(HOST, ref.id, { owner: 'run-4:d' })).toEqual({ status: 'consumed' });
    expect(await store.pendingPasswordReset(HOST)).toBeNull();
    expect(await store.waitForPasswordReset({ host: HOST, sinceMs: begun.requestedAt, timeoutMs: 5000 })).toBeNull();
  });

  it('ignores a message of another request, one older than the request, one of another host, and any recovery not in progress', async () => {
    const { store, begun, add } = await recovering();
    await add({ passwordResetRequestId: 'another-request' });
    await add({ receivedAt: begun.requestedAt - 10 });
    await add({ passwordResetHost: 'other.example' });
    expect(await store.pendingPasswordReset(HOST)).toBeNull();
    await store.abortRecovery(HOST, { requestSubmitted: true, reason: 'x' });
    await add({});
    expect(await store.pendingPasswordReset(HOST)).toBeNull();
  });
});
