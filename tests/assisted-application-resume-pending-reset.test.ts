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

  function setup({ status = 'recovering', pending = { temporaryPassword: 'temp-one', messageId: 'm1', receivedAt: 2000 } as any, afterGoto = signInView } = {}) {
    let url = LOGIN;
    state.snapshot = afterGoto();
    const accounts: any = {
      pendingPasswordReset: vi.fn(async () => pending),
      consumePasswordReset: vi.fn(async () => true),
      beginRecovery: vi.fn(async () => ({ status: 'cooldown', retryAt: 1 })),
      waitForPasswordReset: vi.fn(async () => null),
      completeRecovery: vi.fn(async () => true),
      abortRecovery: vi.fn(async () => true),
      load: vi.fn(async () => ({ email: ALIAS, password: 'staged' })),
    };
    const page: any = { url: () => url, goto: async (target: string) => { url = target; }, waitForLoadState: async () => {}, waitForTimeout: async () => {}, evaluate: async () => '',
      frames: () => [page], mainFrame: () => page, locator: () => ({ first: () => ({ isVisible: async () => false, evaluate: async () => null }) }) };
    const finishRecovery = vi.fn(async (view: any) => ({ snapshot: view }));
    const run = () => recoverAccountPassword({ page, snapshot: signInView(), ctx: { candidate: { identity: { email: ALIAS } }, accounts, dryRun: false }, host: HOST,
      account: { email: ALIAS, password: 'staged', status, recoveryRequestedAt: Date.now() - 1000, recoveryRequestId: 'req' }, diagnostics: null, typedSecrets: null,
      registrationRestarts: new Map(), recoveryAttempts: new Set(), finishRecovery });
    return { run, accounts, finishRecovery };
  }

  it('completes the pending reset, marks it used first, and asks for no new reset', async () => {
    const { run, accounts, finishRecovery } = setup();
    const result: any = await run();
    expect(result.accountRecovered).toBe(true);
    expect(accounts.consumePasswordReset).toHaveBeenCalledTimes(1);
    expect(accounts.consumePasswordReset).toHaveBeenCalledWith(HOST, 'm1');
    expect(accounts.completeRecovery).toHaveBeenCalledWith(HOST, { password: 'temp-one' });
    expect(accounts.beginRecovery).not.toHaveBeenCalled();
    expect(accounts.waitForPasswordReset).not.toHaveBeenCalled();
    expect(finishRecovery).toHaveBeenCalledTimes(1);
  });

  it('an expired or refused pending reset is consumed and the normal path follows (never a wait for the same e-mail)', async () => {
    const { run, accounts } = setup({ afterGoto: noSignIn });
    const result: any = await run();
    expect(result.accountRecovered).not.toBe(true);
    expect(result.handoff).toBeTruthy();
    expect(accounts.consumePasswordReset).toHaveBeenCalledTimes(1);
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
    expect(none.accounts.consumePasswordReset).not.toHaveBeenCalled();
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

  it('returns the arrived link without waiting, and never again once it is consumed', async () => {
    const { store, begun, add } = await recovering();
    expect(await store.pendingPasswordReset(HOST)).toBeNull();
    const ref = await add({});
    const pending = await store.pendingPasswordReset(HOST);
    expect(pending).toMatchObject({ messageId: ref.id, url: `https://${HOST}/?PasswordResetToken=abc&PersID=1` });
    expect(await store.consumePasswordReset(HOST, ref.id)).toBe(true);
    expect(await store.consumePasswordReset(HOST, ref.id)).toBe(false);
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
