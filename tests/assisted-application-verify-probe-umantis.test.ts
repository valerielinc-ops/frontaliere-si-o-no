import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ snapshot: null as any, filled: [] as any[], actions: [] as any[] }));
vi.mock('../scripts/assisted-application/lib/portal/fields.mjs', async importOriginal => ({
  ...await importOriginal<any>(), extractFields: async () => state.snapshot,
}));
vi.mock('../scripts/assisted-application/lib/portal/fill.mjs', async importOriginal => ({
  ...await importOriginal<any>(), applyActions: async (_page: any, fields: any[], actions: any[]) => { state.filled = fields; state.actions = actions; return []; },
}));
import { safeErrorInfo, verifyPortalApplication } from '../scripts/assisted-application/lib/portal/verify.mjs';
import { applicationExistsProbeEntry, applicationExistsProbeNavigation } from '../functions/src/lib/applicationExistsReconciliation.js';
import { portalAccountStore } from '../scripts/assisted-application/lib/portal/account.mjs';
import { createMemoryFirestore } from './helpers/memoryFirestore';

const HOST = 'recruitingapp-0000.umantis.com';
const applyUrl = `https://${HOST}/Vacancies/6604/Description/1`;
const probe = applicationExistsProbeEntry(applyUrl)!;
const entry = probe.entryUrl;
const loginUrl = `https://${HOST}/Vacancies/6604/Application/Login/1`;
const existsUrl = `https://${HOST}/Vacancies/6604/FurtherApplication/ApplicationExists/9`;
const account = { email: 'maria.rossi.abcd@candidature.frontaliereticino.ch', password: 'test-only-credential' };

// A Login page of this ATS carries a registration form next to the sign-in form: three password fields in all.
const loginPage = () => ({
  fields: [
    { id: 'u1', kind: 'text', inputType: 'text', label: 'Benutzername:', frame: 0, formId: 'login' },
    { id: 'p1', kind: 'text', inputType: 'password', label: 'Passwort:', frame: 0, formId: 'login' },
    { id: 'r1', kind: 'text', inputType: 'email', label: 'E-Mail', frame: 0, formId: 'register' },
    { id: 'r2', kind: 'text', inputType: 'password', label: 'Passwort', frame: 0, formId: 'register' },
    { id: 'r3', kind: 'text', inputType: 'password', label: 'Passwort wiederholen', frame: 0, formId: 'register' },
  ],
  buttons: [{ id: 'b1', text: 'Login', frame: 0, formId: 'login' }, { id: 'b2', text: 'Registrieren', frame: 0, formId: 'register' }],
  passwordVisible: true, captcha: false, errors: [], text: 'Anmelden',
});
const existsPage = () => ({ fields: [], buttons: [{ id: 'b9', text: 'Weiter', frame: 0 }], passwordVisible: false, captcha: false, errors: [], text: 'Bewerbung bereits vorhanden' });

type Entry = 'redirect_to_login' | 'inline_signin' | 'register_only';
const registerOnlyPage = () => ({
  fields: [
    { id: 'r1', kind: 'text', inputType: 'email', label: 'E-Mail', frame: 0, formId: 'application' },
    { id: 'r2', kind: 'text', inputType: 'password', label: 'Passwort', frame: 0, formId: 'application' },
    { id: 'r3', kind: 'text', inputType: 'password', label: 'Passwort wiederholen', frame: 0, formId: 'application' },
    { id: 'r4', kind: 'file', inputType: 'file', label: 'Lebenslauf', frame: 0, formId: 'application' },
  ],
  buttons: [{ id: 'b3', text: 'Weiter', frame: 0, formId: 'application' }], passwordVisible: true, captcha: false, errors: [], text: 'Bewerbung',
});
const inlineSigninPage = () => ({ ...loginPage(), text: 'Bewerbung. Bereits registriert? Anmelden' });

type Store = { current: any; load: any; abortRecovery: any; mark: any; adoptPassword: any; resetPasswordCandidates: any; beginRecovery: any };
function makeStore(account: any): Store {
  const store: any = { current: account };
  store.load = vi.fn(async () => store.current);
  store.abortRecovery = vi.fn(async () => true);
  store.mark = vi.fn(async () => {});
  store.adoptPassword = vi.fn(async () => true);
  store.resetPasswordCandidates = vi.fn(async () => []);
  store.beginRecovery = vi.fn(async () => ({ status: 'started', requestedAt: 1 }));
  return store;
}

function harness({ postTo = loginUrl, formAction = loginUrl, signedInPage = existsUrl, entryPage = 'redirect_to_login', accepted = null, store = makeStore(account), recover = undefined, allowRecovery = false, aliasEmail = '' }: { postTo?: string; formAction?: string; signedInPage?: string; entryPage?: Entry; accepted?: string[] | null; store?: Store; recover?: any; allowRecovery?: boolean; aliasEmail?: string } = {}) {
  let handler: (route: any) => Promise<void>;
  let currentUrl = '';
  let signedIn = false;
  const log: Array<{ method: string; url: string; allowed: boolean }> = [];
  const subframe = { name: 'subframe' };
  const fire = async (url: string, method = 'GET', navigation = true, inSubframe = false) => {
    let allowed = false;
    await handler({ request: () => ({ method: () => method, url: () => url, isNavigationRequest: () => navigation, resourceType: () => (navigation ? 'document' : 'xhr'), frame: () => (inSubframe ? subframe : page) }),
      abort: async () => { allowed = false; }, continue: async () => { allowed = true; } });
    log.push({ method, url, allowed });
    return allowed;
  };
  const page: any = {
    url: () => currentUrl,
    mainFrame: () => page,
    frames: () => [page],
    goto: async (url: string) => {
      await fire(url);
      if (signedIn) { await fire(signedInPage); currentUrl = signedInPage; state.snapshot = signedInPage === existsUrl ? existsPage() : loginPage(); }
      else if (url === loginUrl) { currentUrl = loginUrl; state.snapshot = loginPage(); }
      else if (entryPage === 'redirect_to_login') { await fire(loginUrl); currentUrl = loginUrl; state.snapshot = loginPage(); }
      else {
        // The entry page itself, with the tenant's static header loaded as a sub-frame.
        await fire(`https://${HOST}/pubhtml/2800/customer/1/header.html?20261128`, 'GET', true, true);
        currentUrl = entry;
        state.snapshot = entryPage === 'inline_signin' ? inlineSigninPage() : registerOnlyPage();
      }
    },
    locator: () => ({ first: () => ({
      evaluate: async () => ({ action: formAction, method: 'post', credentialsOwned: true }),
      click: async () => {
        const typed = state.actions.find((action: any) => action.fieldId === 'p1')?.value;
        const posted = await fire(postTo, 'POST', false);
        signedIn = posted && (accepted === null || accepted.includes(typed));
      },
    }) }),
    waitForLoadState: async () => {}, waitForTimeout: async () => {}, evaluate: async () => state.snapshot.text, screenshot: async () => Buffer.from('fixture'),
  };
  const context = { route: async (_pattern: string, h: typeof handler) => { handler = h; }, routeWebSocket: async () => {}, addInitScript: async () => {}, newPage: async () => page, close: async () => {} };
  const run = () => verifyPortalApplication({ applyUrl, targetUrl: entry, probe, job: {}, accounts: store as any, allowRecovery, aliasEmail, ...(recover ? { recover } : {}),
    launch: async () => ({ newContext: async () => context, close: async () => {} }) as any });
  return { run, fire, log, store };
}

describe('probe of an ATS sign-in with a registration form beside it (entry -> Login -> POST -> ApplicationExists)', () => {
  it('signs in on the form of its own button and reads the application-exists route', async () => {
    const { run, log } = harness();
    const proof: any = await run();
    expect(proof.applicationExists).toMatchObject({ routeKind: 'umantis_application_exists', vacancyId: '6604', pagePath: '/Vacancies/6604/FurtherApplication/ApplicationExists/9' });
    expect(proof.blockedRequests).toBe(0);
    expect(log.filter(entryLog => entryLog.method === 'POST')).toEqual([{ method: 'POST', url: loginUrl, allowed: true }]);
    expect(proof.trace.map((item: any) => item.kind)).toEqual(expect.arrayContaining(['navigation', 'page', 'login_post']));
    expect(JSON.stringify(proof.trace)).not.toContain(account.password);
  });

  it('trace of the real run: the static header sub-frame is not a blocked navigation, and an inline sign-in block on the entry page is used', async () => {
    const { run, log } = harness({ entryPage: 'inline_signin' });
    const proof: any = await run();
    expect(proof.blockedRequests).toBe(0);
    expect(log[1]).toMatchObject({ method: 'GET', url: expect.stringContaining('/pubhtml/2800/customer/1/header.html'), allowed: true });
    expect(proof.applicationExists).toMatchObject({ vacancyId: '6604' });
    expect(log.filter(entryLog => entryLog.method === 'POST')).toEqual([{ method: 'POST', url: loginUrl, allowed: true }]);
    expect(state.filled.map((field: any) => field.id)).toEqual(['u1', 'p1']);
  });

  it('an entry page with only a registration form goes to the vacancy\'s own Login page, never filling the application form', async () => {
    const { run, log } = harness({ entryPage: 'register_only' });
    const proof: any = await run();
    expect(proof.applicationExists).toMatchObject({ vacancyId: '6604' });
    expect(log.some(entryLog => entryLog.url === loginUrl && entryLog.allowed)).toBe(true);
    expect(state.filled.map((field: any) => field.id)).toEqual(['u1', 'p1']);
    expect(proof.trace).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'page', reason: 'login_page', path: '/Vacancies/6604/Application/Login/1' })]));
  });

  it('an inline sign-in whose form posts to the application itself is never submitted', async () => {
    const { run, log } = harness({ entryPage: 'inline_signin', formAction: entry });
    const proof: any = await run();
    expect(proof.stopReason).toBe('login_action_not_trusted');
    expect(log.some(entryLog => entryLog.method === 'POST')).toBe(false);
    expect(proof.applicationExists ?? null).toBeNull();
  });

  it('a main-frame navigation to the static folder stays blocked (only sub-frames are read)', async () => {
    const { run, fire } = harness({ entryPage: 'inline_signin' });
    const proof: any = await run();
    expect(await fire(`https://${HOST}/pubhtml/2800/customer/1/header.html`)).toBe(false);
    expect(proof.trace.at(-1)).toMatchObject({ kind: 'blocked', reason: 'navigation_not_allowed' });
    expect(await fire(`https://other.example/pubhtml/x.html`, 'GET', true, true)).toBe(false);
  });

  it('accepts the sign-in POST when the portal appends a return address, still only on the vacancy login route', async () => {
    const { run } = harness({ postTo: `${loginUrl}?ReturnUrl=x`, formAction: loginUrl });
    expect(((await run()) as any).applicationExists).not.toBeNull();
  });

  it.each([
    [`${loginUrl}?action=submit`, 'mutation_parameter'],
    [`${loginUrl}?Submit=1`, 'mutation_parameter'],
    [`${loginUrl}?ReturnUrl=https://evil.example/x`, 'login_route_mismatch'],
    [`${loginUrl}?ReturnUrl=//evil.example/x`, 'login_route_mismatch'],
    [`${loginUrl}?ReturnUrl=/Vacancies/6604/Application/Submit/1`, 'login_route_mismatch'],
    [`${loginUrl}?ReturnUrl=/ok&other=1`, 'login_route_mismatch'],
  ])('never proceeds with a sign-in POST carrying %s', async (postTo, reason) => {
    const { run, log } = harness({ postTo, formAction: loginUrl });
    const proof: any = await run();
    expect(log.find(entryLog => entryLog.method === 'POST')?.allowed).toBe(false);
    expect(proof.trace).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'blocked', method: 'POST', reason })]));
    expect(proof.applicationExists ?? null).toBeNull();
    expect(proof.trace.some((item: any) => item.kind === 'login_post')).toBe(false);
  });

  it('an action with a mutation key is not a trusted sign-in action, nor an allowed navigation', () => {
    expect(applicationExistsProbeNavigation(`${loginUrl}?action=submit`, probe)).toBe(false);
    expect(applicationExistsProbeNavigation(`${loginUrl}?ReturnUrl=%2Fok`, probe)).toBe(true);
  });

  it('records the refusal of a POST to any other route, with its reason, and never reads the page as proof', async () => {
    const { run, log } = harness({ postTo: `https://${HOST}/Vacancies/6604/Application/Submit/1`, formAction: loginUrl });
    const proof: any = await run();
    expect(log.find(entryLog => entryLog.method === 'POST')?.allowed).toBe(false);
    expect(proof.trace).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'blocked', method: 'POST', reason: 'login_route_mismatch', path: '/Vacancies/6604/Application/Submit/1' })]));
    expect(proof.applicationExists ?? null).toBeNull();
  });

  it('stops with a named reason, and a trace of the pages seen, when the sign-in action is not the vacancy login route', async () => {
    const { run } = harness({ formAction: `https://${HOST}/Vacancies/6604/Application/Finish/1` });
    const proof: any = await run();
    expect(proof).toMatchObject({ stopReason: 'login_action_not_trusted', pages: [] });
    expect(proof.trace).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'page', path: '/Vacancies/6604/Application/Login/1' }),
      expect.objectContaining({ kind: 'stop', reason: 'login_action_not_trusted' }),
    ]));
  });

  it.each([
    ['GET', `https://${HOST}/Vacancies/6604/Application/Submit/1`, 'mutation_path'],
    ['GET', `https://${HOST}/Vacancies/6604/Application/Finalize/1`, 'mutation_path'],
    ['GET', `https://${HOST}/Vacancies/6604/Application/Withdraw/1`, 'mutation_path'],
    ['GET', `https://${HOST}/Vacancies/6604/Application/Delete/1`, 'mutation_path'],
    ['GET', `https://${HOST}/Vacancies/6604/Application/New/1?action=send`, 'mutation_parameter'],
    ['GET', `https://${HOST}/Vacancies/1234/Application/New/1`, 'navigation_not_allowed'],
    ['GET', `https://${HOST}/SelfService`, 'navigation_not_allowed'],
    ['POST', `https://${HOST}/Vacancies/6604/Application/Login/1`, 'mutation_not_armed'],
    ['PUT', `https://${HOST}/Vacancies/6604/Application/New/1`, 'mutation_not_armed'],
  ])('keeps blocking %s %s (%s) and records it with its reason', async (method, url, reason) => {
    const { run, fire } = harness();
    const proof: any = await run();
    const before = proof.blockedRequests;
    // The route handler is the fence of the run: it records into the proof it returned.
    expect(await fire(url, method)).toBe(false);
    expect(proof.blockedRequests).toBe(before + 1);
    expect(proof.trace.at(-1)).toMatchObject({ kind: 'blocked', method, reason });
  });
});

describe('rejected sign-in: the previous password, then one recovery of the alias account', () => {
  const alias = account.email;

  it('tries the password that was valid before an unconfirmed recovery, and keeps it as the account\'s when it works', async () => {
    const store = makeStore({ ...account, password: 'staged-never-applied', previousPassword: 'old-valid-one' });
    const recover = vi.fn();
    const { run, log } = harness({ accepted: ['old-valid-one'], store, recover, allowRecovery: true, aliasEmail: alias });
    const proof: any = await run();
    expect(proof.applicationExists).toMatchObject({ vacancyId: '6604' });
    expect(recover).not.toHaveBeenCalled();
    expect(log.filter(entryLog => entryLog.method === 'POST')).toHaveLength(2);
    expect(store.adoptPassword).toHaveBeenCalledWith(HOST, 'old-valid-one');
    expect(proof.trace).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'account', reason: 'password_adopted' })]));
  });

  it('recovers once through the portal\'s /Password/ routes, then signs in with the new password and reads the route', async () => {
    const store = makeStore({ ...account, password: 'rejected-one' });
    let fireInRecovery: any;
    const recover = vi.fn(async ({ finishRecovery, host, ctx }: any) => {
      expect(host).toBe(HOST);
      expect(ctx.candidate.identity.email).toBe(alias);
      expect(await fireInRecovery(`https://${HOST}/Password/PWForgotten`)).toBe(true);
      expect(await fireInRecovery(`https://${HOST}/Password/PWForgotten`, 'POST', false)).toBe(true);
      expect(await fireInRecovery(`https://${HOST}/Password/PWForgottenConfirm?token=abc`)).toBe(true);
      expect(await fireInRecovery(`https://${HOST}/Password/PWForgottenConfirm`, 'POST', false)).toBe(true);
      // Nothing else: a third POST, another route, a mutation key, a foreign host.
      expect(await fireInRecovery(`https://${HOST}/Password/PWForgottenConfirm`, 'POST', false)).toBe(false);
      expect(await fireInRecovery(`https://${HOST}/Vacancies/6604/Application/New/1`, 'POST', false)).toBe(false);
      expect(await fireInRecovery(`https://${HOST}/Password/PWForgotten?action=submit`)).toBe(false);
      expect(await fireInRecovery(`https://other.example/Password/PWForgotten`)).toBe(false);
      store.current = { ...store.current, password: 'fresh-one' };
      return { ...(await finishRecovery({})), accountRecovered: true };
    });
    const h = harness({ accepted: ['fresh-one'], store, recover, allowRecovery: true, aliasEmail: alias });
    fireInRecovery = h.fire;
    const proof: any = await h.run();
    expect(recover).toHaveBeenCalledTimes(1);
    expect(proof.applicationExists).toMatchObject({ vacancyId: '6604' });
    expect(proof.recovery).toMatchObject({ attempted: true, accepted: true });
    expect(store.mark).toHaveBeenCalledWith(HOST, expect.objectContaining({ status: 'created' }));
    expect(h.log.filter(entryLog => entryLog.method === 'POST' && entryLog.url === loginUrl)).toHaveLength(2);
    // Outside the recovery the /Password/ routes are closed again.
    expect(await h.fire(`https://${HOST}/Password/PWForgotten`)).toBe(false);
    expect(await h.fire(`https://${HOST}/Password/PWForgotten`, 'POST', false)).toBe(false);
  });

  it('a refused recovery ends unknown with its reason, and signs in nowhere else', async () => {
    const store = makeStore({ ...account, password: 'rejected-one' });
    const recover = vi.fn(async () => ({ handoff: 'account_recovery_timeout', accountFailure: { code: 'account_recovery_timeout', stage: 'login' } }));
    const { run, log } = harness({ accepted: [], store, recover, allowRecovery: true, aliasEmail: alias });
    const proof: any = await run();
    expect(proof).toMatchObject({ stopReason: 'account_recovery_failed', recovery: { attempted: true, accepted: false, code: 'account_recovery_timeout' } });
    expect(proof.applicationExists ?? null).toBeNull();
    expect(recover).toHaveBeenCalledTimes(1);
    expect(log.filter(entryLog => entryLog.method === 'POST')).toHaveLength(1);
    expect(store.mark).not.toHaveBeenCalled();
  });

  it('does not recover when it is not allowed or the alias is unknown', async () => {
    const recover = vi.fn();
    for (const options of [{ allowRecovery: false, aliasEmail: alias }, { allowRecovery: true, aliasEmail: '' }]) {
      const { run } = harness({ accepted: [], recover, ...options });
      expect(((await run()) as any).stopReason).toBe('login_not_accepted');
    }
    expect(recover).not.toHaveBeenCalled();
  });
});

describe('the reset e-mail\'s link and the errors of an inspection', () => {
  const alias = account.email;
  const resetLink = `https://${HOST}/?PasswordResetToken=SECRETTOKEN&PersID=1&customer=x&lang=ger&DesignID=2`;

  it('the link the reset e-mail names is the one extra navigation the recovery may make (the run of 28/11 died on it)', async () => {
    const store = makeStore({ ...account, password: 'rejected-one' });
    store.waitForPasswordReset = vi.fn(async () => ({ url: resetLink, messageId: 'm', receivedAt: 2 }));
    let fireIn: any;
    const recover = vi.fn(async ({ ctx, host }: any) => {
      // Before the e-mail is read, the same URL is refused; once the store names it, exactly it is allowed.
      expect(await fireIn(resetLink)).toBe(false);
      await ctx.accounts.waitForPasswordReset({ host, sinceMs: 1 });
      expect(await fireIn(resetLink)).toBe(true);
      expect(await fireIn(`https://${HOST}/?PasswordResetToken=OTHER`)).toBe(false);
      expect(await fireIn(`https://${HOST}/Password/PWForgottenConfirm?PasswordResetToken=SECRETTOKEN`)).toBe(true);
      return { handoff: 'account_recovery_timeout', accountFailure: { code: 'account_recovery_timeout', stage: 'login' } };
    });
    const h = harness({ accepted: [], store, recover, allowRecovery: true, aliasEmail: alias });
    fireIn = h.fire;
    const proof: any = await h.run();
    expect(recover).toHaveBeenCalledTimes(1);
    expect(proof.trace).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'reset_link', path: '/', params: expect.arrayContaining(['PasswordResetToken']) })]));
    // Parameter NAMES only: the token itself is never in the evidence.
    expect(JSON.stringify(proof)).not.toContain('SECRETTOKEN');
  });

  it('the link of a reset e-mail that already arrived (the pending one) is allowed exactly, like the one waited for', async () => {
    const store = makeStore({ ...account, password: 'rejected-one', status: 'recovering', recoveryRequestedAt: 1 });
    store.pendingPasswordReset = vi.fn(async () => ({ url: resetLink, messageId: 'm1', receivedAt: 2 }));
    let fireIn: any;
    const recover = vi.fn(async ({ ctx, host }: any) => {
      expect(await fireIn(resetLink)).toBe(false);
      await ctx.accounts.pendingPasswordReset(host);
      expect(await fireIn(resetLink)).toBe(true);
      expect(await fireIn(`${resetLink}&extra=1`)).toBe(false);
      return { handoff: 'account_recovery_timeout', accountFailure: { code: 'account_recovery_timeout', stage: 'login' } };
    });
    const h = harness({ accepted: [], store, recover, allowRecovery: true, aliasEmail: alias });
    fireIn = h.fire;
    await h.run();
    expect(recover).toHaveBeenCalledTimes(1);
    expect(store.pendingPasswordReset).toHaveBeenCalledWith(HOST);
  });

  it('refuses a reset link on another host, or with a mutation key', async () => {
    for (const link of [`https://other.example/?PasswordResetToken=x`, `https://${HOST}/?PasswordResetToken=x&action=submit`]) {
      const store = makeStore({ ...account, password: 'rejected-one' });
      store.waitForPasswordReset = vi.fn(async () => ({ url: link }));
      let fireIn: any;
      const recover = vi.fn(async ({ ctx, host }: any) => {
        await ctx.accounts.waitForPasswordReset({ host, sinceMs: 1 });
        expect(await fireIn(link)).toBe(false);
        return { handoff: 'account_recovery_timeout', accountFailure: { code: 'account_recovery_timeout', stage: 'login' } };
      });
      const h = harness({ accepted: [], store, recover, allowRecovery: true, aliasEmail: alias });
      fireIn = h.fire;
      await h.run();
      expect(recover).toHaveBeenCalledTimes(1);
    }
  });

  it('an error in the middle of an inspection keeps the trace and says where and what, as identifiers only', async () => {
    const store = makeStore({ ...account, password: 'rejected-one' });
    const recover = vi.fn(async () => { throw Object.assign(new Error('page.goto: net::ERR_FAILED at https://recruitingapp-2800.umantis.com/?PasswordResetToken=SECRETTOKEN'), { name: 'Error' }); });
    const { run } = harness({ accepted: [], store, recover, allowRecovery: true, aliasEmail: alias });
    const proof: any = await run();
    expect(proof.stopReason).toBe('inspection_exception');
    expect(proof.error).toEqual({ stage: 'recovery', name: 'Error', message: 'net::ERR_FAILED' });
    expect(proof.trace.length).toBeGreaterThan(3);
    expect(proof.trace.at(-1)).toMatchObject({ kind: 'exception', reason: 'exception', stage: 'recovery' });
    expect(JSON.stringify(proof)).not.toContain('SECRETTOKEN');
  });

  it('safeErrorInfo never lets a message through, only known tokens', () => {
    expect(safeErrorInfo(new TypeError("Cannot read properties of undefined (reading 'password') for maria@example.test"), 'login'))
      .toEqual({ stage: 'login', name: 'TypeError', message: 'read_of_undefined' });
    expect(safeErrorInfo(Object.assign(new Error('Timeout 6000ms exceeded. waiting for secret page'), { name: 'TimeoutError' }), 'Entry!'))
      .toEqual({ stage: 'ntry', name: 'TimeoutError', message: 'timeout' });
    expect(safeErrorInfo(Object.assign(new Error('free text with a password hunter2'), { code: 'ECONNRESET' }), 'inspect'))
      .toEqual({ stage: 'inspect', name: 'Error', code: 'ECONNRESET' });
    expect(safeErrorInfo({ name: 'weird name!', message: 'x' }, 'x')).toEqual({ stage: 'x', name: 'Error' });
  });
});

describe('the portal resets the password when the request is sent: the e-mailed ones are candidates before any new request', () => {
  const alias = account.email;

  it('signs in with the newest e-mailed password, adopts it, and asks for no new reset', async () => {
    const store = makeStore({ ...account, password: 'rejected-one' });
    store.resetPasswordCandidates = vi.fn(async () => ['temp-newest', 'temp-older']);
    const recover = vi.fn();
    const { run, log } = harness({ accepted: ['temp-newest'], store, recover, allowRecovery: true, aliasEmail: alias });
    const proof: any = await run();
    expect(proof.applicationExists).toMatchObject({ vacancyId: '6604' });
    expect(store.resetPasswordCandidates).toHaveBeenCalledWith(HOST, { limit: 2 });
    expect(store.adoptPassword).toHaveBeenCalledWith(HOST, 'temp-newest');
    expect(recover).not.toHaveBeenCalled();
    expect(log.filter(entryLog => entryLog.method === 'POST')).toHaveLength(2);
  });

  it('also tries the last password that made a verified sign-in, never the same one twice, and at most three more', async () => {
    const store = makeStore({ ...account, password: 'rejected-one', previousPassword: 'rejected-one', lastGoodPassword: 'good-before' });
    store.resetPasswordCandidates = vi.fn(async () => ['temp-newest', 'rejected-one', 'temp-older', 'temp-oldest']);
    const { run, log } = harness({ accepted: ['good-before'], store, recover: vi.fn(), allowRecovery: false, aliasEmail: alias });
    const proof: any = await run();
    // The stored one once, then temp-newest, temp-older, temp-oldest (a duplicate is never tried twice): the last
    // good one is beyond the cap of three more sign-ins.
    expect(log.filter(entryLog => entryLog.method === 'POST')).toHaveLength(4);
    expect(proof.stopReason).toBe('login_not_accepted');
    const second = makeStore({ ...account, password: 'rejected-one', lastGoodPassword: 'good-before' });
    const again = harness({ accepted: ['good-before'], store: second });
    expect(((await again.run()) as any).applicationExists).toMatchObject({ vacancyId: '6604' });
    expect(second.adoptPassword).toHaveBeenCalledWith(HOST, 'good-before');
  });

  it('records the store\'s answer to a recovery request (rate limit with its retry time) when no click was made', async () => {
    const store = makeStore({ ...account, password: 'rejected-one' });
    store.beginRecovery = vi.fn(async () => ({ status: 'rate_limited', retryAt: 1_700_000_000_000 }));
    const recover = vi.fn(async ({ ctx }: any) => {
      await ctx.accounts.beginRecovery(HOST, { email: alias, password: 'staged' });
      return { handoff: 'account_recovery_timeout', accountFailure: { code: 'account_recovery_timeout', stage: 'login' } };
    });
    const { run } = harness({ accepted: [], store, recover, allowRecovery: true, aliasEmail: alias });
    const proof: any = await run();
    expect(proof.recovery).toMatchObject({ attempted: true, accepted: false, begin: 'rate_limited', retryAt: 1_700_000_000_000 });
    expect(proof.trace).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'recovery_begin', reason: 'rate_limited', retryAt: 1_700_000_000_000 })]));
  });
});

describe('the account store keeps the password that was valid before an unconfirmed recovery', () => {
  it('exposes it as previousPassword while the recovery is unconfirmed, and restores it on abort', async () => {
    const db = createMemoryFirestore({ 'assisted_applications/order_store_test': { paymentStatus: 'paid' } }).db;
    const store = portalAccountStore({ db, orderId: 'order_store_test', key: Buffer.alloc(32, 3) });
    await store.save(HOST, { email: account.email, password: 'valid-before' });
    expect((await store.load(HOST))?.previousPassword).toBeUndefined();
    expect(await store.beginRecovery(HOST, { email: account.email, password: 'staged-never-applied' })).toMatchObject({ status: 'started' });
    // The reset never completed (the runner's timeout): the staged password is what `password` now says.
    expect(await store.load(HOST)).toMatchObject({ password: 'staged-never-applied', previousPassword: 'valid-before', status: 'recovering' });
    await store.abortRecovery(HOST, { requestSubmitted: true, reason: 'previous_password_valid' });
    expect(await store.load(HOST)).toMatchObject({ password: 'valid-before' });
    expect((await store.load(HOST))?.previousPassword).toBeUndefined();
  });

  it('keeps the last password of a verified sign-in apart, and reads the portal\'s e-mailed resets from the alias inbox, newest first', async () => {
    const { encryptJson } = await import('../scripts/assisted-application/lib/secure-run.mjs');
    const key = Buffer.alloc(32, 5);
    const mem = createMemoryFirestore({ 'assisted_applications/order_store_two': { paymentStatus: 'paid' } });
    const store = portalAccountStore({ db: mem.db, orderId: 'order_store_two', key });
    await store.save(HOST, { email: account.email, password: 'first-valid' });
    await store.mark(HOST, { status: 'created', verifiedAt: 1000 });
    await store.beginRecovery(HOST, { email: account.email, password: 'staged-never-applied' });
    expect(await store.load(HOST)).toMatchObject({ password: 'staged-never-applied', previousPassword: 'first-valid' });
    const accountsDoc = mem.read('assisted_applications/order_store_two/automation/accounts') as any;
    expect(Object.values(accountsDoc)[0]).toMatchObject({ lastGoodAt: expect.any(Number) });
    const inbox = mem.db.collection('assisted_applications').doc('order_store_two').collection('inbox');
    await inbox.add({ passwordResetHost: HOST, receivedAt: 2000, passwordResetLinkEnc: encryptJson({ temporaryPassword: 'older-temp' }, key) });
    await inbox.add({ passwordResetHost: HOST, receivedAt: 3000, passwordResetLinkEnc: encryptJson({ temporaryPassword: 'newest-temp' }, key) });
    await inbox.add({ passwordResetHost: 'other.example', receivedAt: 4000, passwordResetLinkEnc: encryptJson({ temporaryPassword: 'foreign' }, key) });
    expect(await store.resetPasswordCandidates(HOST, { limit: 3 })).toEqual(['newest-temp', 'older-temp']);
    expect(await store.adoptPassword(HOST, 'newest-temp')).toBe(true);
    expect(await store.load(HOST)).toMatchObject({ password: 'newest-temp', status: 'created' });
    expect((await store.load(HOST))?.previousPassword).toBeUndefined();
  });

  it('tells when a rate-limited recovery may be asked again', async () => {
    let now = Date.UTC(2026, 10, 27, 6, 0);
    const mem = createMemoryFirestore({ 'assisted_applications/order_store_three': { paymentStatus: 'paid' } });
    const store = portalAccountStore({ db: mem.db, orderId: 'order_store_three', key: Buffer.alloc(32, 6), nowMs: () => now });
    await store.save(HOST, { email: account.email, password: 'valid' });
    const first = now;
    expect(await store.beginRecovery(HOST, { email: account.email, password: 'staged-one' })).toMatchObject({ status: 'started' });
    await store.abortRecovery(HOST, { requestSubmitted: true, reason: 'timeout' });
    now += 16 * 60_000;
    const second = now;
    expect(await store.beginRecovery(HOST, { email: account.email, password: 'staged-two' })).toMatchObject({ status: 'started' });
    await store.abortRecovery(HOST, { requestSubmitted: true, reason: 'timeout' });
    now += 3 * 3_600_000;
    expect(await store.beginRecovery(HOST, { email: account.email, password: 'staged-three' })).toEqual({ status: 'rate_limited', retryAt: first + 24 * 3_600_000 });
    expect(second).toBeGreaterThan(first);
  });
});
