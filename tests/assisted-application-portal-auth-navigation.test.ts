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
      { id: 'email', kind: 'text', inputType: 'email', label: 'E-Mail-Adresse:*', required: true },
      { id: 'password', kind: 'text', inputType: 'password', label: 'Passwort:*', required: true },
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
        buttons: pageKind === 'sign_in' ? [{ id: 'login', text: 'Login' }] : [],
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
        buttons: [{ id: 'login', text: 'Login', frame: 1 }],
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
    const linkLocator = {
      first: () => hiddenLinkLocator,
      filter: vi.fn(() => visibleLinkLocator),
    };
    const hiddenLinkLocator = {
      first: () => hiddenLinkLocator,
      waitFor: vi.fn(async () => { throw new Error('hidden duplicate'); }),
      getAttribute: vi.fn(async () => '/career?login_ns=register'),
      click: vi.fn(),
    };
    const visibleLinkLocator = {
      first: () => visibleLinkLocator,
      waitFor: vi.fn(async () => {}),
      getAttribute: vi.fn(async () => '/career?login_ns=register'),
      click,
    };
    const loginFields = [
      { id: 'email', kind: 'text', inputType: 'email', label: 'E-Mail-Adresse:*', required: true },
      { id: 'password', kind: 'text', inputType: 'password', label: 'Passwort:*', required: true },
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
        buttons: pageKind === 'sign_in' ? [{ id: 'login', text: 'Login' }] : [],
        links: [],
        dialogs: [],
        captcha: false,
        passwordVisible: true,
        errors: [],
        text: '',
      })),
    };
    const unrelatedLinkLocator = {
      first: () => unrelatedLinkLocator,
      filter: vi.fn(() => unrelatedLinkLocator),
      waitFor: vi.fn(async () => {}),
      getAttribute: vi.fn(async () => '/unrelated'),
      click: vi.fn(),
    };
    const unrelatedFrame = {
      url: () => URL,
      getByRole: vi.fn(() => unrelatedLinkLocator),
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
      frames: () => [hostFrame, unrelatedFrame, formFrame],
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
          { id: 'widget-field', kind: 'text', inputType: 'text', label: 'Widget', frame: 1 },
          ...loginFields.map((field) => ({ ...field, frame: 2 })),
        ],
        buttons: [{ id: 'login', text: 'Login', frame: 2 }],
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
    expect(formFrame.getByRole).toHaveBeenCalledWith('link', { name: expect.any(RegExp) });
    expect(unrelatedFrame.getByRole).not.toHaveBeenCalled();
    expect(hiddenLinkLocator.waitFor).not.toHaveBeenCalled();
    expect(page.getByRole).not.toHaveBeenCalled();
    expect(result.snapshot.fields.map((field: any) => field.label)).toEqual([
      'E-Mail-Adresse:*', 'Passwort:*', 'Passwort bestätigen:*',
    ]);
  });
});
