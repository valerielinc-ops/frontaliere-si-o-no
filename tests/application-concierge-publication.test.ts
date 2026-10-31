import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';
vi.mock('../functions/src/assistedApplicationAiDocuments.js', () => ({ extractCvText: async () => 'English C1. Infrastructure engineer with experience maintaining production platforms, application monitoring and incident coordination.' }));
import { prepareConciergeEligibility } from '../functions/src/applicationConciergeEligibility.js';
import { runApplicationConciergeMatching } from '../functions/src/applicationConciergeMatching.js';
import { PROFILE_SYSTEM_PROMPT, REQUIREMENTS_SYSTEM_PROMPT } from '../functions/src/assistedApplicationAiPrompts.js';
import { EVIDENCE_ENTAILMENT_SYSTEM_PROMPT } from '../functions/src/lib/qualificationEvidence.js';
afterEach(() => { vi.unstubAllGlobals(); });
const servicePath = 'application_concierge_services/publication-fixture';
const profilePath = 'user_cv_profiles/publication-candidate';
const now = Date.now();
function fixture() {
  const service = { userId: 'publication-candidate', cvStorageKey: 'application-concierge-uploads/publication-fixture/cv.pdf',
    cvUploadedAt: now - 1000, paidAt: now - 2000, expiresAt: now + 30 * 86400000,
    serviceStatus: 'active', paymentStatus: 'paid', acceptedPositionsCount: 0, maxPositions: 10, locale: 'en' };
  const profile = { status: 'ready', profile: { searchText: 'IT support infrastructure', workPosition: 'IT Support Manager', skills: ['IT', 'support'] } };
  const store = createMemoryFirestore({ [servicePath]: service, [profilePath]: profile });
  const bytes = Buffer.from('%PDF-1.7 synthetic original');
  const bucket = { file: () => ({ getMetadata: async () => [{ size: bytes.length }], download: async () => [bytes] }) };
  const generate = async (system: string, user: string) => {
    if (system === PROFILE_SYSTEM_PROMPT) return { languages: [{ language: 'en', level: 'C1' }], experience: [] };
    if (system === REQUIREMENTS_SYSTEM_PROMPT) return { requirements: [{ requirement: 'English C1', quote: 'English C1 is required.', basis: 'stated', importance: 'high' }] };
    if (system === EVIDENCE_ENTAILMENT_SYSTEM_PROMPT) return { assessments: JSON.parse(user).claims.map((claim: any) => ({
      index: claim.index, proofId: claim.proof.id, verdict: 'supported', reason: 'explicit_fact' })) };
    const payload = JSON.parse(user.split('\n\n<<<POSTING EXCERPT')[0]);
    return { matches: [{ index: 0, status: 'met', evidence: payload.candidateSourceExcerpts.find((source: any) => source.text.includes('English C1')).id }],
      verdict: 'good', questions: [] };
  };
  return { records: store.docs, db: store.db, input: { db: store.db,
    serviceRef: store.db.collection('application_concierge_services').doc('publication-fixture'),
    service: store.read(servicePath), profileRecord: profile, bucket, generate,
    readPosting: async () => ({ text: 'English C1 is required. ' + 'Maintain infrastructure platforms. '.repeat(10), source: 'job_detail', textTruncated: false }) } };
}


const job = { id: 'sdk-job', url: 'https://example.test/sdk-job/', title: 'IT Support Manager', description: 'IT support and infrastructure platform operations' };
describe('source authority at every positive proposal publication', () => {
  it.each(['new', 'proposed', 'retracted'])('fences source changes after inference for a %s proposal', async initial => {
    for (const mutation of ['none', 'notes', 'pointer', 'expiry', 'cap', 'missing_guard']) {
      const f = fixture(); const proposalPath = servicePath + '/proposals/old';
      if (initial !== 'new') f.records.set(proposalPath, { jobId: job.id, jobUrl: job.url, jobTitle: job.title, status: initial });
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [job] })));
      const check = await prepareConciergeEligibility(f.input);
      const eligibility = async (posting: any) => {
        const result = await check(posting); expect(result.status).toBe('compatible');
        const current = f.records.get(servicePath)!;
        if (mutation === 'notes') current.candidateNotes = 'Correction: English A2.';
        if (mutation === 'pointer') f.records.get(profilePath)!.applicationQuestionAnswersUpdatedAt = now;
        if (mutation === 'expiry') current.expiresAt = now - 1;
        if (mutation === 'cap') current.acceptedPositionsCount = 10;
        // A spread intentionally drops the private capability. A positive status alone is insufficient.
        return mutation === 'missing_guard' ? { ...result } : result;
      };
      expect((await runApplicationConciergeMatching({ db: f.db, serviceId: 'publication-fixture', jobIndexUrl: 'https://example.test/synthetic-index', eligibility })).status).toBe('complete');
      const proposed = [...f.records.entries()].filter(([key, value]) => key.startsWith(servicePath + '/proposals/') && value.status === 'proposed');
      expect(proposed).toHaveLength(mutation === 'none' ? 1 : 0);
      if (initial === 'proposed' && mutation !== 'none') expect(f.records.get(proposalPath)!.status).toBe('retracted');
    }
  });
});
