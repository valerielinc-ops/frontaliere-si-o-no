import { describe, expect, it, vi } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({
  getRemoteConfigValue: vi.fn(async () => ''),
  bridgeEmailCascadeCredentialsToEnv: vi.fn(async () => {}),
}));

const { ensureOrderAlias } = await import('../functions/src/assistedApplicationAlias.js');
const { automaticApplicationReceipt, classifyByRules, handleAssistedApplicationInbound, processAssistedApplicationInbound, runAssistedApplicationInboundForwardSweep } = await import('../functions/src/assistedApplicationInbound.js');
const { parseMimeMessage } = await import('../functions/src/lib/mimeMessage.js');
const { runAutomationEffect } = await import('../functions/src/assistedApplicationAutomationEffects.js');

// The employer's automatic receipt of the application (the federal
// SuccessFactors tenant, 2026-11-10, reconstructed with invented names) is a
// system signal: recorded on the order, shown on the concierge page, never
// forwarded. Anything that asks the candidate for something still is.
const ORDER = 'order_RECEIPT1';
const ORDER_PATH = `assisted_applications/${ORDER}`;
const FLOW_PATH = `${ORDER_PATH}/automation/flow`;
const GUARD_PATH = `${ORDER_PATH}/automation/submission`;
const RUN_KEY = Buffer.alloc(32, 9).toString('base64');
const SECRET = 'worker-secret';

const FEDERAL = [
  'Guten Tag',
  '',
  'Vielen Dank für Ihr Interesse an der Stelle als Fachspezialistin Testlogistik 80-100%. Ihre Bewerbung ist bei uns angekommen.',
  '',
  'Die Bearbeitung aller Dossiers braucht etwas Zeit. Wir bitten Sie deshalb um etwas Geduld.',
  '',
  'Den aktuellen Stand Ihrer Bewerbung können Sie in Ihrem Bewerbungskonto https://career74.sapsf.eu/career?company=examplefed einsehen.',
  '',
  'Freundliche Grüsse',
  '',
  'Musterverwaltung',
  '',
  'Dies ist eine automatisch generierte E-Mail, bitte antworten Sie nicht darauf.',
].join('\n');

const ITALIAN = 'Gentile candidata, la ringraziamo per l’interesse. Abbiamo ricevuto la sua candidatura per la posizione di Addetta test e la esamineremo con attenzione.\n\nQuesto è un messaggio generato automaticamente, si prega di non rispondere.';
const FRENCH = 'Madame, nous vous remercions de votre intérêt. Nous avons bien reçu votre candidature pour le poste de Collaboratrice test.\n\nCe message est généré automatiquement, merci de ne pas répondre.';
const ENGLISH = 'Dear candidate, thank you for your interest. We have received your application for the Test Analyst position and will review it carefully.\n\nThis is an automatically generated e-mail, please do not reply.';

function fakeBucket() {
  const files = new Map<string, string>();
  return {
    file: (key: string) => ({
      async save(content: string) { files.set(key, String(content)); },
      async download() { return [Buffer.from(files.get(key) || '')]; },
    }),
  };
}

const cf = () => {
  const rules = new Map<string, string>();
  return {
    async createRule(address: string) { const id = `rule-${rules.size + 1}`; rules.set(id, address); return id; },
    async deleteRule(id: string) { rules.delete(id); },
  };
};

async function setup() {
  const store = createMemoryFirestore({
    [ORDER_PATH]: { paymentStatus: 'paid', locale: 'de', companyName: 'Muster AG', jobTitle: 'Testrolle', applicantEmail: 'candidate@example.test' },
  });
  const alias = await ensureOrderAlias({ db: store.db, orderId: ORDER, cf: cf() });
  return { store, alias };
}

let sequence = 0;
const mail = ({ subject = 'Ihre Bewerbung', text = FEDERAL, from = 'Musterverwaltung <job@stelle.example.test>', headers = [] as string[], attachment = null as null | { type: string; name: string } } = {}) => {
  const body = Buffer.from(text, 'utf8').toString('base64');
  return Buffer.from([
    `Message-ID: <receipt-${sequence++}@example.test>`,
    `From: ${from}`,
    'Authentication-Results: mx.cloudflare.net; dkim=pass header.d=stelle.example.test',
    `Subject: =?utf-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`,
    ...headers,
    ...(attachment ? [
      'Content-Type: multipart/mixed; boundary="m"', '', '--m',
      'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', body, '--m',
      `Content-Type: ${attachment.type}; name="${attachment.name}"`, `Content-Disposition: attachment; filename="${attachment.name}"`,
      'Content-Transfer-Encoding: base64', '', Buffer.from('synthetic').toString('base64'), '--m--',
    ] : ['Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', body]),
    '',
  ].join('\r\n'), 'latin1');
};

const answer = (overrides: Record<string, unknown> = {}) => ({
  category: 'auto_acknowledgement', summaryIt: 'Ricevuta automatica della candidatura.', summaryCandidate: 'Il datore ha ricevuto la candidatura.',
  interviewWhen: '', requestedDocuments: [], verificationCode: '', verificationUrl: '', needsReply: false, ...overrides,
});

const request = (raw: Buffer, to: string) => ({
  method: 'POST',
  rawBody: raw,
  get: (name: string) => ({ 'x-stop-secret': SECRET, 'x-envelope-to': to } as Record<string, string>)[name],
});

async function deliver({ store, alias, raw, model = answer() as any, runEffect = null as any, at = 1000 }: any) {
  const bucket = fakeBucket();
  const sendCascade = vi.fn(async () => ({ failed: [], sent: [{ provider: 'maileroo' }] }));
  const accepted = await handleAssistedApplicationInbound(request(raw, alias.address), { db: store.db, bucket, secret: SECRET, runKey: RUN_KEY, nowMs: at });
  const classify = model ? vi.fn(async () => model) : vi.fn(async () => { throw new Error('codex_unavailable'); });
  const messageId = accepted.body.accepted;
  const processed = await processAssistedApplicationInbound({ db: store.db, bucket, orderId: ORDER, messageId, runKey: RUN_KEY, classify, sendCascade, runEffect, nowMs: at });
  return { processed, inbox: store.read(`${ORDER_PATH}/inbox/${messageId}`)!, sendCascade, bucket, messageId };
}

const receiptOf = (raw: Buffer, model = answer()) => automaticApplicationReceipt(parseMimeMessage(raw), model);

describe('an automatic receipt of the application', () => {
  it.each([['the model', answer()], ['the rules', null]])('is recorded and never forwarded (the federal receipt, %s)', async (_by, model) => {
    const { store, alias } = await setup();
    const { processed, inbox, sendCascade } = await deliver({ store, alias, raw: mail(), model });
    expect(processed).toMatchObject({ ok: true, category: 'auto_acknowledgement', forwarded: 'skipped' });
    expect(inbox).toMatchObject({
      status: 'processed', category: 'auto_acknowledgement', correlationStatus: 'verified',
      automaticApplicationReceipt: true, forwarded: { status: 'skipped', reason: 'application_receipt' },
    });
    expect(sendCascade).not.toHaveBeenCalled();
    // The concierge reads the employer's acknowledgement from the order.
    expect(store.read(ORDER_PATH)).toMatchObject({
      employerReplies: 1, lastEmployerReplyCategory: 'auto_acknowledgement',
      employerResponse: { category: 'auto_acknowledgement', receivedAt: 1000 },
    });
  });

  it.each([
    ['Italian', 'La sua candidatura', ITALIAN],
    ['French', 'Votre candidature', FRENCH],
    ['English', 'Your application', ENGLISH],
  ])('is recognised in %s', async (_language, subject, text) => {
    expect(classifyByRules({ subject, text })).toBe('auto_acknowledgement');
    expect(receiptOf(mail({ subject, text }))).toBe(true);
    const { store, alias } = await setup();
    const { inbox, sendCascade } = await deliver({ store, alias, raw: mail({ subject, text }) });
    expect(inbox.forwarded).toEqual({ status: 'skipped', reason: 'application_receipt' });
    expect(sendCascade).not.toHaveBeenCalled();
  });

  it('is recognised as automatic by its header or its no-reply mailbox, without saying so in the text', () => {
    const text = 'Vielen Dank für Ihre Bewerbung. Wir haben Ihre Bewerbung erhalten und melden uns so bald wie möglich.';
    expect(receiptOf(mail({ text, headers: ['Auto-Submitted: auto-generated'] }))).toBe(true);
    expect(receiptOf(mail({ text, headers: ['Precedence: bulk'] }))).toBe(true);
    expect(receiptOf(mail({ text, from: 'Karriere <no-reply@jobs.example.test>' }))).toBe(true);
    expect(receiptOf(mail({ text, headers: ['Auto-Submitted: no'] }))).toBe(false);
  });

  it('reads a registered application as received, in every language', () => {
    expect(classifyByRules({ subject: '', text: 'Confermiamo che la sua candidatura è stata registrata.' })).toBe('auto_acknowledgement');
    expect(classifyByRules({ subject: '', text: 'Ihre Bewerbung wurde erfolgreich registriert.' })).toBe('auto_acknowledgement');
    expect(classifyByRules({ subject: '', text: 'Votre candidature a bien été enregistrée.' })).toBe('auto_acknowledgement');
    expect(classifyByRules({ subject: '', text: 'Your application has been successfully registered.' })).toBe('auto_acknowledgement');
  });

  it('keeps an inline logo, which carries nothing for the candidate', () => {
    expect(receiptOf(mail({ attachment: { type: 'image/png', name: 'logo.png' } }))).toBe(true);
  });

  it('still settles a submission of unknown outcome as the employer’s acknowledgement', async () => {
    const { store, alias } = await setup();
    const orderRef = store.db.collection('assisted_applications').doc(ORDER);
    await orderRef.set({ submissionStatus: 'ready_for_manual_submission' }, { merge: true });
    await orderRef.collection('automation').doc('flow').set({ state: 'owner_takeover', round: 1, heldBy: ['portal_ambiguous'] });
    await orderRef.collection('automation').doc('submission').set({ r1: { state: 'sending', channel: 'portal', startedAt: 500, clickedAt: 600 } });
    const { processed, sendCascade } = await deliver({ store, alias, raw: mail(), runEffect: runAutomationEffect });
    expect(processed).toEqual({ ok: true, category: 'auto_acknowledgement', forwarded: 'skipped', submissionConfirmed: true });
    expect(sendCascade).not.toHaveBeenCalled();
    expect(store.read(GUARD_PATH)!.r1).toMatchObject({ state: 'sent', confirmedBy: 'acknowledgement', receipt: { proofKind: 'employer_acknowledgement' } });
    expect(store.read(FLOW_PATH)).toMatchObject({ state: 'submitted' });
  });

  it('is never picked up by the forward sweep', async () => {
    const { store, alias } = await setup();
    const { bucket, sendCascade, messageId } = await deliver({ store, alias, raw: mail() });
    const ref = store.db.collection('assisted_applications').doc(ORDER).collection('inbox').doc(messageId);
    // A delivery state rewritten as due (a stale sweep row): the marker alone keeps it from the candidate.
    await ref.set({ forwardDelivery: { status: 'retry_scheduled', retryAt: 0, attempts: 0 } }, { merge: true });
    const snapshot = await ref.get();
    const query: any = { where: () => query, limit: () => query, get: async () => ({ docs: [snapshot] }) };
    await runAssistedApplicationInboundForwardSweep({ db: { ...store.db, collectionGroup: () => query }, bucket, runKey: RUN_KEY, sendCascade, nowMs: 5000 });
    expect(sendCascade).not.toHaveBeenCalled();
    expect(store.read(`${ORDER_PATH}/inbox/${messageId}`)!.forwarded).toMatchObject({ status: 'skipped' });
  });
});

describe('what still reaches the candidate', () => {
  it.each([
    ['an interview invitation with thanks', 'Vielen Dank für Ihre Bewerbung, sie ist bei uns eingegangen. Gerne laden wir Sie zu einem Vorstellungsgespräch am 12. Dezember um 10 Uhr ein.\n\nDies ist eine automatisch generierte E-Mail.', { category: 'interview_invite', interviewWhen: '12. Dezember, 10 Uhr', needsReply: true }],
    ['a document request', 'Wir haben Ihre Bewerbung erhalten. Bitte laden Sie Ihre Arbeitszeugnisse und Diplome in Ihrem Bewerbungskonto hoch.\n\nDies ist eine automatisch generierte E-Mail.', { category: 'documents_request', requestedDocuments: ['Arbeitszeugnisse', 'Diplome'] }],
    ['a refusal', 'Vielen Dank für Ihre Bewerbung. Leider müssen wir Ihnen mitteilen, dass wir Ihre Bewerbung nicht berücksichtigen können.\n\nDies ist eine automatisch generierte E-Mail, bitte antworten Sie nicht darauf.', { category: 'rejection' }],
    ['an assessment', 'We have received your application. Please complete the online test within five days.\n\nThis is an automated message, please do not reply.', { category: 'assessment' }],
  ])('%s, also when the model calls it a receipt', async (_name, text, model) => {
    expect(receiptOf(mail({ text }), answer())).toBe(false);
    const { store, alias } = await setup();
    const { inbox, sendCascade } = await deliver({ store, alias, raw: mail({ text }), model: answer(model) });
    expect(inbox.automaticApplicationReceipt).toBeUndefined();
    expect(inbox.forwarded).toMatchObject({ status: 'sent' });
    expect(sendCascade).toHaveBeenCalledTimes(1);
  });

  it('a person’s acknowledgement, which says nothing of a machine', async () => {
    const text = 'Guten Tag\n\nVielen Dank, wir haben Ihre Bewerbung erhalten und melden uns nächste Woche.\n\nFreundliche Grüsse\nErika Beispiel';
    expect(receiptOf(mail({ text, from: 'Erika Beispiel <erika.beispiel@stelle.example.test>' }))).toBe(false);
    const { store, alias } = await setup();
    const { sendCascade } = await deliver({ store, alias, raw: mail({ text, from: 'Erika Beispiel <erika.beispiel@stelle.example.test>' }) });
    expect(sendCascade).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['asks to complete the profile', `${FEDERAL}\n\nBitte vervollständigen Sie Ihr Profil im Bewerbungskonto.`],
    ['asks a question', 'Wir haben Ihre Bewerbung erhalten. Sind Sie ab Januar verfügbar?\n\nDies ist eine automatisch generierte E-Mail.'],
    ['asks to confirm interest (Italian)', `${ITALIAN}\n\nLa preghiamo di confermare il suo interesse entro venerdì.`],
    ['asks to choose a slot (French)', `${FRENCH}\n\nVeuillez choisir un créneau dans votre espace candidat.`],
  ])('a receipt that %s', (_name, text) => {
    expect(receiptOf(mail({ text }))).toBe(false);
  });

  it('a receipt the model expects an answer to, or carrying a file', () => {
    expect(receiptOf(mail(), answer({ needsReply: true }))).toBe(false);
    expect(receiptOf(mail({ attachment: { type: 'application/pdf', name: 'Formular.pdf' } }))).toBe(false);
  });

  it('a receipt the model reads as something else', async () => {
    expect(receiptOf(mail(), answer({ category: 'other' }))).toBe(false);
    const { store, alias } = await setup();
    const { sendCascade } = await deliver({ store, alias, raw: mail(), model: answer({ category: 'other' }) });
    expect(sendCascade).toHaveBeenCalledTimes(1);
  });

  it('an offer of help is not a request: the receipt stays a system signal', () => {
    expect(receiptOf(mail({ text: `${ENGLISH}\n\nIf you have any questions, please contact our recruiting team.` }))).toBe(true);
    expect(receiptOf(mail({ text: `${FEDERAL}\n\nBei Fragen kontaktieren Sie bitte unser Rekrutierungsteam.` }))).toBe(true);
  });
});
