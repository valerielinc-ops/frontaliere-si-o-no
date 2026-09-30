import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({
  getRemoteConfigValue: vi.fn(async () => ''),
  bridgeEmailCascadeCredentialsToEnv: vi.fn(async () => {}),
}));

const { handleAssistedApplicationReview } = await import('../functions/src/assistedApplicationReview.js');
const { mintReviewToken } = await import('../functions/src/assistedApplicationReviewToken.js');
const { CANDIDATE_REVIEW_MS } = await import('../functions/src/assistedApplicationFlow.js');

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
    expect(bad).toMatchObject({ status: 400, body: { error: 'no_valid_answers' } });

    const answered = await handleAssistedApplicationReview({ method: 'POST', body: { t: token(), action: 'answers', answers: { work_permit: 'G' } } }, deps());
    expect(answered).toMatchObject({ status: 200, body: { state: 'candidate_review' } });
    expect(store.read(`${BASE}/automation/flow`)).toMatchObject({ answers: { work_permit: 'G' }, deadlineAt: T0 + CANDIDATE_REVIEW_MS });

    const approved = await handleAssistedApplicationReview({ method: 'POST', body: { t: token(), action: 'approve' } }, deps());
    expect(approved).toMatchObject({ status: 200, body: { state: 'submitting' } });
    expect(effects.at(-1)).toEqual({ type: 'dispatch', mode: 'submit', reason: 'candidate_approved' });
  });

  it('turns feedback into a new round', async () => {
    const empty = await handleAssistedApplicationReview({ method: 'POST', body: { t: token(), action: 'reject', feedback: 'no' } }, deps());
    expect(empty).toMatchObject({ status: 400, body: { error: 'feedback_required' } });
    const rejected = await handleAssistedApplicationReview({ method: 'POST', body: { t: token(), action: 'reject', feedback: 'Più breve e meno formale' } }, deps());
    expect(rejected).toMatchObject({ status: 200, body: { state: 'regenerating' } });
    expect(store.read(`${BASE}/automation/flow`)).toMatchObject({ round: 2, feedback: [{ round: 1, text: 'Più breve e meno formale' }] });
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
