import { describe, expect, it, vi } from 'vitest';
import { authPageKind, codeField, registrationOutcome, verificationOutcome } from '../scripts/assisted-application/lib/portal/account.mjs';
import { handleAuth, isOtpVerificationPage } from '../scripts/assisted-application/lib/portal/portal.mjs';

// The federal SuccessFactors tenant answers «Konto anlegen» with a one-time-code
// page whose only input is masked (`type=password`, an «Anzeigen» toggle) and
// labelled «*Code:». Synthetic copy of that page, no candidate data.
const host = 'career74.sapsf.eu';
const url = `https://${host}/career?company=examplefed&login_ns=register&career_ns=job_application&career_job_req_id=1`;
const otpText = [
  'Bewerbungskonto: Erstellung',
  'Sie haben bereits ein Bewerbungskonto bei der Bundesverwaltung? Dann loggen Sie sich hier ein.',
  'E-Mail-Adresse: runner@example.test',
  'Geben Sie den Code ein, den wir an Ihre E-Mail-Adresse geschickt haben. Falls Sie diese E-Mail nicht in Ihrem Posteingang finden, prüfen Sie bitte Ihren Spam-Ordner.',
  '*Code: Anzeigen Weiter Sie haben den Code nicht erhalten? In 01:35 Minuten können Sie einen neuen Code anfordern.',
].join('\n');
const maskedCode = { id: 'otp', kind: 'text', inputType: 'password', label: '*Code:', required: true, frame: 0 };
const otpPage = (values = new Map<string, string>()) => ({
  url,
  fields: [{ ...maskedCode, value: values.get('otp') || '' }],
  buttons: [{ id: 'next', text: 'Weiter', disabled: false, frame: 0 }],
  links: [{ id: 'login', text: 'Dann loggen Sie sich hier ein.', frame: 0 }],
  dialogs: [], errors: [], captcha: false, passwordVisible: true, text: otpText,
});
const applicationForm = {
  url,
  fields: [
    { id: 'first-name', kind: 'text', inputType: 'text', label: 'Vorname', frame: 0 },
    { id: 'last-name', kind: 'text', inputType: 'text', label: 'Nachname', frame: 0 },
    { id: 'cv', kind: 'file', inputType: 'file', label: 'Lebenslauf', frame: 0 },
  ],
  buttons: [{ id: 'apply', text: 'Bewerben', disabled: false, frame: 0 }],
  links: [], dialogs: [], errors: [], captcha: false, passwordVisible: false, text: 'Bewerbung',
};

describe('SuccessFactors one-time code behind a masked input', () => {
  it('reads the masked bare «Code» input as the OTP field, never as a sign-in password', () => {
    const page = otpPage();
    expect(codeField(page)?.id).toBe('otp');
    expect(authPageKind(page)).toBe('none');
    // The page that follows the registration click: before the fix it was
    // taken for a sign-in (`created`), so the e-mailed code was never awaited.
    expect(registrationOutcome(page)).toBe('verify');
    expect(isOtpVerificationPage(page, host, { verifiedAt: null })).toBe(true);
    // Still the same code page after «Weiter» is no acceptance (it was read as
    // a sign-in landing, `accepted`, which would have recorded verifiedAt).
    expect(verificationOutcome(page)).toBe('rejected');
  });

  it.each([
    ['Kennwort:*'],
    ['Zugangscode'],
    ['Passwort / Code vergessen?'],
    // Next to the login's e-mail even a bare «Code» is that form's secret.
    ['Code'],
  ])('keeps a password labelled %s an account password', (label) => {
    const signIn = {
      fields: [
        { id: 'email', kind: 'text', inputType: 'email', label: 'E-Mail-Adresse:*' },
        { id: 'password', kind: 'text', inputType: 'password', label },
      ],
      buttons: [], errors: [], text: '',
    };
    expect(codeField(signIn)).toBeNull();
    expect(authPageKind(signIn)).toBe('sign_in');
    expect(authPageKind({ ...signIn, fields: [...signIn.fields, { id: 'repeat', kind: 'text', inputType: 'password', label: 'Kennwort bestätigen' }] })).toBe('create');
  });
});

function otpPortal(after: 'form' | 'same') {
  const values = new Map<string, string>();
  let submitted = false;
  const current = () => (submitted && after === 'form' ? applicationForm : otpPage(values));
  const unavailableRole: any = {
    filter: () => unavailableRole,
    first: () => unavailableRole,
    waitFor: vi.fn(async () => { throw new Error('not-visible'); }),
  };
  const frame = {
    url: () => url,
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
    url: () => url,
    frames: () => [frame],
    mainFrame: () => frame,
    waitForLoadState: vi.fn(async () => {}),
    waitForTimeout: vi.fn(async () => {}),
    getByRole: vi.fn(() => unavailableRole),
  };
  return { page, values, isSubmitted: () => submitted };
}

describe('handleAuth on the masked SuccessFactors OTP page', () => {
  it('enters the e-mailed code for the unverified account instead of a failed sign-in', async () => {
    const { page, values, isSubmitted } = otpPortal('form');
    const createdAt = 1_000;
    const mark = vi.fn(async () => {});
    const waitForVerification = vi.fn(async () => ({ url: '', code: '482915', messageId: 'in-synthetic' }));
    const result = await handleAuth({
      page: page as any,
      snapshot: otpPage() as any,
      ctx: {
        accounts: {
          load: vi.fn(async () => ({ email: 'runner@example.test', password: 'synthetic-password', status: 'created', createdAt, verifiedAt: null })),
          verificationMessageIds: vi.fn(async () => []),
          waitForVerification,
          mark,
        },
      } as any,
    });

    expect(result).not.toHaveProperty('handoff');
    expect(result).toMatchObject({ reopen: true });
    expect(waitForVerification).toHaveBeenCalledWith(expect.objectContaining({ host, sinceMs: createdAt }));
    // The code went into the masked field, never the account password.
    expect(values.get('otp')).toBe('482915');
    expect(isSubmitted()).toBe(true);
    expect(mark).toHaveBeenCalledWith(host, expect.objectContaining({ verifiedAt: expect.any(Number) }));
  });

  it('does not record a verification when the portal stays on the code page', async () => {
    const { page } = otpPortal('same');
    const mark = vi.fn(async () => {});
    const result = await handleAuth({
      page: page as any,
      snapshot: otpPage() as any,
      ctx: {
        accounts: {
          load: vi.fn(async () => ({ email: 'runner@example.test', password: 'synthetic-password', status: 'created', createdAt: 1, verifiedAt: null })),
          verificationMessageIds: vi.fn(async () => []),
          waitForVerification: vi.fn(async () => ({ url: '', code: '482915', messageId: 'in-synthetic' })),
          mark,
        },
      } as any,
    });

    expect(result).toMatchObject({ handoff: 'account_verification_rejected', accountFailure: { code: 'verification_rejected', stage: 'verification' } });
    expect(mark).not.toHaveBeenCalled();
  });

  it.each([
    ['no saved account', null],
    ['an already verified account', { email: 'runner@example.test', password: 'synthetic-password', status: 'created', createdAt: 1, verifiedAt: 2 }],
  ])('hands the code page over with %s, without typing credentials', async (_name, account) => {
    const { page, values } = otpPortal('same');
    const waitForVerification = vi.fn(async () => null);
    const result = await handleAuth({
      page: page as any,
      snapshot: otpPage() as any,
      ctx: { accounts: { load: vi.fn(async () => account), verificationMessageIds: vi.fn(async () => []), waitForVerification, mark: vi.fn() } } as any,
    });

    // Without a saved account the federal copy «Sie haben bereits ein
    // Bewerbungskonto…» keeps its existing-account handoff; either way nothing
    // is typed and no e-mail is awaited.
    expect(result).toMatchObject(account
      ? { handoff: 'account_verification', accountFailure: { code: 'verification_unobserved', stage: 'verification' } }
      : { handoff: 'account', accountFailure: { code: 'login_unobserved', stage: 'login' } });
    expect(waitForVerification).not.toHaveBeenCalled();
    expect(values.size).toBe(0);
  });
});
