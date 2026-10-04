import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { jsPDF } from 'jspdf';
import sharp from 'sharp';
import { PDFDocument, PDFHexString, PDFName, PDFString } from 'pdf-lib';
import { getDocumentProxy, getResolvedPDFJS } from 'unpdf';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { JPEG_2X2 } from './helpers/pdfImages';

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({
  getRemoteConfigValue: vi.fn(async () => ''),
  bridgeEmailCascadeCredentialsToEnv: vi.fn(async () => {}),
}));

const { keepSentFiles, portalUploads, recordOfSend, submitApplication } = await import('../scripts/assisted-application/lib/submit.mjs');
const { keepSentRecord } = await import('../scripts/assisted-application/agent.mjs');
const { decryptJson } = await import('../scripts/assisted-application/lib/secure-run.mjs');
const { submissionGuard } = await import('../functions/src/assistedApplicationSubmissionGuard.js');
const { loadAutomationForAdmin, recordOwnerSubmission } = await import('../functions/src/assistedApplicationAutomationAdmin.js');
const { checkDraftTexts, sanitizeProfile } = await import('../functions/src/assistedApplicationAiDraftCore.js');
const { renderCvPdf } = await import('../functions/src/assistedApplicationPdfRenderer.js');
const { buildCvDocument } = await import('../functions/src/assistedApplicationCvDocument.js');
const { sanitizeTailoredCv } = await import('../functions/src/assistedApplicationTailoredCv.js');
const { sentSummaryIt } = await import('../services/assistedApplicationSentRecord');

// What leaves with an e-mail application and the record of what left, on the runner's real path
// (submitApplication with a Typst letter rebuilt at submit and a Typst tailored CV). An invented
// German nurse (study 2026-10-02).
const ORDER = 'order_SENT01';
const BASE = `assisted_applications/${ORDER}`;
const KEY = Buffer.alloc(32, 5);
const NOW = Date.UTC(2026, 9, 3, 9, 30, 0);
const UPLOADS = `assisted-application-uploads/${ORDER}`;
const TAILORED_KEY = `${UPLOADS}/ai-cv-r1-1.pdf`;
const STORED_LETTER_KEY = `${UPLOADS}/ai-cover-letter-r1-1.pdf`;
const DOCUMENT_KEYS = { pdf: `${UPLOADS}/doc-arbeitszeugnisse-1.pdf`, jpg: `${UPLOADS}/doc-arbeitszeugnisse-2.jpg`, docx: `${UPLOADS}/doc-arbeitszeugnisse-3.docx`, png: `${UPLOADS}/doc-arbeitszeugnisse-4.png`, signed: `${UPLOADS}/doc-arbeitszeugnisse-5.pdf` };
const SENT_KEY = (kind: string, prefix = 'sent', nowMs = NOW) => `${UPLOADS}/${prefix}-r1-${nowMs}-${kind}.pdf`;
const POSTING = 'Das Spital Beispiel sucht eine Pflegefachfrau HF für die Akutpflege. Wir freuen uns auf Ihre Bewerbung.';
const ONE_PDF = 'Bitte senden Sie Ihre vollständigen Bewerbungsunterlagen in einem PDF an hr@beispiel.ch.';
const SEPARATE_PDFS = 'Bitte senden Sie Lebenslauf, Motivationsschreiben und Zeugnisse als separate PDF-Dateien.';
const PASTA = 'https://prod.pastahr.com/en/r/SPIT2003';

const order = {
  jobId: 'spital-beispiel-123', jobUrl: 'https://jobs.example.ch/spital/1', jobTitle: 'Pflegefachfrau HF', companyName: 'Spital Beispiel AG',
  locale: 'de', applicantName: 'Maria Rossi', applicantEmail: 'maria.rossi@example.com', applicantPhone: '+41 79 000 00 00',
  cvStorageKey: `${UPLOADS}/1-cv.pdf`,
};
const profile = {
  fullName: 'Maria Rossi', headline: 'Pflegefachfrau HF', location: 'Como', languages: [{ language: 'Deutsch', level: 'B2' }],
  experience: [{ role: 'Pflegefachfrau HF', employer: 'Spital Beispiel', location: 'Lugano', start: '2018', end: '2023', kind: 'job', highlights: ['Akutpflege auf einer Station mit 24 Betten.'] }],
  education: [], certifications: [], skills: [],
};
const coverLetter = {
  salutation: 'Sehr geehrte Damen und Herren',
  paragraphs: ['Seit 2018 arbeite ich in der Akutpflege auf einer Station mit 24 Betten.', 'Gerne stelle ich mich Ihnen persönlich vor.'],
  closing: 'Freundliche Grüsse',
};

const pdfOf = (text: string, pages = 1) => {
  const doc = new jsPDF();
  for (let page = 0; page < pages; page += 1) {
    if (page) doc.addPage();
    doc.text(pages > 1 ? `${text} ${page + 1}` : text, 20, 20);
  }
  return Buffer.from(doc.output('arraybuffer'));
};
const noise = (length: number) => {
  const out = Buffer.alloc(length);
  for (let offset = 0, counter = 0; offset < length; counter += 1) offset += createHash('sha256').update(String(counter)).digest().copy(out, offset);
  return out;
};
const imageOnlyPdf = () => {
  const doc = new jsPDF();
  doc.addImage(new Uint8Array(JPEG_2X2), 'JPEG', 10, 10, 50, 50);
  return Buffer.from(doc.output('arraybuffer'));
};
async function signedPdf(text: string) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([595.28, 841.89]);
  page.drawText(text, { x: 50, y: 780, size: 12 });
  const signature = doc.context.obj({ Type: 'Sig', Filter: 'Adobe.PPKLite', SubFilter: 'adbe.pkcs7.detached', ByteRange: [0, 0, 0, 0], Contents: PDFHexString.of('00'.repeat(64)) });
  const field = doc.context.register(doc.context.obj({ FT: 'Sig', T: PDFString.of('Signature1'), V: doc.context.register(signature), Type: 'Annot', Subtype: 'Widget', Rect: [0, 0, 0, 0], F: 132, P: page.ref }));
  page.node.set(PDFName.of('Annots'), doc.context.obj([field]));
  doc.catalog.set(PDFName.of('AcroForm'), doc.context.obj({ Fields: [field], SigFlags: 3 }));
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

const fixtures = { tailoredCv: Buffer.alloc(0), reference: Buffer.alloc(0), photo: Buffer.alloc(0), heavyPng: Buffer.alloc(0), signed: Buffer.alloc(0) };
const CV_TEXT = 'Maria Rossi\nPflegefachfrau HF\nSpital Beispiel, Lugano, 2018 – 2023\nAkutpflege auf einer Station mit 24 Betten.\nDeutsch B2';
beforeAll(async () => {
  const sanitized = sanitizeProfile(profile);
  const identity = { name: 'Maria Rossi', email: 'maria.rossi@example.com', phone: '+41 79 000 00 00' };
  const cv = await renderCvPdf(buildCvDocument(sanitizeTailoredCv(
    { headline: 'Pflegefachfrau HF', summary: 'Pflegefachfrau mit Erfahrung in der Akutpflege.', competencies: [], experience: [], skills: [] },
    { profile: sanitized, cvText: CV_TEXT, language: 'de', type: 'qualified', sector: 'health', title: 'Pflegefachfrau HF' },
  ), { identity, profile: sanitized, language: 'de', type: 'qualified', sector: 'health' }));
  expect(cv.renderer).toBe('typst');
  fixtures.tailoredCv = cv.pdf;
  fixtures.reference = pdfOf('Arbeitszeugnis Beispiel AG');
  // Stored 1600×1200, shown upright 1200×1600: a phone's photo of a certificate.
  fixtures.photo = await sharp(noise(1600 * 1200 * 3), { raw: { width: 1600, height: 1200, channels: 3 } }).jpeg({ quality: 40 }).withMetadata({ orientation: 6 }).toBuffer();
  fixtures.heavyPng = await sharp(noise(900 * 900 * 3), { raw: { width: 900, height: 900, channels: 3 } }).png().toBuffer();
  fixtures.signed = await signedPdf('Signiertes Arbeitszeugnis');
}, 60_000);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function fakeBucket({ refuse = null as RegExp | null } = {}) {
  const files = new Map<string, Buffer>();
  const saved: Array<{ key: string; options: any }> = [];
  files.set(TAILORED_KEY, fixtures.tailoredCv);
  files.set(DOCUMENT_KEYS.pdf, fixtures.reference);
  files.set(DOCUMENT_KEYS.jpg, fixtures.photo);
  files.set(DOCUMENT_KEYS.docx, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(200)]));
  files.set(DOCUMENT_KEYS.png, fixtures.heavyPng);
  files.set(DOCUMENT_KEYS.signed, fixtures.signed);
  return {
    files,
    saved,
    file: (key: string) => ({
      async save(content: Buffer | string, options?: any) {
        if (refuse?.test(key)) throw Object.assign(new Error('storage unavailable'), { code: 503 });
        files.set(key, Buffer.from(content));
        saved.push({ key, options });
      },
      async download() {
        if (!files.has(key)) throw Object.assign(new Error('missing'), { code: 404 });
        return [files.get(key)];
      },
      async delete() { files.delete(key); },
    }),
  };
}

function draftFor(over: Record<string, any> = {}) {
  const draft: Record<string, any> = {
    status: 'ready', round: 1, language: 'de', candidateType: { type: 'qualified', sector: 'health' }, profile,
    job: { title: 'Pflegefachfrau HF', applyUrl: '' },
    channel: { type: 'email', email: 'hr@beispiel.ch', applyUrl: '' },
    letterAddress: { contactPerson: '', streetAddress: 'Beispielstrasse 1', postalCode: '8000', location: 'Zürich' },
    coverLetter: { ...coverLetter, text: [coverLetter.salutation, ...coverLetter.paragraphs, coverLetter.closing].join('\n\n') },
    applicationEmail: { to: 'hr@beispiel.ch', subject: 'Bewerbung als Pflegefachfrau HF – Maria Rossi', body: 'Sehr geehrte Damen und Herren\n\nim Anhang finden Sie meinen Lebenslauf und mein Motivationsschreiben.\n\nFreundliche Grüsse' },
    coverLetterPdfKey: STORED_LETTER_KEY, coverLetterRenderer: 'typst',
    questions: [], formAnswers: [],
    factSources: { text: CV_TEXT, posting: POSTING, order: '' },
    tailoredCv: { status: 'ready', pdfKey: TAILORED_KEY, renderer: 'typst' },
    requiredDocuments: [{ id: 'arbeitszeugnisse', label: 'Arbeitszeugnisse', kind: 'reference', required: true }],
    ...over,
  };
  // The gate of the day runs again at submit: its result kept with the owner's confirmation, so the
  // cases here do not depend on what it finds in these texts.
  const factCheck = checkDraftTexts({ coverLetter: draft.coverLetter.text, emailSubject: draft.applicationEmail.subject, emailBody: draft.applicationEmail.body }, draft.factSources, { language: 'de' });
  return { ...draft, factCheck: { ...factCheck, basis: 'pdf_text' }, factCheckAcknowledgedAt: 1 };
}
const withAd = (sentence: string, over: Record<string, any> = {}) => draftFor({ applicationInstructions: sentence, factSources: { text: CV_TEXT, posting: `${POSTING} ${sentence}`, order: '' }, ...over });
const documentFile = (kind: keyof typeof DOCUMENT_KEYS, detectedType: string = kind) => ({ key: DOCUMENT_KEYS[kind], name: `zeugnis.${detectedType}`, detectedType });
const flowWith = (...files: Array<ReturnType<typeof documentFile>>) => ({ round: 1, answers: {}, documents: { arbeitszeugnisse: { files } } });
const TWO_DOCUMENTS = flowWith(documentFile('pdf'), documentFile('jpg'));

const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
const fakeFetch = () => vi.fn(async (url: string, init: any = {}) => {
  if (url.startsWith('https://cdn.frontaliereticino.ch/data/job-detail/')) return new Response(init.method === 'HEAD' ? null : '{}', { status: 200 });
  return new Response(`<main><p>${'Pflegefachfrau HF im Spital Beispiel. '.repeat(20)}</p><a>Jetzt bewerben</a></main>`, { status: 200, headers: { 'content-type': 'text/html' } });
});
const delivered = () => vi.fn(async () => ({ failed: [], sent: [{ provider: 'resend', messageId: 'm1' }] }));

async function submit({ draft = draftFor(), flow = TWO_DOCUMENTS, bucket = fakeBucket(), sendCascade = delivered(), lines = [] as string[], nowMs = NOW, ...extra }: Record<string, any> = {}) {
  return submitApplication({
    order, orderId: ORDER, flow, draft, bucket, runKey: KEY, nowMs, sendCascade,
    cvBuffer: pdfOf('Lebenslauf Maria Rossi'), cvType: 'pdf',
    resolve: publicDns, fetchImpl: fakeFetch(), log: (...args: unknown[]) => lines.push(args.join(' ')),
    ...extra,
  });
}
const attachmentsOf = (sendCascade: any) => sendCascade.mock.calls[0][0][0].payload.attachments as Array<{ filename: string; content: string }>;
const evidence = (bucket: ReturnType<typeof fakeBucket>, name: string, nowMs = NOW) => decryptJson(JSON.parse(bucket.files.get(`${UPLOADS}/run-${nowMs}-${name}.json.enc`)!.toString('utf8')), KEY);
async function pageTexts(bytes: Buffer) {
  const pdf = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
  const out: string[] = [];
  for (let number = 1; number <= pdf.numPages; number += 1) {
    out.push((await (await pdf.getPage(number)).getTextContent()).items.map((item: any) => item.str || '').join(' ').replace(/\s+/g, ' ').trim());
  }
  return out;
}
async function paintsImage(bytes: Buffer, number: number) {
  const { OPS } = await getResolvedPDFJS();
  const pdf = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
  return (await (await pdf.getPage(number)).getOperatorList()).fnArray.includes(OPS.paintImageXObject);
}
const pageSize = async (bytes: Buffer, index: number) => {
  const page = (await PDFDocument.load(bytes, { updateMetadata: false })).getPage(index);
  return [page.getWidth(), page.getHeight()];
};
const names = (sendCascade: any) => attachmentsOf(sendCascade).map((item) => item.filename);

describe('what leaves by e-mail, and the record of it', () => {
  it('leaves the CV and the letter apart and the documents as one PDF, keeps what was new and records what left', async () => {
    const bucket = fakeBucket();
    const store = createMemoryFirestore({ [`${BASE}/ai_drafts/current`]: { round: 1 } });
    const draftRef = store.db.collection('assisted_applications').doc(ORDER).collection('ai_drafts').doc('current');
    const steps: string[] = [];
    const keepSentAttempt = vi.fn(async (attempt: unknown) => {
      steps.push(attempt ? 'attempt' : 'cleared');
      await draftRef.set({ sentAttempt: attempt }, { merge: true });
    });
    const sendCascade = vi.fn(async () => {
      steps.push('send');
      return { failed: [], sent: [{ provider: 'resend', messageId: 'm1' }] };
    });
    const lines: string[] = [];
    const event: any = await submit({ bucket, sendCascade, lines, keepSentAttempt, submissionGuard: submissionGuard(store.db, ORDER, 1) });
    expect(event).toMatchObject({ type: 'submit_succeeded', channel: 'email' });
    expect(names(sendCascade)).toEqual(['CV_Maria_Rossi.pdf', 'Motivationsschreiben_Maria_Rossi.pdf', 'Beilagen_Maria_Rossi.pdf']);
    const attachments = attachmentsOf(sendCascade).map((item) => Buffer.from(item.content, 'base64'));
    // The documents in one PDF: the certificate with its text, then the photo upright and painted.
    const grouped = attachments[2];
    const texts = await pageTexts(grouped);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain('Arbeitszeugnis Beispiel AG');
    const [width, height] = await pageSize(grouped, 1);
    expect(height).toBeGreaterThan(width);
    expect(await paintsImage(grouped, 2)).toBe(true);

    const sent = event.sent;
    expect(sent).toMatchObject({
      at: NOW, channel: 'email', packaging: 'separate', reason: 'default', ad: '', adCue: '', documentsGrouped: true, documentsReason: null,
      pages: 2, bytes: grouped.length, letterRenderer: 'typst',
    });
    // The contract the candidate's page reads: exactly kind, name and key.
    for (const entry of sent.files) expect(Object.keys(entry).sort()).toEqual(['key', 'kind', 'name']);
    expect(sent.files.map((entry: any) => [entry.kind, entry.name])).toEqual([['cv', 'CV_Maria_Rossi.pdf'], ['letter', 'Motivationsschreiben_Maria_Rossi.pdf'], ['documents', 'Beilagen_Maria_Rossi.pdf']]);
    expect(sent.files[0].key).toBe(TAILORED_KEY);
    expect(sent.files[1].key).toMatch(new RegExp(`^${UPLOADS}/sent-r1-\\d+-letter\\.pdf$`));
    expect(sent.files[2].key).toMatch(new RegExp(`^${UPLOADS}/sent-r1-\\d+-documents\\.pdf$`));
    expect(sent.letterKey).toBe(sent.files[1].key);
    // What is kept is what left, byte for byte, as PDFs.
    expect(bucket.files.get(sent.files[1].key)!.equals(attachments[1])).toBe(true);
    expect(bucket.files.get(sent.files[2].key)!.equals(attachments[2])).toBe(true);
    expect(bucket.saved.filter((item) => /\/sent-r1-/.test(item.key)).map((item) => item.options?.contentType)).toEqual(['application/pdf', 'application/pdf']);
    // The same record in the encrypted evidence and in the guard of the round.
    expect(evidence(bucket, 'submit-email').sent).toEqual(sent);
    expect(store.read(`${BASE}/automation/submission`)!.r1).toMatchObject({ state: 'sent', sent });

    // On the draft as the attempt before the send; the send confirmed, agent.mjs keeps it as what left.
    expect(steps).toEqual(['attempt', 'send']);
    expect(keepSentAttempt).toHaveBeenCalledWith(sent);
    delete event.followup; // agent.mjs schedules the follow-ups first and takes them out of the event
    await keepSentRecord(event, { draftRef, dryRun: false });
    expect(store.read(`${BASE}/ai_drafts/current`)).toMatchObject({ sent, sentAttempt: null });
    // Nothing of the candidate in the event the runner reports, nor in its log.
    expect(event).toEqual({ type: 'submit_succeeded', channel: 'email' });
    expect(lines.length).toBeGreaterThan(0);
    for (const text of [...lines, JSON.stringify(event)]) expect(text).not.toMatch(/Maria|Rossi/);
  }, 60_000);

  it('sends one PDF when the ad asks for it, even for an apprentice with the switch off, in the order letter, CV, documents', async () => {
    const bucket = fakeBucket();
    const sendCascade = delivered();
    const event: any = await submit({ draft: withAd(ONE_PDF, { candidateType: { type: 'apprentice', sector: 'health' } }), bucket, sendCascade });
    expect(names(sendCascade)).toEqual(['Bewerbungsdossier_Maria_Rossi.pdf']);
    const dossier = Buffer.from(attachmentsOf(sendCascade)[0].content, 'base64');
    const texts = await pageTexts(dossier);
    expect(texts).toHaveLength(4);
    // Page 1 is the letter rebuilt today, as kept next to the order.
    expect(texts[0]).toBe((await pageTexts(bucket.files.get(event.sent.letterKey)!))[0]);
    expect(texts[1]).toContain('Maria Rossi');
    expect(texts[1]).toContain('Pflegefachfrau HF');
    expect(texts[2]).toContain('Arbeitszeugnis Beispiel AG');
    expect(texts[3]).toBe('');
    expect(await paintsImage(dossier, 4)).toBe(true);
    expect((await PDFDocument.load(dossier, { updateMetadata: false })).getTitle()).toBe('Bewerbungsdossier – Maria Rossi');
    expect(event.sent).toMatchObject({ packaging: 'single', reason: 'ad_single', ad: 'single', adCue: 'einem PDF', documentsGrouped: true, pages: 4 });
    expect(event.sent.files).toEqual([{ kind: 'dossier', name: 'Bewerbungsdossier_Maria_Rossi.pdf', key: SENT_KEY('dossier') }]);
    // The letter is kept on its own too, also when it left inside the dossier.
    expect(event.sent.letterKey).toBe(SENT_KEY('letter'));
    expect(bucket.files.has(SENT_KEY('letter'))).toBe(true);
  }, 60_000);

  it('keeps every file apart when the ad asks for separate files, even with the switch on', async () => {
    vi.stubEnv('ASSISTED_APPLICATION_DOSSIER_MODE', 'single');
    const sendCascade = delivered();
    const event: any = await submit({ draft: withAd(SEPARATE_PDFS), sendCascade });
    expect(names(sendCascade)).toEqual(['CV_Maria_Rossi.pdf', 'Motivationsschreiben_Maria_Rossi.pdf', 'Arbeitszeugnisse_1_Maria_Rossi.pdf', 'Arbeitszeugnisse_2_Maria_Rossi.jpg']);
    expect(event.sent).toMatchObject({ packaging: 'separate', reason: 'ad_separate', ad: 'separate', adCue: 'separate PDF-Dateien', documentsGrouped: false, documentsReason: 'ad_separate' });
    // The documents keep the keys they were uploaded with.
    expect(event.sent.files.slice(2).map((entry: any) => entry.key)).toEqual([DOCUMENT_KEYS.pdf, DOCUMENT_KEYS.jpg]);
  }, 60_000);

  it('with the switch on merges for a first job, never for an apprentice', async () => {
    vi.stubEnv('ASSISTED_APPLICATION_DOSSIER_MODE', 'single');
    const firstJob = delivered();
    const merged: any = await submit({ draft: draftFor({ candidateType: { type: 'first_job', sector: 'health' } }), sendCascade: firstJob });
    expect(names(firstJob)).toEqual(['Bewerbungsdossier_Maria_Rossi.pdf']);
    expect(merged.sent).toMatchObject({ packaging: 'single', reason: 'switch' });
    const apprentice = delivered();
    const apart: any = await submit({ draft: draftFor({ candidateType: { type: 'apprentice', sector: 'health' } }), sendCascade: apprentice });
    expect(names(apprentice)).toEqual(['CV_Maria_Rossi.pdf', 'Motivationsschreiben_Maria_Rossi.pdf', 'Beilagen_Maria_Rossi.pdf']);
    expect(apart.sent).toMatchObject({ packaging: 'separate', reason: 'apprentice', documentsGrouped: true });
  }, 60_000);

  it('falls back to the separate files and says why: a Word document, too many pages, too many bytes', async () => {
    vi.stubEnv('ASSISTED_APPLICATION_DOSSIER_MODE', 'single');
    const word = delivered();
    const withWord: any = await submit({ flow: flowWith(documentFile('pdf'), documentFile('docx')), sendCascade: word });
    expect(names(word)).toEqual(['CV_Maria_Rossi.pdf', 'Motivationsschreiben_Maria_Rossi.pdf', 'Arbeitszeugnisse_1_Maria_Rossi.pdf', 'Arbeitszeugnisse_2_Maria_Rossi.docx']);
    expect(withWord.sent).toMatchObject({ reason: 'document_not_mergeable', documentsGrouped: false, documentsReason: 'document_not_mergeable' });
    // No tailored CV: the candidate's own five pages leave, under its own key; the documents are still grouped.
    const long = delivered();
    const original: any = await submit({ draft: draftFor({ tailoredCv: null }), cvBuffer: pdfOf('Lebenslauf Maria Rossi', 5), sendCascade: long });
    expect(names(long)).toEqual(['CV_Maria_Rossi.pdf', 'Motivationsschreiben_Maria_Rossi.pdf', 'Beilagen_Maria_Rossi.pdf']);
    expect(original.sent).toMatchObject({ reason: 'pages', documentsGrouped: true, documentsReason: null, pages: 2 });
    expect(original.sent.files[0].key).toBe(order.cvStorageKey);
    // One heavy photo: no dossier within 2 MB, and one document file leaves as it is.
    const heavy = delivered();
    const photo: any = await submit({ flow: flowWith(documentFile('png')), sendCascade: heavy });
    expect(names(heavy)).toEqual(['CV_Maria_Rossi.pdf', 'Motivationsschreiben_Maria_Rossi.pdf', 'Arbeitszeugnisse_Maria_Rossi.png']);
    expect(photo.sent).toMatchObject({ reason: 'bytes', documentsGrouped: false, documentsReason: null, pages: null, bytes: null });
  }, 60_000);

  it('never merges a letter whose first page lost its text, and records the stored letter that left', async () => {
    vi.stubEnv('ASSISTED_APPLICATION_DOSSIER_MODE', 'single');
    const bucket = fakeBucket();
    bucket.files.set(STORED_LETTER_KEY, imageOnlyPdf());
    const sendCascade = delivered();
    // A draft from before the recipient's address was kept: its stored letter leaves.
    const event: any = await submit({ draft: draftFor({ letterAddress: undefined, coverLetterRenderer: 'legacy' }), bucket, sendCascade });
    expect(names(sendCascade)).toEqual(['CV_Maria_Rossi.pdf', 'Motivationsschreiben_Maria_Rossi.pdf', 'Beilagen_Maria_Rossi.pdf']);
    expect(event.sent).toMatchObject({ packaging: 'separate', reason: 'check_failed', documentsGrouped: true, letterRenderer: 'legacy', letterKey: STORED_LETTER_KEY });
    expect(event.sent.files[1]).toEqual({ kind: 'letter', name: 'Motivationsschreiben_Maria_Rossi.pdf', key: STORED_LETTER_KEY });
    expect(bucket.files.has(SENT_KEY('letter'))).toBe(false);
  }, 60_000);

  it('leaves a digitally signed certificate as it is, after the documents grouped without it', async () => {
    const sendCascade = delivered();
    const event: any = await submit({ flow: flowWith(documentFile('pdf'), documentFile('jpg'), documentFile('signed', 'pdf')), sendCascade });
    expect(names(sendCascade)).toEqual(['CV_Maria_Rossi.pdf', 'Motivationsschreiben_Maria_Rossi.pdf', 'Beilagen_Maria_Rossi.pdf', 'Arbeitszeugnisse_3_Maria_Rossi.pdf']);
    const attachments = attachmentsOf(sendCascade).map((item) => Buffer.from(item.content, 'base64'));
    expect(attachments[3].equals(fixtures.signed)).toBe(true);
    expect(await pageTexts(attachments[2])).toHaveLength(2);
    expect(event.sent).toMatchObject({ documentsGrouped: true, documentsReason: 'document_signed' });
    expect(event.sent.files.map((entry: any) => [entry.kind, entry.key])).toEqual([
      ['cv', TAILORED_KEY], ['letter', SENT_KEY('letter')], ['documents', SENT_KEY('documents')], ['document', DOCUMENT_KEYS.signed],
    ]);
  }, 60_000);

  it('a dry run keeps its files under dry-run-… and its record in the evidence only', async () => {
    const bucket = fakeBucket();
    const sendCascade = vi.fn();
    const keepSentAttempt = vi.fn();
    expect(await submit({ bucket, sendCascade, keepSentAttempt, dryRun: true })).toEqual({ type: 'dry_run_ready', channel: 'email' });
    expect(sendCascade).not.toHaveBeenCalled();
    expect(keepSentAttempt).not.toHaveBeenCalled();
    expect([...bucket.files.keys()].some((key) => key.includes('/sent-r1-'))).toBe(false);
    const { sent } = evidence(bucket, 'dry-run-email');
    expect(sent.files.map((entry: any) => entry.key)).toEqual([TAILORED_KEY, SENT_KEY('letter', 'dry-run'), SENT_KEY('documents', 'dry-run')]);
    expect(bucket.files.has(SENT_KEY('documents', 'dry-run'))).toBe(true);
  }, 60_000);

  it('a re-dispatched run hands over the first run’s record and sends nothing', async () => {
    const store = createMemoryFirestore();
    const bucket = fakeBucket();
    const sendCascade = delivered();
    const first: any = await submit({ bucket, sendCascade, submissionGuard: submissionGuard(store.db, ORDER, 1) });
    const replay: any = await submit({ bucket, sendCascade, nowMs: NOW + 60_000, submissionGuard: submissionGuard(store.db, ORDER, 1) });
    expect(replay).toMatchObject({ type: 'submit_succeeded', channel: 'email', replayed: true, sent: first.sent });
    expect(store.read(`${BASE}/automation/submission`)!.r1.sent).toEqual(first.sent);
    expect(sendCascade).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('sends nothing and claims nothing when the files of the record cannot be kept', async () => {
    const store = createMemoryFirestore();
    const sendCascade = delivered();
    const keepSentAttempt = vi.fn();
    const event = await submit({ bucket: fakeBucket({ refuse: /\/sent-r/ }), sendCascade, keepSentAttempt, submissionGuard: submissionGuard(store.db, ORDER, 1) });
    expect(event).toEqual({ type: 'submit_failed', error: 'sent_files_not_stored' });
    expect(sendCascade).not.toHaveBeenCalled();
    expect(keepSentAttempt).not.toHaveBeenCalled();
    // Nothing claimed: a later run starts afresh.
    expect(store.read(`${BASE}/automation/submission`)).toBeUndefined();
  }, 60_000);
});

describe('what a portal and WhatsApp received', () => {
  const portalDraft = () => draftFor({ channel: { type: 'lever', applyUrl: 'https://jobs.lever.co/spital/1/apply' } });
  const UPLOADED = [{ document: 'cv' }, { document: 'cover_letter' }, { document: 'extra_1', files: 1 }];

  it('records the files the form’s fields received, keeps the letter, and hands the record over on a replay', async () => {
    const store = createMemoryFirestore();
    const bucket = fakeBucket();
    const runner = vi.fn(async () => ({ event: { type: 'submit_succeeded', channel: 'portal' }, evidence: { steps: [], uploads: UPLOADED } }));
    const run = () => submit({ draft: portalDraft(), bucket, codex: vi.fn(), portalRunner: runner, submissionGuard: submissionGuard(store.db, ORDER, 1) });
    const event: any = await run();
    expect(event.sent).toMatchObject({ at: NOW, channel: 'lever', packaging: 'portal', letterRenderer: 'typst', letterKey: SENT_KEY('letter') });
    // Only the first of the document's two files went into the field.
    expect(event.sent.files).toEqual([
      { kind: 'cv', name: 'CV_Maria_Rossi.pdf', key: TAILORED_KEY },
      { kind: 'letter', name: 'Motivationsschreiben_Maria_Rossi.pdf', key: SENT_KEY('letter') },
      { kind: 'document', name: 'Arbeitszeugnisse_1_Maria_Rossi.pdf', key: DOCUMENT_KEYS.pdf },
    ]);
    expect(bucket.files.has(SENT_KEY('letter'))).toBe(true);
    expect(store.read(`${BASE}/automation/submission`)!.r1.sent).toEqual(event.sent);
    expect(evidence(bucket, 'submit-portal-submit_succeeded').sent).toEqual(event.sent);
    expect(await run()).toMatchObject({ type: 'submit_succeeded', channel: 'lever', replayed: true, sent: event.sent });
    expect(runner).toHaveBeenCalledTimes(1);

    // Storage refuses the letter: the application may have left, so the run still succeeds, without its key.
    const lines: string[] = [];
    const refused: any = await submit({ draft: portalDraft(), bucket: fakeBucket({ refuse: /\/sent-r/ }), lines, codex: vi.fn(), portalRunner: runner });
    expect(refused).toMatchObject({ type: 'submit_succeeded', channel: 'lever' });
    expect(refused.sent.letterKey).toBeNull();
    expect(refused.sent.files.map((entry: any) => entry.key)).toEqual([TAILORED_KEY, null, DOCUMENT_KEYS.pdf]);
    expect(lines).toContain('sent files not kept');
  }, 60_000);

  it('reads the uploads of a run: the largest count per document, nothing from junk', () => {
    const uploads = portalUploads({ uploads: [{ document: 'extra_1', files: 1 }, { document: 'extra_1', files: 3 }, { document: 'cv' }, { files: 2 }, null, 'junk', { document: '' }] });
    expect([...uploads.entries()]).toEqual([['extra_1', 3], ['cv', 1]]);
    expect(portalUploads(undefined).size).toBe(0);
    expect(portalUploads({ uploads: 'cv' }).size).toBe(0);
  });

  it('records that nothing left from us with a WhatsApp application', async () => {
    const bucket = fakeBucket();
    const event: any = await submit({
      draft: draftFor({ channel: { type: 'pastahr', applyUrl: PASTA, postingUrl: 'https://jobs.example.ch/lehrstelle/1', via: 'prospective', host: 'prod.pastahr.com', requiresAccount: false } }),
      bucket, codex: vi.fn(), portalRunner: vi.fn(),
    });
    const sent = { at: NOW, channel: 'whatsapp', packaging: 'whatsapp', reason: 'default', ad: '', adCue: '', documentsGrouped: false, documentsReason: null, pages: null, bytes: null, letterRenderer: null, letterKey: null, files: [] };
    expect(event).toEqual({ type: 'submit_succeeded', channel: 'whatsapp', whatsappUrl: PASTA, sent });
    expect(evidence(bucket, 'submit-whatsapp').sent).toEqual(sent);
  }, 60_000);
});

// Owner decision of 2026-10-04: the record follows the send. An uncertain one keeps the attempt
// until the owner (or the employer's e-mail) confirms it; one that failed for certain clears it.
describe('an uncertain send keeps its record until it is confirmed', () => {
  async function ambiguousSetup() {
    const store = createMemoryFirestore({
      [BASE]: { paymentStatus: 'paid', submissionStatus: 'in_progress', automationState: 'submitting' },
      [`${BASE}/automation/flow`]: { state: 'submitting', round: 1, heldBy: [], answers: {}, feedback: [] },
      [`${BASE}/ai_drafts/current`]: draftFor(),
    });
    const draftRef = store.db.collection('assisted_applications').doc(ORDER).collection('ai_drafts').doc('current');
    const keepSentAttempt = (attempt: unknown) => draftRef.set({ sentAttempt: attempt }, { merge: true });
    return { store, keepSentAttempt, draft: () => store.read(`${BASE}/ai_drafts/current`)! };
  }

  it('keeps the attempt of an e-mail of unknown outcome, and the owner’s «Segna come inviata» makes it the record of what left', async () => {
    const { store, keepSentAttempt, draft } = await ambiguousSetup();
    const bucket = fakeBucket();
    const sendCascade = vi.fn(async () => ({ failed: [{ error: 'timeout after 30 s', ambiguousDelivery: true }], sent: [] }));
    const event: any = await submit({ bucket, sendCascade, keepSentAttempt, submissionGuard: submissionGuard(store.db, ORDER, 1) });
    // A failure carries no record; the attempt is on the draft, the files next to the order, the record in the evidence.
    expect(event).toEqual({ type: 'submit_failed', error: 'email_ambiguous' });
    const attempt = draft().sentAttempt;
    expect(attempt).toMatchObject({ at: NOW, channel: 'email', packaging: 'separate', letterKey: SENT_KEY('letter') });
    expect(evidence(bucket, 'submit-email-failed').sent).toEqual(attempt);
    expect(store.read(`${BASE}/automation/submission`)!.r1).toMatchObject({ state: 'sending' });
    expect(draft().sent).toBeUndefined();
    // A run the watchdog re-dispatched finds the round in flight and leaves the attempt as it is.
    expect(await submit({ bucket, sendCascade, keepSentAttempt, nowMs: NOW + 60_000, submissionGuard: submissionGuard(store.db, ORDER, 1) })).toEqual({ type: 'submit_failed', error: 'email_ambiguous' });
    expect(draft().sentAttempt).toEqual(attempt);
    expect(sendCascade).toHaveBeenCalledTimes(1);

    // The flow holds it for the owner, who checks with the employer and marks it sent.
    await store.db.collection('assisted_applications').doc(ORDER).collection('automation').doc('flow').set({ state: 'owner_takeover', heldBy: ['email_ambiguous'] }, { merge: true });
    const confirmedAt = NOW + 3_600_000;
    expect(await recordOwnerSubmission({ db: store.db, orderId: ORDER, adminEmail: 'owner@example.com', runEffect: vi.fn(async () => ({ ok: true })), nowMs: confirmedAt })).toEqual({ ok: true, state: 'submitted' });
    expect(draft()).toMatchObject({ sent: { ...attempt, confirmedBy: 'owner', confirmedAt }, sentAttempt: null });
    // The owner's panel says so.
    const view: any = await loadAutomationForAdmin(store.db, ORDER, { signUrl: async (key: string) => `https://signed.example/${key.split('/').pop()}` });
    expect(view.draft.sent).toMatchObject({ confirmedBy: 'owner', at: NOW });
    expect(sentSummaryIt(view.draft.sent)).toContain('invio dall’esito incerto, confermato da te');
  }, 60_000);

  it('clears the attempt of an e-mail that failed for certain', async () => {
    const { store, keepSentAttempt, draft } = await ambiguousSetup();
    const sendCascade = vi.fn(async () => ({ failed: [{ error: 'rejected', ambiguousDelivery: false }], sent: [] }));
    const steps: unknown[] = [];
    const event = await submit({ sendCascade, keepSentAttempt: async (attempt: unknown) => { steps.push(attempt && 'attempt'); await keepSentAttempt(attempt); }, submissionGuard: submissionGuard(store.db, ORDER, 1) });
    expect(event).toEqual({ type: 'submit_failed', error: 'email_failed' });
    expect(steps).toEqual(['attempt', null]);
    expect(draft()).toMatchObject({ sentAttempt: null });
    expect(draft().sent).toBeUndefined();
    expect(store.read(`${BASE}/automation/submission`)!.r1).toMatchObject({ state: 'failed', reason: 'email_failed' });
  }, 60_000);

  it('sends nothing and gives the claim back when the attempt cannot be kept on the draft (review of #11505)', async () => {
    const { store } = await ambiguousSetup();
    const sendCascade = vi.fn(async () => ({ failed: [], sent: [{ provider: 'resend', messageId: 'm1' }] }));
    const event = await submit({ sendCascade, keepSentAttempt: async () => { throw new Error('firestore unavailable'); }, submissionGuard: submissionGuard(store.db, ORDER, 1) });
    // Without a durable attempt an unknown outcome could never be confirmed: nothing leaves, the retry is safe.
    expect(event).toEqual({ type: 'submit_failed', error: 'sent_attempt_not_stored' });
    expect(sendCascade).not.toHaveBeenCalled();
    expect(store.read(`${BASE}/automation/submission`)!.r1).toMatchObject({ state: 'failed', reason: 'sent_attempt_not_stored' });
  }, 60_000);

  it('does not press a portal’s final button when the attempt cannot be kept on the draft (review of #11505)', async () => {
    const portalDraft = draftFor({ channel: { type: 'lever', applyUrl: 'https://jobs.lever.co/spital/1/apply' } });
    const uploads = [{ document: 'cv' }, { document: 'cover_letter' }];
    let pressed = false;
    const runner = vi.fn(async (ctx: any) => {
      await ctx.onBeforeSubmit({ uploads });
      pressed = true;
      return { event: { type: 'submit_succeeded', channel: 'portal' }, evidence: { steps: [], uploads } };
    });
    const { store } = await ambiguousSetup();
    const event = await submit({ draft: portalDraft, codex: vi.fn(), portalRunner: runner, keepSentAttempt: async () => { throw new Error('firestore unavailable'); }, submissionGuard: submissionGuard(store.db, ORDER, 1) });
    expect(event).toEqual({ type: 'submit_failed', error: 'sent_attempt_not_stored' });
    expect(pressed).toBe(false);
    // Released, not «sending»: nothing reached the employer.
    expect(store.read(`${BASE}/automation/submission`)!.r1).toMatchObject({ state: 'failed' });
  }, 60_000);

  it('agent.mjs keeps the record of what left before every other after-send write (review of #11505)', () => {
    const src = readFileSync('scripts/assisted-application/agent.mjs', 'utf8');
    const submitAt = src.indexOf('const event = await submitApplication(');
    const keepAt = src.indexOf('await keepSentRecord(event', submitAt);
    expect(submitAt).toBeGreaterThan(-1);
    expect(keepAt).toBeGreaterThan(submitAt);
    for (const later of ['await scheduleFollowups(', "submissionChannel: 'whatsapp'", 'portalAnswers: event.portalAnswers', 'takeFactCheck(event', 'await report(event)']) {
      expect([later, src.indexOf(later, submitAt) > keepAt]).toEqual([later, true]);
    }
  });

  it('records what a portal form held when its final button was pressed, and clears it when the portal says it did not send', async () => {
    const portalDraft = draftFor({ channel: { type: 'lever', applyUrl: 'https://jobs.lever.co/spital/1/apply' } });
    const uploads = [{ document: 'cv' }, { document: 'cover_letter' }, { document: 'extra_1', files: 2 }];
    const pressed = (outcome: Record<string, unknown>) => vi.fn(async (ctx: any) => {
      await ctx.onBeforeSubmit({ uploads });
      return { event: outcome, evidence: { steps: [], uploads, finalOutcomes: ['ambiguous'] } };
    });
    const unknown = await ambiguousSetup();
    const event = await submit({ draft: portalDraft, codex: vi.fn(), portalRunner: pressed({ type: 'submit_failed', error: 'portal_antibot_ambiguous' }), keepSentAttempt: unknown.keepSentAttempt, submissionGuard: submissionGuard(unknown.store.db, ORDER, 1) });
    expect(event).toMatchObject({ type: 'submit_failed', error: 'portal_antibot_ambiguous' });
    expect((event as any).sent).toBeUndefined();
    expect(unknown.draft().sentAttempt).toMatchObject({ channel: 'lever', packaging: 'portal', letterKey: SENT_KEY('letter') });
    expect(unknown.draft().sentAttempt.files.map((entry: any) => entry.kind)).toEqual(['cv', 'letter', 'document', 'document']);
    expect(unknown.store.read(`${BASE}/automation/submission`)!.r1).toMatchObject({ state: 'sending' });

    const refused = await ambiguousSetup();
    await submit({ draft: portalDraft, codex: vi.fn(), portalRunner: pressed({ type: 'submit_failed', error: 'portal_refused' }), keepSentAttempt: refused.keepSentAttempt, submissionGuard: submissionGuard(refused.store.db, ORDER, 1) });
    expect(refused.draft()).toMatchObject({ sentAttempt: null });
    expect(refused.store.read(`${BASE}/automation/submission`)!.r1).toMatchObject({ state: 'failed', reason: 'portal_refused' });
  }, 60_000);
});

describe('the record on the draft', () => {
  const record = () => recordOfSend({ at: NOW, channel: 'email', packaging: 'separate', files: [{ kind: 'cv', name: 'CV_Maria_Rossi.pdf', key: TAILORED_KEY }] });

  it('is merged into the draft before the event leaves, in place of the attempt, and never stays in the event', async () => {
    const store = createMemoryFirestore({ [`${BASE}/ai_drafts/current`]: { round: 1, sentAttempt: { at: 1 } } });
    const draftRef = store.db.collection('assisted_applications').doc(ORDER).collection('ai_drafts').doc('current');
    const event: any = { type: 'submit_succeeded', channel: 'email', sent: record() };
    await keepSentRecord(event, { draftRef, dryRun: false });
    expect(event).toEqual({ type: 'submit_succeeded', channel: 'email' });
    expect(store.read(`${BASE}/ai_drafts/current`)).toEqual({ round: 1, sent: record(), sentAttempt: null });
    // A dry run keeps nothing, and the record still leaves the event.
    const other = createMemoryFirestore({ [`${BASE}/ai_drafts/current`]: { round: 1 } });
    const dry: any = { type: 'dry_run_ready', channel: 'email', sent: record() };
    await keepSentRecord(dry, { draftRef: other.db.collection('assisted_applications').doc(ORDER).collection('ai_drafts').doc('current'), dryRun: true });
    expect(dry).toEqual({ type: 'dry_run_ready', channel: 'email' });
    expect(other.read(`${BASE}/ai_drafts/current`)).toEqual({ round: 1 });
    // An event without a record writes nothing.
    await keepSentRecord({ type: 'submit_failed', error: 'email_failed' }, { draftRef: other.db.collection('assisted_applications').doc(ORDER).collection('ai_drafts').doc('current'), dryRun: false });
    expect(other.read(`${BASE}/ai_drafts/current`)).toEqual({ round: 1 });
  });

  it('never turns a sent application into a failure when the draft cannot be written', async () => {
    // On GitHub Actions the runner's summary() would append this line to the tests job's own summary page.
    vi.stubEnv('GITHUB_STEP_SUMMARY', '');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const failing = { set: vi.fn(async () => { throw new Error('permission denied for maria.rossi@example.com'); }) };
    const event: any = { type: 'submit_succeeded', channel: 'email', sent: record() };
    await expect(keepSentRecord(event, { draftRef: failing, dryRun: false })).resolves.toBeUndefined();
    expect(event).toEqual({ type: 'submit_succeeded', channel: 'email' });
    expect(log.mock.calls.map(([line]) => String(line))).toContain('[assisted-application] sent record not kept on the draft: permission denied for <email>');
  });

  it('keeps every new file under a flat key without personal data, and the files that have one under theirs', async () => {
    const bucket = fakeBucket();
    const kept = await keepSentFiles({
      bucket, orderId: ORDER, round: 2, nowMs: NOW, letter: { buffer: Buffer.from('%PDF letter'), key: null },
      attachments: [{ kind: 'dossier', name: 'Bewerbungsdossier_Maria_Rossi.pdf', buffer: Buffer.from('%PDF dossier') }, { kind: 'document', name: 'Zeugnis_Maria_Rossi.pdf', key: DOCUMENT_KEYS.pdf }],
    });
    expect(kept).toEqual({
      letterKey: `${UPLOADS}/sent-r2-${NOW}-letter.pdf`,
      files: [{ kind: 'dossier', name: 'Bewerbungsdossier_Maria_Rossi.pdf', key: `${UPLOADS}/sent-r2-${NOW}-dossier.pdf` }, { kind: 'document', name: 'Zeugnis_Maria_Rossi.pdf', key: DOCUMENT_KEYS.pdf }],
    });
    // A stored letter is not copied.
    expect((await keepSentFiles({ bucket, orderId: ORDER, round: 1, nowMs: NOW, letter: { buffer: Buffer.from('x'), key: STORED_LETTER_KEY }, attachments: [] })).letterKey).toBe(STORED_LETTER_KEY);
  });
});

describe('the owner’s view of what left', () => {
  const LETTER = SENT_KEY('letter');
  const OTHER_ORDER_KEY = 'assisted-application-uploads/order_OTHER1/x.pdf';
  async function seeded(sent: unknown) {
    return createMemoryFirestore({
      [BASE]: { paymentStatus: 'paid', submissionStatus: 'submitted' },
      [`${BASE}/automation/flow`]: { state: 'submitted', round: 1, heldBy: [], answers: {}, feedback: [] },
      [`${BASE}/ai_drafts/current`]: { ...draftFor(), ...(sent ? { sent } : {}) },
    });
  }

  it('gives each file a signed link of the order’s own folder, never a key, and signs each key once', async () => {
    const sent = {
      ...recordOfSend({
        at: NOW, channel: 'email', packaging: 'separate', documentsGrouped: true, pages: 2, bytes: 421888, letterRenderer: 'typst', letterKey: LETTER,
        files: [
          { kind: 'cv', name: 'CV_Maria_Rossi.pdf', key: TAILORED_KEY },
          { kind: 'letter', name: 'Motivationsschreiben_Maria_Rossi.pdf', key: LETTER },
          { kind: 'documents', name: 'Beilagen_Maria_Rossi.pdf', key: SENT_KEY('documents') },
          { kind: 'document', name: 'Fremd.pdf', key: OTHER_ORDER_KEY },
        ],
      }),
    };
    sent.files.push({ kind: 'unknown', name: 'x.pdf', key: TAILORED_KEY });
    const store = await seeded(sent);
    const signUrl = vi.fn(async (key: string) => `https://signed.example/${key.split('/').pop()}`);
    const view: any = await loadAutomationForAdmin(store.db, ORDER, { signUrl });
    expect(view.draft.sent).toEqual({
      at: NOW, channel: 'email', packaging: 'separate', reason: 'default', ad: '', adCue: '', documentsGrouped: true, documentsReason: null,
      pages: 2, bytes: 421888, letterRenderer: 'typst', confirmedBy: null, letterUrl: `https://signed.example/sent-r1-${NOW}-letter.pdf`,
      files: [
        { kind: 'cv', name: 'CV_Maria_Rossi.pdf', url: 'https://signed.example/ai-cv-r1-1.pdf' },
        { kind: 'letter', name: 'Motivationsschreiben_Maria_Rossi.pdf', url: `https://signed.example/sent-r1-${NOW}-letter.pdf` },
        { kind: 'documents', name: 'Beilagen_Maria_Rossi.pdf', url: `https://signed.example/sent-r1-${NOW}-documents.pdf` },
        { kind: 'document', name: 'Fremd.pdf', url: null },
      ],
    });
    const signedKeys = signUrl.mock.calls.map(([key]) => key);
    expect(signedKeys).not.toContain(OTHER_ORDER_KEY);
    // The tailored CV is the CV that left: one signature for both lines of the panel.
    expect(signedKeys.filter((key) => key === TAILORED_KEY)).toHaveLength(1);
    expect(signedKeys.filter((key) => key === LETTER)).toHaveLength(1);
    expect(view.draft.tailoredCv.url).toBe('https://signed.example/ai-cv-r1-1.pdf');
    expect(JSON.stringify(view)).not.toContain('assisted-application-uploads/');
    // An order sent before the record existed shows none.
    expect((await loadAutomationForAdmin((await seeded(null)).db, ORDER, { signUrl }) as any).draft.sent).toBeNull();
  });

  it('sums up what left in one Italian line', () => {
    const file = (kind: string) => ({ kind: kind as any, name: `${kind}.pdf`, url: null });
    const base = { at: 1, channel: 'email', ad: '' as const, adCue: '', documentsGrouped: false, documentsReason: null, pages: null, bytes: null, letterRenderer: 'typst' as const, letterUrl: null };
    const line = (sent: Record<string, unknown>) => sentSummaryIt({ ...base, ...sent } as any);
    expect(line({ packaging: 'separate', reason: 'default', files: [file('cv'), file('letter')] }))
      .toBe('lettera e CV separati — lettera composta con Typst');
    expect(line({ packaging: 'separate', reason: 'default', documentsGrouped: true, pages: 2, bytes: 421888, files: [file('cv'), file('letter'), file('documents')] }))
      .toBe('lettera e CV separati · documenti richiesti in un PDF · 2 pagine, 412 KB — lettera composta con Typst');
    expect(line({ packaging: 'single', reason: 'ad_single', ad: 'single', adCue: 'einem PDF', documentsGrouped: true, pages: 4, bytes: 307200, files: [file('dossier')] }))
      .toBe('un PDF unico con lettera, CV e documenti richiesti (lo chiede l’annuncio) · 4 pagine, 300 KB · annuncio: «einem PDF» — lettera composta con Typst');
    expect(line({ packaging: 'separate', reason: 'cv_not_pdf', ad: 'single', adCue: 'einem PDF', letterRenderer: 'legacy', files: [file('cv'), file('letter'), file('document')] }))
      .toBe('lettera e CV separati (niente PDF unico: il CV che parte non è un PDF) · documenti richiesti: 1 file · annuncio: «einem PDF» — lettera composta con il generatore di riserva (senza č, ć…)');
    expect(line({ packaging: 'separate', reason: 'ad_separate', ad: 'separate', adCue: 'separate PDF-Dateien', documentsReason: 'ad_separate', files: [file('cv'), file('letter'), file('document'), file('document')] }))
      .toBe('lettera e CV separati (l’annuncio chiede file separati) · documenti richiesti: 2 file separati (lo chiede l’annuncio) · annuncio: «separate PDF-Dateien» — lettera composta con Typst');
    expect(line({ channel: 'lever', packaging: 'portal', reason: 'default', files: [file('cv'), file('letter')] }))
      .toBe('caricata sul portale: 2 file — lettera composta con Typst');
    expect(line({ channel: 'whatsapp', packaging: 'whatsapp', reason: 'default', letterRenderer: null, files: [] }))
      .toBe('via WhatsApp dal telefono del candidato: nessun file è partito da noi');
    // A signed certificate left apart, and a send of uncertain outcome confirmed afterwards.
    expect(line({ packaging: 'separate', reason: 'default', documentsGrouped: true, documentsReason: 'document_signed', pages: 2, bytes: 421888, files: [file('cv'), file('letter'), file('documents'), file('document')] }))
      .toBe('lettera e CV separati · documenti richiesti in un PDF, 1 documento firmato digitalmente a parte · 2 pagine, 412 KB — lettera composta con Typst');
    expect(line({ packaging: 'separate', reason: 'default', documentsReason: 'document_signed', files: [file('cv'), file('letter'), file('document'), file('document')] }))
      .toBe('lettera e CV separati · documenti richiesti: 2 file separati (c’è un PDF firmato digitalmente) — lettera composta con Typst');
    expect(line({ packaging: 'single', reason: 'ad_single', documentsGrouped: true, documentsReason: 'document_signed', files: [file('dossier'), file('document')] }))
      .toBe('un PDF unico con lettera, CV e documenti richiesti (lo chiede l’annuncio) · 1 documento firmato digitalmente a parte — lettera composta con Typst');
    expect(line({ packaging: 'separate', reason: 'default', confirmedBy: 'acknowledgement', files: [file('cv'), file('letter')] }))
      .toBe('lettera e CV separati · invio dall’esito incerto, confermato dalla risposta del datore — lettera composta con Typst');
  });
});
