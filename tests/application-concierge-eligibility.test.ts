import { describe, expect, it, vi } from 'vitest';
vi.mock('../functions/src/remoteConfigSecrets.js', () => ({ getRemoteConfigValue: vi.fn(async () => '') }));
vi.mock('../functions/src/geminiGenerate.js', () => ({ generateServerText: vi.fn() }));
const { generateServerText } = await import('../functions/src/geminiGenerate.js');
vi.mock('../functions/src/assistedApplicationAiDocuments.js', () => ({ extractCvText: vi.fn(async () => 'Candidate Example\nIT Manager, Example Systems\nLanguages: English B2, French B2\nInfrastructure management and operations experience.') }));
const { prepareConciergeEligibility, vettedConciergeDraftInputs } = await import('../functions/src/applicationConciergeEligibility.js');
const { conciergeProposalEligibility, fitNoticeOf } = await import('../functions/src/assistedApplicationFitNotice.js');
const { PROFILE_SYSTEM_PROMPT, REQUIREMENTS_SYSTEM_PROMPT } = await import('../functions/src/assistedApplicationAiPrompts.js');

const requirements = { requirements: [{ requirement: 'Tedesco fluente', importance: 'critical', basis: 'stated', quote: 'Fluent German required' }] };
const rawProfile = { fullName: 'Candidate Example', languages: [{ language: 'English', level: 'B2' }, { language: 'French', level: 'B2' }], languagesExplicitList: true, experience: [] };
function fixture(match: any) {
  const records = new Map<string, any>();
  function ref(path: string): any {
    return { id: path.split('/').at(-1), get: async () => ({ exists: records.has(path), data: () => records.get(path) }),
      set: async (value: any, options?: any) => { records.set(path, options?.merge ? { ...records.get(path), ...value } : value); }, collection: (name: string) => ({ doc: (id: string) => ref(`${path}/${name}/${id}`) }) };
  }
  const serviceRef = ref('application_concierge_services/service');
  const service = { userId: 'candidate', cvStorageKey: 'application-concierge-uploads/service/cv.pdf', locale: 'it' };
  records.set('application_concierge_services/service', service);
  records.set('user_cv_profiles/candidate', {});
  const bytes = Buffer.from('%PDF-1.7 test CV');
  const bucket: any = { file: () => ({ getMetadata: async () => [{ size: bytes.length }], download: async () => [bytes] }) };
  const generate = vi.fn(async (system: string, _user: string, _schema: any) => system === PROFILE_SYSTEM_PROMPT ? rawProfile : system === REQUIREMENTS_SYSTEM_PROMPT ? requirements : match);
  const readPosting = vi.fn(async () => ({ text: `Fluent German required. ${'IT operations and infrastructure. '.repeat(400)}`, source: 'job_detail', textTruncated: false }));
  const db: any = { collection: (name: string) => ({ doc: (id: string) => ref(`${name}/${id}`) }) };
  return { records, serviceRef, service, bytes, bucket, generate, readPosting, db };
}

describe('qualification before proposal publication', () => {
  it('allows all three bounded primary/fallback attempts without the long-running Codex rung', async () => {
    const match = { matches: [{ index: 0, status: 'missing', evidence: '' }], verdict: 'poor', questions: [] };
    const f = fixture(match);
    vi.mocked(generateServerText).mockImplementation(async ({ systemPrompt }: any) => ({ status: 200, body: {
      ok: true, provider: 'test', text: JSON.stringify(systemPrompt.startsWith(PROFILE_SYSTEM_PROMPT) ? rawProfile : systemPrompt.startsWith(REQUIREMENTS_SYSTEM_PROMPT) ? requirements : match),
    } }));
    const { generate: _unused, ...input } = f;
    const check = await prepareConciergeEligibility({ ...input, profileRecord: {} });
    await check({ id: 'job', title: 'IT Lead', company: 'Example' });
    expect(generateServerText).toHaveBeenCalledTimes(3);
    for (const [options] of vi.mocked(generateServerText).mock.calls) expect(options).toMatchObject({ maxProviderAttempts: 3, allowCodexFallback: false, maxTokens: 8192 });
  });

  it.each(['missing', 'partial'])('rejects title relevance when a decisive requirement is %s in both funnels', async status => {
    const match = { matches: [{ index: 0, status, evidence: 'Languages: English B2, French B2' }], verdict: 'poor', questions: [] };
    const f = fixture(match);
    const check = await prepareConciergeEligibility({ ...f, profileRecord: {} });
    const result = await check({ id: 'it-lead', title: 'IT Manager', company: 'Example', url: 'https://example.test/jobs/it/' });
    expect(result.status).toBe('incompatible');
    expect(fitNoticeOf({ ...match, requirements: requirements.requirements })).not.toBeNull();
    // The late requirement at >8,000 chars is preserved, unlike the old public generation endpoint cap.
    expect(f.generate.mock.calls[1][1].length).toBeGreaterThan(8000);
    expect(f.readPosting).toHaveBeenCalledWith(expect.anything(), { maxPostingChars: 30_000 });
  });
  it('does not accept evidence for another language even if the model says met', () => {
    const result = conciergeProposalEligibility(requirements, { matches: [{ index: 0, status: 'met', evidence: 'English B2' }], verdict: 'good' }, { profile: rawProfile });
    expect(result.status).toBe('incompatible');
    expect(result.gaps).toContainEqual(expect.objectContaining({ status: 'missing' }));
  });
  it('keeps a proven language shortfall incompatible even when the model already marked it partial', () => {
    const b2 = { requirements: [{ requirement: 'German B2', importance: 'critical', basis: 'stated', quote: 'Good German knowledge B2' }] };
    const profile = { languages: [{ language: 'German', level: 'A2' }] };
    const result = conciergeProposalEligibility(b2, { matches: [{ index: 0, status: 'partial', evidence: 'German A2' }], verdict: 'good' }, { profile });
    expect(result.status).toBe('incompatible');
    expect(result.gaps).toContainEqual(expect.objectContaining({ knownMissing: true }));
  });
  it('does not convert a geographic reference into a language requirement', () => {
    const geographic = { requirements: [{ requirement: 'Office location', importance: 'critical', basis: 'stated', quote: 'Office in the German-speaking part of Switzerland' }] };
    expect(conciergeProposalEligibility(geographic, { matches: [{ index: 0, status: 'met', evidence: 'English B2' }], verdict: 'strong' }, { profile: rawProfile }).status).toBe('compatible');
  });
  it('does not treat a silent CV or unverified evidence as a positive match', async () => {
    const f = fixture({ matches: [{ index: 0, status: 'met', evidence: 'German C2' }], verdict: 'good', questions: [] });
    f.generate.mockImplementation(async system => system === PROFILE_SYSTEM_PROMPT ? { ...rawProfile, languages: [], languagesExplicitList: false } : system === REQUIREMENTS_SYSTEM_PROMPT ? requirements : { matches: [{ index: 0, status: 'met', evidence: 'German C2' }], verdict: 'good', questions: [] });
    const check = await prepareConciergeEligibility({ ...f, profileRecord: {} });
    expect((await check({ id: 'it-lead', title: 'IT Manager', company: 'Example' })).status).toBe('clarification_required');
  });
  it('does not truncate a long posting into a compatible proposal', async () => {
    const f = fixture({ matches: [], verdict: 'strong' });
    f.readPosting.mockResolvedValue({ text: 'Posting text '.repeat(100), textTruncated: true, source: 'job_detail' });
    const check = await prepareConciergeEligibility({ ...f, profileRecord: {} });
    expect(await check({ id: 'long-posting' })).toMatchObject({ status: 'unverified', reason: 'posting_incomplete' });
    expect(f.generate).toHaveBeenCalledTimes(1);
  });
  it('normalizes indexed job fields and isolates cache entries and fingerprints by prompt metadata', async () => {
    const f = fixture({ matches: [], verdict: 'strong', questions: [] });
    const check = await prepareConciergeEligibility({ ...f, profileRecord: {} });
    f.readPosting.mockResolvedValue({ text: `Posting body ${'role details '.repeat(20)}`, textTruncated: false, source: 'job_detail', location: 'Locarno' });
    const first = await check({ jobId: 'job-a', jobUrl: 'https://example.test/a', jobTitle: 'Analyst', companyName: 'Alpha' });
    const second = await check({ jobId: 'job-b', jobUrl: 'https://example.test/b', jobTitle: 'Engineer', companyName: 'Beta', location: 'Lugano' });

    expect(f.readPosting).toHaveBeenNthCalledWith(1, { jobId: 'job-a', jobUrl: 'https://example.test/a' }, { maxPostingChars: 30_000 });
    expect(f.readPosting).toHaveBeenNthCalledWith(2, { jobId: 'job-b', jobUrl: 'https://example.test/b' }, { maxPostingChars: 30_000 });
    const requirementPrompts = f.generate.mock.calls.filter(([system]) => system === REQUIREMENTS_SYSTEM_PROMPT).map(([, prompt]) => prompt);
    expect(requirementPrompts[0]).toContain('Job title: Analyst\nCompany: Alpha\nLocation: Locarno');
    expect(requirementPrompts[1]).toContain('Job title: Engineer\nCompany: Beta\nLocation: Locarno');
    expect(first.cacheId).not.toBe(second.cacheId);
    expect(first.fingerprint).not.toBe(second.fingerprint);

    await check({ jobId: 'job-a', jobUrl: 'https://example.test/a', jobTitle: 'Changed title', companyName: 'Alpha' });
    expect(f.generate.mock.calls.filter(([system]) => system === REQUIREMENTS_SYSTEM_PROMPT)).toHaveLength(3);
  });
  it('reuses a verified positive only for identical CV, posting and answer memory', async () => {
    const f = fixture({ matches: [{ index: 0, status: 'met', evidence: 'English B2' }], verdict: 'strong', questions: [] });
    const required = { requirements: [{ requirement: 'English B2', importance: 'critical', basis: 'stated', quote: 'English B2' }] };
    f.generate.mockImplementation(async system => system === PROFILE_SYSTEM_PROMPT ? rawProfile : system === REQUIREMENTS_SYSTEM_PROMPT ? required : { matches: [{ index: 0, status: 'met', evidence: 'English B2' }], verdict: 'strong', questions: [] });
    f.readPosting.mockResolvedValue({ text: `English B2 ${'IT operations and infrastructure. '.repeat(20)}`, textTruncated: false, source: 'job_detail' });
    const check = await prepareConciergeEligibility({ ...f, profileRecord: {} });
    const job = { id: 'job', title: 'IT Manager', company: 'Example' };
    const result = await check(job);
    expect(result.status).toBe('compatible');
    await check(job);
    expect(f.generate).toHaveBeenCalledTimes(3);
    f.records.set('application_concierge_services/service/proposals/proposal', { eligibilityCacheId: result.cacheId, eligibilityFingerprint: result.fingerprint });
    const order = { userId: 'candidate', parentServiceId: 'service', parentProposalId: 'proposal' };
    const input = { db: f.db, order, cvBuffer: f.bytes, postingText: (await f.readPosting()).text };
    expect(await vettedConciergeDraftInputs(input)).toMatchObject({ result: { status: 'compatible' } });
    expect(await vettedConciergeDraftInputs({ ...input, cvBuffer: Buffer.from('different CV') })).toBeNull();
    expect(await vettedConciergeDraftInputs({ ...input, postingText: `${input.postingText} changed` })).toBeNull();
    f.records.set('user_cv_profiles/candidate', { applicationQuestionAnswers: { language_en_any_proficiency: 'C1' } });
    expect(await vettedConciergeDraftInputs(input)).toBeNull();
  });
  it('requires all decisive rows and source-grounded positive evidence', () => {
    expect(conciergeProposalEligibility(requirements, { matches: [], verdict: 'good' }).status).toBe('clarification_required');
    expect(conciergeProposalEligibility(requirements, { matches: [{ index: 0, status: 'met', evidence: '' }], verdict: 'good' }).status).toBe('clarification_required');
    expect(conciergeProposalEligibility({ requirements: [] }, { matches: [], verdict: 'strong' }).status).toBe('unverified');
  });
});
