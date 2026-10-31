import { describe, expect, it, vi } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';
vi.mock('../functions/src/assistedApplicationPdfRenderer.js', () => ({
  pdfRendererMode: vi.fn(async () => 'legacy'),
  renderCvPdf: vi.fn(async () => ({ pdf: Buffer.from('%PDF-1.7 synthetic CV'), renderer: 'legacy', photo: false })),
  renderLetterPdf: vi.fn(async () => ({ pdf: Buffer.from('%PDF-1.7 synthetic letter'), renderer: 'legacy' })),
}));
import { renderCvPdf } from '../functions/src/assistedApplicationPdfRenderer.js';
import { handleAssistedApplicationReview } from '../functions/src/assistedApplicationReview.js';
import { mintReviewToken } from '../functions/src/assistedApplicationReviewToken.js';
import { rebuildTailoredCvPdf } from '../functions/src/assistedApplicationTailoredCvPdf.js';
import { rebuildCvToCommit } from '../functions/src/assistedApplicationCvCommit.js';
import { cleanupPendingArtifacts } from '../functions/src/lib/assistedApplicationArtifactRetention.js';
const now = Date.now(); const id = 'synthetic-review'; const base = `assisted_applications/${id}`; const secret = 'synthetic-signing-secret-not-production';
function fixture(acknowledged = false) {
  const order = { cvUploadedAt: now, paymentStatus: 'paid', applicantName: 'Synthetic Candidate' };
  const flow = { state: 'candidate_review', round: 1, answers: {}, documents: {} };
  const draft = { round: 1, status: 'ready', language: 'en', questions: [], profile: { fullName: 'Synthetic Candidate', experience: [], education: [], languages: [] },
    tailoredCv: { status: 'ready', pdfKey: `assisted-application-uploads/${id}/old.pdf`, cv: { language: 'en', headline: 'Engineer', competencies: [], skills: [], experience: [], education: [], languages: [] } },
    coverLetter: { text: 'Old synthetic letter.' }, requiredDocuments: [{ id: 'diploma', kind: 'diploma', label: 'Diploma', required: true, keywords: ['diploma'], quote: 'Diploma' }] };
  const f = createMemoryFirestore({ [base]: order, [`${base}/automation/flow`]: flow, [`${base}/ai_drafts/current`]: draft });
  const objects = new Map<string, any>(); const deletes: any[] = [];
  const bucket = { file: (key: string) => ({
    save: async (bytes: Buffer, options: any) => { objects.set(key, { bytes, options }); if (acknowledged) return; f.read(base).retentionPurgingAt = now; throw Object.assign(new Error('synthetic ACK lost'), { code: 'ETIMEDOUT' }); },
    getMetadata: async () => { if (!objects.has(key)) throw Object.assign(new Error('missing'), { code: 404 }); return [{ generation: '123', metadata: objects.get(key).options.metadata?.metadata || {} }]; },
    download: async () => [objects.get(key)?.bytes],
    delete: async (options: any) => { deletes.push(options); objects.delete(key); },
  }) };
  const token = mintReviewToken({ secret, orderId: id, round: 1, nowMs: now });
  const request = (body: any) => handleAssistedApplicationReview({ method: 'POST', body: { t: token, ...body } }, { db: f.db, bucket, getSecret: async () => secret, nowMs: now });
  return { ...f, order, flow, draft, bucket, objects, deletes, request };
}
async function assertOwnedPendingCleanup(f: ReturnType<typeof fixture>) {
  expect(f.objects.size).toBe(1);
  expect([...f.docs.keys()].filter(path => path.startsWith(`${base}/pending_artifacts/`))).toHaveLength(1);
  await cleanupPendingArtifacts({ db: f.db, bucket: f.bucket, orderRef: f.db.collection('assisted_applications').doc(id) });
  expect(f.objects.size).toBe(0); expect(f.deletes).toContainEqual({ ifGenerationMatch: '123', ignoreNotFound: true });
  expect(f.read(`${base}/automation/flow`).documents).toEqual({});
}
describe('all candidate artifact writers use the canonical upload reservation', () => {
  it.each(['document_upload', 'photo_upload', 'edit'])('keeps the acknowledged retained %s path usable', async action => {
    const f = fixture(true);
    const body = action === 'edit' ? { action, coverLetterText: 'Dear Sir or Madam,\n\n' + 'This is a synthetic candidate letter. '.repeat(8) + '\n\nKind regards' }
      : { action, documentId: 'diploma', fileName: 'synthetic.pdf', contentBase64: (action === 'photo_upload'
        ? Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]) : Buffer.from('%PDF-1.7 synthetic')).toString('base64') };
    await expect(f.request(body)).resolves.toMatchObject({ status: 200 });
    expect(f.objects.size).toBeGreaterThan(0);
    expect([...f.docs.keys()].filter(path => path.startsWith(`${base}/pending_artifacts/`))).toHaveLength(0);
    expect(f.read(base).artifactCleanupPending).toBe(false);
  });
  it.each(['document_upload', 'photo_upload', 'edit'])('retains ownership of an ACK-lost %s during purge', async action => {
    const f = fixture();
    const body = action === 'edit' ? { action, coverLetterText: 'Dear Sir or Madam,\n\n' + 'This is a synthetic candidate letter. '.repeat(8) + '\n\nKind regards' }
      : { action, documentId: 'diploma', fileName: 'synthetic.pdf', contentBase64: (action === 'photo_upload'
        ? Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]) : Buffer.from('%PDF-1.7 synthetic')).toString('base64') };
    await expect(f.request(body)).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    await assertOwnedPendingCleanup(f);
  });
  it('covers the actual tailored-PDF upload independently of the renderer', async () => {
    const f = fixture(); const draft = { ...f.draft, tailoredCv: { status: 'ready', cv: { language: 'en', headline: 'Engineer', competencies: [], skills: [], experience: [], education: [], languages: [] } } };
    await expect(rebuildTailoredCvPdf({ db: f.db, bucket: f.bucket, orderId: id, order: f.order, flow: f.flow, draft, nowMs: now })).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    await assertOwnedPendingCleanup(f);
  });
  it('refuses a purge that starts during PDF rendering before uploading or publishing a reference', async () => {
    const f = fixture(); const draft = { ...f.draft, tailoredCv: { status: 'ready', cv: { language: 'en', headline: 'Engineer', competencies: [], skills: [], experience: [], education: [], languages: [] } } };
    vi.mocked(renderCvPdf).mockImplementationOnce(async () => { f.read(base).retentionPurgingAt = now;
      return { pdf: Buffer.from('%PDF-1.7 synthetic'), renderer: 'legacy', photo: false }; });
    await expect(rebuildCvToCommit({ db: f.db, bucket: f.bucket, orderId: id, order: f.order, flow: f.flow, draft, nowMs: now })).rejects.toMatchObject({ code: 'changed_meanwhile', status: 409 });
    expect(f.objects.size).toBe(0);
    expect(f.read(`${base}/ai_drafts/current`).tailoredCv).toEqual(f.draft.tailoredCv);
  });
});
