import { beforeEach, describe, expect, it, vi } from 'vitest';

const recoveryState = vi.hoisted(() => ({
  snapshot: null as any,
  afterForgot: null as any,
  events: [] as string[],
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
    { id: 'reject', frame: 0, text: 'Refuser', chrome: true },
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
  const forgotClick = vi.fn(async () => {
    recoveryState.events.push('click:forgot');
    if (recoveryState.afterForgot) recoveryState.snapshot = recoveryState.afterForgot;
  });
  const sendClick = vi.fn(async () => { recoveryState.events.push('click:reset-send'); });
  const frame: any = {
    url: () => url,
    evaluate: vi.fn(async () => recoveryState.snapshot),
    locator: vi.fn((selector: string) => {
      const id = /data-aa-id="([^"]+)"/.exec(selector)?.[1] || '';
      const locator: any = {
        first: () => locator,
        isVisible: vi.fn(async () => id === 'forgot'),
        evaluate: vi.fn(async () => ({
          tagName: 'BUTTON', role: '', href: null,
          text: 'Vous avez oublié votre mot de passe ?', ariaLabel: '', title: '', labelledBy: '',
          dataAutomationId: '', formId: '', formIdentityFields: [], formHasPassword: false,
        })),
        click: id === 'forgot' ? forgotClick : id === 'reset-send' ? sendClick : vi.fn(async () => {}),
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
    snapshot: login() as any,
    ctx: { candidate: { identity: { email: alias } }, accounts } as any,
  });
  return { run, accounts, beginRecovery, forgotClick, sendClick, page };
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
});
