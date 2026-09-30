import { describe, expect, it, vi } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({
  getRemoteConfigValue: vi.fn(async () => ''),
  bridgeEmailCascadeCredentialsToEnv: vi.fn(async () => {}),
}));

const {
  ALIAS_DOMAIN,
  aliasLocalPart,
  ensureOrderAlias,
  newAliasLocalPart,
  orderIdForAlias,
  removeOrderAlias,
} = await import('../functions/src/assistedApplicationAlias.js');
const { classifyByRules, handleAssistedApplicationInbound } = await import('../functions/src/assistedApplicationInbound.js');
const { candidateIdentity } = await import('../functions/src/assistedApplicationAiDraftCore.js');
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
  return { files, file: (key: string) => ({ async save(content: string) { files.set(key, String(content)); } }) };
}

describe('order alias', () => {
  it('has the documented shape and only our domain resolves', () => {
    const local = newAliasLocalPart();
    expect(local).toMatch(/^c-[a-z2-9]{10}$/);
    expect(aliasLocalPart(`${local}@${ALIAS_DOMAIN}`)).toBe(local);
    expect(aliasLocalPart(`${local}@frontaliereticino.ch`)).toBe('');
    expect(aliasLocalPart('valerie@candidature.frontaliereticino.ch')).toBe('');
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

describe('employer messages on the alias', () => {
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
    const result = await handleAssistedApplicationInbound(request(employerMail(), alias.address), {
      db: store.db, bucket, secret: SECRET, runKey: RUN_KEY, classify, sendCascade, nowMs: 1000,
    });
    expect(result).toEqual({ status: 200, body: { ok: true, matched: true, category: 'interview_invite' } });
    const inbox = store.list(`assisted_applications/${ORDER}/inbox/`).map((path) => store.read(path)!);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ category: 'interview_invite', verificationCode: '', verificationUrl: '', from: 'hr@arbeitgeber.ch', classifiedBy: 'codex', forwarded: { status: 'sent' } });
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
    const sendCascade = vi.fn(async () => ({ failed: [], sent: [{}] }));
    await handleAssistedApplicationInbound(request(employerMail({ subject: 'Bitte bestätigen Sie Ihre E-Mail', text: 'Ihr Bestätigungscode lautet 482913' }), alias.address), {
      db: store.db, bucket: fakeBucket(), secret: SECRET, runKey: RUN_KEY, sendCascade,
      classify: async () => ({ category: 'verification', summaryIt: '', summaryCandidate: '', interviewWhen: '', requestedDocuments: [], verificationCode: '482913', verificationUrl: '', needsReply: false }),
    });
    const [first] = store.list(`assisted_applications/${ORDER}/inbox/`).map((path) => store.read(path)!);
    expect(first).toMatchObject({ category: 'verification', verificationCode: '482913' });

    const again = await setupInbound();
    await handleAssistedApplicationInbound(request(employerMail({ subject: 'Ihre Bewerbung', text: 'Wir haben Ihre Bewerbung erhalten.', auto: true }), again.alias.address), {
      db: again.store.db, bucket: fakeBucket(), secret: SECRET, runKey: RUN_KEY, sendCascade,
      classify: async () => { throw new Error('codex_auth_expired'); },
    });
    const [ack] = again.store.list(`assisted_applications/${ORDER}/inbox/`).map((path) => again.store.read(path)!);
    expect(ack).toMatchObject({ category: 'auto_acknowledgement', classifiedBy: 'rules' });
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
