import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ snapshot: null as any, filled: [] as any[] }));
vi.mock('../scripts/assisted-application/lib/portal/fields.mjs', async importOriginal => ({
  ...await importOriginal<any>(), extractFields: async () => state.snapshot,
}));
vi.mock('../scripts/assisted-application/lib/portal/fill.mjs', async importOriginal => ({
  ...await importOriginal<any>(), applyActions: async (_page: any, fields: any[]) => { state.filled = fields; return []; },
}));
import { verifyPortalApplication } from '../scripts/assisted-application/lib/portal/verify.mjs';
import { applicationExistsProbeEntry } from '../functions/src/lib/applicationExistsReconciliation.js';

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

function harness({ postTo = loginUrl, formAction = loginUrl, signedInPage = existsUrl }: { postTo?: string; formAction?: string; signedInPage?: string } = {}) {
  let handler: (route: any) => Promise<void>;
  let currentUrl = '';
  let signedIn = false;
  const log: Array<{ method: string; url: string; allowed: boolean }> = [];
  const fire = async (url: string, method = 'GET', navigation = true) => {
    let allowed = false;
    await handler({ request: () => ({ method: () => method, url: () => url, isNavigationRequest: () => navigation, resourceType: () => (navigation ? 'document' : 'xhr') }),
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
      else { await fire(loginUrl); currentUrl = loginUrl; state.snapshot = loginPage(); }
    },
    locator: () => ({ first: () => ({
      evaluate: async () => ({ action: formAction, method: 'post', credentialsOwned: true }),
      click: async () => { signedIn = await fire(postTo, 'POST', false); },
    }) }),
    waitForLoadState: async () => {}, waitForTimeout: async () => {}, evaluate: async () => state.snapshot.text, screenshot: async () => Buffer.from('fixture'),
  };
  const context = { route: async (_pattern: string, h: typeof handler) => { handler = h; }, routeWebSocket: async () => {}, addInitScript: async () => {}, newPage: async () => page, close: async () => {} };
  const run = () => verifyPortalApplication({ applyUrl, targetUrl: entry, probe, job: {}, accounts: { load: vi.fn(async () => account) } as any,
    launch: async () => ({ newContext: async () => context, close: async () => {} }) as any });
  return { run, fire, log };
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

  it('accepts the sign-in POST when the portal appends a return address, still only on the vacancy login route', async () => {
    const { run } = harness({ postTo: `${loginUrl}?ReturnUrl=x`, formAction: loginUrl });
    expect(((await run()) as any).applicationExists).not.toBeNull();
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
