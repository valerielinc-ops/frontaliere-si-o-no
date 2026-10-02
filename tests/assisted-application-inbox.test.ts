import { describe, expect, it, vi } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({
  getRemoteConfigValue: vi.fn(async () => ''),
  bridgeEmailCascadeCredentialsToEnv: vi.fn(async () => {}),
}));

const {
  ALIAS_DOMAIN,
  aliasLocalPart,
  aliasNamePart,
  ensureOrderAlias,
  newAliasLocalPart,
  orderIdForAlias,
  removeOrderAlias,
} = await import('../functions/src/assistedApplicationAlias.js');
const { classifyByRules, handleAssistedApplicationInbound, processAssistedApplicationInbound } = await import('../functions/src/assistedApplicationInbound.js');
const { candidateIdentity } = await import('../functions/src/assistedApplicationAiDraftCore.js');
const { runAutomationEffect } = await import('../functions/src/assistedApplicationAutomationEffects.js');
const { DAY_MS } = await import('../functions/src/assistedApplicationFollowup.js');
const { decryptJson } = await import('../functions/src/lib/evidenceCrypto.js');

const ORDER = 'order_INBOX1';
const RUN_KEY = Buffer.alloc(32, 3).toString('base64');
const SECRET = 'worker-secret';

function fakeCf({ fail = false } = {}) {
  const rules = new Map<string, string>();
  return {
    rules,
    async createRule(address: string) {
      if (fail) throw new Error('cf_403');
      const id = `rule-${rules.size + 1}`;
      rules.set(id, address);
      return id;
    },
    async deleteRule(id: string) { rules.delete(id); },
  };
}

function fakeBucket() {
  const files = new Map<string, string>();
  return {
    files,
    file: (key: string) => ({
      async save(content: string) { files.set(key, String(content)); },
      async download() { return [Buffer.from(files.get(key) || '')]; },
    }),
  };
}

describe('order alias', () => {
  it('has the documented shape and only our domain resolves', () => {
    const local = newAliasLocalPart();
    expect(local).toMatch(/^c-[a-z2-9]{10}$/);
    expect(aliasLocalPart(`${local}@${ALIAS_DOMAIN}`)).toBe(local);
    expect(aliasLocalPart(`${local}@frontaliereticino.ch`)).toBe('');
    expect(aliasLocalPart('valerie@candidature.frontaliereticino.ch')).toBe('');
  });

  it('carries the candidate’s name and 4 random characters, and cannot be guessed from the name alone', () => {
    const bytes = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(newAliasLocalPart(bytes, 'Luigi Prova')).toBe('luigi.prova.bcde');
    expect(aliasNamePart("Luigi D'Angelo-Müller")).toBe('luigi.dangelo-mueller');
    expect(aliasNamePart('Maria De Luca')).toBe('maria.de.luca');
    expect(aliasNamePart('François Côté')).toBe('francois.cote');
    expect(aliasNamePart('Jean-Pierre van der Berg Dupont')).toBe('jean-pierre.dupont');
    expect(aliasNamePart('Anna-Maria Verylongsurnamethatgoesonandonforever').length).toBeLessThanOrEqual(30);
    // No usable name (missing, or no Latin letter): the random shape as before.
    expect(newAliasLocalPart(bytes, '')).toMatch(/^c-[a-z2-9]{10}$/);
    expect(newAliasLocalPart(bytes, '李 小龙')).toMatch(/^c-[a-z2-9]{10}$/);
    // Both shapes resolve; the bare name (the guessable form) does not.
    expect(aliasLocalPart(`luigi.prova.bcde@${ALIAS_DOMAIN}`)).toBe('luigi.prova.bcde');
    expect(aliasLocalPart(`luigi.prova@${ALIAS_DOMAIN}`)).toBe('');
    expect(aliasLocalPart(`luigi.prova.bcd1@${ALIAS_DOMAIN}`)).toBe('');
  });

  it('uses the applicant’s name when the order has one', async () => {
    const store = createMemoryFirestore({ [`assisted_applications/${ORDER}`]: { paymentStatus: 'paid', applicantName: 'Luigi Prova' } });
    const alias = await ensureOrderAlias({ db: store.db, orderId: ORDER, cf: fakeCf(), nowMs: 1 });
    expect(alias.address).toMatch(/^luigi\.prova\.[a-z2-9]{4}@candidature\.frontaliereticino\.ch$/);
    expect(await orderIdForAlias(store.db, alias.address)).toBe(ORDER);
  });

  it('is created once, activated with its routing rule, and removed by retention', async () => {
    const store = createMemoryFirestore({ [`assisted_applications/${ORDER}`]: { paymentStatus: 'paid' } });
    const cf = fakeCf();
    const first = await ensureOrderAlias({ db: store.db, orderId: ORDER, cf, nowMs: 1 });
    expect(first.active).toBe(true);
    expect(await ensureOrderAlias({ db: store.db, orderId: ORDER, cf, nowMs: 2 })).toEqual(first);
    expect(cf.rules.size).toBe(1);
    expect(await orderIdForAlias(store.db, first.address)).toBe(ORDER);
    const order = store.read(`assisted_applications/${ORDER}`);
    expect(order?.candidateAlias).toMatchObject({ address: first.address, active: true });
    expect(await removeOrderAlias({ db: store.db, order, cf })).toBe(true);
    expect(cf.rules.size).toBe(0);
    expect(await orderIdForAlias(store.db, first.address)).toBeNull();
  });

  it('stays inactive when Cloudflare refuses the rule, and the candidate keeps their own address', async () => {
    const store = createMemoryFirestore({ [`assisted_applications/${ORDER}`]: { paymentStatus: 'paid' } });
    const result = await ensureOrderAlias({ db: store.db, orderId: ORDER, cf: fakeCf({ fail: true }) });
    expect(result.active).toBe(false);
    const order = store.read(`assisted_applications/${ORDER}`)!;
    expect(candidateIdentity({ ...order, applicantEmail: 'maria@example.com' }, {}).email).toBe('maria@example.com');
    expect(candidateIdentity({ ...order, candidateAlias: { ...order.candidateAlias, active: true }, applicantEmail: 'maria@example.com' }, {}).email).toBe(result.address);
  });
});

function employerMail({ subject = 'Einladung zum Vorstellungsgespräch', text = 'Guten Tag, wir laden Sie am 12. Oktober um 10:00 ein. Code: 482913', auto = false } = {}) {
  return Buffer.from([
    'From: Anna Muster <hr@arbeitgeber.ch>',
    `Subject: ${subject}`,
    ...(auto ? ['Auto-Submitted: auto-generated'] : []),
    'Content-Type: multipart/mixed; boundary="m"',
    '',
    '--m',
    'Content-Type: text/plain; charset=utf-8',
    '',
    text,
    '--m',
    'Content-Type: application/pdf; name="Einladung.pdf"',
    'Content-Disposition: attachment; filename="Einladung.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('%PDF-1.4 invite').toString('base64'),
    '--m--',
    '',
  ].join('\r\n'), 'latin1');
}

async function setupInbound() {
  const store = createMemoryFirestore({
    [`assisted_applications/${ORDER}`]: { paymentStatus: 'paid', locale: 'de', companyName: 'Arbeitgeber AG', jobTitle: 'Pflegefachfrau', applicantEmail: 'maria@example.com' },
  });
  const alias = await ensureOrderAlias({ db: store.db, orderId: ORDER, cf: fakeCf() });
  return { store, alias };
}

const request = (raw: Buffer, to: string, secret = SECRET) => ({
  method: 'POST',
  rawBody: raw,
  get: (name: string) => ({ 'x-stop-secret': secret, 'x-envelope-to': to } as Record<string, string>)[name],
});

/** The Worker's handoff (accepted at once), then the trigger's processing. */
async function deliver({ store, alias, raw, classify, sendCascade, bucket = fakeBucket(), nowMs = 1000, runEffect = null, db = store.db }: any) {
  const accepted = await handleAssistedApplicationInbound(request(raw, alias.address), { db, bucket, secret: SECRET, runKey: RUN_KEY, nowMs });
  const messageId = accepted.body.accepted;
  const processed = await processAssistedApplicationInbound({ db, bucket, orderId: ORDER, messageId, runKey: RUN_KEY, classify, sendCascade, runEffect, nowMs });
  return { accepted, processed, messageId, bucket };
}

describe('employer messages on the alias', () => {
  it('accepts the message at once, before any classification, so the Worker never waits on Codex', async () => {
    const { store, alias } = await setupInbound();
    const bucket = fakeBucket();
    const accepted = await handleAssistedApplicationInbound(request(employerMail(), alias.address), { db: store.db, bucket, secret: SECRET, runKey: RUN_KEY, nowMs: 1000 });
    expect(accepted).toMatchObject({ status: 200, body: { ok: true, matched: true } });
    const [doc] = store.list(`assisted_applications/${ORDER}/inbox/`).map((path) => store.read(path)!);
    expect(doc).toMatchObject({ status: 'received', receivedAt: 1000 });
    expect(bucket.files.has(doc.rawKey)).toBe(true);
  });

  it('puts a message back to received when processing fails, and processes it once on the retry', async () => {
    const { store, alias } = await setupInbound();
    const bucket = fakeBucket();
    const accepted = await handleAssistedApplicationInbound(request(employerMail(), alias.address), { db: store.db, bucket, secret: SECRET, runKey: RUN_KEY, nowMs: 1000 });
    const messageId = accepted.body.accepted;
    const classify = vi.fn(async () => ({ category: 'question', summaryIt: '', summaryCandidate: '', interviewWhen: '', requestedDocuments: [], verificationCode: '', verificationUrl: '', needsReply: true }));
    const args = { db: store.db, bucket, orderId: ORDER, messageId, runKey: RUN_KEY, classify, nowMs: 2000 };
    await expect(processAssistedApplicationInbound({ ...args, sendCascade: vi.fn(async () => { throw new Error('resend_down'); }) })).rejects.toThrow('resend_down');
    expect(store.read(`assisted_applications/${ORDER}/inbox/${messageId}`)).toMatchObject({ status: 'received', lastError: 'resend_down' });
    const sendCascade = vi.fn(async () => ({ failed: [], sent: [{}] }));
    expect(await processAssistedApplicationInbound({ ...args, sendCascade })).toMatchObject({ ok: true, category: 'question', forwarded: 'sent' });
    // A redelivered trigger does nothing more.
    expect(await processAssistedApplicationInbound({ ...args, sendCascade })).toEqual({ ok: true, skipped: true });
    expect(sendCascade).toHaveBeenCalledTimes(1);
  });

  it('classifies with Codex, keeps only verbatim verification data, stores it encrypted and forwards it', async () => {
    const { store, alias } = await setupInbound();
    const bucket = fakeBucket();
    const sendCascade = vi.fn(async () => ({ failed: [], sent: [{ provider: 'resend' }] }));
    const classify = vi.fn(async () => ({
      category: 'interview_invite',
      summaryIt: 'Invito a colloquio il 12 ottobre.',
      summaryCandidate: 'Einladung zum Gespräch am 12. Oktober um 10:00.',
      interviewWhen: '12. Oktober um 10:00',
      requestedDocuments: [],
      verificationCode: '999999',
      verificationUrl: 'https://evil.example/verify',
      needsReply: true,
    }));
    const { processed } = await deliver({ store, alias, raw: employerMail(), classify, sendCascade, bucket });
    expect(processed).toEqual({ ok: true, category: 'interview_invite', forwarded: 'sent' });
    const inbox = store.list(`assisted_applications/${ORDER}/inbox/`).map((path) => store.read(path)!);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ status: 'processed', category: 'interview_invite', verificationCode: '', verificationUrl: '', from: 'hr@arbeitgeber.ch', classifiedBy: 'codex', forwarded: { status: 'sent' } });
    const envelope = JSON.parse(bucket.files.get(inbox[0].rawKey)!);
    expect(Buffer.from(decryptJson(envelope, Buffer.from(RUN_KEY, 'base64')).raw, 'base64').toString('latin1')).toContain('Einladung zum Vorstellungsgespr');
    const [[items, options]] = sendCascade.mock.calls as any;
    expect(options).toEqual({ delayMs: 0, forceProvider: 'resend' });
    expect(items[0].payload).toMatchObject({ to: ['maria@example.com'], replyTo: 'hr@arbeitgeber.ch', subject: '[Vorstellungsgespräch] Einladung zum Vorstellungsgespräch' });
    expect(items[0].payload.attachments.map((item: any) => item.filename)).toEqual(['Einladung.pdf']);
    expect(items[0].payload.text).toContain('Einladung zum Gespräch am 12. Oktober');
    expect(store.read(`assisted_applications/${ORDER}`)).toMatchObject({ lastEmployerReplyCategory: 'interview_invite' });
  });

  it('keeps a real verification code and falls back to rules when Codex is unavailable', async () => {
    const { store, alias } = await setupInbound();
    // The runner created an account on this portal and waits for its verification.
    await store.db.collection('assisted_applications').doc(ORDER).collection('automation').doc('accounts')
      .set({ careers_arbeitgeber_ch: { host: 'careers.arbeitgeber.ch', passwordEnc: { v: 1 }, verifiedAt: null } });
    const sendCascade = vi.fn(async () => ({ failed: [], sent: [{}] }));
    await deliver({
      store, alias, raw: employerMail({ subject: 'Bitte bestätigen Sie Ihre E-Mail', text: 'Ihr Bestätigungscode lautet 482913' }), sendCascade,
      classify: async () => ({ category: 'verification', summaryIt: '', summaryCandidate: '', interviewWhen: '', requestedDocuments: [], verificationCode: '482913', verificationUrl: '', needsReply: false }),
    });
    const [first] = store.list(`assisted_applications/${ORDER}/inbox/`).map((path) => store.read(path)!);
    expect(first).toMatchObject({ category: 'verification', verificationCode: '482913' });
    // The portal runner reads it from the inbox: the candidate never gets it.
    expect(first.forwarded).toEqual({ status: 'skipped', reason: 'portal_verification' });
    expect(sendCascade).not.toHaveBeenCalled();

    const again = await setupInbound();
    await deliver({
      store: again.store, alias: again.alias, raw: employerMail({ subject: 'Ihre Bewerbung', text: 'Wir haben Ihre Bewerbung erhalten.', auto: true }), sendCascade,
      classify: async () => { throw new Error('codex_auth_expired'); },
    });
    const [ack] = again.store.list(`assisted_applications/${ORDER}/inbox/`).map((path) => again.store.read(path)!);
    expect(ack).toMatchObject({ category: 'auto_acknowledgement', classifiedBy: 'rules' });
  });

  it('forwards a verification message no waiting portal account claims', async () => {
    const verification = (url: string, code = '') => async () => ({ category: 'verification', summaryIt: '', summaryCandidate: '', interviewWhen: '', requestedDocuments: [], verificationCode: code, verificationUrl: url, needsReply: false });
    const mail = (text: string) => employerMail({ subject: 'Confirm your e-mail', text });

    // An account waits on careers.arbeitgeber.ch, but the link is on another site.
    const other = await setupInbound();
    await other.store.db.collection('assisted_applications').doc(ORDER).collection('automation').doc('accounts')
      .set({ careers_arbeitgeber_ch: { host: 'careers.arbeitgeber.ch', passwordEnc: { v: 1 }, verifiedAt: null } });
    const sendOther = vi.fn(async () => ({ failed: [], sent: [{}] }));
    await deliver({ store: other.store, alias: other.alias, raw: mail('Confirm: https://login.other-ats.com/confirm?t=abc'), sendCascade: sendOther, classify: verification('https://login.other-ats.com/confirm?t=abc') });
    const [forwarded] = other.store.list(`assisted_applications/${ORDER}/inbox/`).map((path) => other.store.read(path)!);
    expect(forwarded).toMatchObject({ verificationUrl: 'https://login.other-ats.com/confirm?t=abc', forwarded: { status: 'sent' } });
    expect(sendOther).toHaveBeenCalledTimes(1);

    // No account waits at all (none created, or already verified): a code reaches the candidate too.
    const none = await setupInbound();
    await none.store.db.collection('assisted_applications').doc(ORDER).collection('automation').doc('accounts')
      .set({ careers_arbeitgeber_ch: { host: 'careers.arbeitgeber.ch', passwordEnc: { v: 1 }, verifiedAt: 1000 } });
    const sendNone = vi.fn(async () => ({ failed: [], sent: [{}] }));
    await deliver({ store: none.store, alias: none.alias, raw: mail('Ihr Bestätigungscode lautet 482913'), sendCascade: sendNone, classify: verification('', '482913') });
    const [coded] = none.store.list(`assisted_applications/${ORDER}/inbox/`).map((path) => none.store.read(path)!);
    expect(coded).toMatchObject({ verificationCode: '482913', forwarded: { status: 'sent' } });

    // A code while only an unrelated portal's account waits: the sender is not that portal, so it is forwarded.
    const unrelated = await setupInbound();
    await unrelated.store.db.collection('assisted_applications').doc(ORDER).collection('automation').doc('accounts')
      .set({ jobs_other_portal_com: { host: 'jobs.other-portal.com', passwordEnc: { v: 1 }, verifiedAt: null } });
    const sendUnrelated = vi.fn(async () => ({ failed: [], sent: [{}] }));
    await deliver({ store: unrelated.store, alias: unrelated.alias, raw: mail('Ihr Bestätigungscode lautet 482913'), sendCascade: sendUnrelated, classify: verification('', '482913') });
    const [unclaimed] = unrelated.store.list(`assisted_applications/${ORDER}/inbox/`).map((path) => unrelated.store.read(path)!);
    expect(unclaimed).toMatchObject({ verificationCode: '482913', forwarded: { status: 'sent' } });

    // A link on the waiting account's site is kept for the runner.
    const same = await setupInbound();
    await same.store.db.collection('assisted_applications').doc(ORDER).collection('automation').doc('accounts')
      .set({ careers_arbeitgeber_ch: { host: 'careers.arbeitgeber.ch', passwordEnc: { v: 1 }, verifiedAt: null } });
    const sendSame = vi.fn(async () => ({ failed: [], sent: [{}] }));
    await deliver({ store: same.store, alias: same.alias, raw: mail('Activate: https://careers.arbeitgeber.ch/activate?t=abc'), sendCascade: sendSame, classify: verification('https://careers.arbeitgeber.ch/activate?t=abc') });
    const [kept] = same.store.list(`assisted_applications/${ORDER}/inbox/`).map((path) => same.store.read(path)!);
    expect(kept.forwarded).toEqual({ status: 'skipped', reason: 'portal_verification' });
    expect(sendSame).not.toHaveBeenCalled();
  });

  it('drops unknown aliases and unauthenticated calls', async () => {
    const { store } = await setupInbound();
    const deps = { db: store.db, bucket: fakeBucket(), secret: SECRET, runKey: RUN_KEY, sendCascade: vi.fn(), classify: vi.fn() };
    expect((await handleAssistedApplicationInbound(request(employerMail(), `c-abcdefghjk@${ALIAS_DOMAIN}`), deps)).body).toMatchObject({ matched: false, reason: 'unknown_alias' });
    expect((await handleAssistedApplicationInbound(request(employerMail(), 'x', 'wrong'), deps)).status).toBe(403);
  });

  it('classifies common multilingual messages by rules', () => {
    expect(classifyByRules({ subject: 'Colloquio conoscitivo', text: '' })).toBe('interview_invite');
    expect(classifyByRules({ subject: 'Votre candidature', text: 'Malheureusement nous avons retenu un autre candidat.' })).toBe('rejection');
    expect(classifyByRules({ subject: 'Candidatura', text: 'Abbiamo ricevuto la sua candidatura.' })).toBe('auto_acknowledgement');
    expect(classifyByRules({ subject: 'Hello', text: 'See attached', autoSubmitted: false })).toBe('other');
  });
});

describe('employer acknowledgement of a submit of unknown outcome', () => {
  // career-ops apply.md: an application is "sent" on the success page OR the confirmation e-mail.
  const ORDER_PATH = `assisted_applications/${ORDER}`;
  const GUARD_PATH = `${ORDER_PATH}/automation/submission`;
  const FLOW_PATH = `${ORDER_PATH}/automation/flow`;
  const classifyAs = (category: string) => async () => ({ category, summaryIt: '', summaryCandidate: '', interviewWhen: '', requestedDocuments: [], verificationCode: '', verificationUrl: '', needsReply: false });
  const ackMail = () => employerMail({ subject: 'Ihre Bewerbung', text: 'Wir haben Ihre Bewerbung erhalten.', auto: true });

  /** By default: the portal's final click at 600, the run reported portal_ambiguous, Valerie holds the order. */
  async function ambiguousOrder({
    flow = { state: 'owner_takeover', round: 1, heldBy: ['portal_ambiguous'] },
    guard = { state: 'sending', channel: 'portal', startedAt: 500, clickedAt: 600 },
    draft = null,
  }: any = {}) {
    const { store, alias } = await setupInbound();
    const orderRef = store.db.collection('assisted_applications').doc(ORDER);
    await orderRef.set({ submissionStatus: 'ready_for_manual_submission' }, { merge: true });
    await orderRef.collection('automation').doc('flow').set(flow);
    await orderRef.collection('automation').doc('submission').set({ r1: guard });
    if (draft) await orderRef.collection('ai_drafts').doc('current').set(draft);
    const effects: any[] = [];
    const runEffect = async (context: any) => {
      effects.push(context.effect);
      return runAutomationEffect(context);
    };
    const sendCascade = vi.fn(async () => ({ failed: [], sent: [{}] }));
    const receive = async (category: string, { nowMs = 1000, db = store.db }: any = {}) => (
      await deliver({ store, alias, db, raw: ackMail(), classify: classifyAs(category), sendCascade, runEffect, nowMs })
    ).processed;
    return { store, effects, sendCascade, receive };
  }

  it('confirms an ambiguous portal submit on the automatic acknowledgement, once', async () => {
    const { store, effects, receive } = await ambiguousOrder();
    expect(await receive('auto_acknowledgement')).toEqual({ ok: true, category: 'auto_acknowledgement', forwarded: 'sent', submissionConfirmed: true });
    expect(store.read(GUARD_PATH)!.r1).toMatchObject({ state: 'sent', channel: 'portal', sentAt: 600, confirmedBy: 'acknowledgement', confirmedAt: 1000 });
    expect(store.read(FLOW_PATH)).toMatchObject({ state: 'submitted', heldBy: [], submittedVia: 'portal' });
    expect(store.read(ORDER_PATH)).toMatchObject({ submissionStatus: 'submitted', automationState: 'submitted', automationDueAt: null });
    expect(effects).toEqual([{ type: 'mark_submitted' }]);
    const audit = store.list(`${ORDER_PATH}/events/`).map((path) => store.read(path));
    expect(audit.some((entry) => entry?.eventType === 'submit_acknowledged' && entry?.actor === 'employer_email' && entry?.fromState === 'owner_takeover')).toBe(true);

    // A second acknowledgement changes nothing.
    expect(await receive('auto_acknowledgement', { nowMs: 2000 })).toEqual({ ok: true, category: 'auto_acknowledgement', forwarded: 'sent' });
    expect(store.read(GUARD_PATH)!.r1.confirmedAt).toBe(1000);
    expect(effects).toHaveLength(1);
  });

  it('confirms an ambiguous e-mail application on the employer’s reply and schedules its follow-ups', async () => {
    const { store, effects, receive } = await ambiguousOrder({
      flow: { state: 'owner_takeover', round: 1, heldBy: ['email_ambiguous'] },
      guard: { state: 'sending', channel: 'email', startedAt: 600, clickedAt: null },
      draft: { round: 1, channel: { type: 'email', email: 'jobs@employer.example' }, applicationEmail: { to: 'jobs@employer.example', subject: 'Bewerbung als Pflegefachfrau' } },
    });
    expect((await receive('interview_invite')).submissionConfirmed).toBe(true);
    expect(store.read(GUARD_PATH)!.r1).toMatchObject({ state: 'sent', channel: 'email', sentAt: 600, confirmedBy: 'acknowledgement' });
    expect(store.read(FLOW_PATH)).toMatchObject({ state: 'submitted', submittedVia: 'email' });
    expect(store.read(ORDER_PATH)).toMatchObject({ submissionStatus: 'submitted', followupDueAt: 600 + 7 * DAY_MS });
    expect(store.read(`${ORDER_PATH}/automation/followup`)).toMatchObject({ state: 'scheduled', to: 'jobs@employer.example', subject: 'Bewerbung als Pflegefachfrau', messageId: '', submittedAt: 600 });
    expect(effects).toEqual([{ type: 'mark_submitted' }]);
  });

  it('never fires on an account verification or an unrelated message', async () => {
    for (const category of ['verification', 'other']) {
      const { store, effects, sendCascade, receive } = await ambiguousOrder();
      expect((await receive(category)).submissionConfirmed).toBeUndefined();
      expect(store.read(GUARD_PATH)!.r1).toEqual({ state: 'sending', channel: 'portal', startedAt: 500, clickedAt: 600 });
      expect(store.read(FLOW_PATH)!.state).toBe('owner_takeover');
      expect(store.read(ORDER_PATH)!.submissionStatus).toBe('ready_for_manual_submission');
      expect(effects).toEqual([]);
      // Still forwarded to the candidate as before.
      expect(sendCascade).toHaveBeenCalledTimes(1);
    }
  });

  it('never fires when nothing left: no final click, or a message older than the click', async () => {
    // The run died before pressing submit: an acknowledgement is about another application.
    const unclicked = await ambiguousOrder({ flow: { state: 'submitting', round: 1 }, guard: { state: 'sending', channel: 'portal', startedAt: 500, clickedAt: null } });
    expect((await unclicked.receive('auto_acknowledgement')).submissionConfirmed).toBeUndefined();
    expect(unclicked.store.read(GUARD_PATH)!.r1).toMatchObject({ state: 'sending', clickedAt: null });
    expect(unclicked.store.read(FLOW_PATH)!.state).toBe('submitting');
    expect(unclicked.effects).toEqual([]);

    // Received before the click (e.g. the portal account's welcome message, classified later).
    const early = await ambiguousOrder({ flow: { state: 'submitting', round: 1 }, guard: { state: 'sending', channel: 'portal', startedAt: 500, clickedAt: 1500 } });
    expect((await early.receive('auto_acknowledgement', { nowMs: 1000 })).submissionConfirmed).toBeUndefined();
    expect(early.store.read(GUARD_PATH)!.r1.state).toBe('sending');
    // After the click, a run still out is settled too.
    expect((await early.receive('auto_acknowledgement', { nowMs: 2000 })).submissionConfirmed).toBe(true);
    expect(early.store.read(FLOW_PATH)!.state).toBe('submitted');
    expect(early.store.read(GUARD_PATH)!.r1).toMatchObject({ state: 'sent', sentAt: 1500, confirmedAt: 2000 });
  });

  it('leaves a flow already submitted, and its guard, untouched', async () => {
    // e.g. the candidate confirmed it after a handoff: the guard still says "sending".
    const { store, effects, receive } = await ambiguousOrder({ flow: { state: 'submitted', round: 1 } });
    expect((await receive('auto_acknowledgement')).submissionConfirmed).toBeUndefined();
    expect(store.read(GUARD_PATH)!.r1).toEqual({ state: 'sending', channel: 'portal', startedAt: 500, clickedAt: 600 });
    expect(store.read(FLOW_PATH)!.state).toBe('submitted');
    expect(effects).toEqual([]);
  });

  it('keeps the message processed when the settlement fails, and settles on the employer’s next message', async () => {
    const { store, effects, sendCascade, receive } = await ambiguousOrder();
    let transactions = 0;
    // The inbox claim goes through; the flow's transaction is aborted once.
    const flaky = {
      ...store.db,
      runTransaction: async (callback: any) => {
        transactions += 1;
        if (transactions === 2) throw new Error('transaction aborted');
        return store.db.runTransaction(callback);
      },
    };
    expect(await receive('auto_acknowledgement', { db: flaky })).toEqual({ ok: true, category: 'auto_acknowledgement', forwarded: 'sent' });
    expect(store.read(GUARD_PATH)!.r1).toMatchObject({ state: 'sent', confirmedBy: 'acknowledgement', confirmedAt: 1000 });
    expect(store.read(FLOW_PATH)!.state).toBe('owner_takeover');
    expect(effects).toEqual([]);

    expect((await receive('rejection', { nowMs: 2000 })).submissionConfirmed).toBe(true);
    expect(store.read(FLOW_PATH)!.state).toBe('submitted');
    expect(store.read(GUARD_PATH)!.r1).toMatchObject({ sentAt: 600, confirmedAt: 1000 });
    expect(effects).toEqual([{ type: 'mark_submitted' }]);
    expect(sendCascade).toHaveBeenCalledTimes(2);
  });
});
