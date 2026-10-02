import { beforeEach, describe, expect, it, vi } from 'vitest';
import { jsPDF } from 'jspdf';
import { createMemoryFirestore } from './helpers/memoryFirestore';

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({
  getRemoteConfigValue: vi.fn(async () => ''),
  bridgeEmailCascadeCredentialsToEnv: vi.fn(async () => {}),
}));

const { handleAssistedApplicationReview } = await import('../functions/src/assistedApplicationReview.js');
const { mintReviewToken } = await import('../functions/src/assistedApplicationReviewToken.js');
const { dossierAttachment, dossierMode, mergeParts, wantsDossier } = await import('../scripts/assisted-application/lib/dossier.mjs');

const SECRET = 'p'.repeat(40);
const T0 = Date.UTC(2026, 9, 2, 10, 0, 0);
const ORDER = 'order_PHOTO1';
const BASE = `assisted_applications/${ORDER}`;
// A 1×1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const pdfOf = (text: string, pages = 1) => {
  const doc = new jsPDF();
  for (let page = 0; page < pages; page += 1) {
    if (page) doc.addPage();
    doc.text(`${text} ${page + 1}`, 20, 20);
  }
  return Buffer.from(doc.output('arraybuffer'));
};

// An invented candidate (study 2026-10-02).
const profile = {
  fullName: 'Maria Rossi', location: 'Como', languages: [{ language: 'Deutsch', level: 'B2' }],
  experience: [{ role: 'Pflegefachfrau HF', employer: 'Ospedale Civico', location: 'Lugano', start: '2018', end: '2023', kind: 'job', highlights: ['Akutpflege auf einer Station mit 24 Betten.'] }],
  education: [], certifications: [], skills: [],
};
const tailoredCv = (extra: Record<string, any> = {}) => ({
  status: 'ready', pdfKey: `assisted-application-uploads/${ORDER}/ai-cv-r1-1.pdf`, language: 'de',
  cv: {
    language: 'de', type: 'qualified', sector: 'health', headline: 'Pflegefachfrau HF', headlineSource: 'profile', summary: 'Pflegefachfrau HF mit Erfahrung in der Akutpflege.',
    competencies: ['Akutpflege'], skills: [],
    experience: [{ role: 'Pflegefachfrau HF', employer: 'Ospedale Civico', location: 'Lugano', start: '2018', end: '2023', bullets: ['Akutpflege auf einer Station mit 24 Betten.'], rewritten: true }],
  },
  ...extra,
});

function fakeBucket() {
  const files = new Map<string, Buffer>();
  return {
    files,
    file: (key: string) => ({
      save: async (buffer: Buffer) => { files.set(key, Buffer.from(buffer)); },
      download: async () => { if (!files.has(key)) throw Object.assign(new Error('missing'), { code: 404 }); return [files.get(key)]; },
      delete: async () => { files.delete(key); },
    }),
  };
}

let store: ReturnType<typeof createMemoryFirestore>;
let bucket: ReturnType<typeof fakeBucket>;
const deps = () => ({ db: store.db, bucket, runEffect: vi.fn(async () => ({ ok: true })), getSecret: async () => SECRET, signUrl: async () => 'https://signed.example/x.pdf', nowMs: T0 });
const token = () => mintReviewToken({ secret: SECRET, orderId: ORDER, round: 1, nowMs: T0 });
const post = (body: Record<string, any>) => handleAssistedApplicationReview({ method: 'POST', body: { t: token(), ...body } }, deps());

function seed(draftExtra: Record<string, any> = {}) {
  store = createMemoryFirestore({
    [BASE]: { paymentStatus: 'paid', submissionStatus: 'in_progress', jobTitle: 'Pflegefachperson HF', companyName: 'Spital', locale: 'de', applicantName: 'Maria Rossi', applicantPhone: '+41 79 123 45 67' },
    [`${BASE}/automation/flow`]: { state: 'candidate_review', round: 1, deadlineAt: null, answers: {}, feedback: [] },
    [`${BASE}/ai_drafts/current`]: {
      status: 'ready', round: 1, language: 'de', profile, job: { title: 'Pflegefachperson HF' },
      channel: { type: 'lever', applyUrl: 'https://jobs.lever.co/x/1/apply' }, coverLetter: { subject: 'Bewerbung', text: 'Sehr geehrte Damen und Herren\n\nText.\n\nFreundliche Grüsse' },
      applicationEmail: { to: '', subject: 'x', body: 'y' }, formAnswers: [], questions: [],
      coverLetterPdfKey: `assisted-application-uploads/${ORDER}/ai-cover-letter-r1-1.pdf`,
      tailoredCv: tailoredCv(), ...draftExtra,
    },
  });
}

beforeEach(() => {
  bucket = fakeBucket();
  seed();
});

describe('optional photo of the tailored CV', () => {
  it('offers the photo, recommended for a German-speaking posting', async () => {
    const { body } = await handleAssistedApplicationReview({ method: 'GET', query: { t: token() } }, deps());
    expect(body.tailoredCv).toMatchObject({ photo: false, photoAdvice: 'recommended', photoMaxBytes: 2 * 1024 * 1024 });
    expect(body.can.uploadPhoto).toBe(true);
  });

  it('rebuilds the tailored CV with the photo, and without it when taken back', async () => {
    const upload = await post({ action: 'photo_upload', contentBase64: PNG.toString('base64') });
    expect(upload).toMatchObject({ status: 200, body: { ok: true, photo: true } });
    const flow = store.read(`${BASE}/automation/flow`);
    expect(flow.photo).toMatchObject({ detectedType: 'png', size: PNG.length });
    const draft = store.read(`${BASE}/ai_drafts/current`);
    expect(draft.tailoredCv).toMatchObject({ status: 'ready', photo: true, renderer: 'typst' });
    expect(draft.tailoredCv.pdfKey).not.toBe(tailoredCv().pdfKey);
    expect(bucket.files.get(draft.tailoredCv.pdfKey)!.subarray(0, 5).toString()).toBe('%PDF-');
    expect(bucket.files.has(flow.photo.key)).toBe(true);

    const removed = await post({ action: 'photo_remove' });
    expect(removed).toMatchObject({ status: 200, body: { ok: true, photo: false } });
    expect(store.read(`${BASE}/automation/flow`).photo).toBeNull();
    expect(bucket.files.has(flow.photo.key)).toBe(false);
  }, 60_000);

  it('accepts only a JPG or a PNG of at most 2 MB', async () => {
    expect(await post({ action: 'photo_upload', contentBase64: pdfOf('CV').toString('base64') })).toMatchObject({ status: 400, body: { error: 'photo_type_not_allowed' } });
    const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);
    expect(await post({ action: 'photo_upload', contentBase64: big.toString('base64') })).toMatchObject({ status: 413, body: { error: 'photo_too_large' } });
  });

  it('does not offer the photo on a draft from before the tailored CV was kept', async () => {
    seed({ tailoredCv: tailoredCv({ cv: undefined }) });
    const { body } = await handleAssistedApplicationReview({ method: 'GET', query: { t: token() } }, deps());
    expect(body.can.uploadPhoto).toBe(false);
    expect(await post({ action: 'photo_upload', contentBase64: PNG.toString('base64') })).toMatchObject({ status: 409 });
  });

  it('rebuilds the tailored CV when the candidate corrects the phone printed in its header', async () => {
    const edit = await post({ action: 'edit', fields: { phone: '+41 79 999 88 77' } });
    expect(edit.status).toBe(200);
    expect(store.read(`${BASE}/ai_drafts/current`).tailoredCv.pdfKey).not.toBe(tailoredCv().pdfKey);
  }, 60_000);
});

describe('one-PDF dossier (Remote Config ASSISTED_APPLICATION_DOSSIER_MODE)', () => {
  it('is off by default and never for an apprentice', () => {
    expect(dossierMode({})).toBe('separate');
    expect(dossierMode({ ASSISTED_APPLICATION_DOSSIER_MODE: 'single' })).toBe('single');
    expect(wantsDossier({ mode: 'single', channelType: 'email', candidateType: 'qualified' })).toBe(true);
    expect(wantsDossier({ mode: 'single', channelType: 'email', candidateType: 'apprentice' })).toBe(false);
    expect(wantsDossier({ mode: 'separate', channelType: 'email', candidateType: 'qualified' })).toBe(false);
  });

  it('merges letter, CV and documents (PDF, JPG, PNG) within SECO’s limits, else leaves the files apart', async () => {
    const merged = await mergeParts([{ buffer: pdfOf('Lettera'), type: 'pdf' }, { buffer: pdfOf('CV', 2), type: 'pdf' }, { buffer: PNG, type: 'png' }]);
    expect(merged!.pages).toBe(4);
    const extras = [{ files: [{ fileName: 'Diplomi_Maria_Rossi.pdf', buffer: pdfOf('Diploma') }] }];
    const dossier = await dossierAttachment({ language: 'de', stem: 'Maria_Rossi', letter: pdfOf('Brief'), cv: { buffer: pdfOf('CV'), type: 'pdf' }, extras });
    expect(dossier).toMatchObject({ filename: 'Bewerbungsdossier_Maria_Rossi.pdf', pages: 3 });
    // A Word CV cannot be merged; six pages exceed SECO's five.
    expect(await dossierAttachment({ language: 'it', stem: 'x', letter: pdfOf('L'), cv: { buffer: Buffer.from('PK'), type: 'docx' }, extras: [] })).toBeNull();
    expect(await dossierAttachment({ language: 'it', stem: 'x', letter: pdfOf('L'), cv: { buffer: pdfOf('CV', 5), type: 'pdf' }, extras: [] })).toBeNull();
  });
});
