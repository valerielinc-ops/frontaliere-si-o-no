import { describe, expect, it, vi } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({
  getRemoteConfigValue: vi.fn(async () => ''),
  bridgeEmailCascadeCredentialsToEnv: vi.fn(async () => {}),
}));

const { VERIFY_PAGE_RE, authPageKind, codeField, registrationOutcome, verificationOutcome } = await import('../scripts/assisted-application/lib/portal/account.mjs');
const { handleAuth, isOtpVerificationPage } = await import('../scripts/assisted-application/lib/portal/portal.mjs');
const { ensureOrderAlias } = await import('../functions/src/assistedApplicationAlias.js');
const { handleAssistedApplicationInbound, processAssistedApplicationInbound } = await import('../functions/src/assistedApplicationInbound.js');

// SBB's SuccessFactors tenant answers «Konto anlegen» with a one-time-code page
// (2026-11-10): «Wir haben ein Einmalkennwort an Ihre E-Mail-Adresse geschickt»
// and one masked input («Anzeigen») labelled «*Passcode:». Read as a sign-in,
// it ended as `login_unobserved` with the code already in the runner's inbox.
// Synthetic copy, no candidate data.
const host = 'career5.successfactors.eu';
const url = `https://${host}/career?company=EXAMPLE&career_ns=job_application&career_job_req_id=1&login_ns=register&jobPipeline=example`;
const otpText = [
  'Jobportal: Eröffne dein Profil',
  'Bist du bereits als Benutzer registriert? Bitte melde dich hier an.',
  '*weist auf ein erforderliches Feld hin.',
  'E-Mail-Adresse: runner@example.test',
  'Wir haben ein Einmalkennwort an Ihre E-Mail-Adresse geschickt. Falls Sie diese E-Mail nicht in Ihrem Haupt-E-Mail-Eingang finden, überprüfen Sie bitte Ihre Spam- oder Bulk-E-Mail-Ordner.',
  '*Passcode: Anzeigen Weiter Sie können in 01:35 Minuten einen neuen Passcode anfordern.',
].join('\n');
const passcode = { id: 'otp', kind: 'text', inputType: 'password', label: '*Passcode:', required: true, frame: 0 };
const otpPage = (values = new Map<string, string>(), errors: string[] = []) => ({
  url,
  fields: [{ ...passcode, value: values.get('otp') || '' }],
  buttons: [
    { id: 'cookies', text: 'Cookie-Einstellungen', disabled: false, frame: 0, chrome: true },
    { id: 'next', text: 'Weiter', disabled: false, frame: 0 },
  ],
  links: [{ id: 'login', text: 'Bitte melde dich hier an.', frame: 0 }],
  dialogs: [], errors, captcha: false, passwordVisible: true, text: otpText,
});
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

describe('SBB’s masked «Passcode» page', () => {
  it('is the one-time-code page, not a sign-in', () => {
    const page = otpPage();
    expect(VERIFY_PAGE_RE.test(otpText)).toBe(true);
    expect(codeField(page)?.id).toBe('otp');
    expect(authPageKind(page)).toBe('none');
    expect(registrationOutcome(page)).toBe('verify');
    expect(isOtpVerificationPage(page, host, { verifiedAt: null })).toBe(true);
    expect(verificationOutcome(page)).not.toBe('accepted');
  });

  it.each(['Passcode', 'Pass-Code', 'Einmalkennwort', 'Einmalkennwort:*'])('reads a lone masked «%s» as the code', (label) => {
    const page = { fields: [{ ...passcode, label }], buttons: [], errors: [], text: '' };
    expect(codeField(page)?.id).toBe('otp');
    expect(authPageKind(page)).toBe('none');
  });

  it('keeps a «Passcode» next to the login’s e-mail that form’s secret', () => {
    const signIn = { fields: [{ id: 'email', kind: 'text', inputType: 'email', label: 'E-Mail-Adresse:*' }, { ...passcode, label: 'Passcode' }], buttons: [], errors: [], text: '' };
    expect(codeField(signIn)).toBeNull();
    expect(authPageKind(signIn)).toBe('sign_in');
  });

  it('enters the e-mailed code for the unverified account instead of a failed sign-in', async () => {
    const values = new Map<string, string>();
    let submitted = false;
    const cookies = vi.fn();
    const current = () => (submitted ? applicationForm : otpPage(values));
    const unavailableRole: any = { filter: () => unavailableRole, first: () => unavailableRole, waitFor: vi.fn(async () => { throw new Error('not-visible'); }) };
    const frame = {
      url: () => url,
      evaluate: vi.fn(async (_fn: unknown, args?: unknown) => (args ? current() : null)),
      getByRole: vi.fn(() => unavailableRole),
      locator: vi.fn((selector: string) => {
        const id = /data-aa-id="([^"]+)"/.exec(selector)?.[1] || '';
        const locator: any = {
          first: () => locator,
          click: vi.fn(async () => { if (id === 'next') submitted = true; if (id === 'cookies') cookies(); }),
          fill: vi.fn(async (value: string) => { values.set(id, value); }),
          inputValue: vi.fn(async () => values.get(id) || ''),
          count: vi.fn(async () => 0),
        };
        return locator;
      }),
    };
    const page = {
      url: () => url, frames: () => [frame], mainFrame: () => frame,
      waitForLoadState: vi.fn(async () => {}), waitForTimeout: vi.fn(async () => {}),
      getByRole: vi.fn(() => unavailableRole),
    };
    const mark = vi.fn(async () => {});
    const waitForVerification = vi.fn(async () => ({ url: '', code: '604218', messageId: 'in-synthetic' }));
    const result = await handleAuth({
      page: page as any,
      snapshot: otpPage() as any,
      ctx: { accounts: {
        load: vi.fn(async () => ({ email: 'runner@example.test', password: 'synthetic-password', status: 'created', createdAt: 1_000, verifiedAt: null })),
        verificationMessageIds: vi.fn(async () => []), waitForVerification, mark,
      } } as any,
    });

    expect(result).not.toHaveProperty('handoff');
    expect(result).toMatchObject({ reopen: true });
    expect(waitForVerification).toHaveBeenCalledWith(expect.objectContaining({ host }));
    expect(values.get('otp')).toBe('604218');
    expect(cookies).not.toHaveBeenCalled();
    expect(mark).toHaveBeenCalledWith(host, expect.objectContaining({ verifiedAt: expect.any(Number) }));
  });
});

describe('SBB’s passcode mail without the model', () => {
  const ORDER = 'order_SBBPASSCODE1';
  const ORDER_PATH = `assisted_applications/${ORDER}`;
  const RUN_KEY = Buffer.alloc(32, 7).toString('base64');
  const SECRET = 'worker-secret';
  const cf = () => {
    const rules = new Map<string, string>();
    return {
      async createRule(address: string) { const id = `rule-${rules.size + 1}`; rules.set(id, address); return id; },
      async deleteRule(id: string) { rules.delete(id); },
    };
  };
  const bucket = () => {
    const files = new Map<string, string>();
    return { file: (key: string) => ({
      async save(content: string) { files.set(key, String(content)); },
      async getMetadata() { return [{ generation: '1' }]; },
      async delete() { files.delete(key); },
      async download() { return [Buffer.from(files.get(key) || '')]; },
    }) };
  };
  const subject = 'Einmaliger Passcode für die Aktivierung des Kandidatenkontos';
  const text = 'Hallo,\n\nDein Passcode für die Aktivierung deines Kontos lautet 604218\n\nBitte gib diesen Passcode auf der Seite „Jobportal: Eröffne dein Profil“ ein, um deine Mailadresse zu bestätigen und dein Konto zu aktivieren.\n\nDieser Passcode ist 10 Minuten lang gültig.\n\nHerzliche Grüsse Dein Recruiting-Team';
  const raw = Buffer.from([
    'From: Recruiting <noreply@hrs.example-rail.ch>',
    'Authentication-Results: mx.cloudflare.net; dkim=pass header.d=hrs.example-rail.ch',
    `Subject: =?utf-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(text, 'utf8').toString('base64'),
    '',
  ].join('\r\n'), 'latin1');

  it('keeps the code for the waiting account, not the candidate', async () => {
    const store = createMemoryFirestore({
      [ORDER_PATH]: { paymentStatus: 'paid', cvUploadedAt: 1, cvStorageKey: `assisted-application-uploads/${ORDER}/cv.pdf`, locale: 'de', companyName: 'Muster AG', jobTitle: 'Testrolle', applicantEmail: 'candidate@example.test' },
    });
    const alias = await ensureOrderAlias({ db: store.db, orderId: ORDER, cf: cf() });
    await store.db.collection('assisted_applications').doc(ORDER).collection('automation').doc('accounts')
      .set({ portal: { host, passwordEnc: { v: 1 }, verifiedAt: null, createdAt: 500 } });
    const files = bucket();
    const accepted = await handleAssistedApplicationInbound({
      method: 'POST', rawBody: raw,
      get: (name: string) => ({ 'x-stop-secret': SECRET, 'x-envelope-to': alias.address } as Record<string, string>)[name],
    }, { db: store.db, bucket: files, secret: SECRET, runKey: RUN_KEY, nowMs: 1000 });
    const sendCascade = vi.fn(async () => ({ failed: [], sent: [{ provider: 'maileroo' }] }));
    await processAssistedApplicationInbound({
      db: store.db, bucket: files, orderId: ORDER, messageId: accepted.body.accepted, runKey: RUN_KEY,
      classify: vi.fn(async () => { throw new Error('codex_unavailable'); }), sendCascade, nowMs: 1000,
    });
    expect(store.read(`${ORDER_PATH}/inbox/${accepted.body.accepted}`)).toMatchObject({
      category: 'verification', classifiedBy: 'rules', verificationCode: '604218', portalVerificationHost: host,
      forwarded: { status: 'skipped', reason: 'portal_verification' },
    });
    expect(sendCascade).not.toHaveBeenCalled();
  });
});
