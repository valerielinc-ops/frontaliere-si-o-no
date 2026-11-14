import { describe, expect, it, vi } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({
  getRemoteConfigValue: vi.fn(async () => ''),
  bridgeEmailCascadeCredentialsToEnv: vi.fn(async () => {}),
}));

vi.mock('../functions/src/assistedApplicationPostalPacket.js', () => ({
  postalPacketReadiness: vi.fn(async () => null),
}));

const { ensureOrderAlias } = await import('../functions/src/assistedApplicationAlias.js');
const { classifyByRules, handleAssistedApplicationInbound, portalApplicationReminder, processAssistedApplicationInbound, runAssistedApplicationInboundForwardSweep } = await import('../functions/src/assistedApplicationInbound.js');
const { parseMimeMessage } = await import('../functions/src/lib/mimeMessage.js');
const { runAutomationEffect } = await import('../functions/src/assistedApplicationAutomationEffects.js');

// A portal's automatic reminder of an application the robot started there and did not send (SBB on
// SuccessFactors, 2026-11-10; reconstructed with invented names, hosts and posting). Owner directive: a
// portal's codes, confirmations, receipts and reminders never reach the candidate. A candidate-only request
// for documents or information still does.
const ORDER = 'order_REMINDER1';
const ORDER_PATH = `assisted_applications/${ORDER}`;
const FLOW_PATH = `${ORDER_PATH}/automation/flow`;
const GUARD_PATH = `${ORDER_PATH}/automation/submission`;
const RUN_KEY = Buffer.alloc(32, 5).toString('base64');
const SECRET = 'worker-secret';
const PORTAL_HOST = 'career9.ats.example.test';
const SENDER = 'Bahn Recruiting <recruiting@hrs.bahn.example.test>';
const SENDER_DOMAIN = 'hrs.bahn.example.test';

// The SBB message, its structure kept (SuccessFactors wraps it with blank CRLF lines), every name and link invented.
const SBB_LIKE = [
  'Hallo Erika',
  '',
  ' Uns ist aufgefallen, dass du dich für eine unserer Stellen interessierst. Es würde uns freuen, wenn du deine Bewerbung abschliesst. Vielleicht überzeugen dich unsere attraktiven Benefits für alle unseren Mitarbeiter:innen? Hier https://company.bahn.example.test/benefits erfährst du mehr.',
  '',
  ' Folgende Bewerbungen wurden begonnen:',
  '',
  '',
  '',
  ` Testrolle Plattform (m/w/d) https://${PORTAL_HOST}/career?company=examplebahn&career_job_req_id=1&career_ns=job_application`,
  '',
  ' Wir freuen uns, von dir zu hören.',
  '',
  ' Herzliche Grüsse',
  '',
  ' Team Recruiting - Sourcing & Talents',
  ' #einfachTest',
].join('\r\n');
const SBB_SUBJECT = 'Deine Bewerbung abschliessen';

const VARIANTS: Array<[string, string, string]> = [
  ['German (formal)', 'Ihre Bewerbung', 'Guten Tag\n\nSie haben Ihre Bewerbung noch nicht abgeschlossen. Bitte melden Sie sich an und schliessen Sie Ihre Bewerbung ab.\n\nFreundliche Grüsse\nIhr Recruiting-Team'],
  ['German (incomplete)', 'Erinnerung', 'Ihre Bewerbung ist noch unvollständig. Klicken Sie auf den Link, um Ihre Bewerbung abzuschließen.'],
  ['German (almost complete)', 'Sie waren so nah dran!', 'Beinahe hätten Sie erfolgreich Ihre Bewerbung ausgefüllt. Vollenden Sie Ihre Bewerbung ganz einfach mit diesem Bewerbungsformular: https://career9.ats.example.test/apply?token=fake-token'],
  ['Italian', 'La tua candidatura', 'Gentile candidata,\n\nla sua candidatura non è stata completata. La invitiamo a completare la candidatura tramite il link qui sotto.\n\nCordiali saluti'],
  ['Italian (incomplete)', 'Promemoria', 'La tua candidatura risulta incompleta. Accedi al portale per completare la candidatura.'],
  ['French', 'Votre candidature', 'Madame,\n\nVotre candidature n’a pas encore été finalisée. Veuillez vous connecter et finaliser votre candidature sur notre portail.\n\nMeilleures salutations'],
  ['French (subject)', 'Candidature non finalisée', 'Vous avez commencé une candidature sur notre portail carrière. Connectez-vous pour la terminer.'],
  ['English', 'Your application is incomplete', 'Dear candidate,\n\nYour application is incomplete. Please log in and complete your application.\n\nKind regards,\nTalent Acquisition'],
  ['English (not completed)', 'Reminder', 'You have not yet completed your application for the Test Analyst position. Complete your application here: https://career9.ats.example.test/apply'],
];

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

const ACCOUNT = { portal: { host: PORTAL_HOST, passwordEnc: { v: 1 }, verifiedAt: 600, status: 'created', createdAt: 500 } };
const WAITING_FLOW = { state: 'needs_candidate_action', round: 1, heldBy: ['question:portal_example_question'], reminderAt: 90_000 };

async function setup({ accounts = ACCOUNT as Record<string, unknown> | null, flow = WAITING_FLOW as Record<string, unknown>, submission = { r1: { state: 'failed', channel: 'portal', releasedAt: 700 } } as Record<string, unknown> } = {}) {
  const store = createMemoryFirestore({
    [ORDER_PATH]: { paymentStatus: 'paid', locale: 'de', companyName: 'Bahn AG', jobTitle: 'Testrolle', applicantEmail: 'candidate@example.test', submissionStatus: 'awaiting_upload' },
  });
  const alias = await ensureOrderAlias({ db: store.db, orderId: ORDER, cf: cf() });
  const orderRef = store.db.collection('assisted_applications').doc(ORDER);
  if (accounts) await orderRef.collection('automation').doc('accounts').set(accounts);
  await orderRef.collection('automation').doc('flow').set(flow);
  await orderRef.collection('automation').doc('submission').set(submission);
  return { store, alias };
}

let sequence = 0;
const mail = ({ subject = SBB_SUBJECT, text = SBB_LIKE, from = SENDER, dkim = SENDER_DOMAIN as string | null, attachment = null as null | { type: string; name: string } } = {}) => {
  const body = Buffer.from(text, 'utf8').toString('base64');
  return Buffer.from([
    `Message-ID: <reminder-${sequence++}@example.test>`,
    `From: ${from}`,
    ...(dkim ? [`Authentication-Results: mx.cloudflare.net; dkim=pass header.d=${dkim}`] : []),
    `Subject: =?utf-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`,
    ...(attachment ? [
      'Content-Type: multipart/mixed; boundary="m"', '', '--m',
      'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', body, '--m',
      `Content-Type: ${attachment.type}; name="${attachment.name}"`, `Content-Disposition: attachment; filename="${attachment.name}"`,
      'Content-Transfer-Encoding: base64', '', Buffer.from('synthetic').toString('base64'), '--m--',
    ] : ['Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', body]),
    '',
  ].join('\r\n'), 'latin1');
};

// The model read the SBB message as `other` and expected an answer of the candidate.
const answer = (overrides: Record<string, unknown> = {}) => ({
  category: 'other', summaryIt: 'Il datore ricorda che la candidatura è stata iniziata ma non completata.',
  summaryCandidate: 'Completa la candidatura tramite il link indicato.',
  interviewWhen: '', requestedDocuments: [], verificationCode: '', verificationUrl: '', needsReply: true, ...overrides,
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

const remindsOf = (raw: Buffer, model = answer()) => portalApplicationReminder(parseMimeMessage(raw), model);
const events = (store: any) => store.list(`${ORDER_PATH}/events/`).map((path: string) => store.read(path));

describe('a portal’s reminder of an application started and not sent', () => {
  it.each([['the model', answer()], ['the rules', null]])('is recorded as an event of the order and never forwarded (the SBB reminder, %s)', async (_by, model) => {
    const { store, alias } = await setup();
    const flowBefore = structuredClone(store.read(FLOW_PATH));
    const guardBefore = structuredClone(store.read(GUARD_PATH));
    const { processed, inbox, sendCascade, messageId } = await deliver({ store, alias, raw: mail(), model, runEffect: runAutomationEffect });
    expect(processed).toEqual({ ok: true, category: 'other', forwarded: 'skipped', portalApplicationReminder: true });
    expect(sendCascade).not.toHaveBeenCalled();
    expect(inbox).toMatchObject({
      status: 'processed', category: 'other', needsReply: false, summaryCandidate: '', correlationStatus: 'unknown',
      portalApplicationReminder: true, portalApplicationReminderHost: PORTAL_HOST, modelCategory: 'other',
      forwarded: { status: 'skipped', reason: 'portal_application_reminder' },
    });
    // No employer reply and no candidate-visible response: the order itself is untouched.
    const order = store.read(ORDER_PATH)!;
    expect(order.employerReplies).toBeUndefined();
    expect(order.lastEmployerReplyCategory).toBeUndefined();
    expect(order.employerResponse).toBeUndefined();
    expect(order.employerResponseTimeline).toBeUndefined();
    // The event: its kind, its time and the portal host, nothing personal.
    const [event] = events(store);
    expect(event).toMatchObject({
      eventType: 'portal_application_reminder', actor: 'inbound-mail', messageId, receivedAt: 1000,
      portalHost: PORTAL_HOST, flowState: 'needs_candidate_action',
    });
    expect(Object.keys(event).sort()).toEqual(['actor', 'createdAt', 'eventType', 'flowState', 'messageId', 'portalHost', 'receivedAt']);
    expect(JSON.stringify(event)).not.toMatch(/Erika|example\.test>|bahn\.example|Bewerbung/);
    // A wait for the candidate stays a wait: the flow and the submission guard are not touched.
    expect(store.read(FLOW_PATH)).toEqual(flowBefore);
    expect(store.read(GUARD_PATH)).toEqual(guardBefore);
  });

  it.each(VARIANTS)('is recognised in %s', async (_language, subject, text) => {
    expect(remindsOf(mail({ subject, text }))).toBe(true);
    const { store, alias } = await setup();
    const { inbox, sendCascade } = await deliver({ store, alias, raw: mail({ subject, text }) });
    expect(inbox.forwarded).toEqual({ status: 'skipped', reason: 'portal_application_reminder' });
    expect(sendCascade).not.toHaveBeenCalled();
  });

  it('keeps the near-complete reminder even when the order is already marked submitted', async () => {
    const { store, alias } = await setup();
    await store.db.collection('assisted_applications').doc(ORDER).set({
      submissionStatus: 'submitted', automationState: 'submitted', submittedAt: 900,
    }, { merge: true });
    const text = 'Beinahe hätten Sie erfolgreich Ihre Bewerbung ausgefüllt. Vollenden Sie Ihre Bewerbung ganz einfach mit diesem Bewerbungsformular: https://career9.ats.example.test/apply?token=fake-token';
    const { inbox, sendCascade } = await deliver({ store, alias, raw: mail({ subject: 'Sie waren so nah dran!', text }) });
    expect(inbox).toMatchObject({
      portalApplicationReminder: true,
      correlationStatus: 'unknown',
      forwarded: { status: 'skipped', reason: 'portal_application_reminder' },
    });
    expect(sendCascade).not.toHaveBeenCalled();
    expect(store.read(ORDER_PATH)).toMatchObject({ submissionStatus: 'submitted', automationState: 'submitted' });
    expect(events(store)).toEqual([]);
  });

  it('is never read as an acknowledgement: a submission of unknown outcome stays unknown', async () => {
    const { store, alias } = await setup({
      flow: { state: 'owner_takeover', round: 1, heldBy: ['portal_ambiguous'] },
      submission: { r1: { state: 'sending', channel: 'portal', startedAt: 500, clickedAt: 600 } },
    });
    const { processed, inbox, sendCascade } = await deliver({ store, alias, raw: mail(), model: answer({ category: 'auto_acknowledgement', needsReply: false }), runEffect: runAutomationEffect });
    expect(processed.submissionConfirmed).toBeUndefined();
    expect(inbox).toMatchObject({ category: 'other', modelCategory: 'auto_acknowledgement', correlationStatus: 'unknown' });
    expect(sendCascade).not.toHaveBeenCalled();
    expect(store.read(GUARD_PATH)!.r1).toMatchObject({ state: 'sending' });
    expect(store.read(FLOW_PATH)).toMatchObject({ state: 'owner_takeover' });
  });

  it('never brings a scheduled portal retry forward: its backoff and its limit stay', async () => {
    const flow = { state: 'owner_takeover', round: 1, heldBy: ['portal:portal_needs_candidate'], portalAutoRetryAt: 50_000, portalAutoRetryCount: 1 };
    const { store, alias } = await setup({ flow });
    await deliver({ store, alias, raw: mail(), runEffect: runAutomationEffect, at: 2000 });
    expect(store.read(FLOW_PATH)).toEqual(flow);
    expect(events(store)[0]).toMatchObject({ flowState: 'owner_takeover' });
  });

  it('is never picked up by the forward sweep', async () => {
    const { store, alias } = await setup();
    const { bucket, sendCascade, messageId } = await deliver({ store, alias, raw: mail() });
    const ref = store.db.collection('assisted_applications').doc(ORDER).collection('inbox').doc(messageId);
    await ref.set({ forwardDelivery: { status: 'retry_scheduled', retryAt: 0, attempts: 0 } }, { merge: true });
    const snapshot = await ref.get();
    const query: any = { where: () => query, limit: () => query, get: async () => ({ docs: [snapshot] }) };
    await runAssistedApplicationInboundForwardSweep({ db: { ...store.db, collectionGroup: () => query }, bucket, runKey: RUN_KEY, sendCascade, nowMs: 5000 });
    expect(sendCascade).not.toHaveBeenCalled();
    expect(store.read(`${ORDER_PATH}/inbox/${messageId}`)!.forwarded).toMatchObject({ status: 'skipped' });
  });

  it('keeps an inline logo, which carries nothing for the candidate', () => {
    expect(remindsOf(mail({ attachment: { type: 'image/png', name: 'logo.png' } }))).toBe(true);
  });
});

describe('which content is forwarded to the candidate', () => {
  it.each([
    ['a recruiter’s document request with a contact person', 'Bewerbung', 'Guten Tag\n\nBitte vervollständigen Sie Ihre Bewerbung und laden Sie Ihre Arbeitszeugnisse hoch.\n\nFreundliche Grüsse\nErika Beispiel, HR Business Partner, +41 00 000 00 00', { category: 'documents_request', requestedDocuments: ['Arbeitszeugnisse'] }, true],
    ['a document request inside the reminder sentence', 'Candidatura', 'Per completare la candidatura La preghiamo di inviarci il suo certificato di lavoro.', { category: 'documents_request' }, true],
    ['an interview invitation', 'Your application', 'Your application is incomplete. We would nonetheless like to invite you to an interview on Monday, 14 December at 10:00.', { category: 'interview_invite', interviewWhen: 'Monday, 14 December, 10:00' }, true],
    ['an assessment', 'Your application', 'Please complete your application by completing the online test within five days.', { category: 'assessment' }, true],
    ['a question for the candidate', 'Your application', 'Your application is incomplete. Are you available for a call next week?', {}, true],
    ['a request to call back', 'Ihre Bewerbung', 'Ihre Bewerbung ist noch unvollständig. Bitte rufen Sie mich zurück.\n\nErika Beispiel', {}, true],
    ['a redirect to the employer’s portal', 'Your application', 'Thank you for your interest. Please submit your application through our online portal.', {}, true],
    ['a general rule about incomplete applications', 'Hinweis', 'Unvollständige Bewerbungen werden nicht berücksichtigt.', { needsReply: false }, false],
    ['a human receipt without a candidate action', 'Ihre Bewerbung', 'Vielen Dank für Ihre Bewerbung. Wir haben Ihre Bewerbung erhalten.', { category: 'auto_acknowledgement', needsReply: false }, false],
  ])('%s', async (_name, subject, text, model, shouldForward) => {
    expect(remindsOf(mail({ subject, text }), answer(model))).toBe(false);
    const { store, alias } = await setup();
    const { inbox, sendCascade } = await deliver({ store, alias, raw: mail({ subject, text }), model: answer(model) });
    expect(inbox.portalApplicationReminder).toBeUndefined();
    if (shouldForward) {
      expect(inbox.forwarded).toMatchObject({ status: 'sent' });
      expect(sendCascade).toHaveBeenCalledTimes(1);
    } else {
      expect(inbox.forwarded).toMatchObject({ status: 'skipped', reason: 'not_candidate_action' });
      expect(sendCascade).not.toHaveBeenCalled();
    }
    expect(events(store)).toEqual([]);
  });

  it('a reminder the model reads as an interview, a test, an offer, a refusal or a verification', () => {
    for (const category of ['interview_invite', 'assessment', 'offer', 'rejection', 'verification']) {
      expect(remindsOf(mail(), answer({ category }))).toBe(false);
    }
    expect(remindsOf(mail(), answer({ verificationUrl: `https://${PORTAL_HOST}/verify` }))).toBe(false);
    expect(remindsOf(mail(), answer({ requestedDocuments: ['Diplome'] }))).toBe(false);
  });

  it('a reminder carrying a file', () => {
    expect(remindsOf(mail({ attachment: { type: 'application/pdf', name: 'Formular.pdf' } }))).toBe(false);
  });

  it('a reminder from an unauthenticated sender', async () => {
    const { store, alias } = await setup();
    const { inbox, sendCascade } = await deliver({ store, alias, raw: mail({ dkim: null }) });
    expect(inbox.portalApplicationReminder).toBeUndefined();
    expect(sendCascade).toHaveBeenCalledTimes(1);
  });

  it('a reminder for an order without a portal account', async () => {
    const { store, alias } = await setup({ accounts: null });
    const { inbox, sendCascade } = await deliver({ store, alias, raw: mail() });
    expect(inbox.portalApplicationReminder).toBeUndefined();
    expect(sendCascade).toHaveBeenCalledTimes(1);
  });

  it('the rules alone still read the reminder as nothing but `other`', () => {
    expect(classifyByRules({ subject: SBB_SUBJECT, text: SBB_LIKE })).toBe('other');
  });
});
