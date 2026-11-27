import { beforeEach, describe, expect, it, vi } from 'vitest';

const recoveryState = vi.hoisted(() => ({
  snapshot: null as any,
  afterForgot: null as any,
  events: [] as string[],
  domCookieProof: false,
}));

vi.mock('../scripts/assisted-application/lib/portal/fields.mjs', async importOriginal => ({
  ...await importOriginal<any>(),
  extractFields: vi.fn(async () => recoveryState.snapshot),
}));

vi.mock('../scripts/assisted-application/lib/portal/fill.mjs', async importOriginal => ({
  ...await importOriginal<any>(),
  applyActions: vi.fn(async (_page: unknown, _fields: unknown[], actions: any[]) => {
    for (const action of actions) {
      const field = recoveryState.snapshot.fields.find((candidate: any) => candidate.id === action.fieldId);
      if (field && action.action === 'fill') field.value = action.value;
      recoveryState.events.push(`fill:${action.fieldId}`);
    }
    return actions.map((action: any) => ({ fieldId: action.fieldId, ok: true }));
  }),
}));

import { dismissCookieBanner, handleAuth, passwordResetRequestSurface } from '../scripts/assisted-application/lib/portal/portal.mjs';

const host = 'swarovski.wd3.myworkdayjobs.com';
const url = `https://${host}/fr-FR/swarovski/job/Mendrisio-Outlet/Seasonal-Sales-Consultant_R-12345-1/apply/applyManually`;
const alias = 'c-abcdefghij@candidature.frontaliereticino.ch';
const loginError = "L'adresse e-mail ou le mot de passe saisi est erroné ou votre compte est verrouillé.";

const login = () => ({
  url,
  title: 'Connexion',
  heading: 'Connexion',
  text: `Connexion Adresse e-mail Mot de passe ${loginError}`,
  fields: [
    { id: 'email', kind: 'text', inputType: 'text', label: 'Adresse e-mail*', required: true, frame: 0 },
    { id: 'password', kind: 'text', inputType: 'password', label: 'Mot de passe*', required: true, frame: 0 },
  ],
  buttons: [
    { id: 'privacy', frame: 0, text: 'Lire tout le message sur la confidentialité', chrome: true },
    { id: 'reject', frame: 0, text: 'Refuser les cookies', chrome: true },
    { id: 'accept', frame: 0, text: 'Accepter les cookies', chrome: true },
    { id: 'sign-in', frame: 0, text: 'Connexion', chrome: true },
    { id: 'visit', frame: 0, text: 'Visite Swarovski.com', chrome: true },
    { id: 'jobs', frame: 0, text: 'Rechercher des emplois', chrome: true },
    { id: 'introduce', frame: 0, text: 'Présentez-vous', chrome: true },
    { id: 'back', frame: 0, text: "Retour à l'offre d'emploi", chrome: true },
    { id: 'create', frame: 0, text: 'Créer un compte' },
    { id: 'forgot', frame: 0, text: '', labelledBy: 'Vous avez oublié votre mot de passe ?' },
  ],
  links: [], dialogs: [], errors: [loginError], captcha: false, passwordVisible: true,
});

const resetRequest = () => ({
  url,
  title: 'Mot de passe oublié',
  heading: 'Réinitialiser le mot de passe',
  text: 'Saisissez votre adresse e-mail pour réinitialiser le mot de passe.',
  fields: [
    { id: 'reset-email', kind: 'text', inputType: 'text', label: 'Adresse e-mail*', required: true, frame: 0, formId: 'reset-form', value: '' },
  ],
  buttons: [
    { id: 'reset-send', frame: 0, formId: 'reset-form', text: 'Réinitialiser le mot de passe', disabled: false },
  ],
  links: [], dialogs: [], errors: [], captcha: false, passwordVisible: false,
});

const accessibleNameResetRequest = () => {
  const snapshot = resetRequest();
  return {
    ...snapshot,
    title: 'Reset\npassword',
    heading: '',
    text: '',
    buttons: [{
      ...snapshot.buttons[0],
      text: '',
      label: '',
      ariaLabel: 'Send reset link',
    }],
  };
};

const unrelatedEmailSurface = () => ({
  url,
  title: 'Alertes emploi',
  heading: 'Recevez nos alertes',
  text: 'Recevez les nouvelles offres par e-mail.',
  fields: [{ id: 'alert-email', kind: 'text', inputType: 'email', label: 'Adresse e-mail', frame: 0, formId: 'alerts', value: '' }],
  buttons: [{ id: 'continue', frame: 0, formId: 'alerts', text: 'Continuer', disabled: false }],
  links: [], dialogs: [], errors: [], captcha: false, passwordVisible: false,
});

function harness(afterForgot: any) {
  recoveryState.snapshot = login();
  recoveryState.afterForgot = afterForgot;
  recoveryState.events = [];
  recoveryState.domCookieProof = false;
  const forgotClick = vi.fn(async () => {
    recoveryState.events.push('click:forgot');
    if (recoveryState.afterForgot) recoveryState.snapshot = recoveryState.afterForgot;
  });
  const sendClick = vi.fn(async () => { recoveryState.events.push('click:reset-send'); });
  const frame: any = {
    url: () => url,
    evaluate: vi.fn(async (fn: Function) => {
      const source = String(fn);
      if (recoveryState.domCookieProof && source.includes('document.body?.innerText')) {
        return 'Cette page utilise des cookies sur ce site web.';
      }
      if (recoveryState.domCookieProof && source.includes('const controlFor')) return true;
      return recoveryState.snapshot;
    }),
    locator: vi.fn((selector: string) => {
      const id = /data-aa-id="([^"]+)"/.exec(selector)?.[1] || '';
      const locator: any = {
        first: () => locator,
        isVisible: vi.fn(async () => id === 'forgot'
          || (recoveryState.domCookieProof && ['reject', 'accept'].includes(id))),
        evaluate: vi.fn(async () => ({
          tagName: 'BUTTON', role: '', href: null,
          text: 'Vous avez oublié votre mot de passe ?', ariaLabel: '', title: '', labelledBy: '',
          dataAutomationId: '', formId: '', formIdentityFields: [], formHasPassword: false,
        })),
        click: id === 'forgot' ? forgotClick : id === 'reset-send' ? sendClick
          : ['reject', 'accept'].includes(id) ? vi.fn(async () => {
            recoveryState.events.push(`click:cookie:${id}`);
            recoveryState.snapshot = {
              ...recoveryState.snapshot,
              buttons: recoveryState.snapshot.buttons.filter((button: any) => !['reject', 'accept'].includes(button.id)),
            };
          }) : vi.fn(async () => {}),
      };
      return locator;
    }),
  };
  const page: any = {
    url: () => url,
    frames: () => [frame],
    mainFrame: () => frame,
    waitForLoadState: vi.fn(async () => {}),
    waitForTimeout: vi.fn(async () => {}),
  };
  const beginRecovery = vi.fn(async () => {
    recoveryState.events.push('beginRecovery');
    return { status: 'started', requestedAt: 1_700_000_000_000 };
  });
  const accounts = {
    load: vi.fn(async () => ({ email: alias, status: 'exists_unknown_password', verifiedAt: null })),
    beginRecovery,
    abortRecovery: vi.fn(async () => {}),
    waitForPasswordReset: vi.fn(async () => null),
  };
  const run = () => handleAuth({
    page,
    snapshot: recoveryState.snapshot as any,
    ctx: { candidate: { identity: { email: alias } }, accounts } as any,
  });
  return { run, accounts, beginRecovery, forgotClick, sendClick, page };
}

function harnessWithUnmarkedFrenchCookieControls(afterForgot: any) {
  const fixture = harness(afterForgot);
  const snapshot = recoveryState.snapshot;
  recoveryState.snapshot = {
    ...snapshot,
    buttons: snapshot.buttons.map((button: any) => (
      ['reject', 'accept'].includes(button.id)
        ? { ...button, cookieSurface: undefined }
        : button
    )),
  };
  recoveryState.domCookieProof = true;
  return fixture;
}

function harnessWithUnmarkedFrenchAcceptOnly(afterForgot: any) {
  const fixture = harnessWithUnmarkedFrenchCookieControls(afterForgot);
  recoveryState.snapshot = {
    ...recoveryState.snapshot,
    buttons: recoveryState.snapshot.buttons.map((button: any) => (
      button.id === 'reject' ? { ...button, text: 'Fermer' } : button
    )),
  };
  return fixture;
}

beforeEach(() => vi.clearAllMocks());

describe('bounded Workday password-reset request surface', () => {
  it('uses the normalized accessible name for a multiline reset surface', () => {
    const surface = passwordResetRequestSurface(accessibleNameResetRequest());

    expect(surface).toMatchObject({
      email: { id: 'reset-email', formId: 'reset-form' },
      request: { id: 'reset-send', ariaLabel: 'Send reset link', formId: 'reset-form' },
    });
  });

  it('recognizes the Swarovski reset surface before recovery begins', async () => {
    const fixture = harness(resetRequest());

    const result = await fixture.run();

    expect(result).toMatchObject({ handoff: 'account_recovery_timeout', accountFailure: { code: 'account_recovery_timeout' } });
    expect(result).not.toMatchObject({ handoff: 'account_recovery_rejected' });
    expect(recoveryState.events).toEqual([
      'click:forgot',
      'fill:reset-email',
      'beginRecovery',
      'click:reset-send',
    ]);
    expect(fixture.beginRecovery).toHaveBeenCalledOnce();
    expect(fixture.sendClick).toHaveBeenCalledOnce();
  });

  it('keeps unmarked French chrome cookie controls eligible after DOM context proof', async () => {
    const fixture = harnessWithUnmarkedFrenchCookieControls(resetRequest());

    const result = await fixture.run();

    expect(result).toMatchObject({ handoff: 'account_recovery_timeout', accountFailure: { code: 'account_recovery_timeout' } });
    expect(result).not.toMatchObject({ handoff: 'account_recovery_rejected' });
    expect(recoveryState.events).toEqual([
      'click:cookie:reject',
      'click:forgot',
      'fill:reset-email',
      'beginRecovery',
      'click:reset-send',
    ]);
    expect(fixture.beginRecovery).toHaveBeenCalledOnce();
    expect(fixture.sendClick).toHaveBeenCalledOnce();
  });

  it('accepts the exact French cookie choice when reject is not offered', async () => {
    const fixture = harnessWithUnmarkedFrenchAcceptOnly(resetRequest());

    const result = await fixture.run();

    expect(result).toMatchObject({ handoff: 'account_recovery_timeout', accountFailure: { code: 'account_recovery_timeout' } });
    expect(result).not.toMatchObject({ handoff: 'account_recovery_rejected' });
    expect(recoveryState.events).toEqual([
      'click:cookie:accept',
      'click:forgot',
      'fill:reset-email',
      'beginRecovery',
      'click:reset-send',
    ]);
    expect(fixture.beginRecovery).toHaveBeenCalledOnce();
    expect(fixture.sendClick).toHaveBeenCalledOnce();
  });

  it.each([
    ['the login form never changes', null],
    ['the click lands on an unrelated e-mail surface', unrelatedEmailSurface()],
  ])('fails closed when %s', async (_label, afterForgot) => {
    const fixture = harness(afterForgot);

    const result = await fixture.run();

    expect(result).toMatchObject({ handoff: 'account_recovery_timeout', accountFailure: { code: 'account_recovery_timeout' } });
    expect(fixture.beginRecovery).not.toHaveBeenCalled();
    expect(fixture.sendClick).not.toHaveBeenCalled();
    expect(fixture.accounts.abortRecovery).not.toHaveBeenCalled();
    expect(fixture.page.waitForTimeout).toHaveBeenCalledTimes(16);
  });

  it('accepts a dialog-scoped French Workday password reset surface', () => {
    const surface = passwordResetRequestSurface({
      url: 'https://swarovski.wd3.myworkdayjobs.com/fr-FR/swarovski/job/Mendrisio/Role_R-1/apply/applyManually',
      title: 'Workday',
      dialogs: [{ text: 'Mot de passe oublié ?' }],
      fields: [{ id: 'reset-email', kind: 'text', inputType: 'email', label: 'Adresse e-mail*', formId: 'dlg-form', dialog: true }],
      buttons: [{ id: 'reset-send', text: 'Envoyer', formId: 'dlg-form', dialog: true, disabled: false }],
      text: 'Mot de passe oublié ? Saisissez votre adresse e-mail.',
    } as any);
    expect(surface).toMatchObject({
      email: { id: 'reset-email', dialog: true },
      request: { id: 'reset-send', text: 'Envoyer', dialog: true },
    });
  });

  it('accepts French cookie Refuser + Accepter les cookies without English/prose consent keywords', async () => {
    const clicked: string[] = [];
    const { resolveCookieConsent } = await import('../scripts/assisted-application/lib/portal/portal.mjs');
    let snapshot: any = {
      url: 'https://swarovski.wd3.myworkdayjobs.com/fr-FR/swarovski/job/Mendrisio/Role_R-1/apply/applyManually',
      text: 'Vos choix de cookies : Refuser / Accepter les cookies',
      fields: [],
      buttons: [
        { id: 'f2', frame: 0, text: 'Refuser', dialog: false },
        { id: 'f3', frame: 0, text: 'Accepter les cookies', dialog: false },
      ],
    };
    const makeLocator = (id: string) => ({
      first: () => ({
        isVisible: async () => snapshot.buttons.some((b: any) => b.id === id),
        click: async () => {
          clicked.push(id);
          snapshot = { ...snapshot, buttons: [] };
        },
        evaluate: async () => ({ tagName: 'BUTTON', role: '', href: null, text: id === 'f2' ? 'Refuser' : 'Accepter les cookies', ariaLabel: '', title: '', labelledBy: '', dataAutomationId: '', formId: '', formIdentityFields: [], formHasPassword: false }),
      }),
    });
    const frame: any = {
      url: () => snapshot.url,
      evaluate: vi.fn(async (fn: Function) => {
        const src = String(fn);
        if (src.includes('document.body?.innerText')) return snapshot.text;
        if (src.includes('const controlFor')) return true;
        return snapshot;
      }),
      locator: (sel: string) => {
        const m = /data-aa-id="([^"]+)"/.exec(sel);
        return makeLocator(m?.[1] || '');
      },
    };
    const page: any = {
      url: () => snapshot.url,
      frames: () => [frame],
      mainFrame: () => frame,
      waitForTimeout: async () => {},
    };
    await resolveCookieConsent(page, snapshot);
    expect(clicked).toEqual(['f2']);
  });

  it('uses cookie-word evidence in the snapshot fallback for a bounded cookie pair', async () => {
    const clicked: string[] = [];
    let snapshot: any = {
      url: 'https://swarovski.wd3.myworkdayjobs.com/fr-FR/swarovski/job/Mendrisio/Role_R-1/apply/applyManually',
      text: 'cookies',
      fields: [],
      buttons: [
        { id: 'f2', frame: 0, text: 'Refuser', cookieContainerId: 'cmp', cookieContainerText: 'cookies' },
        { id: 'f3', frame: 0, text: 'Accepter les cookies', cookieContainerId: 'cmp', cookieContainerText: 'cookies' },
      ],
      links: [], dialogs: [],
    };
    recoveryState.snapshot = snapshot;
    const frame: any = {
      locator: (selector: string) => ({
        first: () => ({
          click: async () => {
            clicked.push(/data-aa-id="([^"]+)"/.exec(selector)?.[1] || '');
            snapshot = { ...snapshot, buttons: [] };
            recoveryState.snapshot = snapshot;
          },
        }),
      }),
    };
    const page: any = {
      url: () => snapshot.url,
      frames: () => [frame],
      mainFrame: () => frame,
      waitForTimeout: async () => {},
    };

    const result = await dismissCookieBanner(page, snapshot);

    expect(result.status).toBe('dismissed');
    expect(clicked).toEqual(['f2']);
  });

  it('recognizes Umantis Benutzername password reset surface and signs in with an emailed temporary password', async () => {
    const umantisHost = 'recruitingapp-2800.umantis.com';
    const umantisLoginUrl = `https://${umantisHost}/Vacancies/6604/Application/Login/1`;
    const umantisForgotUrl = `https://${umantisHost}/Password/PWForgotten`;
    const umantisAppUrl = `https://${umantisHost}/Vacancies/6604/Application/New/1`;
    const umantisSurface = passwordResetRequestSurface({
      url: umantisForgotUrl,
      title: 'Neues Passwort | eRecruiting Kanton St.Gallen',
      heading: 'Neues Passwort',
      text: 'Bitte geben Sie Ihren Loginnamen ein. Durch einen Klick auf Senden wird Ihr Passwort zurückgesetzt und Sie erhalten in Kürze eine E-Mail mit dem neuen Passwort.',
      fields: [
        { id: 'f1', kind: 'text', inputType: 'text', label: 'Benutzername', name: 'form_data1', formId: 'pw-form', value: '' },
      ],
      buttons: [
        { id: 'b1', text: 'Neues Passwort senden', formId: 'pw-form', disabled: false },
      ],
      links: [], dialogs: [], errors: [], captcha: false, passwordVisible: false,
    } as any);
    expect(umantisSurface).toMatchObject({
      email: { id: 'f1', label: 'Benutzername' },
      request: { id: 'b1', text: 'Neues Passwort senden' },
    });

    const events: string[] = [];
    let currentUrl = umantisLoginUrl;
    const loginSnap = (err = '') => ({
      url: currentUrl,
      title: 'Login | eRecruiting Kanton St.Gallen',
      heading: 'Login',
      text: `Ich bin bereits Benutzer ${err}`.trim(),
      fields: [
        { id: 'user', kind: 'text', inputType: 'text', label: 'Benutzername', frame: 0, formId: 'login-form', value: '' },
        { id: 'pass', kind: 'text', inputType: 'password', label: 'Passwort', frame: 0, formId: 'login-form', value: '' },
      ],
      buttons: [
        { id: 'login-btn', frame: 0, formId: 'login-form', text: 'Login', disabled: false },
      ],
      links: [
        { id: 'forgot-link', frame: 0, text: 'Ich habe mein Passwort vergessen', href: umantisForgotUrl },
      ],
      dialogs: [], errors: err ? [err] : [], captcha: false, passwordVisible: true,
    });
    const forgotSnap = () => ({
      url: umantisForgotUrl,
      title: 'Neues Passwort | eRecruiting Kanton St.Gallen',
      heading: 'Neues Passwort',
      text: 'Bitte geben Sie Ihren Loginnamen ein. Ihr Passwort wird zurückgesetzt.',
      fields: [
        { id: 'reset-user', kind: 'text', inputType: 'text', label: 'Benutzername', frame: 0, formId: 'pw-form', value: '' },
      ],
      buttons: [
        { id: 'reset-submit', frame: 0, formId: 'pw-form', text: 'Neues Passwort senden', disabled: false },
      ],
      links: [], dialogs: [], errors: [], captcha: false, passwordVisible: false,
    });
    const signedInSnap = () => ({
      url: umantisAppUrl,
      title: 'Bewerbung',
      text: 'Willkommen',
      fields: [{ id: 'q1', kind: 'text', inputType: 'text', label: 'Erfahrung', frame: 0 }],
      buttons: [{ id: 'next', frame: 0, text: 'Weiter', disabled: false }],
      links: [], dialogs: [], errors: [], captcha: false, passwordVisible: false,
    });

    recoveryState.snapshot = loginSnap();
    let storedPassword = 'Stale-Password-1!';
    let status = 'pending';
    const { extractFields } = await import('../scripts/assisted-application/lib/portal/fields.mjs');
    const { applyActions } = await import('../scripts/assisted-application/lib/portal/fill.mjs');
    vi.mocked(extractFields).mockImplementation(async () => recoveryState.snapshot);
    vi.mocked(applyActions).mockImplementation(async (_page: any, _fields: any[], actions: any[]) => {
      for (const action of actions) {
        const target = recoveryState.snapshot.fields.find((f: any) => f.id === action.fieldId);
        if (target && action.action === 'fill') target.value = action.value;
        events.push(`fill:${action.fieldId}:${target?.inputType === 'password' ? (action.value === 'Temp-Synthetic-9!' ? 'temp' : 'stale') : 'user'}`);
      }
      return actions.map((action: any) => ({ fieldId: action.fieldId, ok: true }));
    });
    const frame: any = {
      url: () => currentUrl,
      goto: vi.fn(async (href: string) => {
        events.push(`goto:${new URL(href).pathname}`);
        currentUrl = href;
        recoveryState.snapshot = href.includes('PWForgotten') ? forgotSnap() : loginSnap();
      }),
      evaluate: vi.fn(async () => recoveryState.snapshot),
      locator: vi.fn((selector: string) => {
        const id = /data-aa-id="([^"]+)"/.exec(selector)?.[1] || '';
        const loc: any = {
          first: () => loc,
          isVisible: vi.fn(async () => true),
          evaluate: vi.fn(async () => ({
            tagName: id === 'forgot-link' ? 'A' : 'BUTTON',
            role: '',
            href: id === 'forgot-link' ? umantisForgotUrl : null,
            text: id === 'forgot-link' ? 'Ich habe mein Passwort vergessen' : id === 'reset-submit' ? 'Neues Passwort senden' : 'Login',
            ariaLabel: '', title: '', labelledBy: '', dataAutomationId: '',
            formId: id === 'reset-submit' ? 'pw-form' : id === 'login-btn' ? 'login-form' : '',
            formIdentityFields: [], formHasPassword: false,
          })),
          click: vi.fn(async () => {
            events.push(`click:${id}`);
            if (id === 'login-btn') {
              const typedPass = recoveryState.snapshot.fields.find((f: any) => f.id === 'pass')?.value;
              if (typedPass === 'Temp-Synthetic-9!') {
                currentUrl = umantisAppUrl;
                recoveryState.snapshot = signedInSnap();
              } else {
                recoveryState.snapshot = loginSnap('Benutzername oder Passwort nicht korrekt');
              }
            } else if (id === 'reset-submit') {
              events.push('submitted:pw-forgotten');
            }
          }),
        };
        return loc;
      }),
    };
    const page: any = {
      url: () => currentUrl,
      goto: frame.goto,
      frames: () => [frame],
      mainFrame: () => frame,
      waitForLoadState: vi.fn(async () => {}),
      waitForTimeout: vi.fn(async () => {}),
    };
    const accounts: any = {
      load: vi.fn(async () => ({ email: alias, password: storedPassword, status, verifiedAt: null })),
      beginRecovery: vi.fn(async (_host: string, next: any) => {
        status = 'recovering';
        storedPassword = next.password;
        return { status: 'started', requestedAt: 1_700_000_000_000 };
      }),
      waitForPasswordReset: vi.fn(async () => ({ temporaryPassword: 'Temp-Synthetic-9!', messageId: 'm1', receivedAt: 1_700_000_001_000 })),
      completeRecovery: vi.fn(async (_host: string, opts?: any) => {
        if (opts?.password) storedPassword = opts.password;
        status = 'pending';
        return true;
      }),
      abortRecovery: vi.fn(async () => true),
      mark: vi.fn(async () => {}),
    };
    const result = await handleAuth({
      page,
      snapshot: recoveryState.snapshot as any,
      ctx: { candidate: { identity: { email: alias } }, accounts } as any,
    });
    expect(result).toMatchObject({ snapshot: { url: umantisAppUrl }, accountRecovered: true });
    expect(accounts.completeRecovery).toHaveBeenCalledWith(umantisHost, { password: 'Temp-Synthetic-9!' });
    expect(events).toContain('click:reset-submit');
    expect(events).toContain('fill:pass:temp');
  });

  it('sets a new password on an Umantis PasswordResetToken page and falls back to resolvedSignInUrl when confirmation leaves login fields absent', async () => {
    const umantisHost = 'recruitingapp-2800.umantis.com';
    const umantisLoginUrl = `https://${umantisHost}/Vacancies/6604/Application/Login/1`;
    const umantisForgotUrl = `https://${umantisHost}/Password/PWForgotten`;
    const umantisTokenUrl = `https://${umantisHost}/?PasswordResetToken=Tok_Abc123&customer=2800&lang=ger`;
    const umantisAppUrl = `https://${umantisHost}/Vacancies/6604/Application/New/1`;
    let currentUrl = umantisLoginUrl;
    let stagedPassword = '';
    let status = 'pending';
    const loginSnap = (err = '') => ({
      url: currentUrl,
      title: 'Login',
      heading: 'Login',
      text: `Login ${err}`.trim(),
      fields: [
        { id: 'user', kind: 'text', inputType: 'text', label: 'Benutzername', frame: 0, formId: 'login-form', value: '' },
        { id: 'pass', kind: 'text', inputType: 'password', label: 'Passwort', frame: 0, formId: 'login-form', value: '' },
      ],
      buttons: [{ id: 'login-btn', frame: 0, formId: 'login-form', text: 'Login', disabled: false }],
      links: [{ id: 'forgot-link', frame: 0, text: 'Ich habe mein Passwort vergessen', href: umantisForgotUrl }],
      dialogs: [], errors: err ? [err] : [], captcha: false, passwordVisible: true,
    });
    const forgotSnap = () => ({
      url: umantisForgotUrl,
      title: 'Neues Passwort',
      heading: 'Neues Passwort',
      text: 'Neues Passwort',
      fields: [{ id: 'reset-user', kind: 'text', inputType: 'text', label: 'Benutzername', frame: 0, formId: 'pw-form', value: '' }],
      buttons: [{ id: 'reset-submit', frame: 0, formId: 'pw-form', text: 'Neues Passwort senden', disabled: false }],
      links: [], dialogs: [], errors: [], captcha: false, passwordVisible: false,
    });
    const setPwSnap = () => ({
      url: umantisTokenUrl,
      title: 'Passwort setzen',
      heading: 'Neues Passwort setzen',
      text: 'Bitte geben Sie Ihr neues Passwort ein.',
      fields: [
        { id: 'new-pw', kind: 'text', inputType: 'password', label: 'Passwort', frame: 0, formId: 'set-form', value: '' },
        { id: 'rep-pw', kind: 'text', inputType: 'password', label: 'Passwort wiederholen', frame: 0, formId: 'set-form', value: '' },
      ],
      buttons: [{ id: 'set-submit', frame: 0, formId: 'set-form', text: 'Passwort setzen', disabled: false }],
      links: [], dialogs: [], errors: [], captcha: false, passwordVisible: true,
    });
    const setDoneSnap = () => ({
      url: umantisTokenUrl,
      title: 'Passwort gesetzt',
      heading: 'Passwort gesetzt',
      text: 'Ihr Passwort wurde gespeichert.',
      fields: [], buttons: [], links: [], dialogs: [], errors: [], captcha: false, passwordVisible: false,
    });
    const signedInSnap = () => ({
      url: umantisAppUrl,
      title: 'Bewerbung',
      text: 'Willkommen',
      fields: [{ id: 'q1', kind: 'text', inputType: 'text', label: 'Erfahrung', frame: 0 }],
      buttons: [{ id: 'next', frame: 0, text: 'Weiter', disabled: false }],
      links: [], dialogs: [], errors: [], captcha: false, passwordVisible: false,
    });

    recoveryState.snapshot = loginSnap();
    const { extractFields } = await import('../scripts/assisted-application/lib/portal/fields.mjs');
    const { applyActions } = await import('../scripts/assisted-application/lib/portal/fill.mjs');
    vi.mocked(extractFields).mockImplementation(async () => recoveryState.snapshot);
    vi.mocked(applyActions).mockImplementation(async (_page: any, _fields: any[], actions: any[]) => {
      for (const action of actions) {
        const target = recoveryState.snapshot.fields.find((f: any) => f.id === action.fieldId);
        if (target && action.action === 'fill') target.value = action.value;
      }
      return actions.map((action: any) => ({ fieldId: action.fieldId, ok: true }));
    });
    const frame: any = {
      url: () => currentUrl,
      goto: vi.fn(async (href: string) => {
        currentUrl = href;
        recoveryState.snapshot = href.includes('PWForgotten')
          ? forgotSnap()
          : href.includes('PasswordResetToken')
            ? setPwSnap()
            : loginSnap();
      }),
      evaluate: vi.fn(async () => recoveryState.snapshot),
      locator: vi.fn((selector: string) => {
        const id = /data-aa-id="([^"]+)"/.exec(selector)?.[1] || '';
        const loc: any = {
          first: () => loc,
          isVisible: vi.fn(async () => true),
          evaluate: vi.fn(async () => ({
            tagName: id === 'forgot-link' ? 'A' : 'BUTTON',
            role: '',
            href: id === 'forgot-link' ? umantisForgotUrl : null,
            text: id === 'forgot-link' ? 'Ich habe mein Passwort vergessen' : id === 'reset-submit' ? 'Neues Passwort senden' : id === 'set-submit' ? 'Passwort setzen' : 'Login',
            ariaLabel: '', title: '', labelledBy: '', dataAutomationId: '',
            formId: id === 'reset-submit' ? 'pw-form' : id === 'set-submit' ? 'set-form' : id === 'login-btn' ? 'login-form' : '',
            formIdentityFields: [], formHasPassword: false,
          })),
          click: vi.fn(async () => {
            if (id === 'login-btn') {
              const typedPass = recoveryState.snapshot.fields.find((f: any) => f.id === 'pass')?.value;
              if (stagedPassword && typedPass === stagedPassword) {
                currentUrl = umantisAppUrl;
                recoveryState.snapshot = signedInSnap();
              } else {
                recoveryState.snapshot = loginSnap('Benutzername oder Passwort nicht korrekt');
              }
            } else if (id === 'set-submit') {
              recoveryState.snapshot = setDoneSnap();
            }
          }),
        };
        return loc;
      }),
    };
    const page: any = {
      url: () => currentUrl,
      goto: frame.goto,
      frames: () => [frame],
      mainFrame: () => frame,
      waitForLoadState: vi.fn(async () => {}),
      waitForTimeout: vi.fn(async () => {}),
    };
    const accounts: any = {
      load: vi.fn(async () => ({ email: alias, password: stagedPassword || 'Stale-1!', status, verifiedAt: null })),
      beginRecovery: vi.fn(async (_host: string, next: any) => {
        status = 'recovering';
        stagedPassword = next.password;
        return { status: 'started', requestedAt: 1_700_000_000_000 };
      }),
      waitForPasswordReset: vi.fn(async () => ({ url: umantisTokenUrl, messageId: 'm-link', receivedAt: 1_700_000_001_000 })),
      completeRecovery: vi.fn(async () => {
        status = 'pending';
        return true;
      }),
      abortRecovery: vi.fn(async () => true),
      mark: vi.fn(async () => {}),
    };
    const result = await handleAuth({
      page,
      snapshot: recoveryState.snapshot as any,
      ctx: { candidate: { identity: { email: alias } }, accounts } as any,
    });
    expect(result).toMatchObject({ snapshot: { url: umantisAppUrl }, accountRecovered: true });
    expect(accounts.completeRecovery).toHaveBeenCalledWith(umantisHost);
    expect(accounts.abortRecovery).not.toHaveBeenCalled();
  }, 20_000);
});
