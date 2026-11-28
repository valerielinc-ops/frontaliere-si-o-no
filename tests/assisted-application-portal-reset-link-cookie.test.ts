import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ view: null as any }));
vi.mock('../scripts/assisted-application/lib/portal/fields.mjs', async importOriginal => ({
  ...await importOriginal<any>(), extractFields: async () => state.view(),
}));
vi.mock('../scripts/assisted-application/lib/portal/fill.mjs', async importOriginal => ({
  ...await importOriginal<any>(),
  applyActions: async (_page: unknown, _fields: unknown[], actions: any[]) => actions.map((a: any) => ({ fieldId: a.fieldId, ok: true })),
}));
import { recoverAccountPassword } from '../scripts/assisted-application/lib/portal/portal.mjs';

const HOST = 'careers.example-portal.test';
const ALIAS = 'maria.rossi.abcd@candidature.frontaliereticino.ch';
const LINK = `https://${HOST}/Careers/ResetPassword?token=abc`;

const empty = { buttons: [], links: [], dialogs: [], errors: [] as string[], captcha: false, passwordVisible: false };
const bannerOnly = () => ({ ...empty, url: LINK, title: 'Reset password', heading: 'Reset password', text: 'We use cookies',
  fields: [], buttons: [{ id: 'cookies', frame: 0, text: 'Customise Cookies' }] });
const resetForm = () => ({ ...empty, url: LINK, title: 'Reset password', heading: 'Reset password', text: 'Reset password', passwordVisible: true,
  fields: [
    { id: 'new-pw', kind: 'text', inputType: 'password', name: 'NewPassword', label: 'New password', frame: 0, formId: 'f', value: '' },
    { id: 'rep-pw', kind: 'text', inputType: 'password', name: 'Confirm', label: 'Confirm password', frame: 0, formId: 'f', value: '' },
  ],
  buttons: [{ id: 'submit', frame: 0, formId: 'f', text: 'Reset password', disabled: false }] });
const refused = () => ({ ...empty, url: LINK, title: 'Reset password', heading: 'Reset password', text: 'This link has expired.', fields: [] });
const done = () => ({ ...empty, url: `https://${HOST}/Careers/Login`, title: 'Sign in', heading: 'Sign in', text: 'Sign in', passwordVisible: true,
  fields: [
    { id: 'user', kind: 'text', inputType: 'text', label: 'Username', frame: 0, formId: 'login', value: '' },
    { id: 'pass', kind: 'text', inputType: 'password', label: 'Password', frame: 0, formId: 'login', value: '' },
  ],
  buttons: [{ id: 'login-btn', frame: 0, formId: 'login', text: 'Sign in', disabled: false }] });

function setup(view: (ctx: { ticks: number; submitted: boolean }) => any) {
  const ctx = { ticks: 0, submitted: false };
  state.view = () => view(ctx);
  let url = `https://${HOST}/Careers/Login`;
  const accounts: any = {
    pendingPasswordReset: vi.fn(async () => null),
    beginRecovery: vi.fn(async () => ({ status: 'cooldown', retryAt: 1 })),
    waitForPasswordReset: vi.fn(async () => ({ url: LINK, messageId: 'm1', receivedAt: 2000 })),
    completeRecovery: vi.fn(async () => true),
    abortRecovery: vi.fn(async () => true),
    load: vi.fn(async () => ({ email: ALIAS, password: 'staged' })),
  };
  const goto = vi.fn(async (target: string) => { url = target; });
  const page: any = { url: () => url, goto, waitForLoadState: async () => {}, waitForTimeout: async () => { ctx.ticks += 1; },
    evaluate: async () => '', frames: () => [page], mainFrame: () => page,
    locator: () => {
      const loc: any = { first: () => loc, isVisible: async () => false, click: async () => { ctx.submitted = true; },
        evaluate: async () => ({ tagName: 'BUTTON', role: '', href: null, text: 'Reset password', ariaLabel: '', title: '', labelledBy: '', dataAutomationId: '', formId: 'f', formIdentityFields: [], formHasPassword: false }) };
      return loc;
    } };
  const finishRecovery = vi.fn(async (v: any) => ({ snapshot: v }));
  const run = () => recoverAccountPassword({ page, snapshot: { ...empty, fields: [], text: 'Sign in' }, ctx: { candidate: { identity: { email: ALIAS } }, accounts, dryRun: false },
    host: HOST, account: { email: ALIAS, password: 'staged', status: 'recovering', recoveryRequestedAt: Date.now() - 1000, recoveryRequestId: 'req' },
    diagnostics: null, typedSecrets: null, registrationRestarts: new Map(), recoveryAttempts: new Set<string>(), finishRecovery });
  return { run, accounts, goto };
}

describe('the reset link page behind a cookie banner', () => {
  it('only the banner at first, the fields after the consent wait: the reset completes', async () => {
    const { run, accounts } = setup(c => (c.submitted ? done() : c.ticks >= 1 ? resetForm() : bannerOnly()));
    const result: any = await run();
    expect(result.recoveryStep).toBeUndefined();
    expect(result.handoff).toBeUndefined();
    expect(result.accountRecovered).toBe(true);
    expect(accounts.completeRecovery).toHaveBeenCalledTimes(1);
    expect(accounts.beginRecovery).not.toHaveBeenCalled();
  });

  it('a link the portal says is expired ends as account_recovery_rejected, not a timeout', async () => {
    const { run, accounts } = setup(() => refused());
    const result: any = await run();
    expect(result.handoff).toBe('account_recovery_rejected');
    expect(accounts.completeRecovery).not.toHaveBeenCalled();
  });

  it('no field after the bounded wait is account_recovery_timeout, with one visit and no resend', async () => {
    const { run, accounts, goto } = setup(() => bannerOnly());
    const result: any = await run();
    expect(result.recoveryStep).toBe('reset_page_unrecognized');
    expect(result.handoff).toBe('account_recovery_timeout');
    expect(goto).toHaveBeenCalledTimes(1);
    expect(accounts.completeRecovery).not.toHaveBeenCalled();
    expect(accounts.beginRecovery).not.toHaveBeenCalled();
  });
});
