import { describe, expect, it, vi } from 'vitest';
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
  it.each([
    ['display name containing @', 'Recruiting @ Azienda <maria.rossi@gmail.com>'],
    ['comment after the mailbox', 'maria.rossi@gmail.com (Recruiting)'],
  ])('accepts a valid From with %s', async (_label, from) => {
    const isEnabled = vi.fn(async () => false);
    const result = await handleAssistedApplicationEmailCv(request(rawMessage({ from })), {
      db: store().db,
      bucket: fakeBucket(),
      secret: SECRET,
      isEnabled,
    });

    expect(result.body).toMatchObject({ matched: false, reason: 'automation_off' });
    expect(isEnabled).toHaveBeenCalledWith(ORDER);
  });

  it('does nothing while the automation flag is off: the e-mail reaches Valerie as today', async () => {
    const database = store();
    const bucket = fakeBucket();
    const isEnabled = vi.fn(async () => false);
    const result = await handleAssistedApplicationEmailCv(request(rawMessage()), { db: database.db, bucket, secret: SECRET, isEnabled });
    expect(result.body).toEqual({ ok: true, matched: false, reason: 'automation_off' });
    expect(bucket.files.size).toBe(0);
    // Asked for this order: during the trial run only the named orders are on.
    expect(isEnabled).toHaveBeenCalledWith(ORDER);
  });

  it('rejects a request without the worker secret', async () => {
    const result = await handleAssistedApplicationEmailCv(request(rawMessage(), 'wrong'), { db: store().db, bucket: fakeBucket(), secret: SECRET });
    expect(result.status).toBe(403);
  });

  it('attaches the CV to the sender’s waiting order and keeps the notes', async () => {
    const database = store();
    const bucket = fakeBucket();
    const result = await handleAssistedApplicationEmailCv(request(rawMessage()), { db: database.db, bucket, secret: SECRET, nowMs: Date.UTC(2026, 8, 30, 9) });
    expect(result).toEqual({ status: 200, body: { ok: true, matched: true, cv: 'stored', reply: 'queued' } });
    const order = database.read(BASE)!;
    expect(order.cvStorageKey).toMatch(new RegExp(`^assisted-application-uploads/${ORDER}/\\d+-[0-9a-f-]+-CV-Maria\\.pdf$`));
    expect(order.cvFileName).toBe('CV-Maria.pdf');
    expect(order).toMatchObject({ cvUploadedBy: 'email_reply', submissionStatus: 'in_progress' });
    expect(bucket.files.get(order.cvStorageKey)!.equals(PDF)).toBe(true);
    expect(database.read(`${BASE}/automation/intake`)).toMatchObject({ emailNotes: 'Ciao Valerie, ho il permesso G e sono disponibile dal 1° novembre.' });
    expect(database.read('assisted_applications/order_OTHER')!.cvStorageKey).toBeUndefined();
    // The reply's own text waits for the facts reader (assistedApplicationCandidateReply.js).
    const [replyPath] = database.list(`${BASE}/candidate_replies/`);
    expect(database.read(replyPath)).toMatchObject({ status: 'received', cv: 'stored', attempts: 0, text: 'Ciao Valerie, ho il permesso G e sono disponibile dal 1° novembre.' });
  });

  it('deletes its file when a retried transaction finds a CV uploaded meanwhile', async () => {
    const database = store();
    const bucket = fakeBucket();
    // First attempt: no CV yet, but the commit loses to an upload from the order page; Firestore retries.
    const contended = {
      ...database.db,
      runTransaction: async (callback: any) => {
        await callback({ get: (ref: any) => ref.get(), set: () => {}, delete: () => {} });
        await database.db.collection('assisted_applications').doc(ORDER).set({ cvStorageKey: `assisted-application-uploads/${ORDER}/page.pdf` }, { merge: true });
        return database.db.runTransaction(callback);
      },
    };
    const result = await handleAssistedApplicationEmailCv(request(rawMessage()), { db: contended, bucket, secret: SECRET });
    // The CV loses to the page's; the reply's text is still read for its facts.
    expect(result.body).toEqual({ ok: true, matched: true, cv: 'already_present', reply: 'queued' });
    expect(bucket.files.size).toBe(0);
    expect(database.read(`assisted_applications/${ORDER}`)).toMatchObject({ cvStorageKey: `assisted-application-uploads/${ORDER}/page.pdf` });
  });

  it('never replaces an existing CV, but still reads the reply of an order that has one (case 8BhQom09)', async () => {
    const withCv = store({ cvStorageKey: `assisted-application-uploads/${ORDER}/old.pdf` });
    const bucket = fakeBucket();
    expect((await handleAssistedApplicationEmailCv(request(rawMessage()), { db: withCv.db, bucket, secret: SECRET })).body)
      .toEqual({ ok: true, matched: true, cv: 'already_present', reply: 'queued' });
    expect(bucket.files.size).toBe(0);
    expect(withCv.read(BASE)).toMatchObject({ cvStorageKey: `assisted-application-uploads/${ORDER}/old.pdf` });
    expect(withCv.list(`${BASE}/candidate_replies/`)).toHaveLength(1);
  });

  it('ignores forged senders; a non-CV file is not stored but the text is read', async () => {
    const forged = rawMessage({ auth: 'mx.cloudflare.net; dkim=fail; spf=fail' });
    const forgedStore = store();
    expect((await handleAssistedApplicationEmailCv(request(forged), { db: forgedStore.db, bucket: fakeBucket(), secret: SECRET })).body)
      .toMatchObject({ matched: false, reason: 'unauthenticated' });
    expect(forgedStore.list(`${BASE}/candidate_replies/`)).toEqual([]);
    const exe = rawMessage({ attachment: Buffer.from('MZ\u0090\u0000binary'), filenameHeader: 'filename="cv.exe"' });
    const bucket = fakeBucket();
    expect((await handleAssistedApplicationEmailCv(request(exe), { db: store().db, bucket, secret: SECRET })).body)
      .toEqual({ ok: true, matched: true, cv: 'none', reply: 'queued' });
    expect(bucket.files.size).toBe(0);
  });

  it('reads a text-only reply, once per message, for the sender’s order only', async () => {
    const textOnly = (messageId: string, body: string, from = 'Maria Rossi <maria.rossi@gmail.com>') => Buffer.from([
      'Authentication-Results: mx.cloudflare.net; dkim=pass header.d=gmail.com; spf=pass smtp.mailfrom=maria.rossi@gmail.com',
      `From: ${from}`,
      `Message-ID: <${messageId}@mail.gmail.com>`,
      'Subject: Re: La tua candidatura',
      'Content-Type: text/plain; charset=utf-8',
      '',
      body,
    ].join('\r\n'));
    const database = store();
    const first = await handleAssistedApplicationEmailCv(request(textOnly('one', 'Permesso C, disponibile da 1/12/2026')), { db: database.db, bucket: fakeBucket(), secret: SECRET });
    expect(first.body).toEqual({ ok: true, matched: true, cv: 'none', reply: 'queued' });
    const again = await handleAssistedApplicationEmailCv(request(textOnly('one', 'Permesso C, disponibile da 1/12/2026')), { db: database.db, bucket: fakeBucket(), secret: SECRET });
    expect(again.body).toEqual({ ok: true, matched: false, cv: 'none', reply: 'duplicate' });
    expect(database.list(`${BASE}/candidate_replies/`)).toHaveLength(1);
    expect(database.read('assisted_applications/order_OTHER')).not.toHaveProperty('candidateFacts');
    const stranger = textOnly('two', 'Permesso C', 'Someone <stranger@gmail.com>');
    // Authenticated, but the sender owns no order: nothing is written anywhere.
    expect((await handleAssistedApplicationEmailCv(request(stranger), { db: database.db, bucket: fakeBucket(), secret: SECRET })).body)
      .toMatchObject({ matched: false, reason: 'no_open_order' });
    expect(database.list(`${BASE}/candidate_replies/`)).toHaveLength(1);
    const empty = textOnly('three', '> only quoted history');
    expect((await handleAssistedApplicationEmailCv(request(empty), { db: database.db, bucket: fakeBucket(), secret: SECRET })).body)
      .toMatchObject({ matched: false, reason: 'nothing_to_read' });
  });

  it('applies a reply to the order it quotes by reference, else to the most recent open one', async () => {
    const database = createMemoryFirestore({
      'assisted_applications/order_OLDER001': { paymentStatus: 'paid', submissionStatus: 'in_progress', customerEmail: 'maria.rossi@gmail.com', paidAt: '2026-09-01T08:00:00Z' },
      'assisted_applications/order_NEWER001': { paymentStatus: 'paid', submissionStatus: 'in_progress', customerEmail: 'maria.rossi@gmail.com', paidAt: '2026-09-30T08:00:00Z' },
      'assisted_applications/order_SENT0001': { paymentStatus: 'paid', submissionStatus: 'submitted', customerEmail: 'maria.rossi@gmail.com', paidAt: '2026-10-30T08:00:00Z' },
    });
    const reply = (body: string, id: string) => Buffer.from([
      'Authentication-Results: mx.cloudflare.net; dkim=pass header.d=gmail.com',
      'From: maria.rossi@gmail.com',
      `Message-ID: <${id}@mail.gmail.com>`,
      'Subject: Re: La tua candidatura',
      'Content-Type: text/plain; charset=utf-8',
      '',
      body,
    ].join('\r\n'));
    await handleAssistedApplicationEmailCv(request(reply('Permesso C\n\n> Riferimento ordine: order_OLDER001', 'a')), { db: database.db, bucket: fakeBucket(), secret: SECRET });
    expect(database.list('assisted_applications/order_OLDER001/candidate_replies/')).toHaveLength(1);
    await handleAssistedApplicationEmailCv(request(reply('Permesso C', 'b')), { db: database.db, bucket: fakeBucket(), secret: SECRET });
    expect(database.list('assisted_applications/order_NEWER001/candidate_replies/')).toHaveLength(1);
    expect(database.list('assisted_applications/order_SENT0001/candidate_replies/')).toEqual([]);
  });

  it('rejects an authenticated but ambiguous multi-mailbox From header', async () => {
    const ambiguous = rawMessage({
      from: 'Maria Rossi <maria.rossi@gmail.com>, Other Sender <other@gmail.com>',
    });
    const bucket = fakeBucket();
    const result = await handleAssistedApplicationEmailCv(request(ambiguous), { db: store().db, bucket, secret: SECRET });

    expect(result.body).toMatchObject({ matched: false, reason: 'unauthenticated' });
    expect(bucket.files.size).toBe(0);
  });

  it('strips Spanish and wrapped multi-line Gmail quote attribution headers in candidateNotesFrom', async () => {
    const { candidateNotesFrom } = await import('../functions/src/assistedApplicationEmailCv.js');
    expect(candidateNotesFrom(
      'Permesso G valido.\n\nEl lun, 23 nov 2026, 8:35, Valerie · Frontaliere Ticino <\nvalerie@frontaliereticino.ch> escribió:\n> vecchio testo'
    )).toBe('Permesso G valido.');
    expect(candidateNotesFrom(
      'El lun, 23 nov 2026, 8:35, Valerie · Frontaliere Ticino <\nvalerie@frontaliereticino.ch> escribió:\n> vecchio testo'
    )).toBe('');
    expect(candidateNotesFrom(
      'Le mie competenze\nX a écrit:\nnota'
    )).toBe('Le mie competenze\nX a écrit:\nnota');
  });

  it('converts JPEG and multi-page raster image CVs to PDF while skipping small signature icons', async () => {
    const sharp = (await import('sharp')).default;
    const { PDFDocument } = await import('pdf-lib');
    const { detectCvImageType } = await import('../functions/src/lib/imageCvToPdf.js');

    const jpegPage = await sharp({
      create: { width: 600, height: 850, channels: 3, background: { r: 245, g: 245, b: 245 } },
    }).jpeg({ quality: 85 }).toBuffer();
    const pngPage = await sharp({
      create: { width: 600, height: 850, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0.5 } },
    }).png().toBuffer();
    const tinyIcon = await sharp({
      create: { width: 80, height: 80, channels: 3, background: { r: 0, g: 120, b: 200 } },
    }).png().toBuffer();

    expect(detectCvImageType(jpegPage.subarray(0, 16))).toBe('jpeg');
    expect(detectCvImageType(pngPage.subarray(0, 16))).toBe('png');
    expect(detectCvImageType(Buffer.from('not-an-image'))).toBeNull();

    const boundary = 'b_img_cv';
    const mime = Buffer.from([
      'Authentication-Results: mx.cloudflare.net; dkim=pass header.d=gmail.com; spf=pass smtp.mailfrom=maria.rossi@gmail.com',
      'From: Maria Rossi <maria.rossi@gmail.com>',
      'Message-ID: <img-cv-1@mail.gmail.com>',
      'Subject: Re: La tua candidatura',
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Allego il mio CV in formato foto.',
      `--${boundary}`,
      'Content-Type: image/png; name="sig.png"',
      'Content-Disposition: inline; filename="sig.png"',
      'Content-Transfer-Encoding: base64',
      '',
      tinyIcon.toString('base64'),
      `--${boundary}`,
      'Content-Type: image/jpeg; name="CVFoto.jpg"',
      'Content-Disposition: attachment; filename="CVFoto.jpg"',
      'Content-Transfer-Encoding: base64',
      '',
      jpegPage.toString('base64').replace(/(.{76})/g, '$1\r\n'),
      `--${boundary}`,
      'Content-Type: image/png; name="CVPagina2.png"',
      'Content-Disposition: attachment; filename="CVPagina2.png"',
      'Content-Transfer-Encoding: base64',
      '',
      pngPage.toString('base64').replace(/(.{76})/g, '$1\r\n'),
      `--${boundary}--`,
      '',
    ].join('\r\n'));

    const database = store();
    const bucket = fakeBucket();
    const result = await handleAssistedApplicationEmailCv(request(mime), { db: database.db, bucket, secret: SECRET });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true, matched: true, cv: 'stored', reply: 'queued' });
    const [storedKey, stored] = [...bucket.files.entries()][0];
    expect(storedKey).toMatch(/CVFoto\.pdf$/);
    expect(stored.subarray(0, 5).toString('utf8')).toBe('%PDF-');
    const loadedPdf = await PDFDocument.load(stored);
    expect(loadedPdf.getPageCount()).toBe(2);
    expect(database.read(BASE)?.cvFileName).toBe('CVFoto.pdf');
    const eventKeys = database.list(`${BASE}/events/`);
    expect(eventKeys).toHaveLength(1);
    expect(database.read(eventKeys[0])).toMatchObject({
      eventType: 'materials_received_by_email',
      detectedType: 'pdf',
      convertedFrom: 'jpeg',
      pageCount: 2,
    });
  });

  it('filters MIME-inline and Content-ID banners from resolveCvAttachmentFromEmail while converting attached CV images', async () => {
    const sharp = (await import('sharp')).default;
    const { resolveCvAttachmentFromEmail } = await import('../functions/src/lib/imageCvToPdf.js');
    // High-entropy 600x200 raster so compressed output exceeds 25 KB.
    const raw = Buffer.alloc(600 * 200 * 3);
    for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 73 + (i >> 5)) & 0xff;
    const banner = await sharp(raw, { raw: { width: 600, height: 200, channels: 3 } })
      .jpeg({ quality: 92 })
      .toBuffer();
    expect(banner.length).toBeGreaterThan(25_000);

    expect(await resolveCvAttachmentFromEmail([
      { filename: 'sig-banner.jpg', contentType: 'image/jpeg', contentDisposition: 'inline', content: banner },
    ])).toBeNull();
    expect(await resolveCvAttachmentFromEmail([
      { filename: 'cid-banner.jpg', contentType: 'image/jpeg', contentId: 'banner@example.com', content: banner },
    ])).toBeNull();

    const parsedInline = parseMimeMessage(Buffer.from([
      'From: Maria Rossi <maria.rossi@gmail.com>',
      'Subject: Re: CV',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="b_cid"',
      '',
      '--b_cid',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Saluti',
      '--b_cid',
      'Content-Type: image/jpeg; name="banner.jpg"',
      'Content-Disposition: inline; filename="banner.jpg"',
      'Content-ID: <banner123@gmail.com>',
      'Content-Transfer-Encoding: base64',
      '',
      banner.toString('base64').replace(/(.{76})/g, '$1\r\n'),
      '--b_cid--',
      '',
    ].join('\r\n')));
    expect(parsedInline.attachments[0]).toMatchObject({ contentDisposition: 'inline', contentId: 'banner123@gmail.com' });
    expect(await resolveCvAttachmentFromEmail(parsedInline.attachments)).toBeNull();

    const attached = await resolveCvAttachmentFromEmail([
      { filename: 'CV_Photo.jpg', contentType: 'image/jpeg', contentDisposition: 'attachment', content: banner },
    ]);
    expect(attached).not.toBeNull();
    expect(attached?.type).toBe('pdf');
    expect(attached?.content.subarray(0, 5).toString('utf8')).toBe('%PDF-');
  });

  it('normalizes raster image uploads via normalizeUploadedCvBuffer for admin/owner uploads', async () => {
    const sharp = (await import('sharp')).default;
    const { normalizeUploadedCvBuffer } = await import('../functions/src/lib/imageCvToPdf.js');
    const jpeg = await sharp({
      create: { width: 500, height: 700, channels: 3, background: { r: 255, g: 255, b: 255 } },
    }).jpeg({ quality: 80 }).toBuffer();
    const normalized = await normalizeUploadedCvBuffer(jpeg);
    expect(normalized).not.toBeNull();
    expect(normalized?.type).toBe('pdf');
    expect(normalized?.convertedFrom).toBe('jpeg');
    expect(normalized?.buffer.subarray(0, 5).toString('utf8')).toBe('%PDF-');
  });
});
