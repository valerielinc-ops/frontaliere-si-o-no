import { describe, expect, it, vi } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({
  getRemoteConfigValue: vi.fn(async () => ''),
  bridgeEmailCascadeCredentialsToEnv: vi.fn(async () => {}),
}));

// The inbound path does not exercise packet generation; keep its test isolated from the unrelated PDF implementation.
vi.mock('../functions/src/assistedApplicationPostalPacket.js', () => ({
  postalPacketReadiness: vi.fn(async () => null),
}));

const { ensureOrderAlias } = await import('../functions/src/assistedApplicationAlias.js');
const { handleAssistedApplicationInbound, portalAccountNoticeKind, processAssistedApplicationInbound } = await import('../functions/src/assistedApplicationInbound.js');
const { portalAccountForNotice } = await import('../functions/src/assistedApplicationPortalSites.js');
const { decodeHtmlEntities, parseMimeMessage } = await import('../functions/src/lib/mimeMessage.js');

// A portal's own account mail (the federal SuccessFactors tenant, 2026-11-10:
// «Ihr Bewerbungskonto wurde erfolgreich erstellt», a sign-in link on the
// account's exact host) is the runner's, not news for the candidate.
const ORDER = 'order_ACCOUNTNOTICE1';
const ORDER_PATH = `assisted_applications/${ORDER}`;
const RUN_KEY = Buffer.alloc(32, 7).toString('base64');
const SECRET = 'worker-secret';
const HOST = 'career74.sapsf.eu';
const LINK = `https://${HOST}/career?career_company=examplefed&lang=de_DE&company=examplefed&site=&loginFlowRequired=true&_s.crb=synthetic`;
const CREATED = `Guten Tag\n\nVielen Dank für Ihr Interesse an einer Stelle beim Bund. Ihr Bewerbungskonto wurde erfolgreich erstellt. Hier ${LINK} können Sie Bewerbungen erfassen und jeweils den aktuellen Stand einsehen.\n\nWir freuen uns auf Ihre Bewerbungsunterlagen.\n\nFreundliche Grüsse\n\nBundesverwaltung\n\nDies ist eine automatisch generierte E-Mail, bitte antworten Sie nicht darauf.`;
const CITY_PORTAL_WELCOME = `Guten Tag Test Person

 Willkommen beim Stellenportal der Stadt M&uuml;sterstadt.

 Sie k&ouml;nnen sich jederzeit in unser Stellenportal einloggen, um Ihr Profil zu erg&auml;nzen oder sich auf offene Stellen zu bewerben.

 Ihr Benutzername entspricht Ihrer E-Mail-Adresse und lautet: candidate@example.test.
Das Kennwort haben Sie sich bei der Registrierung selbst gesetzt. Sollten Sie das Kennwort neu setzen wollen oder Ihr Kennwort vergessen haben, klicken Sie im Portal auf &laquo;Haben Sie Ihr Kennwort vergessen?&raquo;.

 Freundliche Gr&uuml;sse

 Stadt M&uuml;sterstadt

 Dies ist eine automatisch generierte Nachricht, bitte antworten Sie nicht an diese E-Mail-Adresse.`;

const cf = () => {
  const rules = new Map<string, string>();
  return {
    async createRule(address: string) { const id = `rule-${rules.size + 1}`; rules.set(id, address); return id; },
    async deleteRule(id: string) { rules.delete(id); },
  };
};

function fakeBucket() {
  const files = new Map<string, string>();
  return {
    file: (key: string) => ({
      async save(content: string) { files.set(key, String(content)); },
      async getMetadata() { return [{ generation: '1' }]; },
      async delete() { files.delete(key); },
      async download() { return [Buffer.from(files.get(key) || '')]; },
    }),
  };
}

async function setup(accounts: Record<string, unknown> | null = { portal: { host: HOST, passwordEnc: { v: 1 }, verifiedAt: null, status: 'created', createdAt: 500 } }) {
  const store = createMemoryFirestore({
    [ORDER_PATH]: { paymentStatus: 'paid', cvUploadedAt: 1, cvStorageKey: `assisted-application-uploads/${ORDER}/cv.pdf`, locale: 'de', companyName: 'Muster AG', jobTitle: 'Testrolle', applicantEmail: 'candidate@example.test' },
  });
  const alias = await ensureOrderAlias({ db: store.db, orderId: ORDER, cf: cf() });
  if (accounts) await store.db.collection('assisted_applications').doc(ORDER).collection('automation').doc('accounts').set(accounts);
  return { store, alias };
}

const mail = ({ subject = 'Ihr Bewerbungskonto bei stelle.admin.ch', text = CREATED, contentType = 'text/plain; charset=utf-8', from = 'Bundesverwaltung <job@stelle.admin.ch>', dkim = 'stelle.admin.ch' } = {}) => Buffer.from([
  `From: ${from}`,
  ...(dkim ? [`Authentication-Results: mx.cloudflare.net; dkim=pass header.d=${dkim}`] : []),
  `Subject: =?utf-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`,
  `Content-Type: ${contentType}`,
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from(text, 'utf8').toString('base64'),
  '',
].join('\r\n'), 'latin1');

const request = (raw: Buffer, to: string) => ({
  method: 'POST',
  rawBody: raw,
  get: (name: string) => ({ 'x-stop-secret': SECRET, 'x-envelope-to': to } as Record<string, string>)[name],
});

async function deliver({ store, alias, raw, answer = null as any, at = 1000 }: any) {
  const bucket = fakeBucket();
  const sendCascade = vi.fn(async () => ({ failed: [], sent: [{ provider: 'maileroo' }] }));
  const accepted = await handleAssistedApplicationInbound(request(raw, alias.address), { db: store.db, bucket, secret: SECRET, runKey: RUN_KEY, nowMs: at });
  const classify = answer ? vi.fn(async () => answer) : vi.fn(async () => { throw new Error('codex_unavailable'); });
  const messageId = accepted.body.accepted;
  const processed = await processAssistedApplicationInbound({ db: store.db, bucket, orderId: ORDER, messageId, runKey: RUN_KEY, classify, sendCascade, nowMs: at });
  return { processed, inbox: store.read(`${ORDER_PATH}/inbox/${messageId}`)!, sendCascade };
}

const modelAnswer = (overrides: Record<string, unknown> = {}) => ({
  category: 'verification', summaryIt: 'Il tuo account di candidatura è stato creato.', summaryCandidate: 'Account creato.',
  interviewWhen: '', requestedDocuments: [], verificationCode: '', verificationUrl: LINK, needsReply: false, ...overrides,
});

describe('a portal account notice for the order’s own account', () => {
  it.each([['the model', modelAnswer()], ['the rules', null]])('is recorded for the runner and kept from the candidate (%s)', async (_by, answer) => {
    const { store, alias } = await setup();
    const { processed, inbox, sendCascade } = await deliver({ store, alias, raw: mail(), answer });
    expect(inbox).toMatchObject({
      category: 'verification', portalVerificationHost: '', portalAccountNoticeHost: HOST, portalAccountNotice: 'created',
      forwarded: { status: 'skipped', reason: 'portal_account_notice' },
    });
    expect(processed.forwarded).toBe('skipped');
    expect(sendCascade).not.toHaveBeenCalled();
  });

  it('is kept from the candidate for an account that is already verified', async () => {
    const { store, alias } = await setup({ portal: { host: HOST, passwordEnc: { v: 1 }, verifiedAt: 900, status: 'created', createdAt: 500 } });
    const { inbox, sendCascade } = await deliver({ store, alias, raw: mail(), answer: modelAnswer() });
    expect(inbox).toMatchObject({ portalAccountNoticeHost: HOST, forwarded: { status: 'skipped', reason: 'portal_account_notice' } });
    expect(sendCascade).not.toHaveBeenCalled();
  });

  it.each([
    ['activated', 'Ihr Bewerbungskonto wurde erfolgreich aktiviert. Sie können sich jetzt anmelden.'],
    ['password_changed', 'Ihr Passwort wurde erfolgreich geändert.'],
    ['created', 'Your account has been successfully created. You can now sign in.'],
  ])('names the %s notice', async (kind, text) => {
    const { store, alias } = await setup();
    const { inbox, sendCascade } = await deliver({ store, alias, raw: mail({ subject: 'Konto', text }), answer: modelAnswer({ verificationUrl: '' }) });
    expect(inbox).toMatchObject({ portalAccountNoticeHost: HOST, portalAccountNotice: kind, forwarded: { status: 'skipped', reason: 'portal_account_notice' } });
    expect(sendCascade).not.toHaveBeenCalled();
  });

  it('decodes the delayed German portal welcome and keeps it visible without forwarding it', async () => {
    const { store, alias } = await setup();
    const { processed, inbox, sendCascade } = await deliver({
      store,
      alias,
      raw: mail({ subject: 'Willkommen beim Stellenportal', text: CITY_PORTAL_WELCOME }),
      answer: modelAnswer({ verificationUrl: '', needsReply: true, summaryCandidate: 'Accedi al portale.' }),
    });

    expect(processed).toMatchObject({ category: 'verification', forwarded: 'skipped' });
    expect(inbox).toMatchObject({
      status: 'processed', classifiedBy: 'codex', category: 'verification',
      verificationCode: '', verificationUrl: '', needsReply: false, summaryCandidate: '',
      correlationStatus: 'unknown', portalAccountNotice: 'created', portalAccountNoticeHost: HOST,
      forwarded: { status: 'skipped', reason: 'portal_account_notice' },
    });
    expect(sendCascade).not.toHaveBeenCalled();
  });

  it('does not treat a password-reset link in a welcome as account verification', async () => {
    const { store, alias } = await setup();
    const resetLink = `https://${HOST}/career/forgot-password`;
    const text = `${CITY_PORTAL_WELCOME}\n\nPasswort vergessen? ${resetLink}`;
    const { inbox, sendCascade } = await deliver({
      store,
      alias,
      raw: mail({ subject: 'Willkommen', text }),
      answer: modelAnswer({ verificationUrl: resetLink, needsReply: true }),
    });

    expect(inbox).toMatchObject({
      category: 'verification', verificationCode: '', verificationUrl: '', needsReply: false, summaryCandidate: '',
      portalAccountNotice: 'created', correlationStatus: 'unknown',
      forwarded: { status: 'skipped', reason: 'portal_account_notice' },
    });
    expect(sendCascade).not.toHaveBeenCalled();
  });

  it.each([
    ['Italian', 'Benvenuta nel portale delle candidature. Il tuo nome utente è candidate@example.test.'],
    ['French', "Bienvenue sur notre portail carrières. Votre nom d'utilisateur correspond à candidate@example.test."],
    ['English', 'Welcome to our city recruiting portal. Your username is candidate@example.test.'],
  ])('recognizes a %s welcome notice and never forwards it', async (_language, text) => {
    const { store, alias } = await setup();
    const answer = modelAnswer({ verificationUrl: '' });
    expect(portalAccountNoticeKind({ subject: 'Portal account', text }, answer)).toBe('created');

    const { inbox, sendCascade } = await deliver({ store, alias, raw: mail({ subject: 'Portal account', text }), answer });
    expect(inbox).toMatchObject({ portalAccountNotice: 'created', correlationStatus: 'unknown', forwarded: { status: 'skipped', reason: 'portal_account_notice' } });
    expect(sendCascade).not.toHaveBeenCalled();
  });

  it.each([
    ['named umlaut', 'ge&auml;ndert'],
    ['decimal numeric umlaut', 'ge&#228;ndert'],
    ['hexadecimal numeric umlaut', 'ge&#xE4;ndert'],
  ])('decodes %s in the shared rule input', (_form, word) => {
    expect(portalAccountNoticeKind({ subject: 'Konto', text: `Ihr Passwort wurde ${word}.` }, modelAnswer({ verificationUrl: '' }))).toBe('password_changed');
  });

  it('decodes one layer of named and numeric entities and leaves unknown entities intact', () => {
    expect(decodeHtmlEntities('&uuml; &ouml; &auml; &laquo; &raquo; &nbsp; &amp; &#228; &#xE4; &unknown; &amp;uuml; ?copy=1&notin=2'))
      .toBe('ü ö ä « »   & ä ä &unknown; &uuml; ?copy=1&notin=2');
  });

  it('keeps the parsed source text while exposing a once-decoded MIME rule input', () => {
    const parsed = parseMimeMessage(mail({ subject: 'Konto', text: 'Ihr Passwort wurde ge&auml;ndert.' }));
    expect(parsed.text).toBe('Ihr Passwort wurde ge&auml;ndert.');
    expect(parsed.ruleText).toBe('Ihr Passwort wurde geändert.');
  });

  it('keeps a recognized account notice from being forwarded for a withdrawn order', async () => {
    const { store, alias } = await setup();
    await store.db.collection('assisted_applications').doc(ORDER).set({ submissionStatus: 'withdrawn' }, { merge: true });
    const { inbox, sendCascade } = await deliver({ store, alias, raw: mail(), answer: modelAnswer({ verificationUrl: '' }) });

    expect(inbox).toMatchObject({ portalAccountNotice: 'created', forwarded: { status: 'skipped', reason: 'portal_account_notice' } });
    expect(sendCascade).not.toHaveBeenCalled();
  });
});

describe('what still reaches the candidate', () => {
  it('without a portal account of the order', async () => {
    const { store, alias } = await setup(null);
    const { inbox, sendCascade } = await deliver({ store, alias, raw: mail(), answer: modelAnswer() });
    expect(inbox.portalAccountNoticeHost).toBeUndefined();
    expect(inbox.forwarded).toMatchObject({ status: 'sent' });
    expect(sendCascade).toHaveBeenCalledTimes(1);
  });

  it('from a sender whose mail is not authenticated', async () => {
    const { store, alias } = await setup();
    const { inbox, sendCascade } = await deliver({ store, alias, raw: mail({ dkim: '' }), answer: modelAnswer() });
    expect(inbox.portalAccountNoticeHost).toBeUndefined();
    expect(sendCascade).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an interview invitation', `${CREATED}\n\nGerne laden wir Sie zu einem Vorstellungsgespräch am 12. Dezember ein.`, { interviewWhen: '12. Dezember' }],
    ['a refusal', `${CREATED}\n\nLeider müssen wir Ihnen mitteilen, dass wir Ihre Bewerbung nicht berücksichtigen können.`, {}],
    ['a document request', `${CREATED}\n\nBitte senden Sie uns Ihre Diplome und Zeugnisse.`, { requestedDocuments: ['Diplome'] }],
    ['a receipt of the application', `${CREATED}\n\nWir haben Ihre Bewerbung erhalten.`, {}],
  ])('when the account notice also carries %s', async (_name, text, overrides) => {
    const { store, alias } = await setup();
    const { inbox, sendCascade } = await deliver({ store, alias, raw: mail({ text }), answer: modelAnswer(overrides) });
    expect(inbox.portalAccountNoticeHost).toBeUndefined();
    expect(sendCascade).toHaveBeenCalledTimes(1);
  });

  it('forwards the welcome when it also asks the candidate to verify an e-mail address', async () => {
    const { store, alias } = await setup();
    const text = `${CITY_PORTAL_WELCOME}\n\nBitte bestätigen Sie Ihre E-Mail-Adresse über den folgenden Link.`;
    expect(portalAccountNoticeKind({ subject: 'Willkommen', text }, modelAnswer({ verificationUrl: '' }))).toBe('');
    const { inbox, sendCascade } = await deliver({ store, alias, raw: mail({ subject: 'Willkommen', text }), answer: modelAnswer({ verificationUrl: '' }) });

    expect(inbox).toMatchObject({ category: 'verification', forwarded: { status: 'sent' } });
    expect(inbox.portalAccountNoticeHost).toBeUndefined();
    expect(sendCascade).toHaveBeenCalledTimes(1);
  });

  it('forwards the welcome when it also invites the candidate to an interview', async () => {
    const { store, alias } = await setup();
    const text = `${CITY_PORTAL_WELCOME}\n\nGerne laden wir Sie zu einem Vorstellungsgespräch ein.`;
    expect(portalAccountNoticeKind({ subject: 'Willkommen', text }, modelAnswer({ verificationUrl: '' }))).toBe('');
    const { inbox, sendCascade } = await deliver({ store, alias, raw: mail({ subject: 'Willkommen', text }), answer: modelAnswer({ verificationUrl: '' }) });

    expect(inbox).toMatchObject({ category: 'verification', forwarded: { status: 'sent' } });
    expect(inbox.portalAccountNoticeHost).toBeUndefined();
    expect(sendCascade).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['sign-in before profile', 'You may sign in to update your profile and provide your salary expectation, please.'],
    ['profile before sign-in', 'Please complete your profile, provide your salary expectation, and then sign in.'],
  ])('forwards a remaining request after removing self-service guidance (%s)', async (_order, sentence) => {
    const { store, alias } = await setup();
    const text = `Welcome to our city recruiting portal. ${sentence}`;
    const answer = modelAnswer({ verificationUrl: '', needsReply: true });
    expect(portalAccountNoticeKind({ subject: 'Welcome', text }, answer)).toBe('');

    const { inbox, sendCascade } = await deliver({ store, alias, raw: mail({ subject: 'Welcome', text }), answer });
    expect(inbox).toMatchObject({ forwarded: { status: 'sent' } });
    expect(inbox.portalAccountNoticeHost).toBeUndefined();
    expect(sendCascade).toHaveBeenCalledTimes(1);
  });

  it('does not decode an HTML-only welcome more than once before filtering', async () => {
    const { store, alias } = await setup();
    const html = '<p>&amp;#87;illkommen beim Stellenportal der Stadt.</p>';
    const raw = mail({ subject: 'Portal message', contentType: 'text/html; charset=utf-8', text: html });
    const parsed = parseMimeMessage(raw);
    expect(parsed.text).toBe('&#87;illkommen beim Stellenportal der Stadt.');
    expect(parsed.ruleText).toBe(parsed.text);

    const { inbox, sendCascade } = await deliver({
      store,
      alias,
      raw,
      answer: modelAnswer({ verificationUrl: '' }),
    });
    expect(inbox.portalAccountNoticeHost).toBeUndefined();
    expect(inbox.forwarded).toMatchObject({ status: 'sent' });
    expect(sendCascade).toHaveBeenCalledTimes(1);
  });

  it('routes a welcome that also confirms an application through the receipt path', async () => {
    const { store, alias } = await setup();
    const text = `${CITY_PORTAL_WELCOME}\n\nWir haben Ihre Bewerbung erhalten.`;
    const receipt = modelAnswer({ category: 'auto_acknowledgement', verificationUrl: '' });
    const { inbox, sendCascade } = await deliver({ store, alias, raw: mail({ subject: 'Willkommen und Bewerbungseingang', text }), answer: receipt });

    expect(inbox).toMatchObject({
      category: 'auto_acknowledgement', automaticApplicationReceipt: true, correlationStatus: 'verified',
      forwarded: { status: 'skipped', reason: 'application_receipt' },
    });
    expect(inbox.portalAccountNotice).toBeUndefined();
    expect(sendCascade).not.toHaveBeenCalled();
  });

  it('when the model reads it as something else than an account mail', async () => {
    const { store, alias } = await setup();
    const { inbox, sendCascade } = await deliver({ store, alias, raw: mail(), answer: modelAnswer({ category: 'other' }) });
    expect(inbox.portalAccountNoticeHost).toBeUndefined();
    expect(sendCascade).toHaveBeenCalledTimes(1);
  });
});

describe('binding a notice to an account', () => {
  const account = (host: string, extra: Record<string, unknown> = {}) => ({ host, passwordEnc: { v: 1 }, verifiedAt: null, createdAt: 500, ...extra });

  it('takes the link’s exact host, never a look-alike or a sibling of the ATS family', () => {
    const accounts = { a: account(HOST), b: account('jobs.other.example') };
    expect(portalAccountForNotice(accounts, { link: LINK, senderHost: 'stelle.admin.ch', receivedAt: 1000 })).toBe(HOST);
    expect(portalAccountForNotice(accounts, { link: `https://${HOST}.evil.example/career`, senderHost: 'stelle.admin.ch', receivedAt: 1000 })).toBe('');
    expect(portalAccountForNotice(accounts, { link: 'https://career5.successfactors.eu/career', senderHost: 'stelle.admin.ch', receivedAt: 1000 })).toBe('');
  });

  it('falls back to the sender’s domain, then to the sole account that existed before the message', () => {
    expect(portalAccountForNotice({ a: account('jobs.employer.example'), b: account('other.example') }, { senderHost: 'mail.employer.example', receivedAt: 1000 })).toBe('jobs.employer.example');
    expect(portalAccountForNotice({ a: account(HOST) }, { senderHost: 'stelle.admin.ch', receivedAt: 1000 })).toBe(HOST);
    expect(portalAccountForNotice({ a: account(HOST, { createdAt: 5000 }) }, { senderHost: 'stelle.admin.ch', receivedAt: 1000 })).toBe('');
    expect(portalAccountForNotice({ a: account(HOST), b: account('jobs.other.example') }, { senderHost: 'stelle.admin.ch', receivedAt: 1000 })).toBe('');
  });

  it('ignores a discarded account and two records for one host', () => {
    expect(portalAccountForNotice({ a: account(HOST, { status: 'discarded', passwordEnc: null }) }, { link: LINK, senderHost: 'stelle.admin.ch', receivedAt: 1000 })).toBe('');
    expect(portalAccountForNotice({ a: account(HOST), legacy: account(HOST) }, { link: LINK, senderHost: 'stelle.admin.ch', receivedAt: 1000 })).toBe('');
  });

  it('reads a verification request as a verification, never as a notice', () => {
    const answer = modelAnswer({ verificationUrl: '' });
    expect(portalAccountNoticeKind({ subject: 'Konto', text: CREATED }, answer)).toBe('created');
    expect(portalAccountNoticeKind({ subject: 'Verifizierung', text: 'Der Code für die Verifizierung Ihres Bewerbungskontos lautet 793151.' }, answer)).toBe('');
    expect(portalAccountNoticeKind({ subject: 'Konto', text: 'Bitte bestätigen Sie Ihre E-Mail-Adresse.' }, answer)).toBe('');
  });
});
