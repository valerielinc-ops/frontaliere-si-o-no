import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({
  getRemoteConfigValue: vi.fn(async () => ''),
  bridgeEmailCascadeCredentialsToEnv: vi.fn(async () => {}),
}));

const { handleAssistedApplicationReview, minDateFor } = await import('../functions/src/assistedApplicationReview.js');
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
    // An option that does not exist: the field says so, nothing is saved.
    expect(bad).toMatchObject({ status: 400, body: { error: 'invalid_answers', fields: { work_permit: 'Scegli una delle opzioni.' } } });

    const answered = await handleAssistedApplicationReview({ method: 'POST', body: { t: token(), action: 'answers', answers: { work_permit: 'G' } } }, deps());
    expect(answered).toMatchObject({ status: 200, body: { state: 'candidate_review' } });
    expect(store.read(`${BASE}/automation/flow`)).toMatchObject({ answers: { work_permit: 'G' }, deadlineAt: T0 + CANDIDATE_REVIEW_MS });

    const approved = await handleAssistedApplicationReview({ method: 'POST', body: { t: token(), action: 'approve' } }, deps());
    expect(approved).toMatchObject({ status: 200, body: { state: 'submitting' } });
    expect(effects.at(-1)).toEqual({ type: 'dispatch', mode: 'submit', reason: 'candidate_approved' });
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

  it('confirms a portal handoff only from the handoff state', async () => {
    const early = await handleAssistedApplicationReview({ method: 'POST', body: { t: token(), action: 'confirm_submitted' } }, deps());
    expect(early.status).toBe(409);
    await store.db.collection('assisted_applications').doc(ORDER).collection('automation').doc('flow').set({ state: 'candidate_handoff' }, { merge: true });
    const confirmed = await handleAssistedApplicationReview({ method: 'POST', body: { t: token(), action: 'confirm_submitted' } }, deps());
    expect(confirmed).toMatchObject({ status: 200, body: { state: 'submitted' } });
    expect(effects.at(-1)).toEqual({ type: 'mark_submitted', by: 'candidate' });
  });
});
