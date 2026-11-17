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

import { handleAuth, passwordResetRequestSurface } from '../scripts/assisted-application/lib/portal/portal.mjs';

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
});
