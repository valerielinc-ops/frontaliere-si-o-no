import { describe, expect, it, vi } from 'vitest';

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({ getRemoteConfigValue: vi.fn(async () => '') }));

const { candidateWithEdits } = await import('../functions/src/assistedApplicationCandidateEdits.js');
const { candidateDocumentIdentity } = await import('../functions/src/assistedApplicationAiDraftCore.js');
const { letterBlocksFor } = await import('../functions/src/assistedApplicationLetterPdf.js');
const { tailoredCvDocumentFor } = await import('../functions/src/assistedApplicationTailoredCvPdf.js');
const { renderCvDocx, renderLetterDocx } = await import('../functions/src/assistedApplicationDocx.js');
const { extractCvText, extractDocxText } = await import('../functions/src/assistedApplicationAiDocuments.js');
const { renderCvPdf, renderLetterPdf } = await import('../functions/src/assistedApplicationPdfRenderer.js');

const applicantEmail = 'candidate@example.test';
const aliasEmail = 'routing@example.test';
const order = {
  applicantName: 'Test Candidate',
  applicantEmail,
  candidateAlias: { active: true, address: aliasEmail },
  companyName: 'Muster AG',
  jobTitle: 'Analista',
};
const draft = {
  status: 'ready',
  round: 1,
  language: 'it',
  job: { title: 'Analista' },
  profile: { fullName: 'Test Candidate', email: 'old-cv@example.test', experience: [], education: [] },
  coverLetter: {
    salutation: 'Gentili Signori',
    paragraphs: ['Mi candido per la posizione di Analista.'],
    closing: 'Cordiali saluti',
  },
  tailoredCv: {
    status: 'ready',
    cv: {
      type: 'qualified',
      sector: 'other',
      language: 'it',
      headline: 'Analista',
      summary: 'Professionista con esperienza.',
      competencies: [],
      experience: [],
      skills: [],
      localized: {},
    },
  },
};

describe('candidate e-mail in assisted-application documents', () => {
  it('prints the intake e-mail in the tailored CV and cover letter, not the routing alias or an older CV address', async () => {
    const flow = {};
    const cv = tailoredCvDocumentFor({ order, draft, flow });
    const letter = letterBlocksFor({ order, orderId: 'order-1', draft, flow, nowMs: Date.UTC(2026, 10, 12) });

    expect(cv?.contact).toContain(applicantEmail);
    expect(cv?.contact).not.toContain(aliasEmail);
    expect(cv?.contact).not.toContain('old-cv@example.test');
    expect(letter.senderLines).toContain(applicantEmail);
    expect(letter.senderLines).not.toContain(aliasEmail);
    expect(letter.senderLines).not.toContain('old-cv@example.test');

    expect(extractDocxText(renderCvDocx(cv!))).toContain(applicantEmail);
    expect(extractDocxText(renderLetterDocx(letter))).toContain(applicantEmail);
    const cvPdf = await renderCvPdf(cv!, { mode: 'legacy' });
    const letterPdf = await renderLetterPdf(letter, { mode: 'legacy' });
    expect(await extractCvText(cvPdf.pdf, 'pdf')).toContain(applicantEmail);
    expect(await extractCvText(letterPdf.pdf, 'pdf')).toContain(applicantEmail);
    // Portal fields and reply routing continue to use the active alias.
    expect(candidateWithEdits({ order, draft, flow }).identity.email).toBe(aliasEmail);
  });

  it('does not substitute a routing alias or checkout address when the candidate e-mail is unknown', () => {
    expect(() => candidateDocumentIdentity(
      { name: 'Test Candidate', email: aliasEmail, phone: '' },
      { candidateAlias: { active: true, address: aliasEmail }, customerEmail: 'payer@example.test' },
    )).toThrow('assisted_application_candidate_email_missing');
  });
});
