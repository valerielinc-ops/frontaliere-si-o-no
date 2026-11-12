import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { portalAccountStore } from '../scripts/assisted-application/lib/portal/account.mjs';
import { handleAuth, verifyAccount } from '../scripts/assisted-application/lib/portal/portal.mjs';

// The federal SuccessFactors tenant accepted the e-mailed code, posted
// `/career` then `/portalcareer` and was still drawing its UI5 shell (no field,
// no button) when the runner read the page and concluded
// `verification_unobserved` (2026-11-10). The portal mailed «Ihr
// Bewerbungskonto wurde erfolgreich erstellt» 25 s after the code.
const host = 'career74.sapsf.eu';
const url = `https://${host}/career?company=examplefed&login_ns=register&career_ns=job_application&career_job_req_id=1`;
const otpPage = (values: Map<string, string>, errors: string[] = []) => ({
  url,
  fields: [{ id: 'otp', kind: 'text', inputType: 'password', label: '*Code:', required: true, frame: 0, value: values.get('otp') || '' }],
  buttons: [{ id: 'next', text: 'Weiter', disabled: false, frame: 0 }],
  links: [], dialogs: [], errors, captcha: false, passwordVisible: true,
  text: 'Bewerbungskonto: Erstellung\nGeben Sie den Code ein, den wir an Ihre E-Mail-Adresse geschickt haben.\n*Code: Anzeigen Weiter',
});
// The shell's own chrome only: words, nothing to fill or press.
const drawing = { url: `https://${host}/portalcareer`, fields: [], buttons: [], links: [], dialogs: [], errors: [], captcha: false, passwordVisible: false, text: 'Stellenportal Bund' };
const applicationForm = {
  url: `https://${host}/portalcareer`,
  fields: [
    { id: 'first-name', kind: 'text', inputType: 'text', label: 'Vorname', frame: 0 },
    { id: 'last-name', kind: 'text', inputType: 'text', label: 'Nachname', frame: 0 },
    { id: 'cv', kind: 'file', inputType: 'file', label: 'Lebenslauf', frame: 0 },
  ],
  buttons: [{ id: 'apply', text: 'Bewerben', disabled: false, frame: 0 }],
  links: [], dialogs: [], errors: [], captcha: false, passwordVisible: false, text: 'Bewerbung',
};

function portal(afterSubmit: (read: number) => any) {
  const values = new Map<string, string>();
  let submitted = false;
  let reads = 0;
  const current = () => (submitted ? afterSubmit(reads++) : otpPage(values));
  const unavailableRole: any = {
    filter: () => unavailableRole,
    first: () => unavailableRole,
    waitFor: vi.fn(async () => { throw new Error('not-visible'); }),
  };
  const frame = {
    url: () => (submitted ? drawing.url : url),
    evaluate: vi.fn(async (_fn: unknown, args?: unknown) => (args ? current() : null)),
    getByRole: vi.fn(() => unavailableRole),
    locator: vi.fn((selector: string) => {
      const id = /data-aa-id="([^"]+)"/.exec(selector)?.[1] || '';
      const locator: any = {
        first: () => locator,
        click: vi.fn(async () => { if (id === 'next') submitted = true; }),
        fill: vi.fn(async (value: string) => { values.set(id, value); }),
        inputValue: vi.fn(async () => values.get(id) || ''),
        count: vi.fn(async () => 0),
      };
      return locator;
    }),
  };
  const page = {
    url: () => frame.url(),
    frames: () => [frame],
    mainFrame: () => frame,
    waitForLoadState: vi.fn(async () => {}),
    // The run's clock moves with each wait, so the 60 s bound is real.
    waitForTimeout: vi.fn(async (ms: number) => { vi.setSystemTime(Date.now() + ms); }),
    getByRole: vi.fn(() => unavailableRole),
  };
  return { page, values, snapshot: () => otpPage(values) };
}

const accountsWith = (notice: unknown = null) => ({
  verificationMessageIds: vi.fn(async () => []),
  waitForVerification: vi.fn(async () => ({ url: '', code: '482915', messageId: 'in-synthetic' })),
  waitForAccountNotice: vi.fn(async () => notice),
  mark: vi.fn(async () => {}),
});

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(1_800_000_000_000); });
afterEach(() => { vi.useRealTimers(); });

describe('the answer to an accepted SuccessFactors code', () => {
  it('waits while the portal is still drawing the page that follows «Weiter»', async () => {
    const { page, values, snapshot } = portal((read) => (read < 6 ? drawing : applicationForm));
    const accounts = accountsWith();
    const result = await verifyAccount({ page: page as any, host, sinceMs: 0, ctx: { accounts } as any, snapshot: snapshot() as any });

    expect(values.get('otp')).toBe('482915');
    expect(result).toMatchObject({ reopen: true });
    expect(result).not.toHaveProperty('handoff');
    expect(accounts.mark).toHaveBeenCalledWith(host, { verifiedAt: expect.any(Number) });
    expect(accounts.waitForAccountNotice).not.toHaveBeenCalled();
  });

  it('takes the portal’s «account created» mail as the answer when the page never settles', async () => {
    const started = Date.now();
    const { page, snapshot } = portal(() => drawing);
    const accounts = accountsWith({ messageId: 'in-notice', kind: 'created' });
    const result = await verifyAccount({ page: page as any, host, sinceMs: 0, ctx: { accounts } as any, snapshot: snapshot() as any });

    expect(result).toMatchObject({ reopen: true });
    expect(accounts.waitForAccountNotice).toHaveBeenCalledWith({ host, sinceMs: expect.any(Number) });
    // Only a mail received once the code was sent counts.
    expect((accounts.waitForAccountNotice.mock.calls as any)[0][0].sinceMs).toBeGreaterThanOrEqual(started);
    expect(accounts.mark).toHaveBeenCalledWith(host, { verifiedAt: expect.any(Number) });
  });

  it('stays unconfirmed, after the bounded wait, without that mail', async () => {
    const started = Date.now();
    const { page, snapshot } = portal(() => drawing);
    const accounts = accountsWith(null);
    const result = await verifyAccount({ page: page as any, host, sinceMs: 0, ctx: { accounts } as any, snapshot: snapshot() as any });

    expect(result).toMatchObject({ handoff: 'account_verification_unconfirmed', accountFailure: { code: 'verification_unobserved', stage: 'verification' } });
    expect(Date.now() - started).toBeGreaterThanOrEqual(60_000);
    expect(accounts.mark).not.toHaveBeenCalled();
  });

  it('accepts the source-proven portalcareer continuation before its UI5 controls draw', async () => {
    const { page, snapshot } = portal(() => drawing);
    const accounts = accountsWith(null);
    const postingUrl = 'https://jobs.example.test/job/example-role/1/';
    const result = await verifyAccount({
      page: page as any,
      host,
      sinceMs: 0,
      ctx: {
        accounts,
        postingUrl,
        postingRouteProof: { via: 'successfactors', applyUrl: url, postingUrl },
      } as any,
      snapshot: snapshot() as any,
    });

    expect(result).toMatchObject({ reopen: true });
    expect(result).not.toHaveProperty('handoff');
    expect(accounts.mark).toHaveBeenCalledWith(host, { verifiedAt: expect.any(Number) });
    expect(accounts.waitForAccountNotice).not.toHaveBeenCalled();
  });

  it('answers a page that never reads again with a bounded handoff, not an uncaught rejection', async () => {
    const started = Date.now();
    const { page, snapshot } = portal(() => { throw new Error('Execution context was destroyed'); });
    const accounts = accountsWith(null);
    const result = await verifyAccount({ page: page as any, host, sinceMs: 0, ctx: { accounts } as any, snapshot: snapshot() as any });

    expect(result).toMatchObject({ handoff: expect.stringMatching(/^account_verification_(?:pending|unconfirmed)$/), accountFailure: { stage: 'verification' } });
    expect(Date.now() - started).toBeLessThanOrEqual(61_000);
    expect(accounts.mark).not.toHaveBeenCalled();
  });

  it('takes the «account created» mail for a page still pending at the deadline', async () => {
    const { page, snapshot } = portal(() => { throw new Error('Execution context was destroyed'); });
    const accounts = accountsWith({ messageId: 'in-notice', kind: 'created' });
    const result = await verifyAccount({ page: page as any, host, sinceMs: 0, ctx: { accounts } as any, snapshot: snapshot() as any });

    expect(result).toMatchObject({ reopen: true });
    expect(result).not.toHaveProperty('handoff');
    expect(accounts.mark).toHaveBeenCalledWith(host, { verifiedAt: expect.any(Number) });
  });

  it('never lets a mail overrule a code the portal refused', async () => {
    const values = new Map<string, string>();
    const { page, snapshot } = portal(() => otpPage(values, ['Der eingegebene Code ist ungültig.']));
    const accounts = accountsWith({ messageId: 'in-notice', kind: 'created' });
    const result = await verifyAccount({ page: page as any, host, sinceMs: 0, ctx: { accounts } as any, snapshot: snapshot() as any });

    expect(result).toMatchObject({ handoff: 'account_verification_rejected' });
    expect(accounts.waitForAccountNotice).not.toHaveBeenCalled();
    expect(accounts.mark).not.toHaveBeenCalled();
  });
});

describe('the next run after an accepted code it never saw', () => {
  it('signs in with the saved password instead of registering the address again', async () => {
    const signInUrl = `https://${host}/career?company=examplefed&career_ns=job_application&career_job_req_id=1`;
    const values = new Map<string, string>();
    let signedIn = false;
    const register = vi.fn();
    const account = { email: 'runner@example.test', password: 'synthetic-password', status: 'created', createdAt: 500, verifiedAt: null as number | null };
    const loginFields = [
      { id: 'email', kind: 'text', inputType: 'email', label: 'E-Mail-Adresse:*', required: true, formId: 'login-form', frame: 0 },
      { id: 'password', kind: 'text', inputType: 'password', label: 'Passwort:*', required: true, formId: 'login-form', frame: 0 },
    ];
    const current = () => (signedIn ? applicationForm : {
      url: signInUrl,
      fields: loginFields.map((field) => ({ ...field, value: values.get(field.id) || '' })),
      buttons: [{ id: 'login', text: 'Anmelden', disabled: false, frame: 0, formId: 'login-form' }],
      links: [{ id: 'register', text: 'Bewerbungskonto erstellen', frame: 0 }],
      dialogs: [], captcha: false, passwordVisible: true, errors: [], text: 'Anmelden',
    });
    const unavailableRole: any = { filter: () => unavailableRole, first: () => unavailableRole, waitFor: vi.fn(async () => { throw new Error('not-visible'); }) };
    const frame = {
      url: () => signInUrl,
      evaluate: vi.fn(async (_fn: unknown, args?: unknown) => (args ? current() : null)),
      getByRole: vi.fn(() => unavailableRole),
      locator: vi.fn((selector: string) => {
        const id = /data-aa-id="([^"]+)"/.exec(selector)?.[1] || '';
        const locator: any = {
          first: () => locator,
          waitFor: vi.fn(async () => {}),
          click: vi.fn(async () => { if (id === 'login') signedIn = true; if (id === 'register') register(); }),
          fill: vi.fn(async (value: string) => { values.set(id, value); }),
          inputValue: vi.fn(async () => values.get(id) || ''),
          count: vi.fn(async () => 0),
        };
        return locator;
      }),
    };
    const page = {
      url: () => signInUrl, frames: () => [frame], mainFrame: () => frame,
      waitForLoadState: vi.fn(async () => {}), waitForTimeout: vi.fn(async (ms: number) => { vi.setSystemTime(Date.now() + ms); }),
      getByRole: vi.fn(() => unavailableRole),
    };
    const mark = vi.fn(async (_host: string, patch: Record<string, unknown>) => { Object.assign(account, patch); });
    const accountNotice = vi.fn(async () => ({ messageId: 'in-notice', kind: 'created', receivedAt: 900 }));
    const result = await handleAuth({ page: page as any, snapshot: current() as any, ctx: { accounts: { load: vi.fn(async () => ({ ...account })), mark, accountNotice } } as any });

    expect(accountNotice).toHaveBeenCalledWith({ host, sinceMs: 500 });
    expect(register).not.toHaveBeenCalled();
    expect(values).toEqual(new Map([['email', 'runner@example.test'], ['password', 'synthetic-password']]));
    expect(result).not.toHaveProperty('handoff');
    expect(mark).toHaveBeenCalledWith(host, expect.objectContaining({ verifiedAt: expect.any(Number) }));
  });
});

describe('the account notice the runner reads', () => {
  it('is the inbound handler’s binding for this exact host, after the code, and a creation or activation only', async () => {
    const ORDER = 'order-notice';
    const inbox = (id: string, data: Record<string, unknown>) => [`assisted_applications/${ORDER}/inbox/${id}`, data];
    const store = createMemoryFirestore(Object.fromEntries([
      inbox('old', { receivedAt: 100, category: 'verification', portalAccountNoticeHost: host, portalAccountNotice: 'created' }),
      inbox('other-host', { receivedAt: 900, category: 'verification', portalAccountNoticeHost: 'career5.successfactors.eu', portalAccountNotice: 'created' }),
      inbox('password', { receivedAt: 900, category: 'verification', portalAccountNoticeHost: host, portalAccountNotice: 'password_changed' }),
      inbox('unbound', { receivedAt: 900, category: 'verification', portalVerificationHost: '', verificationUrl: `https://${host}/career` }),
    ]));
    let now = 1000;
    const accounts = portalAccountStore({ db: store.db, orderId: ORDER, key: Buffer.alloc(32, 1), nowMs: () => now, sleep: async (ms: number) => { now += ms; } });
    expect(await accounts.accountNotice({ host, sinceMs: 500 })).toBeNull();
    expect(await accounts.waitForAccountNotice({ host, sinceMs: 500, timeoutMs: 30_000 })).toBeNull();
    await store.db.collection('assisted_applications').doc(ORDER).collection('inbox').doc('created')
      .set({ receivedAt: 950, category: 'verification', portalAccountNoticeHost: host, portalAccountNotice: 'created' });
    expect(await accounts.accountNotice({ host, sinceMs: 500 })).toMatchObject({ messageId: 'created', kind: 'created' });
  });
});
