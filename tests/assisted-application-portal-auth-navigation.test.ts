import { describe, expect, it, vi } from 'vitest';
import { handleAuth } from '../scripts/assisted-application/lib/portal/portal.mjs';

const URL = 'https://career74.sapsf.eu/career';

describe('assisted portal account navigation', () => {
  it('opens a SuccessFactors create-account link in the form frame when the page exposes only Login as a button', async () => {
    let pageKind: 'sign_in' | 'create' = 'sign_in';
    const click = vi.fn(async () => { pageKind = 'create'; });
    const linkLocator = {
      first: () => linkLocator,
      filter: () => linkLocator,
      waitFor: vi.fn(async () => {}),
      getAttribute: vi.fn(async () => '/career?login_ns=register'),
      click,
    };
    const loginFields = [
      { id: 'email', kind: 'text', inputType: 'email', label: 'E-Mail-Adresse:*', required: true, formId: 'login-form' },
      { id: 'password', kind: 'text', inputType: 'password', label: 'Passwort:*', required: true, formId: 'login-form' },
    ];
    const registrationFields = [
      ...loginFields,
      { id: 'password-repeat', kind: 'text', inputType: 'password', label: 'Passwort bestätigen:*', required: true },
    ];
    const formFrame = {
      url: () => URL,
      locator: vi.fn((selector: string) => {
        expect(selector).toBe('[data-aa-id="create-account"]');
        return linkLocator;
      }),
      evaluate: vi.fn(async () => ({
        url: URL,
        fields: pageKind === 'sign_in' ? loginFields : registrationFields,
        buttons: pageKind === 'sign_in' ? [{ id: 'login', text: 'Login', formId: 'login-form' }] : [],
        links: pageKind === 'sign_in' ? [{ id: 'create-account', text: 'Create an account' }] : [],
        dialogs: [],
        captcha: false,
        passwordVisible: true,
        errors: [],
        text: '',
      })),
    };
    const hostFrame = {
      url: () => URL,
      evaluate: vi.fn(async () => ({
        url: URL,
        fields: [],
        buttons: [],
        links: [],
        dialogs: [],
        captcha: false,
        passwordVisible: false,
        errors: [],
        text: '',
      })),
    };
    const page = {
      url: () => URL,
      frames: () => [hostFrame, formFrame],
      mainFrame: () => hostFrame,
      waitForLoadState: vi.fn(async () => {}),
      waitForTimeout: vi.fn(async () => {}),
      getByRole: vi.fn(() => ({
        first: () => ({ waitFor: vi.fn(async () => { throw new Error('main-frame link not found'); }) }),
      })),
    };
    const result = await handleAuth({
      page: page as any,
      snapshot: {
        url: URL,
        fields: loginFields.map((field) => ({ ...field, frame: 1 })),
        buttons: [{ id: 'login', text: 'Login', frame: 1, formId: 'login-form' }],
        links: [{ id: 'create-account', text: 'Create an account', frame: 1 }],
        dialogs: [],
        captcha: false,
        passwordVisible: true,
        errors: [],
        text: '',
      } as any,
      ctx: { accounts: { load: vi.fn(async () => null) } } as any,
    });

    expect(click).toHaveBeenCalledOnce();
    expect(page.getByRole).not.toHaveBeenCalled();
    expect(result.snapshot.fields.map((field: any) => field.label)).toEqual([
      'E-Mail-Adresse:*', 'Passwort:*', 'Passwort bestätigen:*',
    ]);
  });

  it('finds a late account link in the login form frame when the snapshot contains only Login', async () => {
    let pageKind: 'sign_in' | 'create' = 'sign_in';
    const click = vi.fn(async () => { pageKind = 'create'; });
    const unrelatedClick = vi.fn(async () => {});
    const linkLocator = {
      first: () => linkLocator,
      filter: () => linkLocator,
      waitFor: vi.fn(async () => {}),
      getAttribute: vi.fn(async () => '/career?login_ns=register'),
      click,
    };
    const loginFields = [
      { id: 'email', kind: 'text', inputType: 'email', label: 'E-Mail-Adresse:*', required: true, formId: 'login-form' },
      { id: 'password', kind: 'text', inputType: 'password', label: 'Passwort:*', required: true, formId: 'login-form' },
    ];
    const registrationFields = [
      ...loginFields,
      { id: 'password-repeat', kind: 'text', inputType: 'password', label: 'Passwort bestätigen:*', required: true },
    ];
    const formFrame = {
      url: () => URL,
      getByRole: vi.fn(() => linkLocator),
      evaluate: vi.fn(async () => ({
        url: URL,
        fields: pageKind === 'sign_in' ? loginFields : registrationFields,
        buttons: pageKind === 'sign_in' ? [{ id: 'login', text: 'Login', formId: 'login-form' }] : [],
        links: [],
        dialogs: [],
        captcha: false,
        passwordVisible: true,
        errors: [],
        text: '',
      })),
    };
    const hostFrame = {
      url: () => URL,
      evaluate: vi.fn(async () => ({
        url: URL,
        fields: [],
        buttons: [],
        links: [],
        dialogs: [],
        captcha: false,
        passwordVisible: false,
        errors: [],
        text: '',
      })),
    };
    const unrelatedLink = {
      first: () => unrelatedLink,
      filter: () => unrelatedLink,
      waitFor: vi.fn(async () => {}),
      getAttribute: vi.fn(async () => '/career?login_ns=register'),
      click: unrelatedClick,
    };
    const unrelatedFrame = {
      url: () => URL,
      getByRole: vi.fn(() => unrelatedLink),
    };
    const page = {
      url: () => URL,
      frames: () => [hostFrame, formFrame, unrelatedFrame],
      mainFrame: () => hostFrame,
      waitForLoadState: vi.fn(async () => {}),
      waitForTimeout: vi.fn(async () => {}),
      getByRole: vi.fn(() => ({
        first: () => ({ waitFor: vi.fn(async () => { throw new Error('main-frame link not found'); }) }),
      })),
    };
    const result = await handleAuth({
      page: page as any,
      snapshot: {
        url: URL,
        fields: [
          { id: 'unrelated-field', kind: 'text', inputType: 'text', label: 'Unrelated field', frame: 2, formId: 'other-form' },
          ...loginFields.map((field) => ({ ...field, frame: 1 })),
        ],
        buttons: [
          { id: 'unrelated-button', text: 'Help', frame: 2, formId: 'other-form' },
          { id: 'login', text: 'Login', frame: 1, formId: 'login-form' },
        ],
        links: [],
        dialogs: [],
        captcha: false,
        passwordVisible: true,
        errors: [],
        text: '',
      } as any,
      ctx: { accounts: { load: vi.fn(async () => null) } } as any,
    });

    expect(click).toHaveBeenCalledOnce();
    expect(unrelatedFrame.getByRole).not.toHaveBeenCalled();
    expect(unrelatedClick).not.toHaveBeenCalled();
    expect(formFrame.getByRole).toHaveBeenCalledWith('link', { name: expect.any(RegExp) });
    expect(page.getByRole).not.toHaveBeenCalled();
    expect(result.snapshot.fields.map((field: any) => field.label)).toEqual([
      'E-Mail-Adresse:*', 'Passwort:*', 'Passwort bestätigen:*',
    ]);
  });

  it('finds the visible late create-account button when a hidden duplicate comes first', async () => {
    let pageKind: 'sign_in' | 'create' = 'sign_in';
    const click = vi.fn(async () => { pageKind = 'create'; });
    const hiddenAccountButton = {
      waitFor: vi.fn(async () => { throw new Error('hidden account button selected'); }),
    };
    const visibleAccountButton = {
      waitFor: vi.fn(async () => {}),
      getAttribute: vi.fn(async () => null),
      click,
    };
    const accountButtons = {
      first: () => hiddenAccountButton,
      filter: vi.fn((options: { visible: boolean }) => {
        expect(options).toEqual({ visible: true });
        return { first: () => visibleAccountButton };
      }),
    };
    const missingLink = {
      first: () => missingLink,
      filter: () => missingLink,
      waitFor: vi.fn(async () => { throw new Error('form link not found'); }),
    };
    const loginFields = [
      { id: 'email', kind: 'text', inputType: 'email', label: 'E-Mail-Adresse:*', required: true, formId: 'login-form' },
      { id: 'password', kind: 'text', inputType: 'password', label: 'Passwort:*', required: true, formId: 'login-form' },
    ];
    const registrationFields = [
      ...loginFields,
      { id: 'password-repeat', kind: 'text', inputType: 'password', label: 'Passwort bestätigen:*', required: true },
    ];
    const formFrame = {
      url: () => URL,
      getByRole: vi.fn((role: string) => role === 'button' ? accountButtons : missingLink),
      evaluate: vi.fn(async () => ({
        url: URL,
        fields: pageKind === 'sign_in' ? loginFields : registrationFields,
        buttons: pageKind === 'sign_in' ? [{ id: 'login', text: 'Login', formId: 'login-form' }] : [],
        links: [],
        dialogs: [],
        captcha: false,
        passwordVisible: true,
        errors: [],
        text: '',
      })),
    };
    const hostFrame = {
      url: () => URL,
      evaluate: vi.fn(async () => ({
        url: URL,
        fields: [],
        buttons: [],
        links: [],
        dialogs: [],
        captcha: false,
        passwordVisible: false,
        errors: [],
        text: '',
      })),
    };
    const page = {
      url: () => URL,
      frames: () => [hostFrame, formFrame],
      mainFrame: () => hostFrame,
      waitForLoadState: vi.fn(async () => {}),
      waitForTimeout: vi.fn(async () => {}),
      getByRole: vi.fn(() => ({
        first: () => ({ waitFor: vi.fn(async () => { throw new Error('main-frame control not found'); }) }),
      })),
    };
    const result = await handleAuth({
      page: page as any,
      snapshot: {
        url: URL,
        fields: loginFields.map((field) => ({ ...field, frame: 1 })),
        buttons: [{ id: 'login', text: 'Login', frame: 1, formId: 'login-form' }],
        links: [],
        dialogs: [],
        captcha: false,
        passwordVisible: true,
        errors: [],
        text: '',
      } as any,
      ctx: { accounts: { load: vi.fn(async () => null) } } as any,
    });

    expect(click).toHaveBeenCalledOnce();
    expect(accountButtons.filter).toHaveBeenCalledOnce();
    expect(formFrame.getByRole).toHaveBeenCalledWith('button', { name: expect.any(RegExp) });
    expect(page.getByRole).not.toHaveBeenCalled();
    expect(result.snapshot.fields.map((field: any) => field.label)).toEqual([
      'E-Mail-Adresse:*', 'Passwort:*', 'Passwort bestätigen:*',
    ]);
  });

  it('does not click a matching main-frame account button when auth fields are in a child frame', async () => {
    const mainClick = vi.fn(async () => {});
    const mainButton = {
      getAttribute: vi.fn(async () => null),
      waitFor: vi.fn(async () => {}),
      click: mainClick,
    };
    const mainButtons = {
      first: () => mainButton,
      filter: vi.fn(() => ({ first: () => mainButton })),
    };
    const missingControl = {
      first: () => missingControl,
      filter: () => missingControl,
      waitFor: vi.fn(async () => { throw new Error('auth-frame control not found'); }),
    };
    const formFrame = {
      url: () => URL,
      getByRole: vi.fn(() => missingControl),
    };
    const hostFrame = { url: () => URL };
    const page = {
      url: () => URL,
      frames: () => [hostFrame, formFrame],
      mainFrame: () => hostFrame,
      getByRole: vi.fn(() => mainButtons),
    };
    const result = await handleAuth({
      page: page as any,
      snapshot: {
        url: URL,
        fields: [
          { id: 'email', kind: 'text', inputType: 'email', label: 'E-Mail-Adresse:*', frame: 1, formId: 'login-form' },
          { id: 'password', kind: 'text', inputType: 'password', label: 'Passwort:*', frame: 1, formId: 'login-form' },
        ],
        buttons: [{ id: 'login', text: 'Login', frame: 1, formId: 'login-form' }],
        links: [],
        dialogs: [],
        captcha: false,
        passwordVisible: true,
        errors: [],
        text: '',
      } as any,
      ctx: { accounts: { load: vi.fn(async () => null) } } as any,
    });

    expect(result).toMatchObject({ handoff: 'account', accountFailure: { code: 'no_create_button', stage: 'login' } });
    expect(page.getByRole).not.toHaveBeenCalled();
    expect(mainClick).not.toHaveBeenCalled();
  });

  it('does not use a matching account link from an unrelated frame', async () => {
    const unrelatedClick = vi.fn(async () => {});
    const unrelatedLink = {
      first: () => unrelatedLink,
      waitFor: vi.fn(async () => {}),
      getAttribute: vi.fn(async () => '/career?login_ns=register'),
      click: unrelatedClick,
    };
    const formFrame = {
      getByRole: vi.fn(() => ({
        filter: () => ({ first: () => ({ waitFor: vi.fn(async () => { throw new Error('form link not found'); }) }) }),
        first: () => ({ waitFor: vi.fn(async () => { throw new Error('form link not found'); }) }),
      })),
    };
    const unrelatedFrame = {
      getByRole: vi.fn(() => unrelatedLink),
    };
    const page = {
      url: () => URL,
      frames: () => [{}, formFrame, unrelatedFrame],
      mainFrame: () => ({}),
      getByRole: vi.fn(() => ({
        first: () => ({ waitFor: vi.fn(async () => { throw new Error('main-frame link not found'); }) }),
      })),
    };
    const result = await handleAuth({
      page: page as any,
      snapshot: {
        url: URL,
        fields: [
          { id: 'email', kind: 'text', inputType: 'email', label: 'E-Mail-Adresse:*', required: true, frame: 1, formId: 'login-form' },
          { id: 'password', kind: 'text', inputType: 'password', label: 'Passwort:*', required: true, frame: 1, formId: 'login-form' },
        ],
        buttons: [{ id: 'login', text: 'Login', frame: 1, formId: 'login-form' }],
        links: [],
        dialogs: [],
        passwordVisible: true,
      } as any,
      ctx: { accounts: { load: vi.fn(async () => null) } } as any,
    });

    expect(result).toMatchObject({ handoff: 'account', accountFailure: { code: 'no_create_button', stage: 'login' } });
    expect(unrelatedFrame.getByRole).not.toHaveBeenCalled();
    expect(unrelatedClick).not.toHaveBeenCalled();
  });

  it('retries a saved unverified SuccessFactors account when the job URL opens registration directly', async () => {
    const url = 'https://career5.successfactors.eu/career';
    const result = await handleAuth({
      page: { url: () => url } as any,
      snapshot: {
        url,
        fields: [
          { id: 'email', kind: 'text', inputType: 'email', label: 'E-Mail-Adresse: *', required: true },
          { id: 'email-repeat', kind: 'text', inputType: 'email', label: 'E-Mail-Adresse erneut eingeben: *', required: true },
          { id: 'password', kind: 'text', inputType: 'password', label: 'Wähle ein Kennwort: *', required: true },
          { id: 'password-repeat', kind: 'text', inputType: 'password', label: 'Kennwort erneut eingeben: *', required: true },
        ],
        buttons: [{ id: 'create', text: 'Konto anlegen', disabled: false }],
        links: [],
        dialogs: [],
        errors: [],
        text: '',
        passwordVisible: true,
      },
      ctx: {
        dryRun: true,
        accounts: { load: vi.fn(async () => ({ email: 'runner@example.test', password: 'synthetic-password', status: 'pending', verifiedAt: null })) },
      },
    });

    expect(result).toEqual({ dryRun: true });
  });

  it('uses a saved unverified SuccessFactors account when /career exposes only Anmelden', async () => {
    const url = 'https://career5.successfactors.eu/career';
    const values = new Map<string, string>();
    let signedIn = false;
    const accountMark = vi.fn(async () => {});
    const loginFields = [
      { id: 'email', kind: 'text', inputType: 'email', label: 'E-Mail-Adresse:*', required: true, formId: 'login-form', frame: 0 },
      { id: 'password', kind: 'text', inputType: 'password', label: 'Kennwort:*', required: true, formId: 'login-form', frame: 0 },
    ];
    const currentSnapshot = () => signedIn
      ? {
        url,
        fields: [{ id: 'first-name', kind: 'text', inputType: 'text', label: 'Vorname', frame: 0 }],
        buttons: [], links: [], dialogs: [], captcha: false, passwordVisible: false, errors: [], text: 'Bewerbung',
      }
      : {
        url,
        fields: loginFields.map((field) => ({ ...field, value: values.get(field.id) || '' })),
        buttons: [{ id: 'login', text: 'Anmelden', disabled: false, frame: 0, formId: 'login-form' }],
        links: [], dialogs: [], captcha: false, passwordVisible: true, errors: [], text: '',
      };
    const unavailableRole = {
      filter: () => unavailableRole,
      first: () => unavailableRole,
      waitFor: vi.fn(async () => { throw new Error('registration-control-not-found'); }),
    };
    const frame = {
      url: () => url,
      evaluate: vi.fn(async (_fn: unknown, args?: unknown) => args ? currentSnapshot() : null),
      getByRole: vi.fn(() => unavailableRole),
      locator: vi.fn((selector: string) => {
        const id = /data-aa-id="([^"]+)"/.exec(selector)?.[1] || '';
        const locator: any = {
          first: () => locator,
          click: vi.fn(async () => { if (id === 'login') signedIn = true; }),
          fill: vi.fn(async (value: string) => { values.set(id, value); }),
          inputValue: vi.fn(async () => values.get(id) || ''),
          count: vi.fn(async () => 0),
        };
        return locator;
      }),
    };
    const page = {
      url: () => url,
      frames: () => [frame],
      mainFrame: () => frame,
      waitForLoadState: vi.fn(async () => {}),
      waitForTimeout: vi.fn(async () => {}),
      getByRole: vi.fn(() => unavailableRole),
    };
    const result = await handleAuth({
      page: page as any,
      snapshot: currentSnapshot() as any,
      ctx: {
        accounts: {
          load: vi.fn(async () => ({ email: 'runner@example.test', password: 'synthetic-password', status: 'pending', verifiedAt: null })),
          mark: accountMark,
        },
      },
    });

    expect(values).toEqual(new Map([
      ['email', 'runner@example.test'],
      ['password', 'synthetic-password'],
    ]));
    expect(result).toMatchObject({ snapshot: { text: 'Bewerbung' }, reopen: true, pressed: 'id' });
    expect(accountMark).toHaveBeenCalledWith('career5.successfactors.eu', expect.objectContaining({ status: 'created' }));
  });
});
