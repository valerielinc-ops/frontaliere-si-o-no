import { describe, expect, it } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { addressOf, decodeEncodedWords, parseMimeMessage, senderAuthenticated } from '../functions/src/lib/mimeMessage.js';
import { candidateNotesFrom, handleAssistedApplicationEmailCv } from '../functions/src/assistedApplicationEmailCv.js';

const SECRET = 'stop-secret-for-tests';
const PDF = Buffer.from('%PDF-1.4\nfake cv content\n%%EOF');
const ORDER = 'order_MAIL01';
const BASE = `assisted_applications/${ORDER}`;

function rawMessage({
  from = 'Maria Rossi <maria.rossi@gmail.com>',
  auth = 'mx.cloudflare.net; dkim=pass header.d=gmail.com header.s=20230601; spf=pass smtp.mailfrom=maria.rossi@gmail.com',
  extraAuth = '',
  attachment = PDF,
  filenameHeader = "filename*=utf-8''CV%20Mar%C3%ADa.pdf",
} = {}) {
  const boundary = 'b1_mixed';
  return Buffer.from([
    `Authentication-Results: ${auth}`,
    ...(extraAuth ? [`Authentication-Results: ${extraAuth}`] : []),
    `From: ${from}`,
    'Subject: =?utf-8?Q?Re:_La_tua_candidatura_=C3=A8_pronta?=',
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: multipart/alternative; boundary="b2_alt"',
    '',
    '--b2_alt',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'Ciao Valerie, ho il permesso G e sono disponibile dal 1=C2=B0 novembre.',
    '',
    'Il giorno 30 set 2026, Valerie ha scritto:',
    '> ecco cosa mi serve',
    '--b2_alt--',
    `--${boundary}`,
    `Content-Type: application/pdf; name="cv.pdf"`,
    `Content-Disposition: attachment; ${filenameHeader}`,
    'Content-Transfer-Encoding: base64',
    '',
    attachment.toString('base64').replace(/(.{76})/g, '$1\r\n'),
    `--${boundary}--`,
    '',
  ].join('\r\n'), 'latin1');
}

function fakeBucket() {
  const files = new Map<string, Buffer>();
  return {
    files,
    file: (key: string) => ({
      async save(content: Buffer) { files.set(key, Buffer.from(content)); },
      async delete() { files.delete(key); },
    }),
  };
}

const request = (raw: Buffer, secret = SECRET) => ({
  method: 'POST',
  rawBody: raw,
  get: (name: string) => (name === 'x-stop-secret' ? secret : undefined),
});

function store(order: Record<string, any> = {}) {
  return createMemoryFirestore({
    [BASE]: { paymentStatus: 'paid', submissionStatus: 'awaiting_upload', customerEmail: 'Maria.Rossi@gmail.com', paidAt: '2026-09-30T08:00:00Z', ...order },
    'assisted_applications/order_OTHER': { paymentStatus: 'paid', submissionStatus: 'awaiting_upload', customerEmail: 'someone@else.ch' },
  });
}

describe('MIME reader', () => {
  it('reads nested parts, encodings and RFC 2231 / 2047 names', () => {
    const message = parseMimeMessage(rawMessage());
    expect(addressOf(message.from)).toBe('maria.rossi@gmail.com');
    expect(message.subject).toBe('Re: La tua candidatura è pronta');
    expect(message.text).toContain('disponibile dal 1° novembre');
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0]).toMatchObject({ filename: 'CV María.pdf', contentType: 'application/pdf' });
    expect(message.attachments[0].content.equals(PDF)).toBe(true);
    expect(decodeEncodedWords('=?UTF-8?B?Q1ZfUsOpc3Vtw6kucGRm?=')).toBe('CV_Résumé.pdf');
  });

  it('trusts only the topmost Authentication-Results and an aligned domain', () => {
    const genuine = parseMimeMessage(rawMessage());
    expect(senderAuthenticated(genuine.headers, 'maria.rossi@gmail.com')).toBe(true);
    const forged = parseMimeMessage(rawMessage({
      from: 'maria.rossi@gmail.com',
      auth: 'mx.cloudflare.net; dkim=none; spf=softfail smtp.mailfrom=evil.example',
      extraAuth: 'mx.cloudflare.net; dkim=pass header.d=gmail.com',
    }));
    expect(senderAuthenticated(forged.headers, 'maria.rossi@gmail.com')).toBe(false);
    const otherDomain = parseMimeMessage(rawMessage({ auth: 'mx.cloudflare.net; dkim=pass header.d=evil.example' }));
    expect(senderAuthenticated(otherDomain.headers, 'maria.rossi@gmail.com')).toBe(false);
  });

  it('keeps the reply and drops the quoted history', () => {
    expect(candidateNotesFrom('Ho il permesso G.\n\nOn Tue, Sep 30, 2026 Valerie wrote:\n> old text')).toBe('Ho il permesso G.');
    expect(candidateNotesFrom('> only quoted\nNuova riga')).toBe('Nuova riga');
  });
});

describe('CV by e-mail reply', () => {
  it('does nothing while the automation flag is off: the e-mail reaches Valerie as today', async () => {
    const database = store();
    const bucket = fakeBucket();
    const result = await handleAssistedApplicationEmailCv(request(rawMessage()), { db: database.db, bucket, secret: SECRET, isEnabled: async () => false });
    expect(result.body).toEqual({ ok: true, matched: false, reason: 'automation_off' });
    expect(bucket.files.size).toBe(0);
  });

  it('rejects a request without the worker secret', async () => {
    const result = await handleAssistedApplicationEmailCv(request(rawMessage(), 'wrong'), { db: store().db, bucket: fakeBucket(), secret: SECRET });
    expect(result.status).toBe(403);
  });

  it('attaches the CV to the sender’s waiting order and keeps the notes', async () => {
    const database = store();
    const bucket = fakeBucket();
    const result = await handleAssistedApplicationEmailCv(request(rawMessage()), { db: database.db, bucket, secret: SECRET, nowMs: Date.UTC(2026, 8, 30, 9) });
    expect(result).toEqual({ status: 200, body: { ok: true, matched: true } });
    const order = database.read(BASE)!;
    expect(order.cvStorageKey).toMatch(new RegExp(`^assisted-application-uploads/${ORDER}/\\d+-[0-9a-f-]+-CV-Maria\\.pdf$`));
    expect(order).toMatchObject({ cvUploadedBy: 'email_reply', submissionStatus: 'in_progress' });
    expect(bucket.files.get(order.cvStorageKey)!.equals(PDF)).toBe(true);
    expect(database.read(`${BASE}/automation/intake`)).toMatchObject({ emailNotes: 'Ciao Valerie, ho il permesso G e sono disponibile dal 1° novembre.' });
    expect(database.read('assisted_applications/order_OTHER')!.cvStorageKey).toBeUndefined();
  });

  it('never replaces an existing CV, ignores forged senders and non-CV files', async () => {
    const withCv = store({ cvStorageKey: `assisted-application-uploads/${ORDER}/old.pdf` });
    expect((await handleAssistedApplicationEmailCv(request(rawMessage()), { db: withCv.db, bucket: fakeBucket(), secret: SECRET })).body)
      .toMatchObject({ matched: false, reason: 'no_waiting_order' });
    const forged = rawMessage({ auth: 'mx.cloudflare.net; dkim=fail; spf=fail' });
    expect((await handleAssistedApplicationEmailCv(request(forged), { db: store().db, bucket: fakeBucket(), secret: SECRET })).body)
      .toMatchObject({ matched: false, reason: 'unauthenticated' });
    const exe = rawMessage({ attachment: Buffer.from('MZ\u0090\u0000binary'), filenameHeader: 'filename="cv.exe"' });
    expect((await handleAssistedApplicationEmailCv(request(exe), { db: store().db, bucket: fakeBucket(), secret: SECRET })).body)
      .toMatchObject({ matched: false, reason: 'no_cv_attachment' });
  });
});
