import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({
  getRemoteConfigValue: vi.fn(async () => ''),
  bridgeEmailCascadeCredentialsToEnv: vi.fn(async () => {}),
}));
// The renderer writes the document it is given as JSON: what the tailored CV prints is read back from its bytes.
vi.mock('../functions/src/assistedApplicationPdfRenderer.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  pdfRendererMode: vi.fn(async () => 'typst'),
  renderCvPdf: vi.fn(async (doc: any) => ({ pdf: Buffer.from(JSON.stringify({ personal: doc.personal, contact: doc.contact, sections: doc.sections })), renderer: 'typst', photo: false })),
  renderLetterPdf: vi.fn(async () => ({ pdf: Buffer.from('%PDF-1.4 letter'), renderer: 'typst' })),
}));

const { renderCvPdf } = await import('../functions/src/assistedApplicationPdfRenderer.js');
const { handleAssistedApplicationReview } = await import('../functions/src/assistedApplicationReview.js');
const { mintReviewToken } = await import('../functions/src/assistedApplicationReviewToken.js');
const { handleAutomationAdminAction } = await import('../functions/src/assistedApplicationAutomationAdmin.js');
const { permitOptions } = await import('../functions/src/lib/permitStatus.js');
const { submitApplication } = await import('../scripts/assisted-application/lib/submit.mjs');

const SECRET = 's'.repeat(40);
const T0 = Date.UTC(2026, 9, 4, 10, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const ORDER = 'order_PERS01';
const BASE = `assisted_applications/${ORDER}`;
const RUN_KEY = Buffer.alloc(32, 9);
const CV_KEY = `assisted-application-uploads/${ORDER}/ai-cv-r1-1.pdf`;
const LETTER_KEY = `assisted-application-uploads/${ORDER}/ai-cover-letter-r1-1.pdf`;
const REBUILT = /\/ai-cv-r1-candidate-/;
const DE = permitOptions('de');

// An invented candidate living in Como, with a CV silent on permits, nationality and birth date.
const profile = {
  fullName: 'Giulia Verdi', location: 'Como', linkedin: '', languages: [{ language: 'Deutsch', level: 'B2' }],
  dateOfBirth: '', nationality: '', workPermit: '', availability: '', drivingLicence: '',
  experience: [{ role: 'Pflegefachfrau HF', employer: 'Ospedale Civico', location: 'Lugano', start: '2018', end: '2023', kind: 'job', highlights: ['Akutpflege auf einer Station mit 24 Betten.'] }],
  education: [], certifications: [], skills: [],
};
const cv = {
  language: 'de', type: 'qualified', sector: 'health', headline: 'Pflegefachfrau HF', headlineSource: 'profile', summary: 'Pflegefachfrau HF mit Erfahrung in der Akutpflege.',
  competencies: ['Akutpflege'], skills: [],
  experience: [{ role: 'Pflegefachfrau HF', employer: 'Ospedale Civico', location: 'Lugano', start: '2018', end: '2023', bullets: ['Akutpflege auf einer Station mit 24 Betten.'], rewritten: true }],
};
const permitQuestion = { id: 'work_permit', question: 'Hast du das Schweizer Bürgerrecht oder eine heute gültige Schweizer Bewilligung?', why: '', type: 'choice', options: DE, required: false };
const startQuestion = { id: 'availability', question: 'Ab wann verfügbar?', why: '', type: 'date', options: [], required: false };
const salaryQuestion = { id: 'salary_expectation', question: 'Lohnvorstellung?', why: '', type: 'text', options: [], required: false };

/** P7's fake Storage, with a hook between a request's rebuild (the object stored) and its commit. */
function fakeBucket() {
  const files = new Map<string, Buffer>();
  const bucket = {
    files,
    afterSave: null as null | ((key: string) => Promise<void>),
    file: (key: string) => ({
      save: async (buffer: Buffer) => { files.set(key, Buffer.from(buffer)); await bucket.afterSave?.(key); },
      download: async () => {
        if (!files.has(key)) throw Object.assign(new Error('missing'), { code: 404 });
        return [files.get(key)];
      },
      delete: async () => { files.delete(key); },
    }),
  };
  return bucket;
}

let store: ReturnType<typeof createMemoryFirestore>;
let bucket: ReturnType<typeof fakeBucket>;
// The dispatches of the flow, with the tailored CV the draft names at that moment.
const dispatches: Array<{ effect: any, pdfKey: string }> = [];
const runEffect = vi.fn(async ({ effect }: any) => {
  if (effect.type === 'dispatch') dispatches.push({ effect, pdfKey: store.read(`${BASE}/ai_drafts/current`)?.tailoredCv?.pdfKey });
  return { ok: true };
});

function seed({ draft = {}, flow = {}, person = {} }: { draft?: Record<string, any>, flow?: Record<string, any>, person?: Record<string, any> } = {}) {
  store = createMemoryFirestore({
    [BASE]: {
      paymentStatus: 'paid', submissionStatus: 'in_progress', jobTitle: 'Pflegefachperson HF', companyName: 'Spital Beispiel', locale: 'de',
      applicantName: 'Giulia Verdi', applicantEmail: 'giulia.verdi@example.com', applicantPhone: '+39 333 000 0000',
    },
    [`${BASE}/automation/flow`]: { state: 'candidate_review', round: 1, deadlineAt: null, answers: {}, feedback: [], ...flow },
    [`${BASE}/ai_drafts/current`]: {
      status: 'ready', round: 1, language: 'de', candidateLocale: 'de', profile: { ...profile, ...person }, job: { title: 'Pflegefachperson HF', applyUrl: '' },
      channel: { type: 'email', label: 'E-mail', email: 'hr@spital-beispiel.ch', applyUrl: '' },
      coverLetter: { subject: 'Bewerbung', text: 'Sehr geehrte Damen und Herren\n\nIch bewerbe mich um die Stelle in der Akutpflege.\n\nFreundliche Grüsse' },
      applicationEmail: { to: 'hr@spital-beispiel.ch', subject: 'Bewerbung', body: 'Guten Tag\n\nIm Anhang finden Sie meine Unterlagen.\n\nFreundliche Grüsse' },
      formAnswers: [], questions: [],
      factSources: {
        text: 'Giulia Verdi\nPflegefachfrau HF, Ospedale Civico, Lugano, 2018 – 2023\nAkutpflege auf einer Station mit 24 Betten.',
        posting: 'Wir suchen eine Pflegefachperson HF.', order: 'Pflegefachperson HF\nSpital Beispiel\nGiulia Verdi', answers: '', permitStatus: '',
      },
      factCheck: { ok: true, unsupported: [], advisories: [] },
      coverLetterPdfKey: LETTER_KEY,
      tailoredCv: { status: 'ready', pdfKey: CV_KEY, language: 'de', renderer: 'typst', cv },
      ...draft,
    },
  });
  bucket.files.set(CV_KEY, Buffer.from(JSON.stringify({ personal: [], contact: [], sections: [] })));
  bucket.files.set(LETTER_KEY, Buffer.from('%PDF-1.4 letter'));
}

const deps = (extra: Record<string, any> = {}) => ({ db: store.db, bucket, runEffect, getSecret: async () => SECRET, signUrl: async () => 'https://signed.example/x.pdf', nowMs: T0, ...extra });
// The review link of round 1 (assistedApplicationReviewToken.js).
const link = { secret: SECRET, orderId: ORDER, round: 1, nowMs: T0, kind: 'review' as const };
const token = () => mintReviewToken(link);
const post = (body: Record<string, any>, extra: Record<string, any> = {}) => handleAssistedApplicationReview({ method: 'POST', body: { t: token(), ...body } }, deps(extra));
const draftNow = () => store.read(`${BASE}/ai_drafts/current`);
const flowNow = () => store.read(`${BASE}/automation/flow`);
/** What the tailored CV the draft names prints. */
const printed = (key = draftNow().tailoredCv.pdfKey) => JSON.parse(bucket.files.get(key)!.toString());
const renders = () => vi.mocked(renderCvPdf).mock.calls.length;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const swissDay = (iso: string) => iso.split('-').reverse().join('.');

beforeEach(() => {
  bucket = fakeBucket();
  dispatches.length = 0;
  runEffect.mockClear();
  vi.mocked(renderCvPdf).mockClear();
  seed();
});

// Owner decision 7 of 2026-10-03: every correction of a value the tailored CV prints rebuilds it before anything else
// happens, because the submission sends the PDF the draft names.
describe('a correction always reaches the tailored CV that leaves', () => {
  it('rebuilds it for every field the CV prints, and the submission sends exactly that PDF', async () => {
    const corrections: Array<[Record<string, string>, (doc: any) => void]> = [
      [{ workPermit: DE[2] }, (doc) => expect(doc.personal).toContainEqual(['Arbeitsbewilligung', 'Aufenthaltsbewilligung B'])],
      [{ nationality: 'italiana' }, (doc) => expect(doc.personal).toContainEqual(['Nationalität', 'Italien (EU)'])],
      [{ dateOfBirth: '12.03.1998' }, (doc) => expect(doc.personal).toContainEqual(['Geburtsdatum', '12.03.1998'])],
      [{ availability: 'sofort' }, (doc) => expect(doc.personal).toContainEqual(['Verfügbarkeit', 'sofort'])],
      [{ languages: 'Deutsch C1, Englisch B2' }, (doc) => expect(doc.sections.find((section: any) => section.kind === 'languages').pairs).toEqual([['Deutsch C1', ''], ['Englisch B2', '']])],
      [{ linkedin: 'linkedin.com/in/giulia-verdi-esempio' }, (doc) => expect(doc.contact).toContain('linkedin.com/in/giulia-verdi-esempio')],
    ];
    for (const [fields, check] of corrections) {
      const before = draftNow().tailoredCv.pdfKey;
      expect(await post({ action: 'edit', fields })).toMatchObject({ status: 200, body: { changed: ['fields'] } });
      expect([fields, draftNow().tailoredCv.pdfKey === before]).toEqual([fields, false]);
      check(printed());
    }
    // Every superseded PDF of the review page is still there only as the purge's: the draft names the last one.
    expect(printed().personal).toEqual([
      ['Geburtsdatum', '12.03.1998'], ['Nationalität', 'Italien (EU)'], ['Arbeitsbewilligung', 'Aufenthaltsbewilligung B'], ['Verfügbarkeit', 'sofort'],
    ]);

    const sendCascade = vi.fn(async () => ({ failed: [], sent: [{ provider: 'resend', messageId: 'm1' }] }));
    const event = await submitApplication({
      order: store.read(BASE), orderId: ORDER, flow: flowNow(), draft: draftNow(), cvBuffer: Buffer.from('the uploaded CV'), cvType: 'pdf',
      bucket, runKey: RUN_KEY, sendCascade, resolve: async () => [{ address: '93.184.216.34', family: 4 }], fetchImpl: vi.fn(), nowMs: T0, log: () => {},
    });
    expect(event).toMatchObject({ type: 'submit_succeeded', channel: 'email' });
    const [[items]] = sendCascade.mock.calls as any;
    const attached = items[0].payload.attachments.find((attachment: any) => attachment.filename.startsWith('CV_'));
    expect(Buffer.from(attached.content, 'base64').equals(bucket.files.get(draftNow().tailoredCv.pdfKey)!)).toBe(true);
  });

  it('rebuilds it for an answer it prints, the candidate’s and the owner’s, and never for one it does not print', async () => {
    seed({ draft: { questions: [permitQuestion, startQuestion, salaryQuestion] }, person: { nationality: 'italiana' } });
    expect(await post({ action: 'answers', answers: { work_permit: DE[4] } })).toMatchObject({ status: 200 });
    expect(printed().personal).toContainEqual(['Arbeitsbewilligung', 'Grenzgängerbewilligung G']);
    const start = isoDay(T0 + 90 * DAY);
    expect(await post({ action: 'answers', answers: { availability: start } })).toMatchObject({ status: 200 });
    expect(printed().personal).toContainEqual(['Verfügbarkeit', swissDay(start)]);
    expect(flowNow().answers).toEqual({ work_permit: DE[4], availability: start });

    // A salary is not printed: same PDF, no render.
    const key = draftNow().tailoredCv.pdfKey;
    const before = renders();
    expect(await post({ action: 'answers', answers: { salary_expectation: 'CHF 80000' } })).toMatchObject({ status: 200 });
    expect([draftNow().tailoredCv.pdfKey, renders()]).toEqual([key, before]);

    // The owner's answer, a legacy «B», rebuilds it too.
    await handleAutomationAdminAction(store.db, { action: 'automationSetAnswers', orderId: ORDER, answers: { work_permit: 'B' } }, 'owner@example.com', { runEffect, bucket, nowMs: T0 });
    expect(printed().personal).toContainEqual(['Arbeitsbewilligung', 'Aufenthaltsbewilligung B']);
    expect(flowNow().answers).toMatchObject({ work_permit: 'B', availability: start, salary_expectation: 'CHF 80000' });
  });

  it('commits the rebuilt CV before the answer dispatches the waiting submission', async () => {
    // The CV's own words print a permit; the candidate now says they hold none.
    seed({ flow: { state: 'needs_candidate_action' }, draft: { questions: [{ ...permitQuestion, required: true }] }, person: { workPermit: 'Permesso G' } });
    expect(await post({ action: 'answers', answers: { work_permit: DE[5] } })).toMatchObject({ status: 200, body: { state: 'submitting' } });
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].effect).toMatchObject({ type: 'dispatch', mode: 'submit' });
    expect(dispatches[0].pdfKey).toMatch(REBUILT);
    expect(printed(dispatches[0].pdfKey).personal.map(([label]: [string]) => label)).not.toContain('Arbeitsbewilligung');
  });

  it('refuses answers whose CV another request replaced meanwhile, and keeps what that request saved', async () => {
    seed({ draft: { questions: [permitQuestion] } });
    let edit: any = null;
    let started = false;
    bucket.afterSave = async (key) => {
      if (started || !REBUILT.test(key)) return;
      started = true;
      // The candidate's nationality, saved from another tab while the answers sit between their rebuild and their commit.
      edit = await post({ action: 'edit', fields: { nationality: 'italiana' } });
    };
    const refused = await post({ action: 'answers', answers: { work_permit: DE[2] } });
    expect(edit).toMatchObject({ status: 200 });
    expect(refused).toMatchObject({ status: 409, body: { ok: false, error: 'changed_meanwhile' } });
    expect(flowNow().answers).toEqual({});
    // Only the edit's PDF is left of the two, and the draft names it.
    expect([...bucket.files.keys()].filter((key) => REBUILT.test(key))).toEqual([draftNow().tailoredCv.pdfKey]);
    expect(printed().personal).toEqual([['Nationalität', 'Italien (EU)']]);
  });

  it('keeps the PDF of a sent application, and saves nothing without Storage', async () => {
    seed({ flow: { state: 'submitted' }, draft: { questions: [permitQuestion] } });
    expect(await post({ action: 'answers', answers: { work_permit: DE[2] } })).toMatchObject({ status: 200 });
    expect([flowNow().answers, draftNow().tailoredCv.pdfKey, renders()]).toEqual([{ work_permit: DE[2] }, CV_KEY, 0]);

    seed({ draft: { questions: [permitQuestion] } });
    expect(await post({ action: 'answers', answers: { work_permit: DE[2] } }, { bucket: undefined })).toMatchObject({ status: 503, body: { ok: false, error: 'storage_unavailable' } });
    expect([flowNow().answers, draftNow().tailoredCv.pdfKey]).toEqual([{}, CV_KEY]);
  });
});
