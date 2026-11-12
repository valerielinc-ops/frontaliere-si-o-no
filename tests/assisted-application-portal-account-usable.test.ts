import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({
  getRemoteConfigValue: vi.fn(async () => ''),
  bridgeEmailCascadeCredentialsToEnv: vi.fn(async () => {}),
}));

const { handleAuth, signedInApplicationSurface, verifyAccount } = await import('../scripts/assisted-application/lib/portal/portal.mjs');
const { ensureOrderAlias } = await import('../functions/src/assistedApplicationAlias.js');
const { handleAssistedApplicationInbound, processAssistedApplicationInbound } = await import('../functions/src/assistedApplicationInbound.js');

// Two SuccessFactors tenants, 2026-11-10, synthetic copies without candidate data.
// SBB accepted the passcode and opened the job's form in the candidate's own
// session (sections closed, «Bewerbung abschicken»): read as `unconfirmed`.
// Damiani asked for no OTP at all: the next runs restarted the registration
// at every step until `auth_steps_exhausted`. Both portals mailed a profile or
// registration confirmation that reached the candidate.
const SBB = 'career5.successfactors.eu';
const DAMIANI = 'career55.sapsf.eu';

const sbbForm = {
  url: `https://${SBB}/portalcareer?_s.crb=synthetic`,
  fields: [{ id: 'lang', kind: 'combobox', inputType: 'text', label: 'Sprache', frame: 0 }],
  buttons: [
    { id: 'cookies', text: 'Cookie-Einstellungen', disabled: false, frame: 0, chrome: true },
    { id: 'options', text: 'Optionen', disabled: false, frame: 0 },
    { id: 'expand', text: 'Alle Abschnitte einblenden', disabled: false, frame: 0 },
    { id: 'cv', text: '* Lebenslauf (PDF) Lebenslauf hochladen Öffnet ein Dialogfeld', disabled: false, frame: 0 },
    { id: 'profile', text: 'Profilinformationen', disabled: false, frame: 0 },
    { id: 'save', text: 'Änderungen speichern', disabled: false, frame: 0 },
    { id: 'send', text: 'Bewerbung abschicken', disabled: false, frame: 0 },
  ],
  links: [{ id: 'logout', text: 'Abmelden', frame: 0 }],
  dialogs: [], errors: [], captcha: false, passwordVisible: false,
  text: 'Abmelden Optionen\nProduct Manager (m/w/d)\nHinweis: Bitte kontrolliere nach abgeschlossener Bewerbung auch den Spam-Ordner.\nMeine Dokumente\nBewerbung abschicken',
};
const passcodePage = (values: Map<string, string>) => ({
  url: `https://${SBB}/career?company=EXAMPLE&login_ns=register&career_ns=job_application&career_job_req_id=1`,
  fields: [{ id: 'otp', kind: 'text', inputType: 'password', label: '*Passcode:', required: true, frame: 0, value: values.get('otp') || '' }],
  buttons: [{ id: 'next', text: 'Weiter', disabled: false, frame: 0 }],
  links: [], dialogs: [], errors: [], captcha: false, passwordVisible: true,
  text: 'Wir haben ein Einmalkennwort an Ihre E-Mail-Adresse geschickt.\n*Passcode: Anzeigen Weiter',
});
const signIn = (host: string, values: Map<string, string>) => ({
  url: `https://${host}/careers?company=example`,
  fields: [
    { id: 'email', kind: 'text', inputType: 'email', label: 'Email Address:*', required: true, frame: 0, formId: 'login', value: values.get('email') || '' },
    { id: 'password', kind: 'text', inputType: 'password', label: 'Password:*', required: true, frame: 0, formId: 'login', value: values.get('password') || '' },
  ],
  buttons: [{ id: 'login', text: 'Sign In', disabled: false, frame: 0, formId: 'login' }],
  links: [{ id: 'create', text: 'Create an account', frame: 0 }],
  dialogs: [], errors: [], captcha: false, passwordVisible: true,
  text: 'Career Opportunities: Sign In\nAlready have an account?\nNot a registered user yet? Create an account to apply for our career opportunities.',
});

function fakePage(host: string, current: () => any, onClick: (id: string) => void, values: Map<string, string>) {
  const unavailableRole: any = { filter: () => unavailableRole, first: () => unavailableRole, waitFor: vi.fn(async () => { throw new Error('not-visible'); }) };
  const frame = {
    url: () => current().url,
    evaluate: vi.fn(async (_fn: unknown, args?: unknown) => (args ? current() : null)),
    getByRole: vi.fn(() => unavailableRole),
    locator: vi.fn((selector: string) => {
      const id = /data-aa-id="([^"]+)"/.exec(selector)?.[1] || '';
      const locator: any = {
        first: () => locator,
        waitFor: vi.fn(async () => {}),
        getAttribute: vi.fn(async () => null),
        click: vi.fn(async () => onClick(id)),
        fill: vi.fn(async (value: string) => { values.set(id, value); }),
        inputValue: vi.fn(async () => values.get(id) || ''),
        count: vi.fn(async () => 0),
      };
      return locator;
    }),
  };
  return {
    url: () => current().url, frames: () => [frame], mainFrame: () => frame,
    waitForLoadState: vi.fn(async () => {}),
    // The run's clock moves with each wait, so the portal's bounded waits are real.
    waitForTimeout: vi.fn(async (ms: number) => { vi.setSystemTime(Date.now() + ms); }),
    getByRole: vi.fn(() => unavailableRole),
  };
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(1_800_000_000_000); });
afterEach(() => { vi.useRealTimers(); });

describe('the candidate’s own session on the job’s form', () => {
  it('is the signed-in application surface, never an auth or code page', () => {
    const values = new Map<string, string>();
    expect(signedInApplicationSurface(sbbForm)).toBe(true);
    expect(signedInApplicationSurface(passcodePage(values))).toBe(false);
    // A guest application view has a CV field and a submit button too: without a session mark it proves nothing.
    expect(signedInApplicationSurface({ fields: [{ label: 'CV' }], buttons: [{ text: 'Bewerbung abschicken' }], links: [] } as any)).toBe(false);
    expect(signedInApplicationSurface({ fields: [{ label: 'CV' }], buttons: [{ text: 'Bewerbung abschicken' }, { text: 'Abmelden' }], links: [] } as any)).toBe(true);
    expect(signedInApplicationSurface(signIn(DAMIANI, values))).toBe(false);
    expect(signedInApplicationSurface({ ...sbbForm, buttons: sbbForm.buttons.filter((button) => button.id !== 'send') })).toBe(false);
  });

  it('answers an accepted passcode at once, without waiting for a mail', async () => {
    const values = new Map<string, string>();
    let submitted = false;
    const page = fakePage(SBB, () => (submitted ? sbbForm : passcodePage(values)), (id) => { if (id === 'next') submitted = true; }, values);
    const accounts = {
      verificationMessageIds: vi.fn(async () => []),
      waitForVerification: vi.fn(async () => ({ url: '', code: '604218', messageId: 'in-synthetic' })),
      waitForAccountNotice: vi.fn(async () => null),
      mark: vi.fn(async () => {}),
    };
    const result = await verifyAccount({ page: page as any, host: SBB, sinceMs: 0, ctx: { accounts } as any, snapshot: passcodePage(values) as any });

    expect(values.get('otp')).toBe('604218');
    expect(result).toMatchObject({ reopen: true });
    expect(result).not.toHaveProperty('handoff');
    expect(accounts.waitForAccountNotice).not.toHaveBeenCalled();
    expect(accounts.mark).toHaveBeenCalledWith(SBB, { verifiedAt: expect.any(Number) });
  });
});

describe('an unverified SuccessFactors account on its sign-in page', () => {
  it('restarts the registration once per run, then signs in with the saved password', async () => {
    const values = new Map<string, string>();
    let view: 'sign_in' | 'form' = 'sign_in';
    const clicks: string[] = [];
    // The registration link leads back to the sign-in page (the tenant knows the address).
    const page = fakePage(DAMIANI, () => (view === 'form' ? { ...sbbForm, url: `https://${DAMIANI}/portalcareer` } : signIn(DAMIANI, values)), (id) => {
      clicks.push(id);
      if (id === 'login') view = 'form';
    }, values);
    const account = { email: 'runner@example.test', password: 'synthetic-password', status: 'created', createdAt: 500, verifiedAt: null as number | null };
    const accounts = {
      load: vi.fn(async () => ({ ...account })),
      mark: vi.fn(async (_host: string, patch: Record<string, unknown>) => { Object.assign(account, patch); }),
      accountNotice: vi.fn(async () => null),
    };
    const ctx = { accounts } as any;
    const firstRunRestarts = new Set<string>();

    const first = await handleAuth({ page: page as any, snapshot: signIn(DAMIANI, values) as any, ctx, registrationRestarts: firstRunRestarts });
    expect(clicks).toEqual(['create']);
    expect(first).toMatchObject({ handoff: 'account_verification' });

    const second = await handleAuth({ page: page as any, snapshot: signIn(DAMIANI, values) as any, ctx, registrationRestarts: firstRunRestarts });
    expect(clicks).toEqual(['create', 'login']);
    expect(values).toEqual(new Map([['email', 'runner@example.test'], ['password', 'synthetic-password']]));
    expect(second).not.toHaveProperty('handoff');
    expect(account.verifiedAt).toEqual(expect.any(Number));

    // A new run reuses this account store but owns a fresh restart set.
    account.verifiedAt = null;
    view = 'sign_in';
    const secondRun = await handleAuth({
      page: page as any, snapshot: signIn(DAMIANI, values) as any, ctx, registrationRestarts: new Set<string>(),
    });
    expect(clicks.at(-1)).toBe('create');
    expect(secondRun).toMatchObject({ handoff: 'account_verification' });
  });
});

describe('a profile or registration confirmation of the order’s account', () => {
  const ORDER = 'order_ACCOUNTUSABLE1';
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
  const mail = (from: string, dkim: string, subject: string, text: string) => Buffer.from([
    `From: ${from}`,
    `Authentication-Results: mx.cloudflare.net; dkim=pass header.d=${dkim}`,
    `Subject: =?utf-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(text, 'utf8').toString('base64'),
    '',
  ].join('\r\n'), 'latin1');
  async function deliver(host: string, raw: Buffer, answer: any) {
    const store = createMemoryFirestore({
      [ORDER_PATH]: { paymentStatus: 'paid', cvUploadedAt: 1, cvStorageKey: `assisted-application-uploads/${ORDER}/cv.pdf`, locale: 'de', companyName: 'Muster AG', jobTitle: 'Testrolle', applicantEmail: 'candidate@example.test' },
    });
    const alias = await ensureOrderAlias({ db: store.db, orderId: ORDER, cf: cf() });
    await store.db.collection('assisted_applications').doc(ORDER).collection('automation').doc('accounts')
      .set({ portal: { host, passwordEnc: { v: 1 }, verifiedAt: null, status: 'created', createdAt: 500 } });
    const files = bucket();
    const accepted = await handleAssistedApplicationInbound({
      method: 'POST', rawBody: raw,
      get: (name: string) => ({ 'x-stop-secret': SECRET, 'x-envelope-to': alias.address } as Record<string, string>)[name],
    }, { db: store.db, bucket: files, secret: SECRET, runKey: RUN_KEY, nowMs: 1000 });
    const sendCascade = vi.fn(async () => ({ failed: [], sent: [{ provider: 'maileroo' }] }));
    await processAssistedApplicationInbound({
      db: store.db, bucket: files, orderId: ORDER, messageId: accepted.body.accepted, runKey: RUN_KEY,
      classify: answer ? vi.fn(async () => answer) : vi.fn(async () => { throw new Error('codex_unavailable'); }), sendCascade, nowMs: 1000,
    });
    return { inbox: store.read(`${ORDER_PATH}/inbox/${accepted.body.accepted}`)!, sendCascade };
  }
  const verification = { category: 'verification', summaryIt: 'Conferma account.', summaryCandidate: 'Account creato.', interviewWhen: '', requestedDocuments: [], verificationCode: '', verificationUrl: '', needsReply: false };
  const sbbText = 'Hallo\n\nEs freut uns, dass du mit uns die Schweiz bewegen willst. Du hast im Karriereportal ein Profil erstellt und kannst dich nun direkt auf offene Stellen https://company.example-rail.ch/jobs/ bewerben.\n\nWir freuen uns auf deine Bewerbung.\n\nHerzliche Grüsse Dein Recruiting-Team';
  const damianiText = 'Dear candidate,\nwelcome!\n\nYour registration on the site was successful.\n\nTo find out about our active job offers, please visit our Careers page https://hcm55.sapsf.eu/sf/careers/jobsearch?company=example\n\nBest Regards\nHR Team';

  it.each([
    ['SBB', SBB, mail('Recruiting <noreply@hrs.example-rail.ch>', 'hrs.example-rail.ch', 'Vielen Dank für die Profilerstellung', sbbText)],
    ['Damiani', DAMIANI, mail('Careers <noreply@successfactors.com>', 'successfactors.com', 'Example Group | Thanks for your registration!', damianiText)],
  ])('is kept from the candidate and recorded for the runner (%s)', async (_name, host, raw) => {
    for (const answer of [verification, null]) {
      const { inbox, sendCascade } = await deliver(host, raw, answer);
      expect(inbox).toMatchObject({
        portalVerificationHost: '', portalAccountNoticeHost: host, portalAccountNotice: 'created',
        forwarded: { status: 'skipped', reason: 'portal_account_notice' },
      });
      expect(sendCascade).not.toHaveBeenCalled();
    }
  });

  it('still reaches the candidate when it also invites to an interview', async () => {
    const raw = mail('Careers <noreply@successfactors.com>', 'successfactors.com', 'Thanks for your registration!',
      `${damianiText}\n\nWe would like to invite you to an interview on 12 December at 10:00.`);
    const { inbox, sendCascade } = await deliver(DAMIANI, raw, { ...verification, category: 'interview_invite', interviewWhen: '12 December 10:00' });
    expect(inbox.portalAccountNoticeHost).toBeUndefined();
    expect(sendCascade).toHaveBeenCalledTimes(1);
  });
});
