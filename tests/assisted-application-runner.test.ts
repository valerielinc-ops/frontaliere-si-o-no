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
import { safeErrorCode } from '../scripts/assisted-application/agent.mjs';

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
    expect(draft.questions).toEqual([expect.objectContaining({ id: 'salary_expectation', required: true, source: 'rule' })]);
    // "7 anni" is not in the CV: flagged for the operator.
    expect(draft.factCheck.unsupported.map((item: any) => item.token)).toEqual(['7']);
    expect(bucket.files.has(draft.coverLetterPdfKey)).toBe(true);
    const archive = JSON.parse(bucket.files.get(draft.archiveKey)!.toString('utf8'));
    expect(decryptJson(archive, KEY).postingText).toContain('Ospedale cerca');
    expect(draft.applicationEmail.body).toContain('Maria Rossi');
  });

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
  });

  it('never sends with an open required question, and hands portals over to the candidate', async () => {
    expect(openRequiredQuestions(baseDraft, {})).toHaveLength(1);
    const blocked = await submitApplication({
      order, orderId: ORDER_ID, flow: { answers: {} }, draft: baseDraft, cvBuffer: cvPdf(), cvType: 'pdf',
      bucket: fakeBucket(), runKey: KEY, sendCascade: vi.fn(), resolve: publicDns, fetchImpl: fakeFetch(), log: quiet,
    });
    expect(blocked).toEqual({ type: 'submit_needs_candidate', questions: [{ id: 'salary_expectation' }] });
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
