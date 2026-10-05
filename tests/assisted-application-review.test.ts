import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { JPEG_2X2 } from './helpers/pdfImages';

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({
  getRemoteConfigValue: vi.fn(async () => ''),
  bridgeEmailCascadeCredentialsToEnv: vi.fn(async () => {}),
}));

const { handleAssistedApplicationReview, minDateFor, sendReviewResponse } = await import('../functions/src/assistedApplicationReview.js');
const { permitOptions } = await import('../functions/src/lib/permitStatus.js');
const { mintReviewToken } = await import('../functions/src/assistedApplicationReviewToken.js');
const { CANDIDATE_REVIEW_MS } = await import('../functions/src/assistedApplicationFlow.js');
const { MAX_FIT_GAPS, fitNoticeOf, fitNoticeWording } = await import('../functions/src/assistedApplicationFitNotice.js');
const { default: itCore } = await import('../services/locales/it-core');
const { default: enCore } = await import('../services/locales/en-core');
const { default: deCore } = await import('../services/locales/de-core');
const { default: frCore } = await import('../services/locales/fr-core');
const { sanitizeTailoredCv } = await import('../functions/src/assistedApplicationTailoredCv.js');
const { DOCX_CONTENT_TYPE, paragraphInventory } = await import('../functions/src/assistedApplicationDocxInPlace.js');
const { entryData, readZip } = await import('../functions/src/lib/zipArchive.js');
const { formatLetterDate } = await import('../functions/src/assistedApplicationAiPrompts.js');
const { handleAutomationAdminAction } = await import('../functions/src/assistedApplicationAutomationAdmin.js');
const { runAutomationAdminAction } = await import('../services/assistedApplicationAdminService');

const SECRET = 'r'.repeat(40);
const T0 = Date.UTC(2026, 8, 30, 10, 0, 0);
const ORDER = 'order_REV123';
const BASE = `assisted_applications/${ORDER}`;

function draft(extra: Record<string, any> = {}) {
  return {
    status: 'ready',
    round: 1,
    verdict: 'weak',
    summaryIt: 'Profilo debole: manca il tedesco.',
    checksIt: ['Chiedere il diploma'],
    factCheck: { ok: false, unsupported: [{ kind: 'number', token: '7' }] },
    profile: { fullName: 'Maria Rossi', email: 'maria@example.com', location: 'Como', languages: [] },
    job: { source: 'job_detail', title: 'Infermiera', applyUrl: 'https://jobs.lever.co/x/1/apply' },
    channel: { type: 'lever', label: 'Lever', applyUrl: 'https://jobs.lever.co/x/1/apply' },
    coverLetter: { subject: 'Candidatura', text: 'Gentili Signori,\n\nTesto.\n\nCordiali saluti' },
    applicationEmail: { to: '', subject: 'x', body: 'y' },
    formAnswers: [{ key: 'motivationShort', label: 'Motivazione', value: 'Mi motiva il reparto.' }],
    questions: [{ id: 'work_permit', question: 'Hai un permesso?', why: 'Richiesto', type: 'choice', options: ['G', 'B'], required: true }],
    coverLetterPdfKey: `assisted-application-uploads/${ORDER}/ai-cover-letter-r1-1.pdf`,
    ...extra,
  };
}

let store: ReturnType<typeof createMemoryFirestore>;
const effects: any[] = [];
const runEffect = vi.fn(async (context: any) => { effects.push(context.effect); return { ok: true }; });
const deps = () => ({ db: store.db, runEffect, getSecret: async () => SECRET, signUrl: async () => 'https://signed.example/letter.pdf', nowMs: T0 });
const token = (round = 1) => mintReviewToken({ secret: SECRET, orderId: ORDER, round, nowMs: T0 });

beforeEach(() => {
  effects.length = 0;
  store = createMemoryFirestore({
    [BASE]: { paymentStatus: 'paid', submissionStatus: 'in_progress', jobTitle: 'Infermiera', companyName: 'Clinica', locale: 'it', applicantName: 'Maria Rossi' },
    [`${BASE}/automation/flow`]: { state: 'candidate_review', round: 1, deadlineAt: null, answers: {}, feedback: [] },
    [`${BASE}/ai_drafts/current`]: draft(),
  });
});

describe('candidate review API', () => {
  it('shows the texts and the questions, never the operator analysis', async () => {
    const { status, body } = await handleAssistedApplicationReview({ method: 'GET', query: { t: token() } }, deps());
    expect(status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      stale: false,
      state: 'candidate_review',
      ready: true,
      coverLetterUrl: 'https://signed.example/letter.pdf',
      questions: [{ id: 'work_permit', required: true }],
      can: { approve: false, reject: true, answer: true, confirmSubmitted: false },
    });
    const serialized = JSON.stringify(body);
    for (const secret of ['verdict', 'summaryIt', 'checksIt', 'factCheck', 'Profilo debole', 'Chiedere il diploma']) {
      expect(serialized).not.toContain(secret);
    }
  });

  // Owner decision 2026-10-03: a profile that is not a full match goes on, and the candidate reads why above the questions.
  it('tells the candidate which decisive requirements the CV does not show, and nothing else of the analysis', async () => {
    const requirements = [
      { requirement: 'Tedesco fluente', importance: 'high', basis: 'stated', quote: 'Business fluent German' },
      { requirement: 'Esperienza come concierge in un hotel 5 stelle', importance: 'critical', basis: 'stated', quote: 'Several years of experience as a Concierge within the 5-star hotel industry' },
      { requirement: 'Patente B', importance: 'meaningful', basis: 'stated', quote: 'Driving licence' },
      { requirement: 'Inglese fluente', importance: 'critical', basis: 'stated', quote: 'Business fluent English' },
    ];
    const matches = [
      { index: 0, status: 'partial', evidence: 'Tedesco B1' }, { index: 1, status: 'missing', evidence: '' },
      { index: 2, status: 'missing', evidence: '' }, { index: 3, status: 'met', evidence: 'Inglese C1' },
    ];
    await store.db.collection('assisted_applications').doc(ORDER).collection('ai_drafts').doc('current').set(draft({ verdict: 'poor', requirements, matches }));
    const { body } = await handleAssistedApplicationReview({ method: 'GET', query: { t: token() } }, deps());
    // The must-have first, then what is partly there; never a merely "asked for" requirement, nor one that is met.
    expect(body.fit).toEqual({
      level: 'low',
      gaps: [
        { requirement: 'Esperienza come concierge in un hotel 5 stelle', quote: 'Several years of experience as a Concierge within the 5-star hotel industry', importance: 'critical', status: 'missing' },
        { requirement: 'Tedesco fluente', quote: 'Business fluent German', importance: 'high', status: 'partial' },
      ],
    });
    const serialized = JSON.stringify(body);
    for (const secret of ['verdict', 'summaryIt', 'checksIt', 'factCheck', 'Profilo debole', 'Tedesco B1', 'Inglese C1']) expect(serialized).not.toContain(secret);
    // A draft of another round is not this round's notice.
    await store.db.collection('assisted_applications').doc(ORDER).collection('automation').doc('flow').set({ round: 2 }, { merge: true });
    expect((await handleAssistedApplicationReview({ method: 'GET', query: { t: token(2) } }, deps())).body.fit).toBeNull();
  });

  it('says nothing on a full match, «partial» when a requirement does not show, «low» when the verdict is poor', () => {
    const requirement = (importance: string, index: number) => ({ requirement: `Requisito ${index}`, importance, basis: 'stated', quote: `Quote ${index}` });
    const met = { verdict: 'good', requirements: [requirement('critical', 0), requirement('high', 1)], matches: [{ index: 0, status: 'met' }, { index: 1, status: 'met' }] };
    expect(fitNoticeOf(met)).toBeNull();
    expect(fitNoticeOf(null)).toBeNull();
    // A requirement the match never judged is not called missing.
    expect(fitNoticeOf({ ...met, matches: [{ index: 0, status: 'met' }] })).toBeNull();
    expect(fitNoticeOf({ ...met, verdict: 'weak', matches: [{ index: 0, status: 'met' }, { index: 1, status: 'missing' }] }))
      .toEqual({ level: 'partial', gaps: [{ requirement: 'Requisito 1', quote: 'Quote 1', importance: 'high', status: 'missing' }] });
    // The verdict alone still warns, with whatever gaps there are.
    expect(fitNoticeOf({ ...met, verdict: 'poor' })).toEqual({ level: 'low', gaps: [] });
    const many = Array.from({ length: 9 }, (_, index) => requirement(index % 2 ? 'high' : 'critical', index));
    const notice = fitNoticeOf({ verdict: 'weak', requirements: many, matches: many.map((_, index) => ({ index, status: index < 3 ? 'partial' : 'missing' })) });
    expect(notice?.gaps).toHaveLength(MAX_FIT_GAPS);
    expect(notice?.gaps.map((gap: any) => `${gap.importance}:${gap.status}`)).toEqual(['critical:missing', 'critical:missing', 'critical:missing', 'critical:partial', 'critical:partial', 'high:missing']);
  });

  // Close-out of 2026-10-03: a verdict «poor» may come with no gap to list, and a draft may have no
  // questions; the notice then neither promises a list nor sends the candidate to answers that are not there.
  it('words the notice for what the page shows: a list only when there is one, the answers only when it asks questions', () => {
    const gap = { requirement: 'Tedesco fluente', quote: 'Fluent German', importance: 'high', status: 'missing' };
    expect(fitNoticeWording({ level: 'low', gaps: [] }, { questions: true })).toEqual({ kind: 'far', via: 'answers' });
    expect(fitNoticeWording({ level: 'low', gaps: [gap] }, { questions: true })).toEqual({ kind: 'low', via: 'answers' });
    expect(fitNoticeWording({ level: 'partial', gaps: [gap] }, { questions: true })).toEqual({ kind: 'partial', via: 'answers' });
    // No questions in candidate review: the letter («Modifica») or a new version («Chiedi modifiche»).
    expect(fitNoticeWording({ level: 'low', gaps: [] }, { questions: false })).toEqual({ kind: 'far', via: 'edit' });
    expect(fitNoticeWording({ level: 'partial', gaps: [gap] }, { questions: false, edit: true })).toEqual({ kind: 'partial', via: 'edit' });
    // A portal that asked only for a document: the page offers neither, the notice points to nothing.
    expect(fitNoticeWording({ level: 'partial', gaps: [gap] }, { questions: false, edit: false })).toEqual({ kind: 'partial', via: null });
    expect(fitNoticeWording(null, { questions: true })).toBeNull();

    // Every title and sentence the notice can show, in the four languages, naming the page's own buttons.
    const answersWord: Record<string, string> = { it: 'risposte qui sotto', en: 'answers below', de: 'unten in die Antworten', fr: 'réponses ci-dessous' };
    const listWord: Record<string, RegExp> = { it: /\brequisito\b/, en: /\brequirement\b/, de: /\bAnforderung\b/, fr: /\bexigence\b/ };
    for (const [locale, copy] of Object.entries({ it: itCore, en: enCore, de: deCore, fr: frCore }) as Array<[string, Record<string, string>]>) {
      const key = (name: string) => copy[`jobBoard.assisted.review.fit.${name}`];
      for (const kind of ['partial', 'low', 'far']) {
        expect(key(`${kind}Title`), `${locale} ${kind}Title`).toBeTruthy();
        expect(key(`${kind}Body`), `${locale} ${kind}Body`).toContain(answersWord[locale]);
        const edit = key(`${kind}BodyEdit`);
        expect(edit, `${locale} ${kind}BodyEdit`).toBeTruthy();
        expect(edit).not.toContain(answersWord[locale]);
        expect(edit).toContain(copy['jobBoard.assisted.review.edit']);
        expect(edit).toContain(copy['jobBoard.assisted.review.requestChanges']);
      }
      // With no gap listed, neither the title nor the sentences name a requirement the page does not show.
      for (const name of ['farTitle', 'farBody', 'farBodyEdit']) expect(key(name), `${locale} ${name}`).not.toMatch(listWord[locale]);
    }
  });

  it('rejects forged, expired and superseded links', async () => {
    const forged = token().replace(/.$/, (char) => (char === '0' ? '1' : '0'));
    expect((await handleAssistedApplicationReview({ method: 'GET', query: { t: forged } }, deps())).status).toBe(403);
    const expired = mintReviewToken({ secret: SECRET, orderId: ORDER, round: 1, nowMs: T0 - 40 * 24 * 3600_000 });
    expect((await handleAssistedApplicationReview({ method: 'GET', query: { t: expired } }, deps())).body).toMatchObject({ error: 'link_expired' });

    await store.db.collection('assisted_applications').doc(ORDER).collection('automation').doc('flow').set({ round: 2 }, { merge: true });
    const old = await handleAssistedApplicationReview({ method: 'GET', query: { t: token(1) } }, deps());
    expect(old.body).toMatchObject({ stale: true, can: { approve: false, reject: false } });
    const post = await handleAssistedApplicationReview({ method: 'POST', body: { t: token(1), action: 'approve' } }, deps());
    expect(post).toMatchObject({ status: 409, body: { error: 'stale_link' } });
  });

  it('keeps the application until the required answer arrives, then starts the 12 h clock', async () => {
    const approve = await handleAssistedApplicationReview({ method: 'POST', body: { t: token(), action: 'approve' } }, deps());
    expect(approve).toMatchObject({ status: 409, body: { error: 'questions_open' } });

    const bad = await handleAssistedApplicationReview({ method: 'POST', body: { t: token(), action: 'answers', answers: { work_permit: 'Z', unknown: 'x' } } }, deps());
    // An option that does not exist: the field says so, nothing is saved.
    expect(bad).toMatchObject({ status: 400, body: { error: 'invalid_answers', fields: { work_permit: 'Scegli una delle opzioni.' } } });

    const answered = await handleAssistedApplicationReview({ method: 'POST', body: { t: token(), action: 'answers', answers: { work_permit: 'G' } } }, deps());
    expect(answered).toMatchObject({ status: 200, body: { state: 'candidate_review' } });
    expect(store.read(`${BASE}/automation/flow`)).toMatchObject({ answers: { work_permit: 'G' }, deadlineAt: T0 + CANDIDATE_REVIEW_MS });

    const approved = await handleAssistedApplicationReview({ method: 'POST', body: { t: token(), action: 'approve' } }, deps());
    expect(approved).toMatchObject({ status: 200, body: { state: 'submitting' } });
    expect(effects.at(-1)).toEqual({ type: 'dispatch', mode: 'submit', reason: 'candidate_approved' });
  });

  // Rolex 2026-10-02: the posting asks for school reports and the EVA test results besides the CV.
  describe('requested documents', () => {
    const PDF = Buffer.from('%PDF-1.4\nreport\n%%EOF');
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const docsDraft = () => draft({
      questions: [],
      requiredDocuments: [
        { id: 'reports', label: 'Bulletins scolaires', kind: 'school_report', keywords: ['bulletin'], required: true, quote: 'Vos bulletins' },
        { id: 'eva', label: 'Résultats du test EVA', kind: 'aptitude_test', keywords: ['EVA'], required: true, quote: 'test EVA' },
      ],
    });
    let saved: Map<string, { content: Buffer, options: any }>;
    let deleted: string[];
    const bucket = () => ({
      file: (key: string) => ({
        save: async (content: Buffer, options: any) => { saved.set(key, { content, options }); },
        delete: async () => { deleted.push(key); saved.delete(key); },
      }),
    });
    const post = (body: Record<string, unknown>) => handleAssistedApplicationReview({ method: 'POST', body: { t: token(), ...body } }, { ...deps(), bucket: bucket() });
    const upload = (documentId: string, content: Buffer, extra: Record<string, unknown> = {}) => post({
      action: 'document_upload', documentId, fileName: 'scan.pdf', contentBase64: content.toString('base64'), clientCheck: { verdict: 'match', matched: 'bulletin' }, ...extra,
    });

    beforeEach(async () => {
      saved = new Map();
      deleted = [];
      await store.db.collection('assisted_applications').doc(ORDER).collection('ai_drafts').doc('current').set(docsDraft());
      // As the flow holds it after Valerie's approval.
      await store.db.collection('assisted_applications').doc(ORDER).collection('automation').doc('flow')
        .set({ heldBy: ['document:reports', 'document:eva'], heldSince: T0 }, { merge: true });
    });

    it('shows what the posting asks and keeps the application until each document is given or waived', async () => {
      const page = await handleAssistedApplicationReview({ method: 'GET', query: { t: token() } }, deps());
      expect(page.body).toMatchObject({
        documents: [{ id: 'reports', label: 'Bulletins scolaires', required: true, quote: 'Vos bulletins', files: [], waived: false }, { id: 'eva', files: [] }],
        documentLimits: { maxBytes: 10 * 1024 * 1024, maxFiles: 5 },
        can: { approve: false, uploadDocuments: true },
      });
      expect((await post({ action: 'approve' })).body).toMatchObject({ error: 'questions_open' });

      expect(await upload('reports', PDF)).toMatchObject({ status: 200, body: { state: 'candidate_review' } });
      const [key] = [...saved.keys()];
      expect(key).toMatch(new RegExp(`^assisted-application-uploads/${ORDER}/doc-reports-${T0}-[0-9a-f]{8}\\.pdf$`));
      expect(saved.get(key)!.options).toMatchObject({ contentType: 'application/pdf' });
      expect(store.read(`${BASE}/automation/flow`).documents.reports.files[0]).toMatchObject({
        key, name: 'scan.pdf', size: PDF.length, detectedType: 'pdf', uploadedAt: T0, clientCheck: { verdict: 'match', matched: 'bulletin' },
      });
      // Still held by the EVA results: no clock yet.
      expect(store.read(`${BASE}/automation/flow`)).toMatchObject({ heldBy: ['document:eva'], deadlineAt: null });

      // The candidate has no EVA results and chooses to send without them (after the page's warning).
      expect(await post({ action: 'document_waive', documentId: 'eva', waive: true })).toMatchObject({ status: 200 });
      expect(store.read(`${BASE}/automation/flow`)).toMatchObject({ heldBy: [], deadlineAt: T0 + CANDIDATE_REVIEW_MS, documents: { eva: { waivedAt: T0 } } });
      expect((await post({ action: 'approve' })).body).toMatchObject({ state: 'submitting' });
    });

    it('accepts a photo or a scan, refuses another type, a file too large and a sixth file', async () => {
      expect(await upload('reports', PNG)).toMatchObject({ status: 200 });
      expect([...saved.keys()][0]).toMatch(/\.png$/);
      expect(await upload('reports', Buffer.from('MZ not a document'))).toMatchObject({ status: 400, body: { error: 'file_type_not_allowed' } });
      expect(await upload('reports', Buffer.alloc(10 * 1024 * 1024 + 1, 0x25))).toMatchObject({ status: 413, body: { error: 'file_too_large' } });
      expect(await upload('nope', PDF)).toMatchObject({ status: 400, body: { error: 'invalid_document' } });
      for (let i = 0; i < 4; i += 1) await upload('reports', PDF);
      expect(await upload('reports', PDF)).toMatchObject({ status: 409, body: { error: 'too_many_files' } });
      expect(store.read(`${BASE}/automation/flow`).documents.reports.files).toHaveLength(5);
      // An unknown browser verdict is recorded as "could not check", never trusted.
      await post({ action: 'document_remove', documentId: 'reports', fileId: store.read(`${BASE}/automation/flow`).documents.reports.files[4].key.split('/').pop() });
      await upload('reports', PDF, { clientCheck: { verdict: 'trust_me' } });
      expect(store.read(`${BASE}/automation/flow`).documents.reports.files.at(-1).clientCheck).toEqual({ verdict: 'unreadable', matched: '' });
    });

    // A cut JPG would print half grey inside the grouped PDF of the documents (lib/dossier.mjs).
    it('refuses a JPG cut on the way, as the photo is, and says so in the four languages', async () => {
      expect(await upload('reports', JPEG_2X2.subarray(0, JPEG_2X2.length - 2), { fileName: 'scan.jpg' })).toMatchObject({ status: 400, body: { error: 'file_unreadable' } });
      expect(saved.size).toBe(0);
      expect(store.read(`${BASE}/automation/flow`).documents?.reports?.files ?? []).toEqual([]);
      expect(await upload('reports', JPEG_2X2, { fileName: 'scan.jpg' })).toMatchObject({ status: 200 });
      expect([...saved.keys()][0]).toMatch(/\.jpg$/);
      for (const strings of [itCore, enCore, deCore, frCore]) expect(String(strings['jobBoard.assisted.review.error.file_unreadable'] || '').trim()).not.toBe('');
    });

    it('removes a file, and a document waived is taken back by a file given', async () => {
      await upload('reports', PDF);
      const fileId = store.read(`${BASE}/automation/flow`).documents.reports.files[0].key.split('/').pop();
      expect(await post({ action: 'document_remove', documentId: 'reports', fileId })).toMatchObject({ status: 200 });
      expect(store.read(`${BASE}/automation/flow`).documents.reports.files).toEqual([]);
      expect(deleted).toHaveLength(1);
      expect(store.read(`${BASE}/automation/flow`).heldBy).toContain('document:reports');
      expect(await post({ action: 'document_remove', documentId: 'reports', fileId })).toMatchObject({ status: 400, body: { error: 'invalid_file' } });

      await post({ action: 'document_waive', documentId: 'eva', waive: true });
      await upload('eva', PDF);
      expect(store.read(`${BASE}/automation/flow`).documents.eva).toMatchObject({ waivedAt: null, files: [{ detectedType: 'pdf' }] });
    });

    it('accepts documents only while the candidate can still give them', async () => {
      await store.db.collection('assisted_applications').doc(ORDER).collection('automation').doc('flow').set({ state: 'submitting' }, { merge: true });
      expect(await upload('reports', PDF)).toMatchObject({ status: 409, body: { error: 'not_allowed' } });
      expect(saved.size).toBe(0);
    });
  });

  it('refuses a start date in the past or an impossible date, and tells the page the earliest one', async () => {
    const availability = { id: 'availability', question: 'Da quale data saresti disponibile a iniziare?', why: '', type: 'date', options: [], required: true };
    const birth = { id: 'birth_date', question: 'Data di nascita', why: '', type: 'date', options: [], required: false };
    await store.db.collection('assisted_applications').doc(ORDER).collection('ai_drafts').doc('current').set(draft({ questions: [availability, birth] }));
    const view = await handleAssistedApplicationReview({ method: 'GET', query: { t: token() } }, deps());
    // T0 is 30-09-2026 10:00 UTC: the start date may be today at the earliest; a birth date has no minimum.
    expect(view.body.questions).toEqual([
      // Proposed start: first day of the month three months after next month (September → 1 January).
      expect.objectContaining({ id: 'availability', minDate: '2026-09-30', suggested: '2027-01-01' }),
      expect.objectContaining({ id: 'birth_date', minDate: null, suggested: null }),
    ]);
    const answer = (answers: Record<string, string>) => handleAssistedApplicationReview({ method: 'POST', body: { t: token(), action: 'answers', answers } }, deps());
    expect(await answer({ availability: '1985-09-12' })).toMatchObject({ status: 400, body: { error: 'invalid_answers', fields: { availability: 'La data non può essere nel passato.' } } });
    expect(await answer({ availability: '2026-02-30' })).toMatchObject({ status: 400, body: { error: 'invalid_answers', fields: { availability: 'Inserisci una data valida.' } } });
    expect(await answer({ availability: 'domani' })).toMatchObject({ status: 400, body: { error: 'invalid_answers' } });
    expect(store.read(`${BASE}/automation/flow`)?.answers).toEqual({});
    expect(await answer({ availability: '2026-11-01', birth_date: '1985-09-12' })).toMatchObject({ status: 200 });
    expect(store.read(`${BASE}/automation/flow`)?.answers).toEqual({ availability: '2026-11-01', birth_date: '1985-09-12' });
    // Start-date wording in the four languages, German included.
    for (const question of ['Ab wann verfügbar?', 'Ab wann könnten Sie beginnen?', 'Quand êtes-vous disponible ?', 'When can you start?']) {
      expect(minDateFor({ type: 'date', question }, T0)).toBe('2026-09-30');
    }
    expect(minDateFor({ type: 'date', question: 'Geburtsdatum' }, T0)).toBeNull();
  });

  it('checks each answer with the rule written with its question, and says which field to fix', async () => {
    const notice = {
      id: 'notice_period', question: 'Qual è il tuo periodo di preavviso?', why: '', type: 'text', options: [], required: true,
      validation: { pattern: '^\\d{1,2}\\s?(mesi|mese|settimane)$', minLength: 0, maxLength: 40, min: null, max: null, minDate: '', example: '3 mesi', message: 'Indica il preavviso in mesi o settimane, per esempio 3 mesi.' },
    };
    const years = {
      id: 'years', question: 'Anni di esperienza in geriatria?', why: '', type: 'number', options: [], required: false,
      validation: { pattern: '', minLength: 0, maxLength: 10, min: 0, max: 50, minDate: '', example: '5', message: 'Un numero di anni tra 0 e 50.' },
    };
    await store.db.collection('assisted_applications').doc(ORDER).collection('ai_drafts').doc('current').set(draft({ questions: [notice, years] }));
    const view = await handleAssistedApplicationReview({ method: 'GET', query: { t: token() } }, deps());
    // The page receives the rule and checks it while the candidate types.
    expect(view.body.questions[0].validation).toMatchObject({ example: '3 mesi', maxLength: 40 });
    const save = (answers: Record<string, string>) => handleAssistedApplicationReview({ method: 'POST', body: { t: token(), action: 'answers', answers } }, deps());
    expect(await save({ notice_period: 'boh', years: '120' })).toMatchObject({
      status: 400,
      body: { error: 'invalid_answers', fields: { notice_period: 'Indica il preavviso in mesi o settimane, per esempio 3 mesi.', years: 'Un numero di anni tra 0 e 50.' } },
    });
    expect(store.read(`${BASE}/automation/flow`)?.answers).toEqual({});
    expect(await save({ notice_period: '3 mesi', years: '12' })).toMatchObject({ status: 200 });
    expect(store.read(`${BASE}/automation/flow`)?.answers).toEqual({ notice_period: '3 mesi', years: '12' });
  });

  it('turns feedback into a new round', async () => {
    const empty = await handleAssistedApplicationReview({ method: 'POST', body: { t: token(), action: 'reject', feedback: 'no' } }, deps());
    expect(empty).toMatchObject({ status: 400, body: { error: 'feedback_required' } });
    const rejected = await handleAssistedApplicationReview({ method: 'POST', body: { t: token(), action: 'reject', feedback: 'Più breve e meno formale' } }, deps());
    expect(rejected).toMatchObject({ status: 200, body: { state: 'regenerating' } });
    expect(store.read(`${BASE}/automation/flow`)).toMatchObject({ round: 2, feedback: [{ round: 1, text: 'Più breve e meno formale' }] });
    // Reopened right after sending the changes: the new version is being prepared, not "an older version".
    const reopened = await handleAssistedApplicationReview({ method: 'GET', query: { t: token() } }, deps());
    expect(reopened.body).toMatchObject({ stale: true, preparingNext: true, state: 'regenerating', round: 2 });
    // The old link still cannot act.
    expect(await handleAssistedApplicationReview({ method: 'POST', body: { t: token(), action: 'approve' } }, deps())).toMatchObject({ status: 409 });
  });

  it('lets the candidate correct the letter and their data before approving', async () => {
    const saved: string[] = [];
    const bucket = { file: (key: string) => ({ save: async () => { saved.push(key); } }) };
    const view = await handleAssistedApplicationReview({ method: 'GET', query: { t: token() } }, deps());
    expect(view.body.can.edit).toBe(true);
    const fields = Object.fromEntries(view.body.formAnswers.map((field: any) => [field.key, field]));
    expect(fields.email).toMatchObject({ editable: false, locked: 'alias' });
    expect(fields.workPermit).toMatchObject({ editable: false, locked: 'question' });
    expect(fields.phone).toMatchObject({ editable: true, inLetter: true });

    const letter = `Gentili Signori,\n\n${'Ho assistito 20 persone al giorno in reparto per sei anni, con turni di notte e di giorno. '.repeat(3)}\n\nCordiali saluti`;
    const edit = (body: Record<string, unknown>) => handleAssistedApplicationReview({ method: 'POST', body: { t: token(), action: 'edit', ...body } }, { ...deps(), bucket });
    expect(await edit({ coverLetterText: letter, fields: { phone: 'chiamami' } })).toMatchObject({
      status: 400,
      body: { error: 'invalid_edits', fields: { phone: 'Un numero di telefono, per esempio +41 91 123 45 67.' } },
    });
    expect(saved).toEqual([]);

    expect(await edit({ coverLetterText: letter, fields: { phone: '+41 91 000 00 00' } })).toMatchObject({
      status: 200, body: { ok: true, state: 'candidate_review', changed: ['fields', 'coverLetter'] },
    });
    const stored = store.read(`${BASE}/ai_drafts/current`);
    expect(stored.coverLetter.text).toContain('20 persone');
    // The PDF is rebuilt with the new text and the new phone in the header.
    expect(saved).toEqual([expect.stringMatching(/ai-cover-letter-r1-candidate-/)]);
    expect(stored.coverLetterPdfKey).toBe(saved[0]);
    // The writer that produced the letter now on the draft is kept with it.
    expect(['typst', 'legacy']).toContain(stored.coverLetterRenderer);
    expect(stored.factSources.candidate).toContain('20 persone');
    expect(stored.candidateEditedAt).toBe(T0);
    expect(store.read(`${BASE}/automation/flow`)).toMatchObject({ state: 'candidate_review', formOverrides: { phone: '+41 91 000 00 00' } });
    const after = await handleAssistedApplicationReview({ method: 'GET', query: { t: token() } }, deps());
    expect(after.body.formAnswers.find((field: any) => field.key === 'phone').value).toBe('+41 91 000 00 00');
    expect(after.body.editedAt).toBe(T0);
  });

  it('accepts edits only while the candidate reviews the current round', async () => {
    await store.db.collection('assisted_applications').doc(ORDER).collection('automation').doc('flow').set({ state: 'owner_review' }, { merge: true });
    const refused = await handleAssistedApplicationReview({ method: 'POST', body: { t: token(), action: 'edit', fields: { phone: '+41 91 000 00 00' } } }, deps());
    expect(refused).toMatchObject({ status: 409, body: { error: 'not_allowed' } });
    expect(store.read(`${BASE}/automation/flow`)?.formOverrides).toBeUndefined();
  });

  // Owner decision 2026-10-03: a WhatsApp application is sent once the candidate has its link.
  it('repeats the WhatsApp link of an application sent that way, once it is sent', async () => {
    const link = 'https://prod.pastahr.com/api/v1/redirect/COFU2003?remote_job_id=167757';
    const orderRef = store.db.collection('assisted_applications').doc(ORDER);
    const view = async () => (await handleAssistedApplicationReview({ method: 'GET', query: { t: token() } }, deps())).body;
    await orderRef.set({ submissionChannel: 'whatsapp', whatsappApplyUrl: link }, { merge: true });
    expect((await view()).whatsappUrl).toBeNull();
    await orderRef.collection('automation').doc('flow').set({ state: 'submitted', submittedVia: 'whatsapp' }, { merge: true });
    expect(await view()).toMatchObject({ state: 'submitted', whatsappUrl: link });
    await orderRef.set({ whatsappApplyUrl: 'javascript:alert(1)' }, { merge: true });
    expect((await view()).whatsappUrl).toBeNull();
  });

  it('confirms a portal handoff only from the handoff state', async () => {
    const early = await handleAssistedApplicationReview({ method: 'POST', body: { t: token(), action: 'confirm_submitted' } }, deps());
    expect(early.status).toBe(409);
    await store.db.collection('assisted_applications').doc(ORDER).collection('automation').doc('flow').set({ state: 'candidate_handoff' }, { merge: true });
    const confirmed = await handleAssistedApplicationReview({ method: 'POST', body: { t: token(), action: 'confirm_submitted' } }, deps());
    expect(confirmed).toMatchObject({ status: 200, body: { state: 'submitted' } });
    expect(effects.at(-1)).toEqual({ type: 'mark_submitted', by: 'candidate' });
  });
});

// Owner decisions of 2026-10-03 (P4): the Swiss status on the review page, legacy values kept.
describe('the candidate’s Swiss status on the review page', () => {
  const labels = permitOptions('it');
  const permitQuestion = { id: 'work_permit', question: 'Hai la cittadinanza svizzera o un permesso svizzero valido oggi?', why: '', type: 'choice', options: labels, required: true };
  const notice = { id: 'notice', question: 'Preavviso?', why: '', type: 'text', options: [], required: false };
  const orderRef = () => store.db.collection('assisted_applications').doc(ORDER);
  const seed = async (draftExtra: Record<string, any>, flowPatch: Record<string, any> = {}) => {
    await orderRef().collection('ai_drafts').doc('current').set(draft(draftExtra));
    await orderRef().collection('automation').doc('flow').set(flowPatch, { merge: true });
  };
  const view = async () => (await handleAssistedApplicationReview({ method: 'GET', query: { t: token() } }, deps())).body;
  const answer = (answers: Record<string, string>) => handleAssistedApplicationReview({ method: 'POST', body: { t: token(), action: 'answers', answers } }, deps());

  it('shows a stored answer that is no option as the last option, and takes it back unchanged', async () => {
    await seed({ questions: [permitQuestion, notice] }, { answers: { work_permit: 'Permesso B in rinnovo' } });
    const body = await view();
    expect(body.questions[0].options).toEqual([...labels, 'Permesso B in rinnovo']);
    expect(body.answers.work_permit).toBe('Permesso B in rinnovo');
    expect(await answer({ work_permit: 'Permesso B in rinnovo', notice: '3 mesi' })).toMatchObject({ status: 200 });
    expect(store.read(`${BASE}/automation/flow`)?.answers).toEqual({ work_permit: 'Permesso B in rinnovo', notice: '3 mesi' });
    // Any other text is still no option.
    expect(await answer({ work_permit: 'Permesso B scaduto' })).toMatchObject({ status: 400, body: { fields: { work_permit: 'Scegli una delle opzioni.' } } });
  });

  it('shows a legacy answer as the option that names the same status', async () => {
    await seed({ questions: [permitQuestion] }, { answers: { work_permit: 'G' } });
    const body = await view();
    expect(body.questions[0].options).toEqual(labels);
    expect(body.answers.work_permit).toBe(labels[4]);
  });

  it('shows an e-mail application the fields its tailored CV prints, the permit as a closed list', async () => {
    await seed({ questions: [], channel: { type: 'email', label: 'E-mail', email: 'hr@clinica.ch' }, applicationEmail: { to: 'hr@clinica.ch', subject: 'x', body: 'y' } });
    const fields = Object.fromEntries((await view()).formAnswers.map((field: any) => [field.key, field]));
    for (const key of ['dateOfBirth', 'nationality', 'workPermit', 'availability', 'languages', 'linkedin']) expect([key, fields[key].inCv]).toEqual([key, true]);
    expect(fields.workPermit).toMatchObject({ editable: true, options: labels });
    expect(fields.salary.inCv).toBe(false);
  });

  it('says when the permit G is left out of the tailored CV', async () => {
    const tailored = { tailoredCv: { status: 'ready', pdfKey: `assisted-application-uploads/${ORDER}/ai-cv-r1-1.pdf`, language: 'it' }, questions: [] };
    await seed({ ...tailored, profile: { ...draft().profile, nationality: 'albanese' } }, { answers: { work_permit: labels[4] } });
    expect((await view()).tailoredCv.permitOmitted).toBe(true);
    await seed({ ...tailored, profile: { ...draft().profile, nationality: 'italiana' } });
    expect((await view()).tailoredCv.permitOmitted).toBe(false);
  });
});

// Close-out P8 (owner decisions of 2026-10-03): after the sending the candidate keeps the documents that
// left, and the letter and the tailored CV come as an editable Word copy, built at each request, never stored.
describe('the candidate keeps the documents', () => {
  const DAY = 86_400_000;
  const KEY = (name: string) => `assisted-application-uploads/${ORDER}/${name}`;
  const TAILORED = KEY('ai-cv-r1-1.pdf');
  const ORIGINAL = KEY(`${T0}-abc-cv.pdf`);
  // An invented nurse, as in the rest of this file.
  const profile = {
    fullName: 'Maria Rossi', email: 'maria@example.com', phone: '+41 91 123 45 67', location: 'Como', summary: 'Infermiera con 6 anni in medicina interna.',
    languages: [{ language: 'Italiano', level: 'madrelingua' }], skills: [], education: [], certifications: [],
    experience: [{ role: 'Infermiera', employer: 'Ospedale Esempio', location: 'Como', start: '2019', end: 'oggi', kind: 'job', highlights: ['Turni in medicina interna con 12 pazienti', 'Referente per la gestione del dolore'] }],
  };
  const cv = sanitizeTailoredCv({
    headline: 'Infermiera', summary: 'Infermiera con 6 anni in medicina interna.', competencies: [], skills: [],
    experience: [{ index: 0, bullets: [{ text: 'Turni in medicina interna con 12 pazienti', source: 0, requirement: 0 }] }],
  }, { profile, cvText: JSON.stringify(profile), language: 'it' });
  const keptDraft = (extra: Record<string, any> = {}) => draft({
    profile,
    language: 'it',
    questions: [],
    coverLetter: {
      subject: '', salutation: 'Gentili signore e signori,', paragraphs: ['ho lavorato & imparato <molto>.', 'Riga uno.\nRiga due.'], closing: 'Cordiali saluti',
      text: 'Gentili signore e signori,\n\nho lavorato & imparato <molto>.\n\nRiga uno.\nRiga due.\n\nCordiali saluti',
    },
    letterAddress: { contactPerson: '', streetAddress: 'Via Esempio 1', postalCode: '6900', location: 'Lugano' },
    tailoredCv: { status: 'ready', pdfKey: TAILORED, cv },
    ...extra,
  });
  // The Word copies are built in memory: no Storage call at all.
  const bucket = { file: vi.fn(() => { throw new Error('storage touched'); }) };
  const signUrl = vi.fn(async (key: string) => `https://signed.example/${key.split('/').pop()}`);
  const keptDeps = () => ({ ...deps(), bucket, signUrl });
  const orderRef = () => store.db.collection('assisted_applications').doc(ORDER);
  const seed = async ({ order = {}, flow = {}, draftExtra = {} }: { order?: Record<string, any>, flow?: Record<string, any>, draftExtra?: Record<string, any> } = {}) => {
    await orderRef().set({ cvStorageKey: ORIGINAL, ...order }, { merge: true });
    await orderRef().collection('automation').doc('flow').set(flow, { merge: true });
    await orderRef().collection('ai_drafts').doc('current').set(keptDraft(draftExtra));
  };
  const view = async (t = token()) => (await handleAssistedApplicationReview({ method: 'GET', query: { t } }, keptDeps())).body;
  const word = (file: unknown, t = token()) => handleAssistedApplicationReview({ method: 'GET', query: { t, file } }, keptDeps()) as Promise<any>;
  const texts = (buffer: Buffer) => paragraphInventory(entryData(readZip(buffer).find((entry: any) => entry.name === 'word/document.xml'), 1 << 24).toString('utf8'))
    .map((paragraph: any) => paragraph.text);
  const sentFiles = [
    { kind: 'letter', name: 'Lettera_di_presentazione_Maria_Rossi.pdf', key: KEY(`sent-r1-${T0}-letter.pdf`) },
    { kind: 'cv', name: 'CV_Maria_Rossi.pdf', key: TAILORED },
    { kind: 'documents', name: 'Allegati_Maria_Rossi.pdf', key: KEY(`sent-r1-${T0}-documents.pdf`) },
    { kind: 'cv', name: 'CV_altro.pdf', key: 'assisted-application-uploads/order_OTHER1/x.pdf' },
    { kind: 'cv', name: 'CV_esterno.pdf', key: 'https://evil.example/x.pdf' },
    { kind: 'evil', name: 'x.pdf', key: KEY('x.pdf') },
  ];

  beforeEach(() => {
    bucket.file.mockClear();
    signUrl.mockClear();
  });

  it('offers the Word copies during the review and builds them on request, storing nothing', async () => {
    await seed();
    expect((await view()).word).toEqual({ letter: true, cv: true });
    const before = { draft: store.read(`${BASE}/ai_drafts/current`), flow: store.read(`${BASE}/automation/flow`) };
    const letter = await word('letter.docx');
    expect(letter).toMatchObject({ status: 200, file: { contentType: DOCX_CONTENT_TYPE, fileName: 'Lettera_di_presentazione_Maria_Rossi.docx' } });
    expect(letter.body).toBeUndefined();
    const lines = texts(letter.file.buffer);
    expect(lines).toContain('ho lavorato & imparato <molto>.');
    expect(lines).toContain('Riga uno.\nRiga due.');
    // Before the sending, the day of the download.
    expect(lines.some((text: string) => text.includes(formatLetterDate('it', new Date(T0))))).toBe(true);
    expect(await word('cv.docx')).toMatchObject({ status: 200, file: { contentType: DOCX_CONTENT_TYPE, fileName: 'CV_Maria_Rossi.docx' } });
    expect(store.read(`${BASE}/ai_drafts/current`)).toEqual(before.draft);
    expect(store.read(`${BASE}/automation/flow`)).toEqual(before.flow);
    expect(bucket.file).not.toHaveBeenCalled();
  });

  it('builds the Word CV with the candidate’s corrections and line choices', async () => {
    const line = cv.experience?.[0]?.lines?.[0]?.id;
    expect(line).toBeTruthy();
    await seed({ flow: { formOverrides: { phone: '+41 91 000 00 00' }, cvChoices: { [line]: { use: 'own', text: 'Turni di notte in medicina interna e pronto soccorso' } }, cvChoicesRound: 1 } });
    const lines = texts((await word('cv.docx')).file.buffer);
    expect(lines.some((text: string) => text.includes('+41 91 000 00 00'))).toBe(true);
    expect(lines).toContain('Turni di notte in medicina interna e pronto soccorso');
  });

  it('answers 404 when there is nothing to build from, and only to a review link', async () => {
    await seed({ draftExtra: { tailoredCv: { status: 'fact_check_failed' } } });
    expect((await view()).word).toEqual({ letter: true, cv: false });
    expect(await word('cv.docx')).toMatchObject({ status: 404, body: { error: 'not_found' } });
    // A letter without paragraphs (older drafts): no copy.
    await orderRef().collection('ai_drafts').doc('current').set(draft());
    expect((await view()).word).toEqual({ letter: false, cv: false });
    expect(await word('letter.docx')).toMatchObject({ status: 404, body: { error: 'not_found' } });
    await seed();
    for (const file of ['x.docx', '', ['letter.docx', 'cv.docx']]) expect(await word(file)).toMatchObject({ status: 404, body: { error: 'not_found' } });
    const followup = mintReviewToken({ secret: SECRET, orderId: ORDER, round: 1, nowMs: T0, kind: 'followup' });
    expect(await word('letter.docx', followup)).toMatchObject({ status: 404, body: { error: 'not_found' } });
    const forged = token().replace(/.$/, (char) => (char === '0' ? '1' : '0'));
    expect(await word('letter.docx', forged)).toMatchObject({ status: 403, body: { error: 'invalid_link' } });
    // A new round on its way: the round-1 draft is no copy of the current round.
    await orderRef().collection('automation').doc('flow').set({ round: 2, state: 'regenerating' }, { merge: true });
    expect(await word('letter.docx', token(2))).toMatchObject({ status: 404 });
    expect((await view(token(2))).word).toEqual({ letter: false, cv: false });
  });

  it('dates the Word letter of a sent application with the day it left', async () => {
    await seed({ order: { submittedAt: new Date(T0 - 5 * DAY) }, flow: { state: 'submitted' } });
    const dated = async () => texts((await word('letter.docx')).file.buffer).join('\n');
    expect(await dated()).toContain(formatLetterDate('it', new Date(T0 - 5 * DAY)));
    // The runner's record: the day the letter that left was built.
    await orderRef().collection('ai_drafts').doc('current').set({ sent: { at: T0 - 6 * DAY, files: [] } }, { merge: true });
    expect(await dated()).toContain(formatLetterDate('it', new Date(T0 - 6 * DAY)));
    expect(await dated()).not.toContain(formatLetterDate('it', new Date(T0)));
  });

  it('lists what really left, signed, from the order’s folder only', async () => {
    await seed({ flow: { state: 'submitted' }, draftExtra: { sent: { at: T0, channel: 'email', packaging: 'separate', files: sentFiles } } });
    const body = await view();
    expect(body.keptDocuments).toEqual({
      source: 'sent',
      whatsapp: false,
      files: [
        { kind: 'letter', name: 'Lettera_di_presentazione_Maria_Rossi.pdf', url: `https://signed.example/sent-r1-${T0}-letter.pdf`, word: ['letter.docx'], suggested: false },
        { kind: 'cvTailored', name: 'CV_Maria_Rossi.pdf', url: 'https://signed.example/ai-cv-r1-1.pdf', word: ['cv.docx'], suggested: false },
        { kind: 'documents', name: 'Allegati_Maria_Rossi.pdf', url: `https://signed.example/sent-r1-${T0}-documents.pdf`, word: [], suggested: false },
      ],
    });
    const signed = signUrl.mock.calls.map(([key]) => key);
    expect(signed).not.toContain('assisted-application-uploads/order_OTHER1/x.pdf');
    expect(signed).not.toContain('https://evil.example/x.pdf');
    // One signature per key and request: the tailored CV is the review's and a kept file.
    expect(signed.filter((key) => key === TAILORED)).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain('assisted-application-uploads/');
    // The candidate's own Word file with the adapted lines, recorded by its key.
    const inplace = { status: 'ready', docxKey: KEY('ai-cv-inplace-r1-1.docx') };
    await seed({ flow: { state: 'submitted' }, draftExtra: { tailoredCv: { status: 'ready', pdfKey: TAILORED, cv, inplace }, sent: { at: T0, files: [{ kind: 'cv', name: 'CV_Maria_Rossi.docx', key: inplace.docxKey }] } } });
    expect((await view()).keptDocuments.files).toEqual([{ kind: 'cvInplace', name: 'CV_Maria_Rossi.docx', url: 'https://signed.example/ai-cv-inplace-r1-1.docx', word: [], suggested: false }]);
  });

  it('keeps the stored letter and the CV that leaves for an older order, or a record it cannot sign', async () => {
    await seed({ flow: { state: 'submitted' } });
    expect((await view()).keptDocuments).toEqual({
      source: 'prepared',
      whatsapp: false,
      files: [
        { kind: 'letter', name: 'Lettera_di_presentazione_Maria_Rossi.pdf', url: 'https://signed.example/ai-cover-letter-r1-1.pdf', word: ['letter.docx'], suggested: false },
        { kind: 'cvTailored', name: 'CV_Maria_Rossi.pdf', url: 'https://signed.example/ai-cv-r1-1.pdf', word: ['cv.docx'], suggested: false },
      ],
    });
    // A record whose only file cannot be signed: the prepared files, not an empty block.
    await orderRef().collection('ai_drafts').doc('current').set({ sent: { at: T0, files: [{ kind: 'cv', name: 'CV.pdf', key: 'https://evil.example/x.pdf' }] } }, { merge: true });
    expect((await view()).keptDocuments).toMatchObject({ source: 'prepared', files: [{ kind: 'letter' }, { kind: 'cvTailored' }] });
    // The original chosen on the review page: named by the type of its bytes, as the runner sent it.
    await orderRef().set({ cvFileCheck: { key: ORIGINAL, verdict: 'ok', detectedType: 'docx' } }, { merge: true });
    await orderRef().collection('automation').doc('flow').set({ cvChoice: 'original' }, { merge: true });
    expect((await view()).keptDocuments.files[1]).toEqual({ kind: 'cvOriginal', name: 'CV_Maria_Rossi.docx', url: `https://signed.example/${T0}-abc-cv.pdf`, word: [], suggested: false });
  });

  // Owner decision 2026-10-03: in a WhatsApp application the candidate chooses the CV they send in the chat.
  it('offers a WhatsApp candidate the tailored CV, highlighted, and their own, and stores no choice', async () => {
    await seed({
      order: { submissionChannel: 'whatsapp', whatsappApplyUrl: 'https://prod.pastahr.com/api/v1/redirect/COFU2003?remote_job_id=167757' },
      flow: { state: 'submitted', cvChoice: 'original' },
      // Whatever a record says, no file left from us.
      draftExtra: { sent: { at: T0, channel: 'whatsapp', packaging: 'whatsapp', files: sentFiles } },
    });
    const before = { draft: store.read(`${BASE}/ai_drafts/current`), flow: store.read(`${BASE}/automation/flow`) };
    expect((await view()).keptDocuments).toEqual({
      source: 'prepared',
      whatsapp: true,
      files: [
        { kind: 'letter', name: 'Lettera_di_presentazione_Maria_Rossi.pdf', url: 'https://signed.example/ai-cover-letter-r1-1.pdf', word: ['letter.docx'], suggested: false },
        { kind: 'cvTailored', name: 'CV_Maria_Rossi.pdf', url: 'https://signed.example/ai-cv-r1-1.pdf', word: ['cv.docx'], suggested: true },
        { kind: 'cvOriginal', name: 'CV_Maria_Rossi.pdf', url: `https://signed.example/${T0}-abc-cv.pdf`, word: [], suggested: false },
      ],
    });
    expect(store.read(`${BASE}/ai_drafts/current`)).toEqual(before.draft);
    expect(store.read(`${BASE}/automation/flow`)).toEqual(before.flow);
    // A CV whose link cannot be made is not offered, and then nothing is left to choose between.
    const unsigned = await handleAssistedApplicationReview({ method: 'GET', query: { t: token() } }, {
      ...keptDeps(), signUrl: async (key: string) => (key === ORIGINAL ? null : `https://signed.example/${key.split('/').pop()}`),
    });
    expect(unsigned.body.keptDocuments.files.map((file: any) => [file.kind, file.suggested])).toEqual([['letter', false], ['cvTailored', false]]);
    // No tailored CV past the gate: the candidate's own, nothing to choose between.
    await orderRef().collection('ai_drafts').doc('current').set(keptDraft({ tailoredCv: { status: 'fact_check_failed' } }));
    expect((await view()).keptDocuments.files.map((file: any) => [file.kind, file.suggested])).toEqual([['letter', false], ['cvOriginal', false]]);
    // The page's words for both cases, in the four languages.
    for (const strings of [itCore, enCore, deCore, frCore] as Array<Record<string, string>>) {
      for (const key of ['introWhatsapp', 'introWhatsappChoice', 'suggested', 'cvTailored', 'cvOriginal']) expect(String(strings[`jobBoard.assisted.review.kept.${key}`] || '').trim()).not.toBe('');
    }
  });

  it('keeps nothing before the sending, and never takes a Word copy as the CV that leaves', async () => {
    await seed();
    expect((await view()).keptDocuments).toBeNull();
    expect(await handleAssistedApplicationReview({ method: 'POST', body: { t: token(), action: 'cv_choice', cvChoice: 'docx' } }, keptDeps()))
      .toMatchObject({ status: 400, body: { error: 'invalid_cv_choice' } });
  });

  it('answers a Word copy as a download no cache keeps, anything else as JSON', () => {
    const calls: unknown[] = [];
    const res: any = {
      set: (headers: unknown) => { calls.push(['set', headers]); return res; },
      status: (code: number) => { calls.push(['status', code]); return res; },
      send: (data: unknown) => { calls.push(['send', data]); return res; },
      json: (data: unknown) => { calls.push(['json', data]); return res; },
    };
    const buffer = Buffer.from('docx');
    sendReviewResponse(res, { status: 200, file: { buffer, contentType: DOCX_CONTENT_TYPE, fileName: 'CV_Maria_Rossi.docx' } });
    expect(calls).toEqual([
      ['set', { 'Content-Type': DOCX_CONTENT_TYPE, 'Content-Disposition': 'attachment; filename="CV_Maria_Rossi.docx"', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }],
      ['status', 200],
      ['send', buffer],
    ]);
    calls.length = 0;
    sendReviewResponse(res, { status: 404, body: { ok: false, error: 'not_found' } });
    expect(calls).toEqual([['status', 404], ['json', { ok: false, error: 'not_found' }]]);
  });

  // The letter the candidate keeps stays the one that left: the owner's edit stops with the sending.
  it('refuses the owner’s edit of a draft whose application left, with its own code and message', async () => {
    const edit = { action: 'automationEditDraft', orderId: ORDER, emailSubject: 'Candidatura per il posto di infermiera' };
    await seed({ flow: { state: 'submitted' } });
    const before = store.read(`${BASE}/ai_drafts/current`);
    await expect(handleAutomationAdminAction(store.db, edit, 'owner@example.com', { runEffect, nowMs: T0 })).rejects.toMatchObject({ code: 'draft_submitted', status: 409 });
    expect(store.read(`${BASE}/ai_drafts/current`)).toEqual(before);
    // The queue tells Valerie why, in Italian.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'draft_submitted' }), { status: 409 })));
    try {
      await expect(runAutomationAdminAction({ getIdToken: async () => 'id-token' } as any, ORDER, 'automationEditDraft', edit))
        .rejects.toMatchObject({ code: 'draft_submitted', message: 'La candidatura è già stata inviata: la bozza non si può più modificare.' });
    } finally {
      vi.unstubAllGlobals();
    }
    // Before the sending the same edit goes through.
    await orderRef().collection('automation').doc('flow').set({ state: 'owner_review' }, { merge: true });
    await expect(handleAutomationAdminAction(store.db, edit, 'owner@example.com', { runEffect, nowMs: T0 })).resolves.toMatchObject({ ok: true });
  });

  // Owner decision 2026-10-05, «Fino a fine consenso»: a talent-pool order's link lasts as long as the consent.
  describe('the link of an order kept for the talent pool', () => {
    const consentToken = () => mintReviewToken({ secret: SECRET, orderId: ORDER, round: 1, nowMs: T0 - 200 * DAY, untilConsentEnds: true });
    const at = (nowMs: number, t = consentToken()) => handleAssistedApplicationReview({ method: 'GET', query: { t } }, { ...keptDeps(), nowMs }) as Promise<any>;

    it('opens while the consent lasts, well beyond 30 days and the purge', async () => {
      await seed({ order: { talentPoolConsent: true, cvUploadedAt: new Date(T0 - 200 * DAY) }, flow: { state: 'submitted' } });
      const opened = await at(T0 + 400 * DAY);
      expect(opened.status).toBe(200);
      expect(opened.body.keptDocuments.files.length).toBeGreaterThan(0);
      expect((await word('cv.docx', consentToken())).status).toBe(200);
    });

    it('answers as an expired link once the consent is withdrawn, the documents are gone or the order is not kept', async () => {
      await seed({ order: { talentPoolConsent: true }, flow: { state: 'submitted' } });
      expect((await at(T0)).status).toBe(200);
      for (const order of [{ talentPoolConsent: false }, { talentPoolConsent: true, retentionPurgedAt: new Date(T0) }]) {
        await orderRef().set({ talentPoolConsent: true, retentionPurgedAt: null, ...order }, { merge: true });
        expect(await at(T0)).toEqual({ status: 403, body: { ok: false, error: 'link_expired' } });
        const post = await handleAssistedApplicationReview({ method: 'POST', body: { t: consentToken(), action: 'approve' } }, keptDeps());
        expect(post).toEqual({ status: 403, body: { ok: false, error: 'link_expired' } });
      }
      // The flow is no longer the sent one (or no longer there): the same answer.
      await orderRef().set({ talentPoolConsent: true, retentionPurgedAt: null }, { merge: true });
      await orderRef().collection('automation').doc('flow').set({ state: 'candidate_review' }, { merge: true });
      expect(await at(T0)).toEqual({ status: 403, body: { ok: false, error: 'link_expired' } });
      await orderRef().collection('automation').doc('flow').delete();
      expect(await at(T0)).toEqual({ status: 403, body: { ok: false, error: 'link_expired' } });
    });

    it('leaves every other link as it was: the expiry signed in it decides', async () => {
      // A consent given later does not stretch a link minted with an end.
      await seed({ order: { talentPoolConsent: true }, flow: { state: 'submitted' } });
      const ended = mintReviewToken({ secret: SECRET, orderId: ORDER, round: 1, nowMs: T0 - 200 * DAY, ttlMs: 90 * DAY });
      expect(await at(T0, ended)).toEqual({ status: 403, body: { ok: false, error: 'link_expired' } });
      // Without the consent an ordinary link opens until its expiry (the purge), nothing more is read.
      await orderRef().set({ talentPoolConsent: false }, { merge: true });
      const ordinary = mintReviewToken({ secret: SECRET, orderId: ORDER, round: 1, nowMs: T0, ttlMs: 90 * DAY });
      expect((await at(T0 + 89 * DAY, ordinary)).status).toBe(200);
      expect(await at(T0 + 91 * DAY, ordinary)).toEqual({ status: 403, body: { ok: false, error: 'link_expired' } });
      // A follow-up link is never bound to the consent.
      expect(() => mintReviewToken({ secret: SECRET, orderId: ORDER, round: 1, kind: 'followup', untilConsentEnds: true })).toThrow('invalid_token_kind');
    });
  });
});
