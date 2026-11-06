import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({
  getRemoteConfigValue: vi.fn(async () => ''),
  bridgeEmailCascadeCredentialsToEnv: vi.fn(async () => {}),
}));

const { handleAssistedApplicationReview } = await import('../functions/src/assistedApplicationReview.js');
const { mintReviewToken } = await import('../functions/src/assistedApplicationReviewToken.js');
const { applyCvLineChoices, cvChoicesOf, sanitizeTailoredCv } = await import('../functions/src/assistedApplicationTailoredCv.js');

const SECRET = 'l'.repeat(40);
const T0 = Date.UTC(2026, 9, 2, 10, 0, 0);
const ORDER = 'order_LINES1';
const BASE = `assisted_applications/${ORDER}`;

// An invented candidate (study 2026-10-02).
const CV_TEXT = 'Marco Bianchi\nSviluppatore full-stack, Esempio Software Srl, Milano, 03/2021 – oggi: sviluppo di un portale B2B in React e Node.js usato da 400 clienti; riduzione del tempo di build del 40% con Docker multi-stage; mentoring di 2 sviluppatori junior';
const profile = {
  fullName: 'Marco Bianchi', location: 'Como', summary: 'Sviluppatore con 6 anni di esperienza su applicazioni web.', languages: [], education: [], certifications: [], skills: ['React'],
  experience: [{ role: 'Sviluppatore full-stack', employer: 'Esempio Software Srl', location: 'Milano', start: '03/2021', end: 'oggi', kind: 'job', highlights: [
    'Sviluppo di un portale B2B in React e Node.js usato da 400 clienti', 'Riduzione del tempo di build del 40% con Docker multi-stage', 'Mentoring di 2 sviluppatori junior',
  ] }],
};
const raw = {
  headline: 'Sviluppatore full-stack', summary: 'Sviluppatore full-stack con esperienza in React e Node.js.', competencies: ['React'], skills: ['React'],
  experience: [{ index: 0, bullets: [
    { text: 'Portale B2B in React e Node.js usato da 400 clienti', source: 0, requirement: 0 },
    { text: 'Build ridotta del 40% con Docker multi-stage', source: 1, requirement: 1 },
    { text: 'Portale e build per 400 clienti con Docker', source: -1, requirement: -1 },
  ] }],
};

describe('anchored rewrites (idea of Resume-Matcher)', () => {
  it('keeps each rewritten line with the CV line it rewrites, and still reads the older plain bullets', () => {
    const cv = sanitizeTailoredCv(raw, { profile, cvText: CV_TEXT, language: 'it' });
    expect(cv.experience[0].lines).toEqual([
      { id: 'r0-l0', text: 'Portale B2B in React e Node.js usato da 400 clienti', original: profile.experience[0].highlights[0], requirement: 0 },
      { id: 'r0-l1', text: 'Build ridotta del 40% con Docker multi-stage', original: profile.experience[0].highlights[1], requirement: 1 },
      { id: 'r0-l2', text: 'Portale e build per 400 clienti con Docker', original: '', requirement: -1 },
    ]);
    // An anchor out of the role's highlights is not trusted as an anchor.
    const outOfRange = sanitizeTailoredCv({ ...raw, experience: [{ index: 0, bullets: [{ text: 'Mentoring di 2 sviluppatori junior', source: 9, requirement: -1 }] }] }, { profile, cvText: CV_TEXT, language: 'it' });
    expect(outOfRange.experience[0].lines[0].original).toBe('');
    const plain = sanitizeTailoredCv({ ...raw, experience: [{ index: 0, bullets: ['Mentoring di 2 sviluppatori junior'] }] }, { profile, cvText: CV_TEXT, language: 'it' });
    expect(plain.experience[0]).toMatchObject({ rewritten: true, bullets: ['Mentoring di 2 sviluppatori junior'] });
  });

  it('applies the candidate’s choices line by line, and the summary', () => {
    const cv = sanitizeTailoredCv(raw, { profile, cvText: CV_TEXT, language: 'it' });
    const applied = applyCvLineChoices(cv, {
      'r0-l0': { use: 'original' },
      'r0-l1': { use: 'own', text: 'Tempi di build dimezzati con Docker' },
      'r0-l2': { use: 'original' }, // rewrites no line: dropped
      'r9-l9': { use: 'own', text: 'ignorata' },
      summary: { use: 'original' },
    }, { profile });
    expect(applied.experience[0].bullets).toEqual([profile.experience[0].highlights[0], 'Tempi di build dimezzati con Docker']);
    expect(applied.summary).toBe(profile.summary);
    expect(applyCvLineChoices(cv, {}, { profile }).experience[0].bullets).toEqual(cv.experience[0].bullets);
  });
});

function fakeBucket() {
  const files = new Map<string, Buffer>();
  return {
    files,
    file: (key: string) => ({
      save: async (buffer: Buffer) => { files.set(key, Buffer.from(buffer)); },
      download: async () => [files.get(key)],
      delete: async () => { files.delete(key); },
    }),
  };
}

let store: ReturnType<typeof createMemoryFirestore>;
let bucket: ReturnType<typeof fakeBucket>;
const deps = () => ({ db: store.db, bucket, runEffect: vi.fn(async () => ({ ok: true })), getSecret: async () => SECRET, signUrl: async () => 'https://signed.example/x.pdf', nowMs: T0 });
const token = () => mintReviewToken({ secret: SECRET, orderId: ORDER, round: 1, nowMs: T0 });
const post = (body: Record<string, any>) => handleAssistedApplicationReview({ method: 'POST', body: { t: token(), ...body } }, deps());

function seed(cv: any) {
  store = createMemoryFirestore({
    [BASE]: { paymentStatus: 'paid', submissionStatus: 'in_progress', jobTitle: 'Sviluppatore', companyName: 'Esempio Fintech SA', locale: 'it', applicantName: 'Marco Bianchi' },
    [`${BASE}/automation/flow`]: { state: 'candidate_review', round: 1, deadlineAt: null, answers: {}, feedback: [] },
    [`${BASE}/ai_drafts/current`]: {
      status: 'ready', round: 1, language: 'it', profile, job: { title: 'Sviluppatore' }, factSources: { text: CV_TEXT },
      channel: { type: 'lever', applyUrl: 'https://jobs.lever.co/x/1/apply' }, coverLetter: { subject: 'Candidatura', text: 'Gentili signore, egregi signori,\n\ntesto.\n\nCordiali saluti' },
      applicationEmail: { to: '', subject: 'x', body: 'y' }, formAnswers: [], questions: [],
      tailoredCv: { status: 'ready', pdfKey: `assisted-application-uploads/${ORDER}/ai-cv-r1-1.pdf`, language: 'it', cv },
    },
  });
}

beforeEach(() => {
  bucket = fakeBucket();
  seed(sanitizeTailoredCv(raw, { profile, cvText: CV_TEXT, language: 'it' }));
});

describe('line-by-line review on the review page', () => {
  it('shows each rewritten line beside the CV’s own line', async () => {
    const { body } = await handleAssistedApplicationReview({ method: 'GET', query: { t: token() } }, deps());
    expect(body.can.reviewCvLines).toBe(true);
    expect(body.tailoredCv.changes.summary).toMatchObject({ id: 'summary', original: profile.summary, use: 'adapted' });
    expect(body.tailoredCv.changes.roles[0].lines.map((line: any) => [line.id, Boolean(line.original), line.use])).toEqual([['r0-l0', true, 'adapted'], ['r0-l1', true, 'adapted'], ['r0-l2', false, 'adapted']]);
  });

  it('saves the choices, checks the facts again and rebuilds the PDF', async () => {
    const saved = await post({ action: 'cv_lines', choices: { 'r0-l0': { use: 'original' }, 'r0-l1': { use: 'own', text: 'Tempi di build dimezzati con Docker' } } });
    expect(saved).toMatchObject({ status: 200, body: { ok: true } });
    expect(store.read(`${BASE}/automation/flow`).cvChoices).toEqual({ 'r0-l0': { use: 'original' }, 'r0-l1': { use: 'own', text: 'Tempi di build dimezzati con Docker' } });
    const draft = store.read(`${BASE}/ai_drafts/current`);
    expect(draft.tailoredCv.pdfKey).not.toBe(`assisted-application-uploads/${ORDER}/ai-cv-r1-1.pdf`);
    expect(bucket.files.get(draft.tailoredCv.pdfKey)!.subarray(0, 5).toString()).toBe('%PDF-');
    const { body } = await handleAssistedApplicationReview({ method: 'GET', query: { t: token() } }, deps());
    expect(body.tailoredCv.changes.roles[0].lines[1]).toMatchObject({ use: 'own', text: 'Tempi di build dimezzati con Docker' });
  }, 60_000);

  it('keeps the choices to their round: a new tailored CV starts from its own lines', async () => {
    await post({ action: 'cv_lines', choices: { 'r0-l1': { use: 'own', text: 'Tempi di build dimezzati con Docker' } } });
    expect(store.read(`${BASE}/automation/flow`)).toMatchObject({ cvChoicesRound: 1 });
    // The runner writes round 2: same line ids, other lines.
    const draft = store.read(`${BASE}/ai_drafts/current`);
    store.docs.set(`${BASE}/ai_drafts/current`, { ...draft, round: 2 });
    store.docs.set(`${BASE}/automation/flow`, { ...store.read(`${BASE}/automation/flow`), round: 2 });
    const token2 = mintReviewToken({ secret: SECRET, orderId: ORDER, round: 2, nowMs: T0 });
    const { body } = await handleAssistedApplicationReview({ method: 'GET', query: { t: token2 } }, deps());
    expect(body.tailoredCv.changes.roles[0].lines.map((line: any) => line.use)).toEqual(['adapted', 'adapted', 'adapted']);
    expect(cvChoicesOf(store.read(`${BASE}/ai_drafts/current`), store.read(`${BASE}/automation/flow`))).toEqual({});
  }, 60_000);

  it('refuses an empty own line and the CV line of a line that rewrites none', async () => {
    const result = await post({ action: 'cv_lines', choices: { 'r0-l1': { use: 'own', text: '  ' }, 'r0-l2': { use: 'original' } } });
    expect(result).toMatchObject({ status: 400, body: { error: 'invalid_cv_choices', fields: { 'r0-l1': 'empty', 'r0-l2': 'no_original' } } });
  });

  it('runs the fact gate again: an adapted line with a figure the CV lacks is refused', async () => {
    const cv = sanitizeTailoredCv(raw, { profile, cvText: CV_TEXT, language: 'it' });
    cv.experience[0].lines[0].text = 'Portale B2B usato da 900 clienti';
    seed(cv);
    expect(await post({ action: 'cv_lines', choices: {} })).toMatchObject({ status: 409, body: { error: 'cv_fact_check_failed', unsupported: ['900'] } });
    // The candidate's own words vouch for themselves, as letter edits do.
    expect((await post({ action: 'cv_lines', choices: { 'r0-l0': { use: 'own', text: 'Portale B2B usato da 900 clienti' } } })).status).toBe(200);
  }, 60_000);
});
