import { describe, expect, it, vi } from 'vitest';
import { renderPdf } from '../functions/src/assistedApplicationAiDocuments.js';
import {
  DOCUMENTS_SCHEMA,
  MATCH_SCHEMA,
  PROFILE_SCHEMA,
  REQUIREMENTS_SCHEMA,
} from '../functions/src/assistedApplicationAiPrompts.js';
import { TAILORED_CV_SCHEMA } from '../functions/src/assistedApplicationTailoredCv.js';
import { buildDraft, DraftAbort } from '../scripts/assisted-application/lib/draft.mjs';
import { classifyLiveness, isHardClosed } from '../scripts/assisted-application/lib/liveness.mjs';
import { decryptJson, encryptJson, maskValues } from '../scripts/assisted-application/lib/secure-run.mjs';
import { openRequiredQuestions, submitApplication } from '../scripts/assisted-application/lib/submit.mjs';
import { submissionGuard } from '../functions/src/assistedApplicationSubmissionGuard.js';
import { evaluateRedFlags } from '../functions/src/assistedApplicationFlow.js';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { PNG_1X1, pdfPaintsImage } from './helpers/pdfImages';
import { safeErrorCode, takeFactCheck, writeDraft } from '../scripts/assisted-application/agent.mjs';

const KEY = Buffer.alloc(32, 7);
const ORDER_ID = 'order_RUN123';
const CV_LINES = [
  'Maria Rossi — Infermiera',
  'Email: maria.rossi@example.com — Telefono: +41 79 123 45 67 — Como',
  'Esperienza: Ospedale Civico Lugano, infermiera di reparto, 2018 – 2023. Reparto da 24 letti.',
  'Ridotto gli errori di somministrazione del 15% con un nuovo protocollo di doppio controllo.',
  'Lingue: italiano madrelingua, tedesco B1. Competenze: triage, terapia intensiva, cartella clinica.',
];

function cvPdf() {
  return renderPdf(CV_LINES.map((text) => ({ text })));
}

function fakeBucket() {
  const files = new Map<string, Buffer>();
  return {
    files,
    file: (key: string) => ({
      async save(content: Buffer | string) { files.set(key, Buffer.from(content)); },
      async download() {
        if (!files.has(key)) throw Object.assign(new Error('missing'), { code: 404 });
        return [files.get(key)];
      },
      async delete() { files.delete(key); },
    }),
  };
}

const POSTING = 'L’Ospedale cerca un’infermiera per il reparto di medicina. Requisiti: diploma SUP in cure infermieristiche, esperienza di reparto, tedesco B1. '
  + 'Inviare il CV con le pretese salariali. '.repeat(3);

function fakeFetch({ employerStatus = 200, employerHtml = '<main><p>Descrizione del posto di lavoro in reparto.</p><a>Candidati ora</a></main>' } = {}) {
  return vi.fn(async (url: string, init: any = {}) => {
    if (url.startsWith('https://cdn.frontaliereticino.ch/data/job-detail/')) {
      if (init.method === 'HEAD') return new Response(null, { status: 200 });
      return new Response(JSON.stringify({
        description: POSTING,
        applyUrl: 'https://jobs.lever.co/ospedale/1/apply',
        titleByLocale: { it: 'Infermiera di reparto' },
        addressLocality: 'Lugano',
      }), { status: 200 });
    }
    return new Response(employerHtml.repeat(employerStatus === 200 ? 5 : 1), { status: employerStatus, headers: { 'content-type': 'text/html' } });
  });
}

function fakeCodex() {
  return vi.fn(async ({ schema }: { schema: unknown }) => {
    if (schema === PROFILE_SCHEMA) {
      return {
        fullName: 'Maria Rossi', email: 'maria.rossi@example.com', phone: '+41 79 123 45 67', location: 'Como', linkedin: '', website: '',
        headline: 'Infermiera', summary: '', workPermit: '', availability: '',
        languages: [{ language: 'italiano', level: 'madrelingua' }, { language: 'tedesco', level: 'B1' }],
        skills: ['triage'], experience: [{ role: 'Infermiera', employer: 'Ospedale Civico', location: 'Lugano', start: '2018', end: '2023', highlights: ['Reparto da 24 letti.'] }],
        education: [], certifications: [], cvLanguage: 'it',
      };
    }
    if (schema === REQUIREMENTS_SCHEMA) {
      return {
        postingLanguage: 'it', roleTitle: 'Infermiera',
        requirements: [
          { requirement: 'Diploma SUP', importance: 'critical', basis: 'stated', quote: 'diploma SUP in cure infermieristiche' },
          { requirement: 'Tedesco B1', importance: 'high', basis: 'stated', quote: 'tedesco B1' },
          { requirement: 'Empatia', importance: 'critical', basis: 'inferred', quote: 'inventata' },
          { requirement: 'Esperienza', importance: 'high', basis: 'stated', quote: 'citazione che non esiste' },
        ],
        languageRequirements: [], workPermitQuote: '', salaryRequested: true, applicationEmail: 'hr@invented.ch', contactPerson: '', applicationInstructions: 'Inviare il CV con le pretese salariali.',
      };
    }
    if (schema === MATCH_SCHEMA) {
      return {
        matches: [{ index: 1, status: 'met', evidence: 'tedesco B1' }, { index: 0, status: 'missing', evidence: 'diploma inventato nel CV' }],
        verdict: 'good', summaryIt: 'Buon profilo.', checksIt: [], questions: [],
      };
    }
    if (schema === DOCUMENTS_SCHEMA) {
      return {
        coverLetter: {
          salutation: 'Gentili Signore e Signori,',
          paragraphs: ['Dal 2018 al 2023 ho lavorato in un reparto da 24 letti e ridotto gli errori del 15%.', 'Ho 7 anni di esperienza.'],
          closing: 'Cordiali saluti',
        },
        emailSubject: 'Candidatura infermiera', emailBody: 'Gentili Signori,\nin allegato CV e lettera.\nCordiali saluti',
        motivationShort: 'Mi motiva il lavoro di reparto.', whyCompany: 'Ospedale di riferimento.',
      };
    }
    if (schema === TAILORED_CV_SCHEMA) {
      return {
        headline: 'Infermiera', summary: 'Infermiera con esperienza in reparto.', competencies: ['triage', 'astrofisica'],
        experience: [{ index: 0, bullets: ['Reparto da 24 letti.'] }], skills: ['triage'],
        sectionTitles: { summary: 'Profilo', competencies: 'Competenze', experience: 'Esperienza', education: 'Formazione', certifications: 'Certificazioni', skills: 'Competenze tecniche', languages: 'Lingue' },
      };
    }
    throw new Error('unexpected schema');
  });
}

const order = {
  jobId: 'ospedale-123', jobUrl: 'https://jobs.lever.co/ospedale/1', jobTitle: 'Infermiera', companyName: 'Ospedale',
  locale: 'it', applicantName: 'Maria Rossi', applicantEmail: 'maria.rossi@example.com', applicantPhone: '+41 79 123 45 67',
  cvStorageKey: `assisted-application-uploads/${ORDER_ID}/1-cv.pdf`,
};

const quiet = () => {};
const publicDns = async () => [{ address: "93.184.216.34", family: 4 }];

describe('draft mode', () => {
  it('builds the draft from Codex answers, with the career-ops guards applied in code', async () => {
    const bucket = fakeBucket();
    const codex = fakeCodex();
    const draft = await buildDraft({
      order, orderId: ORDER_ID, flow: { round: 1, answers: {} }, previousDraft: null, cvBuffer: cvPdf(), cvType: 'pdf',
      codex, bucket, runKey: KEY, resolve: publicDns, fetchImpl: fakeFetch(), nowMs: Date.UTC(2026, 8, 30), log: quiet,
    });
    // Profile, requirements, match, letter and the tailored ATS CV (career-ops extras).
    expect(codex).toHaveBeenCalledTimes(5);
    expect(draft.tailoredCv).toMatchObject({ status: 'ready', dropped: ['astrofisica'] });
    expect(bucket.files.has(draft.tailoredCv.pdfKey)).toBe(true);
    expect(draft.ats.original.structural.grade).toBeTruthy();
    expect(draft.ats.tailored.keywords).toBeTruthy();
    expect(['high_confidence', 'caution', 'suspicious']).toContain(draft.legitimacy.tier);
    expect(draft).toMatchObject({ status: 'ready', round: 1, verdict: 'good', language: 'it', channel: { type: 'lever' } });
    // Inferred rows are never critical; unverified quotes and invented addresses are dropped.
    expect(draft.requirements[2]).toMatchObject({ basis: 'inferred', importance: 'meaningful', quote: '' });
    expect(draft.requirements[3]).toMatchObject({ quote: '', quoteUnverified: true });
    expect(draft.requirementsRaw.applicationEmail).toBe('');
    // Evidence the CV does not contain is not kept as evidence.
    expect(draft.matches.find((item: any) => item.index === 0)).toMatchObject({ evidence: '', evidenceUnverified: true });
    // The posting asks for a salary expectation: the question is added even though the model forgot it.
    expect(draft.questions).toEqual([
      expect.objectContaining({ id: 'salary_expectation', required: true, source: 'rule' }),
      // The application leaves through a portal's form (Lever): the form of address is asked now, optional.
      expect.objectContaining({ id: 'salutation', required: false, type: 'choice', options: ['Signor', 'Signora', 'Altro'], source: 'rule' }),
    ]);
    // "7 anni" is not in the CV: flagged for the operator.
    expect(draft.factCheck.unsupported.map((item: any) => item.token)).toEqual(['7']);
    expect(bucket.files.has(draft.coverLetterPdfKey)).toBe(true);
    const archive = JSON.parse(bucket.files.get(draft.archiveKey)!.toString('utf8'));
    expect(decryptJson(archive, KEY).postingText).toContain('Ospedale cerca');
    expect(draft.applicationEmail.body).toContain('Maria Rossi');
    // The subject names the position and the candidate (the model's "Candidatura infermiera" is not used).
    expect(draft.applicationEmail.subject).toMatch(/^Candidatura per la posizione di .+ – Maria Rossi$/);
  });

  it('writes the next round from the candidate as corrected on the review page', async () => {
    const codex = fakeCodex();
    const flow = { round: 2, answers: { work_permit: 'G' }, formOverrides: { languages: 'Deutsch C1', workPermit: 'B', salary: 'CHF 90000' } };
    const draft = await buildDraft({
      order, orderId: ORDER_ID, flow, previousDraft: null, cvBuffer: cvPdf(), cvType: 'pdf',
      codex, bucket: fakeBucket(), runKey: KEY, resolve: publicDns, fetchImpl: fakeFetch(), nowMs: Date.UTC(2026, 8, 30), log: quiet,
    });
    const promptFor = (schema: unknown) => (codex.mock.calls as any[]).find(([request]) => request.schema === schema)[0].prompt;
    for (const schema of [MATCH_SCHEMA, DOCUMENTS_SCHEMA]) {
      expect(promptFor(schema)).toContain('Deutsch C1');
      expect(promptFor(schema)).toContain('"work_permit":"B"');
    }
    expect(draft.profile).toMatchObject({ languages: [{ language: 'Deutsch C1', level: '' }], workPermit: 'B' });
    // The corrected salary answers the question the posting asks.
    expect(draft.questions.map((question: any) => question.id)).not.toContain('salary_expectation');
  });

  it('reuses a profile read by this version, normalized; a profile read before the kinds of experience is read again', async () => {
    const run = (previousDraft: any) => {
      const codex = fakeCodex();
      return buildDraft({
        order, orderId: ORDER_ID, flow: { round: 2, answers: {} }, previousDraft, cvBuffer: cvPdf(), cvType: 'pdf',
        codex, bucket: fakeBucket(), runKey: KEY, resolve: publicDns, fetchImpl: fakeFetch(), nowMs: Date.UTC(2026, 8, 30), log: quiet,
      }).then((draft) => ({ draft, calls: codex.mock.calls.length }));
    };
    const { draft: first } = await run(null);
    const reused = await run({ ...first, profile: { ...first.profile, fullName: '  Maria   Rossi  ' } });
    // Match, documents and tailored CV only: profile and requirements are reused.
    expect(reused.calls).toBe(3);
    expect(reused.draft.profile.fullName).toBe('Maria Rossi');
    const { aptitudeTests, recognitions, projects, interests, references, drivingLicence, ...older } = first.profile;
    const reread = await run({ ...first, profile: { ...older, experience: older.experience.map(({ kind, ...role }: any) => role) } });
    expect(reread.calls).toBe(5);
  });

  it('keeps on the next round’s tailored CV the photo the candidate gave on the review page', async () => {
    const bucket = fakeBucket();
    await bucket.file(`assisted-application-uploads/${ORDER_ID}/photo-1.png`).save(PNG_1X1);
    const draft = await buildDraft({
      order, orderId: ORDER_ID, flow: { round: 2, answers: {}, photo: { key: `assisted-application-uploads/${ORDER_ID}/photo-1.png`, detectedType: 'png' } },
      previousDraft: null, cvBuffer: cvPdf(), cvType: 'pdf', codex: fakeCodex(), bucket, runKey: KEY, resolve: publicDns, fetchImpl: fakeFetch(), nowMs: Date.UTC(2026, 8, 30), log: quiet,
    });
    expect(draft.tailoredCv).toMatchObject({ status: 'ready', photo: true, renderer: 'typst' });
    expect(await pdfPaintsImage(bucket.files.get(draft.tailoredCv.pdfKey)!)).toBe(true);
  }, 60_000);

  it('deletes the previous round’s tailored CV that carried the photo once the next draft replaces it', async () => {
    const bucket = fakeBucket();
    const photo = { key: `assisted-application-uploads/${ORDER_ID}/photo-1.png`, detectedType: 'png' };
    await bucket.file(photo.key).save(PNG_1X1);
    const store = createMemoryFirestore();
    const orderRef = store.db.collection('assisted_applications').doc(ORDER_ID);
    const build = (round: number) => buildDraft({
      order, orderId: ORDER_ID, flow: { round, answers: {}, photo }, previousDraft: null, cvBuffer: cvPdf(), cvType: 'pdf',
      codex: fakeCodex(), bucket, runKey: KEY, resolve: publicDns, fetchImpl: fakeFetch(), nowMs: Date.UTC(2026, 8, 30), log: quiet,
    });
    const first = await build(1);
    await writeDraft({ orderRef, bucket, draft: first, previousDraft: null });
    const next = await build(2);
    await writeDraft({ orderRef, bucket, draft: next, previousDraft: first });
    expect(store.read(`assisted_applications/${ORDER_ID}/ai_drafts/current`).tailoredCv.pdfKey).toBe(next.tailoredCv.pdfKey);
    // Only the PDF the draft names carries the photo: taken back on the review page, it leaves none behind.
    const withPhoto: string[] = [];
    for (const [key, bytes] of bucket.files) if (key.endsWith('.pdf') && await pdfPaintsImage(bytes)) withPhoto.push(key);
    expect(withPhoto).toEqual([next.tailoredCv.pdfKey]);

    // A PDF without the photo (none given, or the standard-font writer) is not this rule's: it stays for the purge.
    for (const tailoredCv of [{ renderer: 'typst' }, { renderer: 'legacy', photo: true }]) {
      const key = `assisted-application-uploads/${ORDER_ID}/ai-cv-r1-${tailoredCv.renderer}.pdf`;
      await bucket.file(key).save(cvPdf());
      await writeDraft({ orderRef, bucket, draft: next, previousDraft: { tailoredCv: { status: 'ready', pdfKey: key, ...tailoredCv } } });
      expect(bucket.files.has(key)).toBe(true);
    }

    // A delete that fails is logged; the draft (here a round whose tailored CV failed) is written all the same.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    // On GitHub Actions the runner's summary() would append this line to the tests job's own summary page.
    vi.stubEnv('GITHUB_STEP_SUMMARY', '');
    const failing = { file: (key: string) => ({ ...bucket.file(key), delete: async () => { throw new Error('storage unavailable'); } }) };
    try {
      await writeDraft({ orderRef, bucket: failing, draft: { ...next, round: 3, tailoredCv: { status: 'failed', language: 'it' } }, previousDraft: next });
      expect(store.read(`assisted_applications/${ORDER_ID}/ai_drafts/current`)).toMatchObject({ round: 3, tailoredCv: { status: 'failed' } });
      expect(bucket.files.has(next.tailoredCv.pdfKey)).toBe(true);
      expect(log.mock.calls.map(([line]) => String(line))).toContain('[assisted-application] superseded tailored cv not deleted: storage unavailable');
    } finally {
      log.mockRestore();
      vi.unstubAllEnvs();
    }
  }, 60_000);

  it('records the photo only when the PDF carries it: never with the standard-font writer', async () => {
    const bucket = fakeBucket();
    await bucket.file(`assisted-application-uploads/${ORDER_ID}/photo-1.png`).save(PNG_1X1);
    vi.stubEnv('ASSISTED_APPLICATION_PDF_RENDERER', 'legacy');
    try {
      const draft = await buildDraft({
        order, orderId: ORDER_ID, flow: { round: 2, answers: {}, photo: { key: `assisted-application-uploads/${ORDER_ID}/photo-1.png`, detectedType: 'png' } },
        previousDraft: null, cvBuffer: cvPdf(), cvType: 'pdf', codex: fakeCodex(), bucket, runKey: KEY, resolve: publicDns, fetchImpl: fakeFetch(), nowMs: Date.UTC(2026, 8, 30), log: quiet,
      });
      expect(draft.tailoredCv).toMatchObject({ status: 'ready', renderer: 'legacy' });
      expect(draft.tailoredCv).not.toHaveProperty('photo');
      expect(await pdfPaintsImage(bucket.files.get(draft.tailoredCv.pdfKey)!)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  }, 60_000);

  it('stops before any Codex call when the posting is closed', async () => {
    const codex = fakeCodex();
    await expect(buildDraft({
      order, orderId: ORDER_ID, flow: { round: 1 }, previousDraft: null, cvBuffer: cvPdf(), cvType: 'pdf',
      codex, bucket: fakeBucket(), runKey: KEY, resolve: publicDns, fetchImpl: fakeFetch({ employerStatus: 404 }), log: quiet,
    })).rejects.toMatchObject({ eventType: 'posting_closed' });
    expect(codex).not.toHaveBeenCalled();
    expect(new DraftAbort('draft_failed', 'x').eventType).toBe('draft_failed');
  });
});

describe('submit mode', () => {
  const baseDraft = {
    status: 'ready', round: 1, language: 'it', profile: { fullName: 'Maria Rossi' },
    coverLetter: { text: 'Gentili Signori,\n\nDal 2018 al 2023.\n\nSaluti' },
    applicationEmail: { to: 'hr@ospedale.ch', subject: 'Candidatura', body: 'In allegato CV e lettera.' },
    coverLetterPdfKey: `assisted-application-uploads/${ORDER_ID}/ai-cover-letter.pdf`,
    factSources: { text: CV_LINES.join('\n'), posting: POSTING, order: '' },
    questions: [{ id: 'salary_expectation', required: true }],
    formAnswers: [],
    channel: { type: 'email', email: 'hr@ospedale.ch', applyUrl: '' },
    job: { applyUrl: '' },
  };

  it('sends the e-mail application through Resend with both attachments and replies to the candidate', async () => {
    const bucket = fakeBucket();
    await bucket.file(baseDraft.coverLetterPdfKey).save(Buffer.from('%PDF-1.4 letter'));
    const sendCascade = vi.fn(async () => ({ failed: [], sent: [{ provider: 'resend', messageId: 'm1' }] }));
    const event = await submitApplication({
      order, orderId: ORDER_ID, flow: { answers: { salary_expectation: 'CHF 80k' } }, draft: baseDraft, cvBuffer: cvPdf(), cvType: 'pdf',
      bucket, runKey: KEY, sendCascade, resolve: publicDns, fetchImpl: fakeFetch(), log: quiet,
    });
    // The follow-ups (day 7 and 14) get the recipient, the subject and our Message-ID.
    expect(event).toMatchObject({ type: 'submit_succeeded', channel: 'email', followup: { to: 'hr@ospedale.ch', subject: 'Candidatura' } });
    expect(event.followup.messageId).toMatch(/^<aa-.+@candidature\.frontaliereticino\.ch>$/);
    const [[items, options]] = sendCascade.mock.calls as any;
    expect(options).toEqual({ delayMs: 0, forceProvider: 'resend' });
    expect(items[0].payload).toMatchObject({ to: ['hr@ospedale.ch'], replyTo: 'maria.rossi@example.com', from: '"Maria Rossi via Frontaliere Ticino" <valerie@frontaliereticino.ch>' });
    expect(items[0].payload.attachments.map((item: any) => item.filename)).toEqual(['CV_Maria_Rossi.pdf', 'Lettera_di_presentazione_Maria_Rossi.pdf']);
    // Sent in the candidate's name: no rewritten links, no open pixel.
    expect(items[0].payload).toMatchObject({ tracking: false, openTracking: false });
  });

  it('sends one dossier when the switch asks for it, never to an apprentice', async () => {
    const sent = async (candidateType: unknown) => {
      const bucket = fakeBucket();
      await bucket.file(baseDraft.coverLetterPdfKey).save(cvPdf());
      const sendCascade = vi.fn(async () => ({ failed: [], sent: [{ provider: 'resend', messageId: 'm1' }] }));
      await submitApplication({
        order, orderId: ORDER_ID, flow: { answers: { salary_expectation: 'CHF 80k' } }, draft: { ...baseDraft, candidateType }, cvBuffer: cvPdf(), cvType: 'pdf',
        bucket, runKey: KEY, sendCascade, resolve: publicDns, fetchImpl: fakeFetch(), log: quiet,
      });
      return (sendCascade.mock.calls as any)[0][0][0].payload.attachments.map((item: any) => item.filename);
    };
    const previous = process.env.ASSISTED_APPLICATION_DOSSIER_MODE;
    process.env.ASSISTED_APPLICATION_DOSSIER_MODE = 'single';
    try {
      expect(await sent({ type: 'qualified', sector: 'health' })).toEqual(['Dossier_di_candidatura_Maria_Rossi.pdf']);
      const separate = ['CV_Maria_Rossi.pdf', 'Lettera_di_presentazione_Maria_Rossi.pdf'];
      expect(await sent({ type: 'apprentice', sector: 'it' })).toEqual(separate);
      expect(await sent('apprentice')).toEqual(separate);
      expect(await sent(undefined)).toEqual(separate);
    } finally {
      if (previous === undefined) delete process.env.ASSISTED_APPLICATION_DOSSIER_MODE;
      else process.env.ASSISTED_APPLICATION_DOSSIER_MODE = previous;
    }
  });

  it('a dry run prepares the e-mail, keeps it encrypted next to the order, and sends nothing', async () => {
    const bucket = fakeBucket();
    await bucket.file(baseDraft.coverLetterPdfKey).save(Buffer.from('%PDF-1.4 letter'));
    const sendCascade = vi.fn();
    const event = await submitApplication({
      order, orderId: ORDER_ID, flow: { answers: { salary_expectation: 'CHF 80k' } }, draft: baseDraft, cvBuffer: cvPdf(), cvType: 'pdf',
      bucket, runKey: KEY, sendCascade, resolve: publicDns, fetchImpl: fakeFetch(), log: quiet, dryRun: true,
    });
    expect(event).toEqual({ type: 'dry_run_ready', channel: 'email' });
    expect(sendCascade).not.toHaveBeenCalled();
    expect([...bucket.files.keys()].some((key) => key.includes('dry-run-email'))).toBe(true);
  });

  it('fills the portal form with the corrections the candidate made on the review page', async () => {
    const bucket = fakeBucket();
    await bucket.file(baseDraft.coverLetterPdfKey).save(Buffer.from('%PDF-1.4 letter'));
    const portalDraft = { ...baseDraft, channel: { type: 'lever', applyUrl: 'https://jobs.lever.co/ospedale/1/apply' } };
    const runner = vi.fn(async () => ({ event: { type: 'submit_handoff', reason: 'captcha' }, evidence: { steps: [] } }));
    await submitApplication({
      order, orderId: ORDER_ID, draft: portalDraft, cvBuffer: cvPdf(), cvType: 'pdf',
      flow: { answers: { salary_expectation: 'CHF 80k' }, formOverrides: { firstName: 'Maria Luisa', lastName: 'Rossi', phone: '+41 91 000 00 00', location: 'Varese' } },
      bucket, runKey: KEY, sendCascade: vi.fn(), resolve: publicDns, fetchImpl: fakeFetch(), log: quiet, codex: vi.fn(), portalRunner: runner,
    });
    const [[ctx]] = runner.mock.calls as any;
    expect(ctx.candidate.identity).toMatchObject({ fullName: 'Maria Luisa Rossi', firstName: 'Maria Luisa', lastName: 'Rossi', phone: '+41 91 000 00 00', location: 'Varese' });
    expect(ctx.files.cv).toMatch(/CV_Maria_Luisa_Rossi\.pdf$/);
  });

  // Coop, 2026-10-02: jobs.coopjobs.ch → Prospective.ch redirect → SAP SuccessFactors.
  it('starts Coop on SuccessFactors and checks the posting, not the ATS sign-in, for liveness', async () => {
    const bucket = fakeBucket();
    await bucket.file(baseDraft.coverLetterPdfKey).save(Buffer.from('%PDF-1.4 letter'));
    const posting = 'https://jobs.coopjobs.ch/offene-stellen/baecker/20d53107-db26-4a35-8f4c-b4d15bb4bb31';
    const redirect = 'https://ohws.prospective.ch/public/v1/redirect/20d53107-db26-4a35-8f4c-b4d15bb4bb31/ats/';
    const ats = 'https://career2.successfactors.eu/career?company=Coop&career_ns=job_application&career_job_req_id=170044';
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init: any = {}) => {
      calls.push(`${init.method || 'GET'} ${url}`);
      if (url.startsWith('https://cdn.frontaliereticino.ch/data/job-detail/')) return new Response(null, { status: 200 });
      if (url === redirect) return new Response(null, { status: 303, headers: { location: ats } });
      return new Response(`<main><p>${'Bäcker:in bei Coop. '.repeat(30)}</p><a class="main-btn apply" href="${redirect}">Jetzt bewerben</a></main>`, { status: 200, headers: { 'content-type': 'text/html' } });
    });
    const runner = vi.fn(async () => ({ event: { type: 'submit_handoff', reason: 'captcha' }, evidence: { steps: [] } }));
    const submit = (draft: any) => submitApplication({
      order, orderId: ORDER_ID, draft, cvBuffer: cvPdf(), cvType: 'pdf', flow: { answers: { salary_expectation: 'CHF 80k' } },
      bucket, runKey: KEY, sendCascade: vi.fn(), resolve: publicDns, fetchImpl, log: quiet, codex: vi.fn(), portalRunner: runner,
    });
    // A draft made before the redirect was resolved: resolved at submit time.
    await submit({ ...baseDraft, channel: { type: 'employer_site', applyUrl: posting, host: 'jobs.coopjobs.ch', requiresAccount: false } });
    expect((runner.mock.calls as any)[0][0].applyUrl).toBe(ats);
    // A draft made today: the ATS for the runner, the posting for liveness, SuccessFactors never fetched.
    calls.length = 0;
    await submit({ ...baseDraft, channel: { type: 'successfactors', applyUrl: ats, postingUrl: posting, via: 'prospective', host: 'career2.successfactors.eu', requiresAccount: true } });
    expect((runner.mock.calls as any)[1][0].applyUrl).toBe(ats);
    expect(calls).toContain(`GET ${posting}`);
    expect(calls.some((call) => call.includes('successfactors'))).toBe(false);
  });

  // Coop's apprenticeships, 2026-10-02: the redirect ends on a WhatsApp chat (PastaHR).
  // Owner decision 2026-10-03: sent once the candidate has the link and the steps by e-mail.
  it('completes a WhatsApp-only application with its link, without running the browser', async () => {
    const bucket = fakeBucket();
    await bucket.file(baseDraft.coverLetterPdfKey).save(Buffer.from('%PDF-1.4 letter'));
    const posting = 'https://jobs.coopjobs.ch/offene-stellen/detailhandel-efz/5ce03251-9c03-4836-9887-cdbd5753a42c';
    const redirect = 'https://ohws.prospective.ch/public/v1/redirect/5ce03251-9c03-4836-9887-cdbd5753a42c/ats/';
    const pasta = 'https://prod.pastahr.com/en/r/COFU2003?utm_medium=prospective-job-description';
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith('https://cdn.frontaliereticino.ch/data/job-detail/')) return new Response(null, { status: 200 });
      if (url === redirect) return new Response(null, { status: 303, headers: { location: pasta } });
      return new Response(`<main><p>${'Lehrstelle bei Coop. '.repeat(30)}</p><a href="${redirect}">Jetzt bewerben</a></main>`, { status: 200, headers: { 'content-type': 'text/html' } });
    });
    const runner = vi.fn();
    const sendCascade = vi.fn();
    const submit = (draft: any, extra: Record<string, unknown> = {}) => submitApplication({
      order, orderId: ORDER_ID, draft, cvBuffer: cvPdf(), cvType: 'pdf', flow: { answers: { salary_expectation: 'CHF 80k' } },
      bucket, runKey: KEY, sendCascade, resolve: publicDns, fetchImpl, log: quiet, codex: vi.fn(), portalRunner: runner, ...extra,
    });
    const pastaChannel = { type: 'pastahr', applyUrl: pasta, postingUrl: posting, via: 'prospective', host: 'prod.pastahr.com', requiresAccount: false };
    const sent = { type: 'submit_succeeded', channel: 'whatsapp', whatsappUrl: pasta };
    // A draft from before the redirect was resolved, and one made today.
    await expect(submit({ ...baseDraft, channel: { type: 'employer_site', applyUrl: posting, host: 'jobs.coopjobs.ch', requiresAccount: false } }))
      .resolves.toEqual(sent);
    await expect(submit({ ...baseDraft, channel: pastaChannel })).resolves.toEqual(sent);
    expect([...bucket.files.keys()].some((key) => key.includes('submit-whatsapp'))).toBe(true);
    // A dry run says so and stores nothing; a WhatsApp channel without a PastaHR https link stays a handoff.
    await expect(submit({ ...baseDraft, channel: pastaChannel }, { dryRun: true })).resolves.toEqual({ type: 'dry_run_ready', channel: 'whatsapp' });
    await expect(submit({ ...baseDraft, channel: { ...pastaChannel, applyUrl: 'http://prod.pastahr.com/en/r/COFU2003' } }))
      .resolves.toEqual({ type: 'submit_handoff', reason: 'whatsapp' });
    expect(runner).not.toHaveBeenCalled();
    expect(sendCascade).not.toHaveBeenCalled();
  });

  // Rolex 2026-10-02: «Vos bulletins des trois dernières années scolaires», EVA and GRI results.
  const withDocuments = (draft: any) => ({
    ...draft,
    requiredDocuments: [
      { id: 'school_reports', label: 'Bulletins des trois dernières années', kind: 'school_report', keywords: ['bulletin'], required: true, quote: '' },
      { id: 'eva_test', label: 'Résultats du test EVA', kind: 'aptitude_test', keywords: ['EVA'], required: true, quote: '' },
    ],
  });
  const documentsFlow = {
    answers: { salary_expectation: 'CHF 80k' },
    documents: {
      school_reports: { files: [
        { key: `assisted-application-uploads/${ORDER_ID}/doc-1.pdf`, name: 'a.pdf', detectedType: 'pdf' },
        { key: `assisted-application-uploads/${ORDER_ID}/doc-2.jpg`, name: 'b.jpg', detectedType: 'jpg' },
        // Never a key outside the order's folder.
        { key: 'assisted-application-uploads/other_order/doc.pdf', name: 'c.pdf', detectedType: 'pdf' },
      ] },
      eva_test: { files: [], waivedAt: 1 },
    },
  };
  async function documentsBucket() {
    const bucket = fakeBucket();
    await bucket.file(baseDraft.coverLetterPdfKey).save(Buffer.from('%PDF-1.4 letter'));
    await bucket.file(`assisted-application-uploads/${ORDER_ID}/doc-1.pdf`).save(Buffer.from('%PDF-1.4 report 1'));
    await bucket.file(`assisted-application-uploads/${ORDER_ID}/doc-2.jpg`).save(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    await bucket.file('assisted-application-uploads/other_order/doc.pdf').save(Buffer.from('%PDF-1.4 not ours'));
    return bucket;
  }

  it('attaches the documents the posting requires, as the candidate gave them, to the e-mail', async () => {
    const bucket = await documentsBucket();
    const sendCascade = vi.fn(async () => ({ failed: [], sent: [{ provider: 'resend', messageId: 'm1' }] }));
    await submitApplication({
      order, orderId: ORDER_ID, flow: documentsFlow, draft: withDocuments(baseDraft), cvBuffer: cvPdf(), cvType: 'pdf',
      bucket, runKey: KEY, sendCascade, resolve: publicDns, fetchImpl: fakeFetch(), log: quiet,
    });
    const [[items]] = sendCascade.mock.calls as any;
    expect(items[0].payload.attachments.map((item: any) => item.filename)).toEqual([
      'CV_Maria_Rossi.pdf', 'Lettera_di_presentazione_Maria_Rossi.pdf',
      'Bulletins_des_trois_dernieres_annees_1_Maria_Rossi.pdf', 'Bulletins_des_trois_dernieres_annees_2_Maria_Rossi.jpg',
    ]);
    expect(Buffer.from(items[0].payload.attachments[2].content, 'base64').toString()).toBe('%PDF-1.4 report 1');
  });

  it('gives the portal planner the requested documents by slot, with their files', async () => {
    const bucket = await documentsBucket();
    const portalDraft = withDocuments({ ...baseDraft, channel: { type: 'lever', applyUrl: 'https://jobs.lever.co/ospedale/1/apply' } });
    let seen: any = null;
    const runner = vi.fn(async (ctx: any) => {
      const { readFile } = await import('node:fs/promises');
      seen = { files: ctx.files, extra: ctx.candidate.documents.extra, first: (await readFile(ctx.files.extra_1[0])).toString() };
      return { event: { type: 'submit_handoff', reason: 'captcha' }, evidence: { steps: [] } };
    });
    await submitApplication({
      order, orderId: ORDER_ID, draft: portalDraft, cvBuffer: cvPdf(), cvType: 'pdf', flow: documentsFlow,
      bucket, runKey: KEY, sendCascade: vi.fn(), resolve: publicDns, fetchImpl: fakeFetch(), log: quiet, codex: vi.fn(), portalRunner: runner,
    });
    expect(seen.extra).toEqual([{ slot: 'extra_1', label: 'Bulletins des trois dernières années', kind: 'school_report' }]);
    expect(seen.files.extra_1).toHaveLength(2);
    expect(seen.files.extra_2).toBeUndefined();
    expect(seen.first).toBe('%PDF-1.4 report 1');
  });

  it('submits on a portal once, resumes a run that died before the click, never one that died after it', async () => {
    const bucket = fakeBucket();
    await bucket.file(baseDraft.coverLetterPdfKey).save(Buffer.from('%PDF-1.4 letter'));
    const portalDraft = { ...baseDraft, channel: { type: 'lever', applyUrl: 'https://jobs.lever.co/ospedale/1/apply' } };
    const submit = (db: any, portalRunner: any) => submitApplication({
      order, orderId: ORDER_ID, flow: { answers: { salary_expectation: 'CHF 80k' } }, draft: portalDraft, cvBuffer: cvPdf(), cvType: 'pdf',
      bucket, runKey: KEY, sendCascade: vi.fn(), resolve: publicDns, fetchImpl: fakeFetch(), log: quiet,
      codex: vi.fn(), portalRunner, submissionGuard: submissionGuard(db, ORDER_ID, 1),
    });
    const sent = createMemoryFirestore();
    const clicksAndSends = vi.fn(async (ctx: any) => { await ctx.onBeforeSubmit(); return { event: { type: 'submit_succeeded', channel: 'portal' }, evidence: { steps: [] } }; });
    expect(await submit(sent.db, clicksAndSends)).toMatchObject({ type: 'submit_succeeded', channel: 'lever' });
    expect(await submit(sent.db, clicksAndSends)).toEqual({ type: 'submit_succeeded', channel: 'lever', replayed: true });
    expect(clicksAndSends).toHaveBeenCalledTimes(1);

    // Died after pressing submit: the outcome is unknown, the retry does not press it again.
    const afterClick = createMemoryFirestore();
    await expect(submit(afterClick.db, async (ctx: any) => { await ctx.onBeforeSubmit(); throw new Error('browser crashed'); })).rejects.toThrow('browser crashed');
    const neverAgain = vi.fn();
    expect(await submit(afterClick.db, neverAgain)).toEqual({ type: 'submit_failed', error: 'portal_ambiguous' });
    expect(neverAgain).not.toHaveBeenCalled();

    // Died while filling the form: nothing reached the employer, the retry starts again.
    const beforeClick = createMemoryFirestore();
    await expect(submit(beforeClick.db, async () => { throw new Error('browser crashed'); })).rejects.toThrow('browser crashed');
    const given = [{ question: 'Vorname', answer: 'Maria', source: 'identity' }];
    const again = vi.fn(async () => ({ event: { type: 'submit_handoff', reason: 'captcha' }, evidence: { steps: [], answers: given } }));
    // What went into the form travels next to the event, for the draft (agent.mjs), never inside it.
    expect(await submit(beforeClick.db, again)).toEqual({ type: 'submit_handoff', reason: 'captcha', portalAnswers: { status: 'submit_handoff', at: expect.any(Number), answers: given } });
    expect(again).toHaveBeenCalledTimes(1);
    expect(beforeClick.read(`assisted_applications/${ORDER_ID}/automation/submission`)).toMatchObject({ r1: { state: 'failed', reason: 'captcha' } });

    // An error before the click (here the cover letter cannot be read): released, the retry claims it again.
    const storageDown = createMemoryFirestore();
    const brokenBucket = { file: () => ({ download: async () => { throw new Error('storage_down'); }, save: async () => {} }) };
    const neverRun = vi.fn();
    await expect(submitApplication({
      order, orderId: ORDER_ID, flow: { answers: { salary_expectation: 'CHF 80k' } }, draft: portalDraft, cvBuffer: cvPdf(), cvType: 'pdf',
      bucket: brokenBucket, runKey: KEY, sendCascade: vi.fn(), resolve: publicDns, fetchImpl: fakeFetch(), log: quiet,
      codex: vi.fn(), portalRunner: neverRun, submissionGuard: submissionGuard(storageDown.db, ORDER_ID, 1),
    })).rejects.toThrow('storage_down');
    expect(neverRun).not.toHaveBeenCalled();
    expect(storageDown.read(`assisted_applications/${ORDER_ID}/automation/submission`)).toMatchObject({ r1: { state: 'failed', reason: 'error: storage_down' } });
    expect(await submissionGuard(storageDown.db, ORDER_ID, 1).claim('portal', Date.now(), { resumable: true })).toMatchObject({ status: 'claimed', resumed: false });

    // The temporary folder cannot be created: released too, nothing was clicked.
    const noTmp = createMemoryFirestore();
    const previousTmp = process.env.TMPDIR;
    process.env.TMPDIR = '/nonexistent-aa-portal-tmp';
    try {
      await expect(submit(noTmp.db, neverRun)).rejects.toThrow();
    } finally {
      if (previousTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmp;
    }
    expect(neverRun).not.toHaveBeenCalled();
    expect(noTmp.read(`assisted_applications/${ORDER_ID}/automation/submission`)).toMatchObject({ r1: { state: 'failed' } });
    expect(await submissionGuard(noTmp.db, ORDER_ID, 1).claim('portal', Date.now(), { resumable: true })).toMatchObject({ status: 'claimed' });

    // A CAPTCHA that shows up after the final click: the portal may have the
    // application, so the claim stays "sending" and no later run presses it again.
    const captchaAfterClick = createMemoryFirestore();
    const clicksThenCaptcha = async (ctx: any) => { await ctx.onBeforeSubmit(); return { event: { type: 'submit_handoff', reason: 'captcha' }, evidence: { steps: [] } }; };
    expect(await submit(captchaAfterClick.db, clicksThenCaptcha)).toMatchObject({ type: 'submit_handoff', reason: 'captcha' });
    expect(captchaAfterClick.read(`assisted_applications/${ORDER_ID}/automation/submission`)).toMatchObject({ r1: { state: 'sending' } });
    expect(await submissionGuard(captchaAfterClick.db, ORDER_ID, 1).claim('portal', Date.now(), { resumable: true })).toMatchObject({ status: 'in_flight' });
    const notAgain = vi.fn();
    expect(await submit(captchaAfterClick.db, notAgain)).toEqual({ type: 'submit_failed', error: 'portal_ambiguous' });
    expect(notAgain).not.toHaveBeenCalled();

    // The portal said in words, after the click, that it did not send (JOIN
    // «Non siamo riusciti a inviare…»): released, Valerie's retry claims it again.
    const refusedAfterClick = createMemoryFirestore();
    const clicksThenRefused = async (ctx: any) => { await ctx.onBeforeSubmit(); return { event: { type: 'submit_failed', error: 'portal_refused' }, evidence: { steps: [], antibot: true } }; };
    expect(await submit(refusedAfterClick.db, clicksThenRefused)).toMatchObject({ type: 'submit_failed', error: 'portal_refused' });
    expect(refusedAfterClick.read(`assisted_applications/${ORDER_ID}/automation/submission`)).toMatchObject({ r1: { state: 'failed', reason: 'portal_refused' } });
    expect(await submissionGuard(refusedAfterClick.db, ORDER_ID, 1).claim('portal', Date.now(), { resumable: true })).toMatchObject({ status: 'claimed' });

    // Coop's SuccessFactors, 2026-10-03: «Bewerben» answered with the portal's own
    // validation, then questions for the candidate: nothing left, released.
    const validationAfterClick = createMemoryFirestore();
    const clicksThenValidation = async (ctx: any) => { await ctx.onBeforeSubmit(); return { event: { type: 'submit_needs_candidate', questions: [{ question: 'Strasse und Hausnummer', type: 'text' }] }, evidence: { steps: [], finalOutcomes: ['validation'] } }; };
    expect(await submit(validationAfterClick.db, clicksThenValidation)).toMatchObject({ type: 'submit_needs_candidate' });
    expect(validationAfterClick.read(`assisted_applications/${ORDER_ID}/automation/submission`)).toMatchObject({ r1: { state: 'failed', reason: 'portal_validation' } });
    expect(await submissionGuard(validationAfterClick.db, ORDER_ID, 1).claim('portal', Date.now(), { resumable: true })).toMatchObject({ status: 'claimed' });
    // A validation, then a click whose outcome is unknown: kept "sending".
    const validationThenUnknown = createMemoryFirestore();
    const clicksTwice = async (ctx: any) => { await ctx.onBeforeSubmit(); return { event: { type: 'submit_failed', error: 'portal_ambiguous' }, evidence: { steps: [], finalOutcomes: ['validation', 'ambiguous'] } }; };
    expect(await submit(validationThenUnknown.db, clicksTwice)).toMatchObject({ type: 'submit_failed', error: 'portal_ambiguous' });
    expect(validationThenUnknown.read(`assisted_applications/${ORDER_ID}/automation/submission`)).toMatchObject({ r1: { state: 'sending' } });
  });

  it('sends an application once per order and round, whatever the watchdog re-dispatches', async () => {
    const store = createMemoryFirestore();
    const bucket = fakeBucket();
    await bucket.file(baseDraft.coverLetterPdfKey).save(Buffer.from('%PDF-1.4 letter'));
    const sendCascade = vi.fn(async () => ({ failed: [], sent: [{ provider: 'resend', messageId: 'm1' }] }));
    const run = () => submitApplication({
      order, orderId: ORDER_ID, flow: { answers: { salary_expectation: 'CHF 80k' } }, draft: baseDraft, cvBuffer: cvPdf(), cvType: 'pdf',
      bucket, runKey: KEY, sendCascade, resolve: publicDns, fetchImpl: fakeFetch(), log: quiet,
      submissionGuard: submissionGuard(store.db, ORDER_ID, 1),
    });
    expect(await run()).toMatchObject({ type: 'submit_succeeded', channel: 'email' });
    // The first run sent it, then died before its event: the retry does not send again.
    // The replay still hands over what the follow-ups need, from the record of the first send.
    expect(await run()).toMatchObject({ type: 'submit_succeeded', channel: 'email', replayed: true, followup: { to: 'hr@ospedale.ch', subject: 'Candidatura' } });
    expect(sendCascade).toHaveBeenCalledTimes(1);
    expect(store.read(`assisted_applications/${ORDER_ID}/automation/submission`)).toMatchObject({ r1: { state: 'sent', channel: 'email', to: 'hr@ospedale.ch' } });

    // A send cut off half-way (claimed, never marked): its outcome is unknown, never re-sent.
    const other = createMemoryFirestore();
    await submissionGuard(other.db, ORDER_ID, 1).claim('email', 1);
    const ambiguous = await submitApplication({
      order, orderId: ORDER_ID, flow: { answers: { salary_expectation: 'CHF 80k' } }, draft: baseDraft, cvBuffer: cvPdf(), cvType: 'pdf',
      bucket, runKey: KEY, sendCascade, resolve: publicDns, fetchImpl: fakeFetch(), log: quiet,
      submissionGuard: submissionGuard(other.db, ORDER_ID, 1),
    });
    expect(ambiguous).toEqual({ type: 'submit_failed', error: 'email_ambiguous' });
    expect(sendCascade).toHaveBeenCalledTimes(1);
  });

  // Close-out of 2026-10-03: the gate is run again at submit with the code of the day. A draft that was
  // clean under a looser gate (here: «45» backed by the phone number of the CV) must not be trapped.
  it('stops a send the fact gate no longer passes, with what it found for the draft, until the owner confirms', async () => {
    const bucket = fakeBucket();
    await bucket.file(baseDraft.coverLetterPdfKey).save(Buffer.from('%PDF-1.4 letter'));
    const sendCascade = vi.fn(async () => ({ failed: [], sent: [{ provider: 'resend', messageId: 'm1' }] }));
    const submit = (draft: any) => submitApplication({
      order, orderId: ORDER_ID, flow: { answers: { salary_expectation: 'CHF 80k' } }, draft, cvBuffer: cvPdf(), cvType: 'pdf',
      bucket, runKey: KEY, sendCascade, resolve: publicDns, fetchImpl: fakeFetch(), log: quiet,
    });
    const draft = {
      ...baseDraft,
      coverLetter: { text: 'Gentili Signori,\n\nHo guidato un team di 45 persone.\n\nSaluti' },
      factCheck: { ok: true, unsupported: [], advisories: [], basis: 'pdf_text' },
    };
    expect(evaluateRedFlags(draft).owner).toEqual([]);
    const stopped: any = await submit(draft);
    expect(stopped).toMatchObject({ type: 'submit_failed', error: 'fact_check_not_acknowledged', factCheck: { ok: false } });
    expect(stopped.factCheck.unsupported).toEqual([expect.objectContaining({ field: 'coverLetter', kind: 'number', token: '45' })]);
    expect(sendCascade).not.toHaveBeenCalled();

    // agent.mjs: the result goes on the draft with the basis of its own check; the event carries no token.
    const patch = takeFactCheck(stopped, draft);
    expect(stopped).toEqual({ type: 'submit_failed', error: 'fact_check_not_acknowledged' });
    expect(patch).toEqual({ factCheck: { ok: false, unsupported: [expect.objectContaining({ kind: 'number', token: '45' })], advisories: expect.any(Array), basis: 'pdf_text' } });
    expect(takeFactCheck({ type: 'submit_succeeded', channel: 'email' }, draft)).toBeNull();
    // With it the owner's panel lists the tokens and the flow holds on them.
    const stored = { ...draft, ...patch };
    expect(evaluateRedFlags(stored).owner).toEqual(['fact_check']);

    // The two readers of the acknowledgement agree: the queue's tick, or the flag by name.
    for (const acknowledgement of [{ factCheckAcknowledgedAt: 1 }, { acknowledgedFlags: { fact_check: 1 } }]) {
      expect(evaluateRedFlags({ ...stored, ...acknowledgement }).owner).toEqual([]);
      expect(await submit({ ...stored, ...acknowledgement })).toMatchObject({ type: 'submit_succeeded', channel: 'email' });
    }
    expect(await submit({ ...stored, acknowledgedFlags: { no_posting: 1 } })).toMatchObject({ type: 'submit_failed', error: 'fact_check_not_acknowledged' });
    expect(sendCascade).toHaveBeenCalledTimes(2);
  });

  // The e-mail leaves with the candidate's signature: the phone of the order, as the order writes it.
  // Its digits back no figure of the letter, and are no figure themselves when the gate runs at submit.
  it('sends an e-mail signed with a phone number written without the country prefix', async () => {
    const national = { ...order, applicantPhone: '079 123 45 67' };
    const bucket = fakeBucket();
    const draft = await buildDraft({
      order: national, orderId: ORDER_ID, flow: { round: 1, answers: {} }, previousDraft: null, cvBuffer: cvPdf(), cvType: 'pdf',
      codex: fakeCodex(), bucket, runKey: KEY, resolve: publicDns, fetchImpl: fakeFetch(), nowMs: Date.UTC(2026, 8, 30), log: quiet,
    } as any);
    expect(draft.applicationEmail.body.endsWith('Maria Rossi\nmaria.rossi@example.com\n079 123 45 67')).toBe(true);
    expect(draft.factSources.order).toContain('079 123 45 67');
    const sendCascade = vi.fn(async () => ({ failed: [], sent: [{ provider: 'resend', messageId: 'm1' }] }));
    const event = await submitApplication({
      order: national, orderId: ORDER_ID, flow: { answers: { salary_expectation: 'CHF 80k' } }, cvBuffer: cvPdf(), cvType: 'pdf',
      // The same draft, by e-mail, without the «7 anni» the model invented.
      draft: {
        ...draft,
        channel: { type: 'email', email: 'hr@ospedale.ch', applyUrl: '' },
        applicationEmail: { ...draft.applicationEmail, to: 'hr@ospedale.ch' },
        coverLetter: { ...draft.coverLetter, paragraphs: draft.coverLetter.paragraphs.slice(0, 1), text: draft.coverLetter.text.replace('\n\nHo 7 anni di esperienza.', '') },
      },
      bucket, runKey: KEY, sendCascade, resolve: publicDns, fetchImpl: fakeFetch(), log: quiet,
    });
    expect(event).toMatchObject({ type: 'submit_succeeded', channel: 'email' });
    expect((sendCascade.mock.calls as any)[0][0][0].payload.text).toContain('079 123 45 67');
  });

  it('never sends with an open required question, and hands portals over to the candidate', async () => {
    expect(openRequiredQuestions(baseDraft, {})).toHaveLength(1);
    const blocked = await submitApplication({
      order, orderId: ORDER_ID, flow: { answers: {} }, draft: baseDraft, cvBuffer: cvPdf(), cvType: 'pdf',
      bucket: fakeBucket(), runKey: KEY, sendCascade: vi.fn(), resolve: publicDns, fetchImpl: fakeFetch(), log: quiet,
    });
    expect(blocked).toEqual({ type: 'submit_needs_candidate', questions: [{ id: 'salary_expectation' }], documents: [] });
    const handoff = await submitApplication({
      order, orderId: ORDER_ID, flow: { answers: { salary_expectation: 'CHF 80k' } },
      draft: { ...baseDraft, channel: { type: 'lever', applyUrl: 'https://jobs.lever.co/ospedale/1/apply' } },
      cvBuffer: cvPdf(), cvType: 'pdf', bucket: fakeBucket(), runKey: KEY, sendCascade: vi.fn(), resolve: publicDns, fetchImpl: fakeFetch(), log: quiet,
    });
    expect(handoff).toEqual({ type: 'submit_handoff', reason: 'portal_needs_candidate' });
  });
});

describe('career-ops liveness', () => {
  it('reads closure banners in Italian, German, French and English', () => {
    for (const text of [
      'Ci dispiace, questo annuncio non è più disponibile.',
      'Diese Stelle ist leider nicht mehr verfügbar.',
      'Cette offre n’est plus disponible.',
      'This job is no longer available.',
      'Die Bewerbungsfrist ist abgelaufen.',
    ]) {
      expect(classifyLiveness({ status: 200, bodyText: `${text} ${'x '.repeat(200)}` })).toMatchObject({ result: 'expired', code: 'expired_body' });
    }
    expect(classifyLiveness({ status: 200, bodyText: 'y '.repeat(200), applyControls: ['Jetzt bewerben'] })).toMatchObject({ result: 'active' });
  });

  it('refunds only on unambiguous closure', () => {
    expect(isHardClosed({ result: 'expired', code: 'http_gone' })).toBe(true);
    expect(isHardClosed({ result: 'expired', code: 'insufficient_content' }, { datasetGone: true })).toBe(false);
    expect(isHardClosed({ result: 'expired', code: 'listing_page' }, { datasetGone: true })).toBe(true);
    expect(isHardClosed({ result: 'uncertain', code: 'bot_challenge' }, { datasetGone: true })).toBe(false);
  });
});

describe('personal data in a public run', () => {
  it('masks values and their variants, never a line break', () => {
    const lines: string[] = [];
    const count = maskValues([['Maria Rossi', '+41 79 123 45 67'], 'x', 'a\nb'], (line) => lines.push(line));
    expect(lines).toContain('::add-mask::Maria Rossi\n');
    expect(lines).toContain('::add-mask::Rossi\n');
    expect(lines).toContain('::add-mask::41791234567\n');
    expect(lines.some((line) => line.includes('a\nb'))).toBe(false);
    expect(count).toBe(lines.length);
  });

  it('encrypts evidence with authenticated encryption', () => {
    const envelope = encryptJson({ secret: 'CV' }, KEY);
    expect(decryptJson(envelope, KEY)).toEqual({ secret: 'CV' });
    expect(() => decryptJson({ ...envelope, data: Buffer.from('tampered').toString('base64') }, KEY)).toThrow();
    expect(() => decryptJson(envelope, Buffer.alloc(32, 1))).toThrow();
  });

  it('keeps addresses and phone numbers out of error codes', () => {
    expect(safeErrorCode(new Error('failed for maria.rossi@example.com at +41 79 123 45 67'))).toBe('failed for <email> at <number>');
  });
});
