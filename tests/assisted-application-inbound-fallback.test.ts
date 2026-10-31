import { describe, expect, it, vi } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({
  getRemoteConfigValue: vi.fn(async () => ''),
  bridgeEmailCascadeCredentialsToEnv: vi.fn(async () => {}),
}));

const { ensureOrderAlias } = await import('../functions/src/assistedApplicationAlias.js');
const { buildForward, classifyByRules, handleAssistedApplicationInbound, processAssistedApplicationInbound } = await import('../functions/src/assistedApplicationInbound.js');
const { hostKey, portalAccountStore } = await import('../scripts/assisted-application/lib/portal/account.mjs');
const { employerResponseOf, employerResponseView } = await import('../functions/src/assistedApplicationEmployerResponse.js');

const ORDER = 'order_FALLBACK1';
const ORDER_PATH = `assisted_applications/${ORDER}`;
const RUN_KEY = Buffer.alloc(32, 7).toString('base64');
const SECRET = 'worker-secret';
const MIB = 1024 * 1024;

const cf = () => {
  const rules = new Map<string, string>();
  return {
    async createRule(address: string) { const id = `rule-${rules.size + 1}`; rules.set(id, address); return id; },
    async deleteRule(id: string) { rules.delete(id); },
  };
};

function fakeBucket() {
  const files = new Map<string, string>();
  const metadata = new Map<string, any>();
  return {
    files,
    file: (key: string) => ({
      async save(content: string, options: any) {
        files.set(key, String(content));
        metadata.set(key, { generation: '1', metadata: options.metadata?.metadata });
      },
      async getMetadata() { return [metadata.get(key)]; },
      async delete() { files.delete(key); metadata.delete(key); },
      async download() { return [Buffer.from(files.get(key) || '')]; },
    }),
  };
}

async function setup(locale = 'de', accountHost = '') {
  const store = createMemoryFirestore({
    [ORDER_PATH]: { paymentStatus: 'paid', cvUploadedAt: 1, cvStorageKey: `assisted-application-uploads/${ORDER}/cv.pdf`, locale, companyName: 'Muster AG', jobTitle: 'Testrolle', applicantEmail: 'candidate@example.test' },
  });
  const alias = await ensureOrderAlias({ db: store.db, orderId: ORDER, cf: cf() });
  if (accountHost) {
    await store.db.collection('assisted_applications').doc(ORDER).collection('automation').doc('accounts')
      .set({ portal: { host: accountHost, passwordEnc: { v: 1 }, verifiedAt: null } });
  }
  return { store, alias };
}

const request = (raw: Buffer, to: string) => ({
  method: 'POST',
  rawBody: raw,
  get: (name: string) => ({ 'x-stop-secret': SECRET, 'x-envelope-to': to } as Record<string, string>)[name],
});

/** Codex unavailable: the classifier throws, and nothing leaves the process but the stubbed provider. */
async function deliverWithoutModel({ store, alias, raw, at = 1000, sendCascade = vi.fn(async () => ({ failed: [], sent: [{ provider: 'maileroo' }] })) }: any) {
  const bucket = fakeBucket();
  const now = () => at;
  const accepted = await handleAssistedApplicationInbound(request(raw, alias.address), { db: store.db, bucket, secret: SECRET, runKey: RUN_KEY, now, nowMs: at });
  const classify = vi.fn(async () => { throw new Error('codex_unavailable'); });
  const messageId = accepted.body.accepted;
  const processed = await processAssistedApplicationInbound({ db: store.db, bucket, orderId: ORDER, messageId, runKey: RUN_KEY, classify, sendCascade, now, nowMs: at });
  const inbox = store.read(`${ORDER_PATH}/inbox/${messageId}`)!;
  return { processed, inbox, classify, sendCascade, messageId, bucket };
}

const plainMail = ({ subject, text, headers = [] }: { subject: string; text: string; headers?: string[] }) => Buffer.from([
  'From: Recruiting <hr@employer.example>',
  `Subject: =?utf-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`,
  ...headers,
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from(text, 'utf8').toString('base64'),
  '',
].join('\r\n'), 'latin1');

describe('fallback classification by the purpose of the message', () => {
  const table: Array<[string, string, string, string]> = [
    // An application received, in the four languages.
    ['auto_acknowledgement', 'Ihre Bewerbung', 'Hiermit bestätigen wir den Eingang Ihrer Bewerbung.', 'de receipt'],
    ['auto_acknowledgement', 'Application', 'We have received your application and will contact you if your profile matches.', 'en receipt, conditional after it'],
    ['auto_acknowledgement', 'Candidatura', 'Abbiamo ricevuto la sua candidatura.', 'it receipt'],
    ['auto_acknowledgement', 'Candidature', 'Nous avons bien reçu votre candidature à notre offre d’emploi.', 'fr receipt naming the job ad'],
    ['auto_acknowledgement', 'Application', 'We have received your application. If your profile matches, we will invite you to an interview. Unfortunately we cannot answer every enquiry individually.', 'en boilerplate with a conditional interview'],
    ['auto_acknowledgement', 'Bewerbung', 'Wir haben Ihre Bewerbung erhalten. Sollten wir Sie zu einem Vorstellungsgespräch einladen, melden wir uns.', 'de boilerplate with a conditional interview'],
    ['auto_acknowledgement', 'Candidatura', 'Abbiamo ricevuto la sua candidatura. Qualora il suo profilo sia idoneo, la contatteremo per un colloquio.', 'it boilerplate with a conditional interview'],
    ['auto_acknowledgement', 'Candidature', 'Nous avons bien reçu votre candidature. Si votre profil correspond, nous vous inviterons à un entretien.', 'fr boilerplate with a conditional interview'],
    ['auto_acknowledgement', 'Ihre Bewerbung', 'Hiermit bestätigen wir den Eingang Ihrer Bewerbung.'.normalize('NFD'), 'decomposed Unicode'],
    ['auto_acknowledgement', 'Ihre Bewerbung', 'Wir haben Ihre\u00a0Bewerbung\u00a0erhalten.', 'no-break spaces'],
    ['auto_acknowledgement', 'Email', 'We confirm the receipt of your email. We have received your application.', 'en receipt of an e-mail is no verification'],
    ['auto_acknowledgement', 'Application', 'We confirm your email was received. We have received your application.', 'a statement about an e-mail is no verification'],
    // What only sounds like a receipt.
    ['other', 'Bewerbung', 'Wir haben Ihre Bewerbung leider nicht erhalten.', 'de receipt denied'],
    ['other', 'Application', 'We never received your application.', 'en receipt denied with never'],
    ['other', 'Candidatura', 'Non abbiamo mai ricevuto la sua candidatura.', 'it receipt denied'],
    ['other', 'Candidature', 'Nous n’avons pas reçu votre candidature.', 'fr receipt denied'],
    ['other', 'Payment', 'We have received your payment.', 'a receipt of something else'],
    ['other', 'Hello', 'Abbiamo ricevuto il tuo messaggio.', 'it receipt of a message'],
    ['other', 'Hello', 'We have received many applications for this role.', 'everyone’s applications'],
    ['other', 'Hello', 'If we have received your application, you will get an e-mail.', 'a receipt that is only conditional'],
    ['other', 'Hello', 'Have you received your application number? We have received your application?', 'a question'],
    // A portal account.
    ['verification', 'Registrierungsbestätigung Stellenportal', 'Vielen Dank für deine Registrierung auf dem Stellenportal.', 'de account notice'],
    ['verification', 'Welcome', 'Your account has been created.', 'en account notice'],
    ['verification', 'Conferma di registrazione', 'Il tuo account è stato creato.', 'it account notice'],
    ['verification', 'Inscription', 'Votre compte a été créé.', 'fr account notice'],
    ['verification', 'Bitte bestätigen Sie Ihre E-Mail', 'Ihr Bestätigungscode lautet 482913', 'de code'],
    ['verification', 'Ihr Konto', 'Bitte klicken Sie auf den Link, um Ihre E-Mail-Adresse zu bestätigen.', 'de request, verb last'],
    ['verification', 'Verify your e-mail address', 'Click the link to continue.', 'en request'],
    ['verification', 'Account verification', 'Click the link to continue.', 'en named in the subject'],
    ['verification', 'Security', 'Use this link to verify: https://careers.employer.example/activate?t=abc', 'en explicit link'],
    ['verification', 'Attivazione', 'Il tuo codice di verifica è 482913.', 'it code'],
    ['verification', 'Attivazione', 'Conferma il tuo indirizzo e-mail per continuare.', 'it request'],
    ['verification', 'Compte', 'Votre code de vérification est 482913.', 'fr code'],
    ['verification', 'Compte', 'Veuillez confirmer votre adresse e-mail.', 'fr request'],
    // Verification words that ask for nothing.
    ['other', 'Hello', 'You do not need to verify your email.', 'en negated request'],
    ['other', 'Hello', 'Non è necessario verificare il tuo account.', 'it negated request'],
    ['auto_acknowledgement', 'Candidatura', 'Abbiamo ricevuto la sua candidatura. Verifica lo stato della candidatura: https://portal.example/stato', 'it status link of the application'],
    // Interviews proposed.
    ['interview_invite', 'Your application', 'We would like to invite you to an interview on 12 October.', 'en invite'],
    ['interview_invite', 'Your application', 'We are pleased to offer you an interview next week.', 'en interview offered, no job offer'],
    ['interview_invite', 'Ihre Bewerbung', 'Wir laden Sie am 12. Oktober zu einem Vorstellungsgespräch ein.', 'de invite across a date'],
    ['interview_invite', 'Ihre Bewerbung', 'Gerne möchten wir Sie zu einem Vorstellungsgespräch einladen.', 'de invite, verb last'],
    ['interview_invite', 'Candidatura', 'La invitiamo a un colloquio il 12 ottobre.', 'it invite'],
    ['interview_invite', 'Candidature', 'Nous vous invitons à un entretien le 12 octobre.', 'fr invite'],
    ['interview_invite', 'Colloquio conoscitivo', '', 'subject alone, nothing to contradict it'],
    // Interviews refused.
    ['rejection', 'Your application', 'Unfortunately we will not invite you to an interview.', 'en refused'],
    ['rejection', 'Your application', 'We are not able to invite you to an interview.', 'en refused from afar, no regret word'],
    ['rejection', 'Your application', 'Unfortunately we won’t be moving forward.', 'en contraction, curly apostrophe'],
    ['rejection', 'Ihre Bewerbung', 'Leider können wir Sie nicht zu einem Vorstellungsgespräch einladen.', 'de refused'],
    ['rejection', 'Ihre Bewerbung', 'Wir werden Sie nicht zu einem Vorstellungsgespräch einladen.', 'de refused, no regret word'],
    ['rejection', 'Ihre Bewerbung', 'Leider findet kein Vorstellungsgespräch statt.', 'de no interview'],
    ['rejection', 'Ihre Bewerbung', 'Leider können wir Ihre Bewerbung nicht berücksichtigen.', 'de not considered'],
    ['rejection', 'Candidatura', 'Purtroppo non la inviteremo a un colloquio.', 'it refused'],
    ['rejection', 'Candidature', 'Malheureusement, nous ne vous inviterons pas à un entretien.', 'fr refused'],
    ['rejection', 'Candidature', 'Nous ne pouvons pas vous proposer d’entretien, malheureusement.', 'fr elided article'],
    ['rejection', 'Votre candidature', 'Malheureusement nous avons retenu un autre candidat.', 'fr another candidate'],
    ['rejection', 'Danke für Ihre Bewerbung', 'Vielen Dank für Ihre Bewerbung. Leider haben wir uns für eine andere Person entschieden.', 'a thank-you before the refusal'],
    ['rejection', 'Your interview', 'Thank you for the interview. Unfortunately your application was not successful.', 'a past interview'],
    // Quoted or cited material of another message.
    ['rejection', 'Bewerbung', 'Leider haben wir uns für eine andere Person entschieden.\n\nAm 3. Mai 2026 schrieb HR <hr@employer.example>:\n> Wir laden Sie zum Vorstellungsgespräch ein.', 'de refusal over a quoted invite'],
    ['interview_invite', 'Application', 'We would like to invite you to an interview on 12 October.\n\n-----Original Message-----\nUnfortunately your earlier application was not successful.', 'en invite over a quoted refusal'],
    ['interview_invite', 'Candidatura', 'La invitiamo a un colloquio il 12 ottobre.\n\nDa: HR <hr@employer.example>\nInviato: lunedì 3 maggio\nOggetto: Esito\nPurtroppo non possiamo proseguire.', 'it invite over a quoted refusal'],
    ['documents_request', 'Candidature', 'Veuillez nous envoyer vos diplômes.\n\nLe 3 mai 2026, HR <hr@employer.example> a écrit :\n> Nous avons bien reçu votre candidature.', 'fr current request over a quoted receipt'],
    ['rejection', 'AW: Einladung zum Vorstellungsgespräch', 'Leider haben wir uns für einen anderen Bewerber entschieden.', 'a reply subject quotes the old message'],
    ['other', 'Re: Your application', '> Your verification code is 482913\n\nThanks, see you soon.', 'a quoted code is not this message'],
    ['other', 'Application', 'Your application for the Zurich role was not successful, but we would like to invite you to an interview for the Lugano role.', 'both outcomes in one message'],
    // Neither an interview nor a refusal.
    ['other', 'Application', 'Unfortunately we need to reschedule your interview.', 'en reschedule'],
    ['other', 'Bewerbung', 'Leider müssen wir das Vorstellungsgespräch verschieben.', 'de reschedule'],
    ['other', 'Hello', 'Our interview process takes three weeks.', 'an interview only named'],
    ['other', 'Your interview', 'Thank you for the interview. We will be in touch.', 'a past interview in subject and body'],
    ['other', 'Hello', 'Al termine del colloquio le daremo un riscontro.', 'it end of an interview'],
    ['other', 'Hello', 'Please do not be late for the interview we scheduled.', 'a negation not about the invitation'],
    ['other', 'Hello', 'Unfortunately we cannot invite all applicants to an interview.', 'boilerplate about everyone'],
    ['other', 'Hello', 'Unfortunately our office is closed on Monday.', 'regret alone'],
    ['other', 'Hello', 'Unfortunately your application is not complete.', 'regret and negation are no refusal'],
    ['other', 'Hello', 'Do not hesitate to contact us.', 'courtesy'],
    // Other purposes.
    ['assessment', 'Next step', 'Please complete the HireVue video interview by Friday.', 'a recorded interview is an assessment'],
    ['other', 'Hello', 'Our process includes an online assessment.', 'an assessment only named'],
    ['documents_request', 'Bewerbung', 'Bitte senden Sie uns Ihre Zeugnisse.', 'documents asked'],
    ['other', 'Bewerbung', 'Bitte senden Sie uns keine Zeugnisse per Post.', 'documents refused'],
    ['offer', 'Your application', 'We are pleased to offer you the position.', 'offer'],
    ['offer', 'Bewerbung', 'Wir freuen uns, Ihnen die Stelle anzubieten.', 'German offer with ordinary punctuation'],
    ['other', 'Bewerbung', 'Wir freuen uns nicht, Ihnen die Stelle anzubieten.', 'negated German offer'],
    ['rejection', 'Bewerbung', 'Leider können wir Ihre Bewerbung nicht weiter berücksichtigen. Wir freuen uns, Ihnen die Stelle anzubieten.', 'rejection vetoes neighboring German offer'],
    ['other', 'Application', 'The role comes with a permanent employment contract.', 'a contract only named'],
    ['other', 'Application', 'Your application for this job offer is being reviewed.', 'the job ad named'],
  ];

  for (const [category, subject, text, label] of table) {
    it(`${label} is ${category}`, () => {
      expect(classifyByRules({ subject, text })).toBe(category);
    });
  }

  it('never makes a receipt out of the Auto-Submitted header alone', () => {
    const automated = { subject: 'Automatic reply', text: 'This mailbox is not monitored.', autoSubmitted: true };
    expect(classifyByRules(automated)).toBe('other');
  });

  it('stays fast on long hostile text', () => {
    const started = Date.now();
    for (const text of ['a'.repeat(20_000), 'not '.repeat(5000), `${'a-'.repeat(10_000)}!`, `${'Bewerbung '.repeat(2000)}.`]) classifyByRules({ subject: 'x', text });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('fallback with the model unavailable, through the real handler', () => {
  it('records a receipt in the employer’s words as a receipt, with no fabricated code', async () => {
    const { store, alias } = await setup();
    const { processed, inbox, classify, sendCascade } = await deliverWithoutModel({ store, alias, raw: plainMail({ subject: 'Ihre Bewerbung', text: 'Hiermit bestätigen wir den Eingang Ihrer Bewerbung.' }) });
    expect(classify).toHaveBeenCalledTimes(1);
    expect(processed).toMatchObject({ ok: true, category: 'auto_acknowledgement', forwarded: 'sent' });
    expect(inbox).toMatchObject({ classifiedBy: 'rules', verificationCode: '', verificationUrl: '' });
    expect(sendCascade).toHaveBeenCalledTimes(1);
  });

  it('does not tell the candidate a refusal is an interview', async () => {
    const { store, alias } = await setup();
    const { processed, sendCascade } = await deliverWithoutModel({ store, alias, raw: plainMail({ subject: 'Ihre Bewerbung', text: 'Leider können wir Sie nicht zu einem Vorstellungsgespräch einladen.' }) });
    expect(processed.category).toBe('rejection');
    expect((sendCascade.mock.calls as any)[0][0][0].payload.subject).toBe('[Entscheid] Ihre Bewerbung');
  });

  it('keeps an automated message without receipt content out of the receipt categories', async () => {
    const { store, alias } = await setup();
    const { processed } = await deliverWithoutModel({ store, alias, raw: plainMail({ subject: 'Automatic reply', text: 'This mailbox is not monitored.', headers: ['Auto-Submitted: auto-generated'] }) });
    expect(processed.category).toBe('other');
    expect(store.read(ORDER_PATH)).toMatchObject({ lastEmployerReplyCategory: 'other' });
    expect(store.read(ORDER_PATH)?.employerResponse).toBeUndefined();
  });

  it('keeps the exact code of a real verification, in the languages it is written in', async () => {
    const cases = [
      ['Bitte bestätigen Sie Ihre E-Mail', 'Ihr Bestätigungscode lautet 482913'],
      ['Verify your email', 'Your verification code is 482913'],
      ['Attivazione', 'Il tuo codice di verifica è 482913.'],
      ['Compte', 'Votre code de vérification est 482913.'],
      ['Sicherheit', 'Ihr Sicherheitscode: 482913'],
    ];
    for (const [subject, text] of cases) {
      const { store, alias } = await setup();
      const { inbox } = await deliverWithoutModel({ store, alias, raw: plainMail({ subject, text }) });
      expect(inbox).toMatchObject({ category: 'verification', classifiedBy: 'rules', verificationCode: '482913' });
    }
  });

  it('never takes a code from the quoted message', async () => {
    const { store, alias } = await setup();
    const { inbox } = await deliverWithoutModel({ store, alias, raw: plainMail({ subject: 'Verify your email', text: 'Click the link to continue.\n\n> Your verification code is 111111' }) });
    expect(inbox).toMatchObject({ category: 'verification', verificationCode: '' });
  });

  describe('the verification link', () => {
    const ask = 'Please verify your email address';

    it('reaches the runner, not the candidate, when it is the only one, requested, https and on the waiting portal', async () => {
      const { store, alias } = await setup('de', 'careers.employer.example');
      const link = 'https://careers.employer.example/activate?t=abc';
      const { inbox, sendCascade } = await deliverWithoutModel({ store, alias, raw: plainMail({ subject: ask, text: `Click here: ${link}`, headers: ['Authentication-Results: mx.cloudflare.net; dkim=pass header.d=employer.example'] }) });
      expect(inbox).toMatchObject({ category: 'verification', verificationUrl: link, forwarded: { status: 'skipped', reason: 'portal_verification' } });
      expect(sendCascade).not.toHaveBeenCalled();
    });

    const refused: Array<[string, string, string]> = [
      ['a foreign host', 'careers.employer.example', 'Click: https://login.other-ats.example/activate?t=abc'],
      ['a look-alike host', 'careers.employer.example', 'Click: https://careers.employer.example.evil.example/activate?t=abc'],
      ['credentials in the link', 'careers.employer.example', 'Click: https://careers.employer.example@evil.example/activate?t=abc'],
      ['no TLS', 'careers.employer.example', 'Click: http://careers.employer.example/activate?t=abc'],
      ['two links', 'careers.employer.example', 'Click: https://careers.employer.example/activate?t=abc or https://careers.employer.example/privacy'],
      ['a second bare link', 'careers.employer.example', 'Click: https://careers.employer.example/activate?t=abc Info: www.evil.example'],
      ['no waiting account', '', 'Click: https://careers.employer.example/activate?t=abc'],
    ];

    for (const [label, accountHost, text] of refused) {
      it(`stays with the candidate with ${label}`, async () => {
        const { store, alias } = await setup('de', accountHost);
        const { inbox, sendCascade } = await deliverWithoutModel({ store, alias, raw: plainMail({ subject: ask, text }) });
        expect(inbox).toMatchObject({ category: 'verification', verificationUrl: '', forwarded: { status: 'sent' } });
        expect((sendCascade.mock.calls as any)[0][0][0].payload.text).toContain(text);
      });
    }

    it('is not picked from a quote, nor from a message that asks for nothing', async () => {
      const quoted = await setup('de', 'careers.employer.example');
      const first = await deliverWithoutModel({ ...quoted, raw: plainMail({ subject: ask, text: 'See the portal.\n\n> https://careers.employer.example/activate?t=old' }) });
      expect(first.inbox).toMatchObject({ verificationUrl: '', forwarded: { status: 'sent' } });

      const receipt = await setup('de', 'careers.employer.example');
      const second = await deliverWithoutModel({ ...receipt, raw: plainMail({ subject: 'Ihre Bewerbung', text: 'Wir haben Ihre Bewerbung erhalten: https://careers.employer.example/status' }) });
      expect(second.inbox).toMatchObject({ category: 'auto_acknowledgement', verificationUrl: '', forwarded: { status: 'sent' } });
    });
  });

  describe('the provider’s answer', () => {
    it('records a refused send as failed, not as forwarded, and keeps the classification', async () => {
      const { store, alias } = await setup();
      const sendCascade = vi.fn(async () => ({ failed: [{ error: 'provider_rejected' }], sent: [] }));
      const { processed, inbox } = await deliverWithoutModel({ store, alias, raw: plainMail({ subject: 'Ihre Bewerbung', text: 'Wir haben Ihre Bewerbung erhalten.' }), sendCascade });
      expect(processed).toMatchObject({ category: 'auto_acknowledgement', forwarded: 'failed' });
      expect(inbox.forwarded).toEqual({ status: 'failed', error: 'provider_rejected' });
    });

    it('puts the message back to received when the provider throws, and counts nothing', async () => {
      const { store, alias } = await setup();
      const sendCascade = vi.fn(async () => { throw new Error('provider_down'); });
      await expect(deliverWithoutModel({ store, alias, raw: plainMail({ subject: 'Ihre Bewerbung', text: 'Wir haben Ihre Bewerbung erhalten.' }), sendCascade })).rejects.toThrow('provider_down');
      const [path] = store.list(`${ORDER_PATH}/inbox/`);
      expect(store.read(path)).toMatchObject({ status: 'received', lastError: 'provider_down' });
      expect(store.read(ORDER_PATH)?.employerReplies).toBeUndefined();
      expect(store.read(ORDER_PATH)?.employerResponse).toBeUndefined();
    });
  });

  describe('what the candidate’s status shows', () => {
    const receipt = plainMail({ subject: 'Ihre Bewerbung', text: 'Hiermit bestätigen wir den Eingang Ihrer Bewerbung.' });
    const invite = plainMail({ subject: 'Ihre Bewerbung', text: 'Wir laden Sie zu einem Vorstellungsgespräch ein.' });
    const refusal = plainMail({ subject: 'Ihre Bewerbung', text: 'Leider haben wir uns für eine andere Person entschieden.' });
    const shown = (store: any) => employerResponseView(employerResponseOf(store.read(ORDER_PATH)));

    it('shows a known receipt, and the prop the page reads carries only what it may show', async () => {
      const { store, alias } = await setup();
      await deliverWithoutModel({ store, alias, raw: receipt, at: 1000 });
      expect(shown(store)).toEqual({ category: 'auto_acknowledgement', receivedAt: 1000, needsReply: false });
    });

    it('never lets a later receipt overwrite an interview or a refusal', async () => {
      for (const [raw, category] of [[invite, 'interview_invite'], [refusal, 'rejection']] as const) {
        const { store, alias } = await setup();
        await deliverWithoutModel({ store, alias, raw, at: 1000 });
        await deliverWithoutModel({ store, alias, raw: receipt, at: 2000 });
        expect(shown(store)).toEqual({ category, receivedAt: 1000, needsReply: false });
        expect(store.read(ORDER_PATH)).toMatchObject({ lastEmployerReplyCategory: 'auto_acknowledgement' });
      }
    });

    it('moves from a receipt to the employer’s answer, and to the newest answer', async () => {
      const { store, alias } = await setup();
      await deliverWithoutModel({ store, alias, raw: receipt, at: 1000 });
      await deliverWithoutModel({ store, alias, raw: invite, at: 2000 });
      expect(shown(store)).toMatchObject({ category: 'interview_invite', receivedAt: 2000 });
      await deliverWithoutModel({ store, alias, raw: refusal, at: 3000 });
      expect(shown(store)).toMatchObject({ category: 'rejection', receivedAt: 3000 });
    });

    it('is not moved by an old message arriving late, by a quote, or by a message it cannot place', async () => {
      const { store, alias } = await setup();
      await deliverWithoutModel({ store, alias, raw: refusal, at: 3000 });
      await deliverWithoutModel({ store, alias, raw: invite, at: 2000 });
      expect(shown(store)).toMatchObject({ category: 'rejection', receivedAt: 3000 });
      const quoted = plainMail({ subject: 'Re: Ihre Bewerbung', text: 'Danke für Ihre Nachricht.\n\n> Wir laden Sie zu einem Vorstellungsgespräch ein.' });
      const { processed } = await deliverWithoutModel({ store, alias, raw: quoted, at: 4000 });
      expect(processed.category).toBe('other');
      expect(shown(store)).toMatchObject({ category: 'rejection', receivedAt: 3000 });
    });
  });
});

describe('attachments left out of the forward', () => {
  const classification = { category: 'other', summaryCandidate: '' };
  const message = { subject: 'Hello', text: 'See attached.' };
  const COPY: Record<string, [string, string, string, string, string]> = {
    it: ['1 allegato non è stato inoltrato', '2 allegati non sono stati inoltrati', 'Non inoltrati:', 'limite complessivo di 10 MB', 'allegato'],
    de: ['1 Anhang wurde nicht weitergeleitet', '2 Anhänge wurden nicht weitergeleitet', 'Nicht weitergeleitet:', 'Gesamtgrenze von 10 MB', 'Anhang'],
    fr: ['1 pièce jointe n’a pas été transférée', '2 pièces jointes n’ont pas été transférées', 'Non transférées :', 'limite totale de 10 Mo', 'pièce jointe'],
    en: ['1 attachment was not forwarded', '2 attachments were not forwarded', 'Not forwarded:', '10 MB total limit', 'attachment'],
  };

  for (const [locale, [one, many, names, limit]] of Object.entries(COPY)) {
    it(`says it clearly in ${locale}, in both versions of the template`, () => {
      const order = { locale, companyName: 'Muster AG', jobTitle: 'Testrolle' };
      const single = buildForward({ order, message, classification, sender: 'hr@employer.example', omittedAttachments: ['Vertrag.pdf'] });
      expect(single.text).toContain(one);
      expect(single.text).toContain(`${names} Vertrag.pdf`);
      expect(single.text).toContain(limit);
      expect(single.html).toContain(one);
      const several = buildForward({ order, message, classification, sender: 'hr@employer.example', omittedAttachments: ['a.pdf', 'b.pdf'] });
      expect(several.text).toContain(many);
      expect(several.html).toContain(`${names} a.pdf, b.pdf`);
    });
  }

  it('says nothing when every attachment was forwarded', () => {
    const forward = buildForward({ order: { locale: 'it' }, message, classification, sender: 'hr@employer.example' });
    expect(forward.text).not.toContain('Attenzione');
    expect(forward.html).not.toContain('Non inoltrati');
  });

  for (const [locale, [, , names, , fallback]] of Object.entries(COPY)) {
    it(`uses a generic safe display for hostile names in ${locale} while preserving Unicode filenames`, () => {
      const omittedAttachments = [
        '../../etc/<img src=x onerror=1>.pdf',
        'https://evil.example/pay.pdf',
        'www.evil.example',
        'hr@evil.example',
        '',
        'a\u202egnp.exe',
        '<img src=x onerror=1>.pdf',
        'Zeugnis Müller.bin',
        'résumé final (v2).pdf',
      ];
      const forward = buildForward({ order: { locale }, message, classification, sender: 'hr@employer.example', omittedAttachments });
      expect(forward.text).toContain(`${names} ${fallback}, ${fallback}, ${fallback}, ${fallback}, ${fallback}, ${fallback}, ${fallback}, Zeugnis Müller.bin, résumé final (v2).pdf`);
      for (const output of [forward.text, forward.html]) {
        expect(output).not.toContain('<img src=x');
        expect(output).not.toContain('onerror=1');
        expect(output).not.toContain('https://evil.example');
        expect(output).not.toContain('pay.pdf');
        expect(output).not.toContain('www.evil.example');
        expect(output).not.toContain('hr@evil.example');
        expect(output).not.toContain('gnp.exe');
        expect(output).not.toContain('\u202e');
      }
    });
  }

  it('keeps the 10 MB cap, forwards what still fits, and names the rest without its bytes or a link', async () => {
    const { store, alias } = await setup();
    // 8bit, as base64 could not bring more than ~9 MiB past the 12 MiB raw limit.
    const part = (disposition: string, content: string) => ['--m', 'Content-Type: application/octet-stream', `Content-Disposition: attachment; ${disposition}`, 'Content-Transfer-Encoding: 8bit', '', content];
    const raw = Buffer.from([
      'Authentication-Results: mx.cloudflare.net; dkim=pass header.d=employer.example',
      'From: Personal <hr@employer.example>',
      'Subject: Unterlagen für Müller',
      'Content-Type: multipart/mixed; boundary="m"',
      '',
      '--m',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('Grüße aus Zürich: anbei die Unterlagen.', 'utf8').toString('base64'),
      ...part('filename="kept.bin"', 'K'.repeat(6 * MIB)),
      ...part("filename*=utf-8''https%3A%2F%2Fevil.example%2Fpay.pdf", `OMITTEDBYTES${'O'.repeat(5 * MIB)}`),
      ...part('filename="small.txt"', 'tiny'),
      '--m--',
      '',
    ].join('\r\n'), 'latin1');
    const { processed, sendCascade } = await deliverWithoutModel({ store, alias, raw });
    expect(processed.forwarded).toBe('sent');
    const { payload } = (sendCascade.mock.calls as any)[0][0][0];
    expect(payload.attachments.map((item: any) => item.filename)).toEqual(['kept.bin', 'small.txt']);
    const forwardedBytes = payload.attachments.reduce((sum: number, item: any) => sum + Buffer.from(item.content, 'base64').length, 0);
    expect(forwardedBytes).toBeLessThanOrEqual(10 * MIB);
    expect(payload.text).toContain('1 Anhang wurde nicht weitergeleitet');
    // This is the causal MIME regression: the oversized hostile URI filename
    // reaches the omission warning, but its attacker-controlled display text
    // does not. The bytes stay omitted as well.
    expect(payload.text).toContain('Nicht weitergeleitet: Anhang');
    expect(payload.text).not.toContain('evil.example');
    expect(payload.html).toContain('Nicht weitergeleitet: Anhang');
    expect(payload.text).toContain('Grüße aus Zürich');
    expect(payload.text).not.toContain('https://');
    expect(JSON.stringify(payload)).not.toContain('OMITTEDBYTES');
    expect(payload.replyTo).toBe('hr@employer.example');
    expect(payload.to).toEqual(['candidate@example.test']);
  });

  it('keeps original MIME attachment bytes and body while preserving hostile MIME filenames', async () => {
    const { store, alias } = await setup('en');
    const part = (disposition: string, content: string) => ['--m', 'Content-Type: application/octet-stream', `Content-Disposition: attachment; ${disposition}`, 'Content-Transfer-Encoding: 8bit', '', content];
    const keptContent = 'K'.repeat(256 * 1024);
    const raw = Buffer.from([
      'Authentication-Results: mx.cloudflare.net; dkim=pass header.d=employer.example',
      'From: Personal <hr@employer.example>',
      'Subject: Supporting documents',
      'Content-Type: multipart/mixed; boundary="m"',
      '',
      '--m',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('The original message body is preserved.', 'utf8').toString('base64'),
      ...part('filename="kept.bin"', keptContent),
      ...part('filename="../private/offer.pdf"', 'x'),
      ...part("filename*=utf-8''https%3A%2F%2Fevil.example%2Fpay.pdf", 'y'),
      ...part("filename*=utf-8''a%E2%80%AEgnp.exe", 'z'),
      ...part('filename="https%3A%2F%2Fevil.example%2Fencoded.pdf"', 'w'),
      ...part("filename*=utf-8''Zeugnis%20M%C3%BCller.bin", 'u'),
      '--m--',
      '',
    ].join('\r\n'), 'latin1');
    const { processed, sendCascade } = await deliverWithoutModel({ store, alias, raw });
    expect(processed.forwarded).toBe('sent');
    const { payload } = (sendCascade.mock.calls as any)[0][0][0];
    expect(payload.attachments.map((item: any) => item.filename)).toEqual([
      'kept.bin',
      '../private/offer.pdf',
      'https://evil.example/pay.pdf',
      'a\u202egnp.exe',
      'https%3A%2F%2Fevil.example%2Fencoded.pdf',
      'Zeugnis Müller.bin',
    ]);
    expect(payload.attachments[0].filename).toBe('kept.bin');
    expect(payload.attachments[0].contentType).toBe('application/octet-stream');
    expect(Buffer.from(payload.attachments[0].content, 'base64')).toEqual(Buffer.from(keptContent, 'ascii'));
    expect(payload.attachments[5].filename).toBe('Zeugnis Müller.bin');
    expect(Buffer.from(payload.attachments[5].content, 'base64')).toEqual(Buffer.from('u', 'ascii'));
    expect(payload.text).toContain('The original message body is preserved.');
    for (const leaked of ['private/offer.pdf', 'evil.example', 'pay.pdf', 'gnp.exe', 'encoded.pdf', '\u202e']) {
      expect(payload.text).not.toContain(leaked);
    }
  });
});

// Regression cases from the independent review: ambiguous text remains other.
const ACK = 'auto_acknowledgement';
const rows: Array<[string, string[], string, string]> = [
  // A. boilerplate read as a refusal
  ['boiler-en-incomplete', [ACK], 'Application', 'We have received your application. Incomplete applications will not be considered.'],
  ['boiler-en-notshortlisted', [ACK], 'Application', 'We have received your application. Candidates not shortlisted will not be contacted.'],
  ['boiler-en-notselected', ['other'], 'Application', 'Applicants who are not selected will be informed by e-mail.'],
  ['boiler-en-unsolicited', ['other'], 'Hello', 'Please note that we do not consider applications from agencies.'],
  ['boiler-de-incomplete', [ACK], 'Bewerbung', 'Wir haben Ihre Bewerbung erhalten. Unvollständige Bewerbungen können nicht berücksichtigt werden.'],
  ['boiler-fr-incomplete', [ACK], 'Candidature', 'Nous avons bien reçu votre candidature. Les dossiers incomplets ne seront pas retenus.'],
  ['boiler-it-incomplete', [ACK], 'Candidatura', 'Abbiamo ricevuto la sua candidatura. Non possiamo dare seguito alle candidature incomplete.'],
  // B. a negation that does not refuse
  ['until-en', ['other', 'documents_request'], 'Application', 'We will not schedule an interview until we receive your references.'],
  ['until-de', ['other', 'documents_request'], 'Bewerbung', 'Wir werden Sie nicht zu einem Vorstellungsgespräch einladen, bevor wir Ihre Zeugnisse haben.'],
  ['until-it', ['other', 'documents_request'], 'Candidatura', 'Non la inviteremo a un colloquio prima di aver ricevuto i documenti.'],
  ['until-fr', ['other', 'documents_request'], 'Candidature', 'Nous ne pouvons pas vous proposer d’entretien avant d’avoir reçu vos diplômes.'],
  ['idiom-en-cant-wait', ['interview_invite', 'other'], 'Application', 'We can’t wait to invite you to an interview.'],
  ['idiom-en-not-only', ['interview_invite', 'other'], 'Application', 'Not only do we want to invite you to an interview, we also liked your profile.'],
  ['idiom-it-non-vediamo', ['interview_invite', 'other'], 'Candidatura', 'Non vediamo l’ora di invitarla a un colloquio.'],
  ['idiom-it-non-mancheremo', ['interview_invite', 'other'], 'Candidatura', 'Non mancheremo di invitarla a un colloquio.'],
  ['idiom-fr-ne-manquerons', ['interview_invite', 'other'], 'Candidature', 'Nous ne manquerons pas de vous inviter à un entretien.'],
  ['negated-refusal-en', ['other'], 'Application', 'Your application has not been rejected.'],
  ['negated-refusal-de', ['other'], 'Bewerbung', 'Ihre Bewerbung wurde nicht abgelehnt, sie ist noch in Prüfung.'],
  // C. a conditional or general statement read as an invitation
  ['cond-en-selected', ['other'], 'Application', 'Selected applicants will be invited to an interview.'],
  ['cond-en-successful', ['other'], 'Application', 'Successful candidates will be invited to interview.'],
  ['cond-en-shortlisted', [ACK], 'Application', 'We have received your application. Shortlisted applicants will be contacted to arrange an interview.'],
  ['cond-en-may', [ACK], 'Application', 'We have received your application. We may invite you to an interview.'],
  ['cond-en-general', ['other'], 'Hello', 'Interviews are usually scheduled within two weeks.'],
  ['cond-de-profil', [ACK], 'Bewerbung', 'Wir haben Ihre Bewerbung erhalten. Bei passendem Profil laden wir Sie zu einem Vorstellungsgespräch ein.'],
  ['cond-de-ggf', [ACK], 'Bewerbung', 'Wir haben Ihre Bewerbung erhalten. Gegebenenfalls laden wir Sie zu einem Vorstellungsgespräch ein.'],
  ['cond-it-idonei', [ACK], 'Candidatura', 'Abbiamo ricevuto la sua candidatura. I candidati idonei saranno invitati a un colloquio.'],
  ['cond-it-potremmo', [ACK], 'Candidatura', 'Abbiamo ricevuto la sua candidatura. Potremmo invitarla a un colloquio.'],
  ['cond-fr-pourrions', [ACK], 'Candidature', 'Nous avons bien reçu votre candidature. Nous pourrions vous inviter à un entretien.'],
  ['homonym-fr-entretien', ['other'], 'Candidature', 'Nous vous invitons à compléter votre dossier pour le poste d’agent d’entretien.'],
  // D. the account-verification reading of a receipt or of an interview request
  ['bestaetig-mit-dieser-email', [ACK], 'Ihre Bewerbung', 'Mit dieser E-Mail bestätigen wir den Eingang Ihrer Bewerbung.'],
  ['bestaetig-per-email', [ACK], 'Ihre Bewerbung', 'Den Eingang Ihrer Bewerbung per E-Mail bestätigen wir hiermit gerne.'],
  ['bestaetig-erhalt', ['other', ACK], 'Ihre Bewerbung', 'Hiermit bestätigen wir den Erhalt Ihrer Bewerbung.'],
  ['confirm-by-email-en', ['interview_invite', 'other'], 'Application', 'We invite you to an interview on 12 October. Please confirm by email.'],
  ['confirm-by-email-de', ['interview_invite', 'other'], 'Bewerbung', 'Wir laden Sie zu einem Vorstellungsgespräch ein. Bitte bestätigen Sie uns per E-Mail.'],
  ['confirm-by-email-it', ['interview_invite', 'other'], 'Candidatura', 'La invitiamo a un colloquio. La preghiamo di confermare via e-mail.'],
  ['confirm-by-email-fr', ['interview_invite', 'other'], 'Candidature', 'Nous vous invitons à un entretien. Veuillez confirmer par e-mail.'],
  ['we-hereby-confirm-en', [ACK, 'other'], 'Application', 'We hereby confirm your email was received. We have received your application.'],
  ['warning-names-code', [ACK], 'Application', 'We have received your application. Never share your verification code with anyone.'],
  ['verifica-it-check', ['interview_invite', 'other'], 'Candidatura', 'Verifica i dettagli del colloquio qui: https://careers.employer.example/slot/7'],
  ['verify-en-check', ['interview_invite', 'other'], 'Application', 'Please verify the time of the meeting here: https://careers.employer.example/slot/7'],
  // E. real verification that must stay operational
  ['real-negated-en', ['verification'], 'Welcome', 'You will not be able to sign in until you confirm your email address.'],
  ['real-negated-de', ['verification', 'other'], 'Willkommen', 'Sie können sich erst anmelden, wenn Sie Ihre E-Mail-Adresse bestätigen, nicht vorher.'],
  ['real-negated-it', ['verification', 'other'], 'Benvenuto', 'Non potrai accedere finché non confermi il tuo indirizzo e-mail.'],
  ['real-negated-fr', ['verification', 'other'], 'Bienvenue', 'Vous ne pourrez pas vous connecter tant que vous n’aurez pas confirmé votre adresse e-mail.'],
  // F. an offer that is not one
  ['zusage-absage', ['other'], 'Bewerbung', 'Eine Zusage oder Absage erhalten Sie in zwei Wochen.'],
  ['zusage-termin', ['other'], 'Bewerbung', 'Bitte geben Sie uns bis Freitag Ihre Zusage.'],
  // G. quoted mail
  ['quote-gmx', ['rejection'], 'Bewerbung', 'Leider haben wir uns für eine andere Person entschieden.\n\n-------- Original-Nachricht --------\nBetreff: Einladung\nDatum: 3.5.2026\n\nWir laden Sie zu einem Vorstellungsgespräch ein.'],
  ['quote-begin-forwarded', ['rejection'], 'Bewerbung', 'Leider haben wir uns für eine andere Person entschieden.\n\nBegin forwarded message:\n\nWir laden Sie zu einem Vorstellungsgespräch ein.'],
  ['quote-ack-over-invite', [ACK], 'Bewerbung', 'Wir haben Ihre Bewerbung erhalten.\n\n-------- Original-Nachricht --------\nWir laden Sie zu einem Vorstellungsgespräch ein.'],
];


describe('mail purpose regressions', () => {
  for (const [id, allowed, subject, text] of rows) it(id, () => {
    expect(allowed).toContain(classifyByRules({ subject, text }));
  });
});

const swallow: Array<[string, string, string, string]> = [
  ['swallow-receipt-warning', 'careers.employer.example', 'Application', 'We have received your application. Never share your verification code with anyone. Status: https://careers.employer.example/status'],
  ['swallow-it-interview', 'careers.employer.example', 'Candidatura', 'Verifica i dettagli del colloquio qui: https://careers.employer.example/slot/7'],
  ['swallow-en-meeting', 'careers.employer.example', 'Application', 'Please verify the time of the meeting here: https://careers.employer.example/slot/7'],
  ['swallow-suffix-sibling', 'careers.foo.co.uk', 'Verify your email', 'Please verify your email address: https://evil.co.uk/phish'],
  ['swallow-tenant-sibling', 'victim.wd3.myworkdayjobs.com', 'Verify your email', 'Please verify your email address: https://attacker.wd1.myworkdayjobs.com/x'],
  ['swallow-family-sibling', 'victim.wd3.myworkdayjobs.com', 'Verify your email', 'Please verify your email address: https://attacker.myworkday.com/x'],
  ['swallow-truncated-link', 'careers.employer.example', 'Verify your email', `Please verify your email address: https://careers.employer.example/a?t=${'x'.repeat(2100)}`],
];

describe('verification is not a reason to hide unrelated employer mail', () => {
  for (const [id, host, subject, text] of swallow) for (const authenticated of [false, true]) {
    it(`${id}, authenticated=${authenticated}`, async () => {
      const { store, alias } = await setup('it', host);
      const headers = authenticated ? ['Authentication-Results: mx.cloudflare.net; dkim=pass header.d=employer.example'] : [];
      const { inbox, sendCascade } = await deliverWithoutModel({ store, alias, raw: plainMail({ subject, text, headers }) });
      expect(sendCascade).toHaveBeenCalledTimes(1);
      expect(inbox.portalVerificationHost).toBe('');
      expect(inbox.forwarded.status).toBe('sent');
      expect((sendCascade.mock.calls as any)[0][0][0].payload.text).toContain(text);
    });
  }

  it('forwards a directly negated verification instruction even when it says before', async () => {
    const host = 'portal.example';
    const text = `Do not verify your account before Monday: https://${host}/verify/123`;
    expect(classifyByRules({ subject: '', text })).toBe('other');
    const { store, alias } = await setup('it', host);
    const { inbox, sendCascade } = await deliverWithoutModel({
      store,
      alias,
      raw: plainMail({
        subject: 'Security',
        text,
        headers: ['Authentication-Results: mx.cloudflare.net; dkim=pass header.d=employer.example'],
      }),
    });
    expect(inbox).toMatchObject({ category: 'other', verificationUrl: '', portalVerificationHost: '', forwarded: { status: 'sent' } });
    expect(sendCascade).toHaveBeenCalledTimes(1);
  });

  it('never shortens a model-proposed link into a different verification token', async () => {
    const { store, alias } = await setup('it', 'careers.employer.example');
    const text = `Please verify your email: https://careers.employer.example/v?token=${'x'.repeat(2100)}`;
    const bucket = fakeBucket();
    const accepted = await handleAssistedApplicationInbound(request(plainMail({ subject: 'Verify your email', text, headers: ['Authentication-Results: mx.cloudflare.net; dkim=pass header.d=employer.example'] }), alias.address), { db: store.db, bucket, secret: SECRET, runKey: RUN_KEY, nowMs: 1000 });
    const sendCascade = vi.fn(async () => ({ failed: [], sent: [{ provider: 'stub' }] }));
    await processAssistedApplicationInbound({ db: store.db, bucket, orderId: ORDER, messageId: accepted.body.accepted, runKey: RUN_KEY, nowMs: 1000, sendCascade, classify: async () => ({ category: 'verification', verificationUrl: text.slice(text.indexOf('https:')) }) });
    expect(store.read(`${ORDER_PATH}/inbox/${accepted.body.accepted}`)).toMatchObject({ verificationUrl: '', portalVerificationHost: '', forwarded: { status: 'sent' } });
  });
});

describe('inbound-to-runner account binding', () => {
  async function wait(store: any, host: string) {
    let now = 1000;
    const accounts = portalAccountStore({ db: store.db, orderId: ORDER, key: Buffer.from(RUN_KEY, 'base64'), nowMs: () => now, sleep: async (ms: number) => { now += ms; } });
    return accounts.waitForVerification({ host, sinceMs: 0, timeoutMs: 100 });
  }
  it('hands the exact authenticated URL emitted by inbound to that account only', async () => {
    const host = 'careers.employer.example';
    const { store, alias } = await setup('it', host);
    const link = `https://${host}/verify?t=a%2Fb.!`;
    const { inbox } = await deliverWithoutModel({ store, alias, raw: plainMail({ subject: 'Verify your email', text: `Please verify your email: ${link}`, headers: ['Authentication-Results: mx.cloudflare.net; dkim=pass header.d=employer.example'] }) });
    expect(inbox).toMatchObject({ verificationUrl: link, portalVerificationHost: host });
    expect(await wait(store, host)).toMatchObject({ url: link });
    expect(await wait(store, 'other.employer.example')).toBeNull();
  });
  it('forwards an exact-host verification when canonical and legacy records make the account ambiguous', async () => {
    const host = 'careers.employer.example';
    const { store, alias } = await setup('it', host);
    await store.db.collection('assisted_applications').doc(ORDER).collection('automation').doc('accounts')
      .set({ [hostKey(host)]: { host, passwordEnc: { v: 1 }, verifiedAt: null } }, { merge: true });
    const link = `https://${host}/verify?t=duplicate`;
    const { inbox, sendCascade } = await deliverWithoutModel({
      store,
      alias,
      raw: plainMail({
        subject: 'Verify your email',
        text: `Please verify your email: ${link}`,
        headers: ['Authentication-Results: mx.cloudflare.net; dkim=pass header.d=employer.example'],
      }),
    });
    expect(inbox).toMatchObject({ verificationUrl: '', portalVerificationHost: '', forwarded: { status: 'sent' } });
    expect(sendCascade).toHaveBeenCalledTimes(1);
    expect(await wait(store, host)).toBeNull();
  });
  it('does not consume a legacy unverified link or unrelated code', async () => {
    const { store } = await setup();
    await store.db.collection('assisted_applications').doc(ORDER).collection('inbox').doc('legacy').set({ receivedAt: 1000, category: 'verification', verificationUrl: 'https://careers.employer.example/verify', verificationCode: '111111' });
    expect(await wait(store, 'careers.employer.example')).toBeNull();
  });
  it('does not assign a token to a different Workday tenant even with a forged binding', async () => {
    const host = 'victim.wd3.myworkdayjobs.com';
    const { store } = await setup();
    await store.db.collection('assisted_applications').doc(ORDER).collection('inbox').doc('foreign').set({ receivedAt: 1000, category: 'verification', portalVerificationHost: host, verificationUrl: 'https://attacker.wd1.myworkdayjobs.com/verify', verificationCode: '' });
    expect(await wait(store, host)).toBeNull();
  });
});

describe('verification code provenance', () => {
  it('binds a current authenticated code only to the exact sender/account host', async () => {
    const { store, alias } = await setup('it', 'employer.example');
    const { inbox, sendCascade } = await deliverWithoutModel({ store, alias, raw: plainMail({ subject: 'Verify your email', text: 'Your verification code is 482913', headers: ['Authentication-Results: mx.cloudflare.net; dkim=pass header.d=employer.example'] }) });
    expect(inbox).toMatchObject({ verificationCode: '482913', portalVerificationHost: 'employer.example', forwarded: { status: 'skipped' } });
    expect(sendCascade).not.toHaveBeenCalled();
  });
  it('never lets model output consume a code found only in quoted history', async () => {
    const { store, alias } = await setup('it', 'employer.example');
    const text = 'Click here to verify.\n\n> Your verification code is 111111';
    const bucket = fakeBucket();
    const accepted = await handleAssistedApplicationInbound(request(plainMail({ subject: 'Verify your email', text, headers: ['Authentication-Results: mx.cloudflare.net; dkim=pass header.d=employer.example'] }), alias.address), { db: store.db, bucket, secret: SECRET, runKey: RUN_KEY, nowMs: 1000 });
    const sendCascade = vi.fn(async () => ({ failed: [], sent: [{ provider: 'stub' }] }));
    await processAssistedApplicationInbound({ db: store.db, bucket, orderId: ORDER, messageId: accepted.body.accepted, runKey: RUN_KEY, nowMs: 1000, sendCascade, classify: async () => ({ category: 'verification', verificationCode: '111111' }) });
    expect(store.read(`${ORDER_PATH}/inbox/${accepted.body.accepted}`)).toMatchObject({ portalVerificationHost: '', forwarded: { status: 'sent' } });
    expect(sendCascade).toHaveBeenCalledTimes(1);
  });
});

describe('verification tokens stay in the native sender text', () => {
  const auth = ['Authentication-Results: mx.cloudflare.net; dkim=pass header.d=employer.example'];
  for (const mark of ['\u00ad', '\u200b', '\u200d', '\u00a0']) for (const model of [false, true]) {
    it(`does not delete ${mark.codePointAt(0)} from a URL, model=${model}`, async () => {
      const host = 'careers.employer.example';
      const { store, alias } = await setup('it', host);
      const url = `https://${host}/verify?token=a${mark}b`;
      const raw = plainMail({ subject: 'Verify your email', text: `Please verify your email: ${url}`, headers: auth });
      if (!model) {
        const { inbox, sendCascade } = await deliverWithoutModel({ store, alias, raw });
        expect(inbox).toMatchObject({ verificationUrl: '', portalVerificationHost: '', forwarded: { status: 'sent' } });
        expect(sendCascade).toHaveBeenCalledTimes(1);
      } else {
        const bucket = fakeBucket();
        const accepted = await handleAssistedApplicationInbound(request(raw, alias.address), { db: store.db, bucket, secret: SECRET, runKey: RUN_KEY, nowMs: 1000 });
        const sendCascade = vi.fn(async () => ({ failed: [], sent: [{ provider: 'stub' }] }));
        await processAssistedApplicationInbound({ db: store.db, bucket, orderId: ORDER, messageId: accepted.body.accepted, runKey: RUN_KEY, nowMs: 1000, sendCascade, classify: async () => ({ category: 'verification', verificationUrl: url.replace(mark, '') }) });
        expect(store.read(`${ORDER_PATH}/inbox/${accepted.body.accepted}`)).toMatchObject({ verificationUrl: '', portalVerificationHost: '', forwarded: { status: 'sent' } });
        expect(sendCascade).toHaveBeenCalledTimes(1);
      }
    });
  }
  for (const mark of ['\u00ad', '\u200b', '\u200d']) for (const model of [false, true]) {
    it(`does not join or truncate code digits around ${mark.codePointAt(0)}, model=${model}`, async () => {
      const { store, alias } = await setup('it', 'employer.example');
      const raw = plainMail({ subject: 'Verify your email', text: `Your verification code is 1234${mark}5678`, headers: auth });
      if (!model) {
        const { inbox, sendCascade } = await deliverWithoutModel({ store, alias, raw });
        expect(inbox).toMatchObject({ verificationCode: '', portalVerificationHost: '', forwarded: { status: 'sent' } });
        expect(sendCascade).toHaveBeenCalledTimes(1);
      } else {
        const bucket = fakeBucket();
        const accepted = await handleAssistedApplicationInbound(request(raw, alias.address), { db: store.db, bucket, secret: SECRET, runKey: RUN_KEY, nowMs: 1000 });
        const sendCascade = vi.fn(async () => ({ failed: [], sent: [{ provider: 'stub' }] }));
        await processAssistedApplicationInbound({ db: store.db, bucket, orderId: ORDER, messageId: accepted.body.accepted, runKey: RUN_KEY, nowMs: 1000, sendCascade, classify: async () => ({ category: 'verification', verificationCode: '1234' }) });
        expect(store.read(`${ORDER_PATH}/inbox/${accepted.body.accepted}`)).toMatchObject({ verificationCode: '', portalVerificationHost: '', forwarded: { status: 'sent' } });
        expect(sendCascade).toHaveBeenCalledTimes(1);
      }
    });
  }
});
