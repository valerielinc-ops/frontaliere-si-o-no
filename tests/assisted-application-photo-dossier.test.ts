import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsPDF } from 'jspdf';
import sharp from 'sharp';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { JPEG_2X2 as JPEG, PNG_1X1 as PNG, pdfPaintsImage } from './helpers/pdfImages';

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({
  getRemoteConfigValue: vi.fn(async () => ''),
  bridgeEmailCascadeCredentialsToEnv: vi.fn(async () => {}),
}));

const { handleAssistedApplicationReview } = await import('../functions/src/assistedApplicationReview.js');
const { mintReviewToken } = await import('../functions/src/assistedApplicationReviewToken.js');
const { dossierAttachment, dossierMode, draftCandidateType, mergeParts, wantsDossier } = await import('../scripts/assisted-application/lib/dossier.mjs');
const { chooseCv } = await import('../scripts/assisted-application/lib/submit.mjs');
const { jpegIsWhole } = await import('../functions/src/assistedApplicationTailoredCvPdf.js');

const SECRET = 'p'.repeat(40);
const T0 = Date.UTC(2026, 9, 2, 10, 0, 0);
const ORDER = 'order_PHOTO1';
const BASE = `assisted_applications/${ORDER}`;
// Its first bytes say PNG, the rest was lost on the way: the type check passes, no reader opens it.
const TRUNCATED_PNG = PNG.subarray(0, 30);
// The tailored CV rebuilt on the review page, and the photos given there.
const REBUILT_CV = /\/ai-cv-r1-candidate-/;
const PHOTO_FILE = /\/photo-/;
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
  const bucket = {
    files,
    // Set by a test to act while a request is between its rebuild (the object just stored) and its commit.
    afterSave: null as null | ((key: string) => Promise<void>),
    // Set by a test to act just before a request reads an object (the photo, in its rebuild).
    beforeDownload: null as null | ((key: string) => Promise<void>),
    // Storage refusing every delete.
    failDeletes: false,
    file: (key: string) => ({
      save: async (buffer: Buffer) => { files.set(key, Buffer.from(buffer)); await bucket.afterSave?.(key); },
      download: async () => {
        await bucket.beforeDownload?.(key);
        if (!files.has(key)) throw Object.assign(new Error('missing'), { code: 404 });
        return [files.get(key)];
      },
      delete: async () => { if (bucket.failDeletes) throw new Error('storage unavailable'); files.delete(key); },
    }),
  };
  return bucket;
}

let store: ReturnType<typeof createMemoryFirestore>;
let bucket: ReturnType<typeof fakeBucket>;
const deps = () => ({ db: store.db, bucket, runEffect: vi.fn(async () => ({ ok: true })), getSecret: async () => SECRET, signUrl: async () => 'https://signed.example/x.pdf', nowMs: T0 });
const token = () => mintReviewToken({ secret: SECRET, orderId: ORDER, round: 1, nowMs: T0 });
const post = (body: Record<string, any>, nowMs = T0) => handleAssistedApplicationReview({ method: 'POST', body: { t: token(), ...body } }, { ...deps(), nowMs });
const get = () => handleAssistedApplicationReview({ method: 'GET', query: { t: token() } }, deps());
const givePhoto = (photo: Buffer = PNG) => post({ action: 'photo_upload', contentBase64: photo.toString('base64') });
const flowNow = () => store.read(`${BASE}/automation/flow`);
const draftNow = () => store.read(`${BASE}/ai_drafts/current`);
const stored = (pattern: RegExp) => [...bucket.files.keys()].filter((key) => pattern.test(key));
/** Whether the CV the runner would send now (chooseCv) carries a photo. */
const sentCvHasPhoto = async () => pdfPaintsImage((await chooseCv({ draft: draftNow(), flow: flowNow(), bucket, cvBuffer: Buffer.from('the uploaded CV'), cvType: 'pdf' })).cvBuffer);

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

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
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
    expect(await sentCvHasPhoto()).toBe(true);
    expect((await get()).body.tailoredCv).toMatchObject({ photo: true, photoPrinted: true });

    const removed = await post({ action: 'photo_remove' });
    expect(removed).toMatchObject({ status: 200, body: { ok: true, photo: false } });
    expect(store.read(`${BASE}/automation/flow`).photo).toBeNull();
    expect(bucket.files.has(flow.photo.key)).toBe(false);
    expect(draftNow().tailoredCv).toMatchObject({ photo: false, renderer: 'typst' });
    expect(await sentCvHasPhoto()).toBe(false);
    expect((await get()).body.tailoredCv).toMatchObject({ photo: false, photoPrinted: false });
  }, 60_000);

  it('prints a JPG as well', async () => {
    expect(await givePhoto(JPEG)).toMatchObject({ status: 200, body: { photo: true } });
    expect(flowNow().photo).toMatchObject({ detectedType: 'jpg', size: JPEG.length });
    expect(draftNow().tailoredCv).toMatchObject({ photo: true, renderer: 'typst' });
    expect(await sentCvHasPhoto()).toBe(true);
  }, 60_000);

  it('refuses a photo Typst cannot read: nothing is stored, what was there stays', async () => {
    const empty = { flow: flowNow(), draft: draftNow() };
    expect(await givePhoto(TRUNCATED_PNG)).toMatchObject({ status: 400, body: { error: 'photo_unreadable' } });
    expect(bucket.files.size).toBe(0);
    expect(flowNow()).toEqual(empty.flow);
    expect(draftNow()).toEqual(empty.draft);
    // With a photo already on the CV: it stays, with the PDF that carries it.
    await givePhoto();
    const kept = { flow: flowNow(), draft: draftNow(), files: [...bucket.files.keys()] };
    expect(await givePhoto(TRUNCATED_PNG)).toMatchObject({ status: 400, body: { error: 'photo_unreadable' } });
    expect([...bucket.files.keys()]).toEqual(kept.files);
    expect(flowNow()).toEqual(kept.flow);
    expect(draftNow()).toEqual(kept.draft);
    expect(await sentCvHasPhoto()).toBe(true);
  }, 60_000);

  it('refuses a JPG cut on the way, which Typst would print half grey: nothing is stored, what was there stays', async () => {
    const before = { flow: flowNow(), draft: draftNow() };
    // Its end marker lost, then its scan cut short too: Typst compiles both and prints what arrived.
    for (const cut of [JPEG.subarray(0, JPEG.length - 2), JPEG.subarray(0, JPEG.length - 3)]) {
      expect(await givePhoto(cut)).toMatchObject({ status: 400, body: { error: 'photo_unreadable' } });
    }
    expect(bucket.files.size).toBe(0);
    expect(flowNow()).toEqual(before.flow);
    expect(draftNow()).toEqual(before.draft);
  }, 60_000);

  it('tells a whole JPG from a cut one by its structure, as encoders write them', async () => {
    const noise = (channels: 1 | 3) => {
      const raw = Buffer.alloc(120 * 160 * channels);
      let value = 7;
      for (let index = 0; index < raw.length; index += 1) {
        value = (value * 1103515245 + 12345) & 0x7fffffff;
        raw[index] = (value >> 16) & 0xff;
      }
      return sharp(raw, { raw: { width: 120, height: 160, channels } });
    };
    const baseline = await noise(3).jpeg({ quality: 80 }).toBuffer();
    const photos = [
      JPEG,
      baseline,
      await noise(3).jpeg({ quality: 80, progressive: true }).toBuffer(),
      await noise(1).jpeg().toBuffer(),
      await sharp(baseline).toColourspace('cmyk').jpeg().toBuffer(),
      await noise(3).withMetadata().jpeg().toBuffer(),
    ];
    for (const photo of photos) {
      expect(jpegIsWhole(photo)).toBe(true);
      // What some phones append after the end marker is not the picture.
      expect(jpegIsWhole(Buffer.concat([photo, Buffer.from('appended by the camera')]))).toBe(true);
      const step = Math.max(1, Math.floor(photo.length / 200));
      for (let cut = 0; cut < photo.length; cut += step) expect(jpegIsWhole(photo.subarray(0, cut))).toBe(false);
      expect(jpegIsWhole(photo.subarray(0, photo.length - 1))).toBe(false);
    }
    // The end marker of a thumbnail kept in an EXIF segment is not the photo's.
    const exif = Buffer.concat([Buffer.from('Exif\0\0'), JPEG]);
    const withThumbnail = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, (exif.length + 2) >> 8, (exif.length + 2) & 0xff]), exif, baseline.subarray(2)]);
    expect(jpegIsWhole(withThumbnail)).toBe(true);
    expect(jpegIsWhole(withThumbnail.subarray(0, Math.floor(withThumbnail.length / 2)))).toBe(false);
  }, 60_000);

  it('keeps nothing of a photo whose rebuild fails', async () => {
    const before = { flow: flowNow(), draft: draftNow() };
    const file = bucket.file;
    bucket.file = (key: string) => (REBUILT_CV.test(key) ? { ...file(key), save: async () => { throw new Error('storage unavailable'); } } : file(key));
    await expect(givePhoto()).rejects.toThrow('storage unavailable');
    expect(bucket.files.size).toBe(0);
    expect(flowNow()).toEqual(before.flow);
    expect(draftNow()).toEqual(before.draft);
  }, 60_000);

  it('says the photo is included only when the PDF carries it: not with the standard-font writer', async () => {
    vi.stubEnv('ASSISTED_APPLICATION_PDF_RENDERER', 'legacy');
    // The switch on legacy: the photo is kept, the PDF has none, and neither the draft nor the page says otherwise.
    expect(await givePhoto()).toMatchObject({ status: 200, body: { photo: true } });
    expect(flowNow().photo).toMatchObject({ detectedType: 'png' });
    expect(draftNow().tailoredCv).toMatchObject({ renderer: 'legacy', photo: false });
    expect(await sentCvHasPhoto()).toBe(false);
    expect((await get()).body.tailoredCv).toMatchObject({ photo: true, photoPrinted: false });
    // Typst again: the next rebuild prints the photo, and records it.
    vi.unstubAllEnvs();
    expect((await post({ action: 'edit', fields: { phone: '+41 79 999 88 77' } })).status).toBe(200);
    expect(draftNow().tailoredCv).toMatchObject({ renderer: 'typst', photo: true });
    expect(await sentCvHasPhoto()).toBe(true);
    expect((await get()).body.tailoredCv).toMatchObject({ photo: true, photoPrinted: true });
    // A record from before the result was kept said "photo" for a photo given, whatever the writer.
    store.docs.set(`${BASE}/ai_drafts/current`, { ...draftNow(), tailoredCv: { ...draftNow().tailoredCv, renderer: 'legacy', photo: true } });
    expect((await get()).body.tailoredCv).toMatchObject({ photo: true, photoPrinted: false });
  }, 60_000);

  it('deletes at once the photo taken back or replaced and the PDF that carried it', async () => {
    // The PDF of the draft, without a photo: not touched when a photo is added.
    bucket.files.set(tailoredCv().pdfKey, pdfOf('CV'));
    await givePhoto();
    expect(bucket.files.has(tailoredCv().pdfKey)).toBe(true);
    const first = { photo: flowNow().photo.key, pdf: draftNow().tailoredCv.pdfKey };
    // Replaced: the first photo and its PDF go once the new ones are committed.
    await givePhoto();
    expect(flowNow().photo.key).not.toBe(first.photo);
    expect(stored(PHOTO_FILE)).toEqual([flowNow().photo.key]);
    expect(stored(REBUILT_CV)).toEqual([draftNow().tailoredCv.pdfKey]);
    // A corrected header rebuilds the PDF with the same photo: the PDF it replaces goes too.
    expect((await post({ action: 'edit', fields: { phone: '+41 79 999 88 77' } })).status).toBe(200);
    expect(stored(REBUILT_CV)).toEqual([draftNow().tailoredCv.pdfKey]);
    expect(stored(REBUILT_CV)).not.toContain(first.pdf);
    // Taken back: no photo and no PDF with it is left in the folder.
    expect((await post({ action: 'photo_remove' })).status).toBe(200);
    expect(stored(PHOTO_FILE)).toEqual([]);
    expect(stored(REBUILT_CV)).toEqual([draftNow().tailoredCv.pdfKey]);
    expect(await sentCvHasPhoto()).toBe(false);
  }, 60_000);

  it('logs a delete that fails and still answers: the purge of the folder is the backstop', async () => {
    await givePhoto();
    const before = { photo: flowNow().photo.key, pdf: draftNow().tailoredCv.pdfKey };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    bucket.failDeletes = true;
    expect(await post({ action: 'photo_remove' })).toMatchObject({ status: 200, body: { photo: false } });
    expect(flowNow().photo).toBeNull();
    expect(await sentCvHasPhoto()).toBe(false);
    const failures = warn.mock.calls.filter(([message]) => String(message).includes('delete failed'));
    expect(failures.map((call) => call[2]).sort()).toEqual([before.photo, before.pdf].map((key) => key.split('/').pop()).sort());
  }, 60_000);

  it('accepts only a JPG or a PNG of at most 2 MB', async () => {
    expect(await post({ action: 'photo_upload', contentBase64: pdfOf('CV').toString('base64') })).toMatchObject({ status: 400, body: { error: 'photo_type_not_allowed' } });
    const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);
    expect(await post({ action: 'photo_upload', contentBase64: big.toString('base64') })).toMatchObject({ status: 413, body: { error: 'photo_too_large' } });
    // Exactly 2 MiB passes the base64 preflight and the decoded-size check.
    const boundary = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024 - PNG.length)]);
    expect(await post({ action: 'photo_upload', contentBase64: boundary.toString('base64') })).toMatchObject({ status: 200, body: { photo: true } });
  }, 60_000);

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

describe('requests that overlap on the review page (two tabs, a request still running after a reload)', () => {
  /**
   * The memory Firestore gives no isolation, so the overlap is driven by hand:
   * `second` runs from start to end while `first` is at `at`: between its
   * rebuild (its PDF just stored) and its commit, before its rebuild reads the
   * photo, or at its commit (a change that rebuilds no PDF). A second later,
   * as a real second request.
   * @returns both answers, and the objects `first` had stored by then
   */
  async function overlap(first: Record<string, any>, second: Record<string, any>, at: 'rebuilt' | 'photo' | 'commit' = 'rebuilt') {
    const before = new Set(bucket.files.keys());
    const photo = flowNow().photo?.key;
    const runTransaction = store.db.runTransaction.bind(store.db);
    let started = false;
    let firstStored: string[] = [];
    let inner: Awaited<ReturnType<typeof post>> | null = null;
    const runSecond = async () => {
      started = true;
      firstStored = [...bucket.files.keys()].filter((name) => !before.has(name));
      inner = await post(second, T0 + 1000);
    };
    if (at === 'rebuilt') bucket.afterSave = async (key) => { if (!started && REBUILT_CV.test(key)) await runSecond(); };
    if (at === 'photo') bucket.beforeDownload = async (key) => { if (!started && key === photo) await runSecond(); };
    if (at === 'commit') {
      store.db.runTransaction = async (callback: any) => {
        if (!started) await runSecond();
        return runTransaction(callback);
      };
    }
    const outer = await post(first);
    bucket.afterSave = null;
    bucket.beforeDownload = null;
    store.db.runTransaction = runTransaction;
    return { first: outer, second: inner as Awaited<ReturnType<typeof post>> | null, firstStored };
  }

  /** The CV that would leave carries a photo exactly when the flow has one, the page says the same, and nothing else is kept. */
  async function expectOneConsistentState() {
    const photo = flowNow().photo?.key || null;
    expect(await sentCvHasPhoto()).toBe(Boolean(photo));
    expect(draftNow().tailoredCv.photo).toBe(Boolean(photo));
    expect((await get()).body.tailoredCv).toMatchObject({ photo: Boolean(photo), photoPrinted: Boolean(photo) });
    expect(stored(PHOTO_FILE)).toEqual(photo ? [photo] : []);
    // No PDF with a photo beside the one the draft names.
    for (const key of stored(REBUILT_CV)) {
      if (key !== draftNow().tailoredCv.pdfKey) expect(await pdfPaintsImage(bucket.files.get(key)!)).toBe(false);
    }
  }

  const photoUpload = { action: 'photo_upload', contentBase64: PNG.toString('base64') };

  it('never publishes a line-choice PDF built with a photo that was removed during its rebuild', async () => {
    await givePhoto();
    const { first, second, firstStored } = await overlap({ action: 'cv_lines', choices: {} }, { action: 'photo_remove' });
    expect(second).toMatchObject({ status: 200, body: { photo: false } });
    expect(flowNow().photo).toBeNull();
    await expectOneConsistentState();
    // Built with the photo that is gone: refused, its PDF deleted, its choices not saved.
    expect(first).toMatchObject({ status: 409, body: { ok: false, error: 'changed_meanwhile' } });
    expect(firstStored).toHaveLength(1);
    expect(firstStored.filter((key) => bucket.files.has(key))).toEqual([]);
    expect(flowNow().cvChoicesRound).toBeUndefined();
  }, 60_000);

  it('never publishes a corrected header built with a photo that was removed during its rebuild', async () => {
    await givePhoto();
    const letter = draftNow().coverLetterPdfKey;
    const { first, second, firstStored } = await overlap({ action: 'edit', fields: { phone: '+41 79 999 88 77' } }, { action: 'photo_remove' });
    expect(second).toMatchObject({ status: 200, body: { photo: false } });
    await expectOneConsistentState();
    expect(first).toMatchObject({ status: 409, body: { ok: false, error: 'changed_meanwhile' } });
    // The letter and the CV it rebuilt are deleted; nothing of the edit is saved.
    expect(firstStored).toHaveLength(2);
    expect(firstStored.filter((key) => bucket.files.has(key))).toEqual([]);
    expect(flowNow().formOverrides).toBeUndefined();
    expect(draftNow().coverLetterPdfKey).toBe(letter);
    expect(draftNow().candidateEditedAt).toBeUndefined();
  }, 60_000);

  it('refuses as at its commit, not with a 500, a change whose photo was taken back before its rebuild read it', async () => {
    for (const change of [{ action: 'cv_lines', choices: {} }, { action: 'edit', fields: { phone: '+41 79 999 88 77' } }]) {
      bucket = fakeBucket();
      seed();
      await givePhoto();
      const letter = draftNow().coverLetterPdfKey;
      const { first, second, firstStored } = await overlap(change, { action: 'photo_remove' }, 'photo');
      expect(second).toMatchObject({ status: 200, body: { photo: false } });
      await expectOneConsistentState();
      // The page reloads on this answer and shows the CV without the photo.
      expect(first).toMatchObject({ status: 409, body: { ok: false, error: 'changed_meanwhile' } });
      // What it stored before reading the photo (the edit's letter) is deleted; nothing of it is saved.
      expect(firstStored).toHaveLength(change.action === 'edit' ? 1 : 0);
      expect(firstStored.filter((key) => bucket.files.has(key))).toEqual([]);
      expect(flowNow().cvChoicesRound).toBeUndefined();
      expect(flowNow().formOverrides).toBeUndefined();
      expect(draftNow().coverLetterPdfKey).toBe(letter);
      expect(draftNow().candidateEditedAt).toBeUndefined();
    }
  }, 60_000);

  it('refuses an edit when another edit was saved meanwhile: what the other tab saved is not overwritten', async () => {
    const body = 'Sehr geehrte Damen und Herren\n\nim Anhang meine Bewerbung.\n\nFreundliche Grüsse\nMaria Rossi';
    seed({ channel: { type: 'email', email: 'jobs@spital.example' }, applicationEmail: { to: 'jobs@spital.example', subject: 'Bewerbung als Pflegefachperson HF', body } });
    const subject = 'Bewerbung Pflegefachperson HF, Maria Rossi';
    const otherBody = 'Sehr geehrte Damen und Herren\n\nim Anhang sende ich Ihnen meine Bewerbung mit Lebenslauf und Brief.\n\nFreundliche Grüsse\nMaria Rossi';
    // Neither rebuilds a PDF: the body (first) reaches its commit after the subject (second) is saved.
    const { first, second } = await overlap({ action: 'edit', emailBody: otherBody }, { action: 'edit', emailSubject: subject }, 'commit');
    expect(second).toMatchObject({ status: 200, body: { changed: ['email'] } });
    // Written whole from what it loaded, the body's e-mail would put the old subject back.
    expect(first).toMatchObject({ status: 409, body: { ok: false, error: 'changed_meanwhile' } });
    expect(draftNow().applicationEmail).toMatchObject({ subject, body });
    expect(draftNow().factSources.candidate).toBe(subject);
    expect(draftNow().candidateEditedAt).toBe(T0 + 1000);
  }, 60_000);

  it('leaves one consistent state when a photo is given and taken back at the same time', async () => {
    // Taken back while one is being given: the upload is refused, its photo and its PDF deleted.
    let run = await overlap(photoUpload, { action: 'photo_remove' });
    expect(run.second).toMatchObject({ status: 200, body: { photo: false } });
    expect(flowNow().photo).toBeNull();
    await expectOneConsistentState();
    expect(run.first).toMatchObject({ status: 409, body: { error: 'changed_meanwhile' } });
    expect(run.firstStored).toHaveLength(2);
    expect(run.firstStored.filter((key) => bucket.files.has(key))).toEqual([]);

    // Given while the one there is being taken back: the removal is refused, the new photo is on the CV.
    await givePhoto();
    const old = flowNow().photo.key;
    run = await overlap({ action: 'photo_remove' }, photoUpload);
    expect(run.second).toMatchObject({ status: 200, body: { photo: true } });
    await expectOneConsistentState();
    expect(flowNow().photo.key).not.toBe(old);
    expect(run.first).toMatchObject({ status: 409, body: { error: 'changed_meanwhile' } });
    expect(run.firstStored.filter((key) => bucket.files.has(key))).toEqual([]);
  }, 60_000);

  it('refuses a change that finishes after the candidate approved: the CV approved is the CV that leaves', async () => {
    await givePhoto();
    const approved = draftNow().tailoredCv.pdfKey;
    const { first, second, firstStored } = await overlap({ action: 'photo_remove' }, { action: 'approve' });
    expect(second).toMatchObject({ status: 200, body: { state: 'submitting' } });
    expect(draftNow().tailoredCv.pdfKey).toBe(approved);
    expect(await sentCvHasPhoto()).toBe(true);
    expect(flowNow()).toMatchObject({ state: 'submitting', photo: { detectedType: 'png' } });
    expect(first).toMatchObject({ status: 409, body: { error: 'changed_meanwhile' } });
    expect(firstStored.filter((key) => bucket.files.has(key))).toEqual([]);
  }, 60_000);

  it('writes the photo and its PDF together: a write that fails leaves neither', async () => {
    await givePhoto();
    const before = { flow: flowNow(), draft: draftNow() };
    // Firestore applies the writes of a transaction at its commit, together or not at all; the
    // memory helper applies each one as it is asked. The commit is added here.
    const put = store.docs.set.bind(store.docs);
    store.db.runTransaction = async (callback: any) => {
      const writes: Array<() => Promise<void>> = [];
      const result = await callback({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, options: any) => { writes.push(() => ref.set(data, options)); },
        delete: (ref: any) => { writes.push(() => ref.delete()); },
      });
      const snapshot = new Map(store.docs);
      try {
        for (const write of writes) await write();
      } catch (error) {
        store.docs.clear();
        for (const [path, data] of snapshot) put(path, data);
        throw error;
      }
      return result;
    };
    // The draft cannot be written, the flow can.
    store.docs.set = (path: string, data: any) => {
      if (path === `${BASE}/ai_drafts/current`) throw new Error('draft write failed');
      return put(path, data);
    };
    await expect(post({ action: 'photo_remove' })).rejects.toThrow('draft write failed');
    store.docs.set = put;
    expect(flowNow()).toEqual(before.flow);
    expect(draftNow()).toEqual(before.draft);
    expect(bucket.files.has(before.flow.photo.key)).toBe(true);
    expect(await sentCvHasPhoto()).toBe(true);
  }, 60_000);
});

describe('one-PDF dossier (Remote Config ASSISTED_APPLICATION_DOSSIER_MODE)', () => {
  it('is off by default and never for an apprentice', () => {
    expect(dossierMode({})).toBe('separate');
    expect(dossierMode({ ASSISTED_APPLICATION_DOSSIER_MODE: 'single' })).toBe('single');
    expect(wantsDossier({ mode: 'single', channelType: 'email', candidateType: 'qualified' })).toBe(true);
    expect(wantsDossier({ mode: 'single', channelType: 'email', candidateType: 'apprentice' })).toBe(false);
    expect(wantsDossier({ mode: 'separate', channelType: 'email', candidateType: 'qualified' })).toBe(false);
    // A draft older than the types of application: the separate files.
    expect(wantsDossier({ mode: 'single', channelType: 'email', candidateType: '' })).toBe(false);
    // The draft keeps { type, sector }; a plain string is read too.
    expect(draftCandidateType({ candidateType: { type: 'apprentice', sector: 'it' } })).toBe('apprentice');
    expect(draftCandidateType({ candidateType: 'apprentice' })).toBe('apprentice');
    expect(draftCandidateType({})).toBe('');
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
