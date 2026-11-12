import { describe, expect, it, vi } from 'vitest';

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({ getRemoteConfigValue: vi.fn(async () => '') }));

const { candidateWithEdits } = await import('../functions/src/assistedApplicationCandidateEdits.js');
const { candidateDocumentIdentity } = await import('../functions/src/assistedApplicationAiDraftCore.js');
const { withRegisteredCandidateEmail } = await import('../functions/src/assistedApplicationDocumentIdentity.js');
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
  it('prints applicantEmail before the account email, routing alias, or an older CV address', async () => {
    const flow = {};
    const orderWithAccountEmail = { ...order, documentAccountEmail: 'account@example.test' };
    const cv = tailoredCvDocumentFor({ order: orderWithAccountEmail, draft, flow });
    const letter = letterBlocksFor({ order: orderWithAccountEmail, orderId: 'order-1', draft, flow, nowMs: Date.UTC(2026, 10, 12) });

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

  it('uses the registered Firebase account email fetched for the order userId', async () => {
    const storedOrder = { userId: 'synthetic-user-id', applicantEmail: '', customerEmail: 'payer@example.test' };
    const auth = { getUser: vi.fn(async () => ({ email: 'account@example.test', emailVerified: true })) };
    const documentOrder = await withRegisteredCandidateEmail(storedOrder, { auth });

    expect(auth.getUser).toHaveBeenCalledWith('synthetic-user-id');
    expect(documentOrder).toEqual({ ...storedOrder, documentAccountEmail: 'account@example.test' });
    expect(storedOrder).not.toHaveProperty('documentAccountEmail');
    expect(candidateDocumentIdentity({ name: 'Test Candidate', email: '' }, documentOrder).email).toBe('account@example.test');

    const cv = tailoredCvDocumentFor({ order: documentOrder, draft, flow: {} });
    const letter = letterBlocksFor({ order: documentOrder, orderId: 'order-1', draft, flow: {}, nowMs: Date.UTC(2026, 10, 12) });
    expect(cv?.contact).toContain('account@example.test');
    expect(letter.senderLines).toContain('account@example.test');
    expect(cv?.contact).not.toContain(aliasEmail);
    expect(letter.senderLines).not.toContain(aliasEmail);
  });

  it('uses customerEmail when the Firebase account email cannot be read', async () => {
    const storedOrder = { userId: 'missing-user-id', customerEmail: 'payer@example.test' };
    const auth = { getUser: vi.fn(async () => { throw new Error('auth_user_not_found'); }) };
    const documentOrder = await withRegisteredCandidateEmail(storedOrder, { auth });

    expect(documentOrder).toBe(storedOrder);
    expect(candidateDocumentIdentity({ name: 'Test Candidate', email: aliasEmail }, documentOrder).email).toBe('payer@example.test');
  });

  it('uses customerEmail when the order has no registered user', async () => {
    const orderWithoutUser = { customerEmail: 'payer@example.test' };
    const auth = { getUser: vi.fn() };
    const documentOrder = await withRegisteredCandidateEmail(orderWithoutUser, { auth });

    expect(auth.getUser).not.toHaveBeenCalled();
    expect(candidateDocumentIdentity({ name: 'Test Candidate', email: '' }, documentOrder).email).toBe('payer@example.test');
  });

  it('uses the active alias only when applicant, account, and customer email are absent', () => {
    const aliasOrder = { candidateAlias: { active: true, address: aliasEmail } };
    expect(candidateDocumentIdentity({ name: 'Test Candidate', email: '' }, aliasOrder).email).toBe(aliasEmail);
  });

  it('does not throw when no email source or active alias exists', () => {
    expect(candidateDocumentIdentity(
      { name: 'Test Candidate', email: aliasEmail, phone: '' },
      { candidateAlias: { active: false, address: aliasEmail } },
    )).toEqual({ name: 'Test Candidate', email: '', phone: '' });
  });

  it('omits every e-mail row when no source or active alias is available, including the merged dossier', async () => {
    const noEmailOrder = { ...order, applicantEmail: '', documentAccountEmail: '', customerEmail: '', candidateAlias: { active: false, address: aliasEmail } };
    const flow = {};
    const cv = tailoredCvDocumentFor({ order: noEmailOrder, draft, flow });
    const letter = letterBlocksFor({ order: noEmailOrder, orderId: 'order-1', draft, flow, nowMs: Date.UTC(2026, 10, 12) });

    expect(candidateDocumentIdentity({ name: 'Test Candidate', email: aliasEmail, phone: '' }, noEmailOrder).email).toBe('');
    expect(cv?.contact.join(' ')).not.toMatch(/@|example\.test/i);
    expect(letter.senderLines.join(' ')).not.toMatch(/@|example\.test/i);

    const cvDocx = extractDocxText(renderCvDocx(cv!));
    const letterDocx = extractDocxText(renderLetterDocx(letter));
    const cvPdf = await renderCvPdf(cv!, { mode: 'legacy' });
    const letterPdf = await renderLetterPdf(letter, { mode: 'legacy' });
    const cvPdfText = await extractCvText(cvPdf.pdf, 'pdf');
    const letterPdfText = await extractCvText(letterPdf.pdf, 'pdf');
    const { dossierAttachment } = await import('../scripts/assisted-application/lib/dossier.mjs');
    const dossier = await dossierAttachment({
      language: 'it', stem: 'test-candidate', name: 'Test Candidate', letter: letterPdf.pdf,
      cv: { buffer: cvPdf.pdf, type: 'pdf', name: 'cv.pdf' }, nowMs: Date.UTC(2026, 10, 12),
    });
    expect(dossier.ok).toBe(true);
    const dossierText = await extractCvText(dossier.pdf, 'pdf');

    for (const text of [cvDocx, letterDocx, cvPdfText, letterPdfText, dossierText]) {
      expect(text).not.toMatch(/@|example\.test|\b(?:e-?mail|courriel)\s*:/i);
      expect(text).not.toContain(aliasEmail);
    }
  });
});
