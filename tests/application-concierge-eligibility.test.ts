import { Timestamp } from 'firebase-admin/firestore';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../functions/src/remoteConfigSecrets.js', () => ({ getRemoteConfigValue: vi.fn(async () => '') }));
vi.mock('../functions/src/geminiGenerate.js', () => ({ generateServerText: vi.fn() }));
const { generateServerText } = await import('../functions/src/geminiGenerate.js');
vi.mock('../functions/src/assistedApplicationAiDocuments.js', () => ({ extractCvText: vi.fn() }));
const { extractCvText } = await import('../functions/src/assistedApplicationAiDocuments.js');
const { evaluateConciergePosting, prepareConciergeEligibility, preflightExistingCvEligibility, vettedConciergeDraftInputs } = await import('../functions/src/applicationConciergeEligibility.js');
const { conciergeProposalEligibility, fitNoticeOf } = await import('../functions/src/assistedApplicationFitNotice.js');
const { PROFILE_SYSTEM_PROMPT, REQUIREMENTS_SYSTEM_PROMPT } = await import('../functions/src/assistedApplicationAiPrompts.js');
const { EVIDENCE_ENTAILMENT_SYSTEM_PROMPT } = await import('../functions/src/lib/qualificationEvidence.js');
import { qualificationEvidenceCases } from './fixtures/qualification-evidence-cases.mjs';

const requirements = { requirements: [{ requirement: 'Tedesco fluente', importance: 'critical', basis: 'stated', quote: 'Fluent German required' }] };
const rawProfile = { fullName: 'Candidate Example', languages: [{ language: 'English', level: 'B2' }, { language: 'French', level: 'B2' }], languagesExplicitList: true, experience: [] };
function fixture(match: any) {
  vi.mocked(extractCvText).mockResolvedValue('Candidate Example\nIT Manager, Example Systems\nLanguages: English B2, French B2\nInfrastructure management and operations experience.');
  const records = new Map<string, any>();
  function ref(path: string): any {
    return { path, id: path.split('/').at(-1), get: async () => ({ exists: records.has(path), data: () => records.get(path) }),
      set: async (value: any, options?: any) => { records.set(path, options?.merge ? { ...records.get(path), ...value } : value); }, collection: (name: string) => ({ doc: (id: string) => ref(`${path}/${name}/${id}`) }) };
  }
  const serviceRef = ref('application_concierge_services/service');
  const service = { userId: 'candidate', cvStorageKey: 'application-concierge-uploads/service/cv.pdf', locale: 'it',
    paymentStatus: 'paid', serviceStatus: 'active', expiresAt: Date.now() + 30 * 86400000, maxPositions: 10, acceptedPositionsCount: 0 };
  records.set('application_concierge_services/service', service);
  records.set('user_cv_profiles/candidate', {});
  const bytes = Buffer.from('%PDF-1.7 test CV');
  const bucket: any = { file: () => ({ getMetadata: async () => [{ size: bytes.length }], download: async () => [bytes] }) };
  const generate = vi.fn(async (system: string, user: string, _schema: any, _options?: any) => system === PROFILE_SYSTEM_PROMPT ? rawProfile
    : system === REQUIREMENTS_SYSTEM_PROMPT ? requirements : system === EVIDENCE_ENTAILMENT_SYSTEM_PROMPT ? supportedEvidence(user) : match);
  const readPosting = vi.fn(async () => ({ text: `Fluent German required. ${'IT operations and infrastructure. '.repeat(400)}`, source: 'job_detail', textTruncated: false }));
  const db: any = { collection: (name: string) => ({ doc: (id: string) => ref(`${name}/${id}`) }),
    runTransaction: (callback: any) => callback({ get: (target: any) => target.get(), set: (target: any, value: any, options?: any) => target.set(value, options) }) };
  return { records, serviceRef, service, bytes, bucket, generate, readPosting, db };
}

function supportedEvidence(user: string) {
  return { assessments: JSON.parse(user).claims.map((claim: any) => ({ index: claim.index, proofId: claim.proof.id,
    verdict: 'supported', reason: 'explicit_fact' })) };
}

describe('qualification before proposal publication', () => {
  it('preserves actual SDK Timestamp semantics before snapshotting service sources', async () => {
    const f = fixture({ matches: [{ index: 0, status: 'missing', evidence: '' }], verdict: 'poor', questions: [] });
    const uploadedAt = Date.now() - 1000;
    Object.assign(f.service, { cvUploadedAt: Timestamp.fromMillis(uploadedAt), expiresAt: Timestamp.fromMillis(Date.now() + 30 * 86400000) });
    const check = await prepareConciergeEligibility({ ...f, profileRecord: {} });
    const job = { id: 'sdk-timestamp', url: 'https://example.test/jobs/sdk-timestamp/' };
    const first = await check(job);
    expect(first.status).toBe('incompatible');
    const calls = f.generate.mock.calls.length;
    expect((await check(job)).status).toBe('incompatible');
    expect(f.generate.mock.calls).toHaveLength(calls);
    f.records.get('application_concierge_services/service').cvUploadedAt = Timestamp.fromMillis(uploadedAt + 1);
    expect(await check(job)).toMatchObject({ status: 'unverified', reason: 'evidence_source_changed' });
  });

  it.each(['service_notes', 'cv_key', 'profile_cv', 'answer_pointer', 'service_expiry', 'position_cap'])('does not cache an assessment when %s changes during inference', async mutation => {
    const f = fixture({ matches: [{ index: 0, status: 'missing', evidence: '' }], verdict: 'poor', questions: [] });
    const original = f.generate.getMockImplementation()!;
    f.generate.mockImplementation(async (system, user, schema, options) => {
      const response = await original(system, user, schema, options);
      if (system === REQUIREMENTS_SYSTEM_PROMPT) {
        const current = f.records.get('application_concierge_services/service');
        if (mutation === 'service_notes') current.candidateNotes = 'Correction: my current language level is A2.';
        if (mutation === 'cv_key') current.cvStorageKey = 'application-concierge-uploads/service/replacement.pdf';
        if (mutation === 'service_expiry') current.expiresAt = Date.now() - 1;
        if (mutation === 'position_cap') current.acceptedPositionsCount = 10;
        const profile = f.records.get('user_cv_profiles/candidate');
        if (mutation === 'profile_cv') profile.profile = { searchText: 'Replacement CV' };
        if (mutation === 'answer_pointer') profile.applicationQuestionAnswersUpdatedAt = Date.now();
      }
      return response;
    });
    const check = await prepareConciergeEligibility({ ...f, profileRecord: {} });
    expect(await check({ id: 'race', url: 'https://example.test/jobs/race/' })).toMatchObject({ status: 'unverified', reason: 'evidence_source_changed' });
    expect([...f.records.keys()].filter(key => key.includes('/eligibility/job-'))).toEqual([]);
  });
  it('keeps the publication capability private and revalidates cached facts', async () => {
    const f = fixture({ matches: [{ index: 0, status: 'missing', evidence: '' }], verdict: 'poor', questions: [] });
    const check = await prepareConciergeEligibility({ ...f, profileRecord: {} });
    const job = { id: 'private-capability', url: 'https://example.test/jobs/private-capability/' };
    const result = await check(job);
    expect(typeof result.publicationGuard.assertInTransaction).toBe('function');
    expect(JSON.stringify(result)).not.toContain('publicationGuard');
    f.records.get('user_cv_profiles/candidate').applicationQuestionAnswersUpdatedAt = Date.now();
    expect(await check(job)).toMatchObject({ status: 'unverified', reason: 'evidence_source_changed' });
  });

  it('invalidates a cached assessment when only service candidate notes change', async () => {
    const f = fixture({ matches: [{ index: 0, status: 'missing', evidence: '' }], verdict: 'poor', questions: [] });
    const job = { id: 'notes-cache', url: 'https://example.test/jobs/notes-cache/' };
    const before = await (await prepareConciergeEligibility({ ...f, profileRecord: {} }))(job);
    const priorCalls = f.generate.mock.calls.length;
    const service = { ...f.service, candidateNotes: 'Correction: I do not hold the required degree.' };
    f.records.set('application_concierge_services/service', service);
    const after = await (await prepareConciergeEligibility({ ...f, service, profileRecord: {} }))(job);
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(f.generate.mock.calls.length).toBeGreaterThan(priorCalls);
  });
  it('allows all three bounded primary/fallback attempts without the long-running Codex rung', async () => {
    const match = { matches: [{ index: 0, status: 'missing', evidence: '' }], verdict: 'poor', questions: [] };
    const f = fixture(match);
    vi.mocked(generateServerText).mockImplementation(async ({ systemPrompt }: any) => ({ status: 200, body: {
      ok: true, provider: 'test', text: JSON.stringify(systemPrompt.startsWith(PROFILE_SYSTEM_PROMPT) ? rawProfile : systemPrompt.startsWith(REQUIREMENTS_SYSTEM_PROMPT) ? requirements : match),
    } }));
    const { generate: _unused, ...input } = f;
    const check = await prepareConciergeEligibility({ ...input, profileRecord: {}, background: true });
    await check({ id: 'job', title: 'IT Lead', company: 'Example' });
    expect(generateServerText).toHaveBeenCalledTimes(3);
    for (const [options] of vi.mocked(generateServerText).mock.calls) expect(options).toMatchObject({ maxProviderAttempts: 3, allowCodexFallback: false, maxTokens: 8192, background: true });
  });

  it('defers cancellation without publishing or caching a late posting read', async () => {
    const f = fixture({ matches: [], verdict: 'strong' });
    const controller = new AbortController();
    let release!: (value: any) => void;
    f.readPosting.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const check = await prepareConciergeEligibility({ ...f, profileRecord: {}, signal: controller.signal });
    const result = check({ id: 'cancelled', url: 'https://example.test/jobs/cancelled/' });
    const failure = expect(result).rejects.toThrow('matching deadline');
    controller.abort(new Error('matching deadline'));
    await failure;
    release({ text: 'IT operations experience. '.repeat(100), textTruncated: false });
    await Promise.resolve();
    expect([...f.records.keys()].filter(key => key.includes('/eligibility/job-'))).toEqual([]);
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(await check({ id: 'next' })).toEqual({ status: 'unverified', reason: 'analysis_deferred' });
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
  it.each([
    ['Verhandlungssichere Deutschkenntnisse erforderlich', 'Deutsch'],
    ['Fliessende Deutschkenntnisse erforderlich', 'Deutsch'],
    ['Muttersprachliche Deutschkenntnisse erforderlich', 'Deutsch'],
    ['Verhandlungssichere Deutschkenntnisse erforderlich', 'de-CH'],
  ])('uses the quoted language metadata for inflected requirement %s (%s)', (quote, language) => {
    const rows = { requirements: [{ requirement: 'Tedesco', importance: 'critical', basis: 'stated', quote }],
      languageRequirements: [{ language, level: '', quote }] };
    const profile = { languages: [{ language: 'German', level: 'A2' }, { language: 'English', level: 'C1' }] };
    expect(conciergeProposalEligibility(rows, { matches: [{ index: 0, status: 'met', evidence: 'English C1' }], verdict: 'good' }, { profile }).status).toBe('incompatible');
  });
  it('does not use evidence in a different language when the quoted level is not a known minimum', () => {
    const quote = 'Gute Deutschkenntnisse erforderlich';
    const rows = { requirements: [{ requirement: 'Tedesco', importance: 'high', basis: 'stated', quote }],
      languageRequirements: [{ language: 'Deutsch', level: 'gut', quote }] };
    expect(conciergeProposalEligibility(rows, { matches: [{ index: 0, status: 'met', evidence: 'English C1' }], verdict: 'good' },
      { profile: { languages: [{ language: 'German', level: 'A2' }] } })).toMatchObject({ status: 'unverified', reason: 'evidence_incomplete', gaps: [] });
  });
  it('retries a language clause omitted from numbered requirements instead of publishing or caching it', async () => {
    const f = fixture({ matches: [{ index: 0, status: 'met', evidence: 'IT Manager' }], verdict: 'strong' });
    const omitted = { requirements: [{ requirement: 'IT experience', importance: 'high', basis: 'stated', quote: 'IT operations' }],
      languageRequirements: [{ language: 'German', level: 'fluent', quote: 'Fluent German required' }] };
    f.generate.mockImplementation(async system => system === PROFILE_SYSTEM_PROMPT ? rawProfile : system === REQUIREMENTS_SYSTEM_PROMPT ? omitted : { matches: [{ index: 0, status: 'met', evidence: 'IT Manager' }], verdict: 'strong' });
    const check = await prepareConciergeEligibility({ ...f, profileRecord: {} });
    for (let retry = 0; retry < 2; retry++) expect(await check({ id: 'omitted-language' }))
      .toMatchObject({ status: 'unverified', reason: 'requirements_incomplete', gaps: [] });
    expect([...f.records.keys()].filter(key => key.includes('/eligibility/job-'))).toEqual([]);
    expect(f.generate.mock.calls.filter(([system]) => system === REQUIREMENTS_SYSTEM_PROMPT)).toHaveLength(2);
  });
  it('accepts an optional language without positive evidence', () => {
    const quote = 'French is a plus';
    const rows = { requirements: [{ requirement: quote, importance: 'preferred', basis: 'stated', quote }],
      languageRequirements: [{ language: 'French', level: '', quote }] };
    expect(conciergeProposalEligibility(rows, { matches: [{ index: 0, status: 'missing', evidence: '' }], verdict: 'good' }).status).toBe('compatible');
  });
  it('does not satisfy fluent German AND English with English evidence while German is A2', () => {
    const quote = 'Fluent German and English required';
    const rows = { requirements: [{ requirement: quote, importance: 'critical', basis: 'stated', quote }],
      languageRequirements: [{ language: 'German', level: 'fluent', quote }, { language: 'English', level: 'fluent', quote }] };
    const profile = { languages: [{ language: 'German', level: 'A2' }, { language: 'English', level: 'C1' }] };
    expect(conciergeProposalEligibility(rows, { matches: [{ index: 0, status: 'met', evidence: 'English C1' }], verdict: 'good' }, { profile }))
      .toMatchObject({ status: 'incompatible', gaps: [expect.objectContaining({ knownMissing: true })] });
  });
  it('accepts fluent German OR French when only French C1 is proven', () => {
    const quote = 'Fluent German or French required';
    const rows = { requirements: [{ requirement: quote, importance: 'critical', basis: 'stated', quote }],
      languageRequirements: [{ language: 'German', level: 'fluent', quote }, { language: 'French', level: 'fluent', quote }] };
    const profile = { languagesExplicitList: true, languages: [{ language: 'French', level: 'C1' }] };
    expect(conciergeProposalEligibility(rows, { matches: [{ index: 0, status: 'met', evidence: 'French C1' }], verdict: 'good' }, { profile }).status).toBe('compatible');
  });
  it.each(['Strong German & English communication', 'German C1 and English B2 required', 'Native German and fluent English required', 'Fluent German and English B2 required', 'German C1 and working knowledge of English required', 'German C1 and basic English required', 'Fluent German and basic English required', 'Fluent German / English required', 'Fluent German and English or French required'])('keeps ambiguous language clause %s a technical failure without inventing a gap', quote => {
    const rows = { requirements: [{ requirement: quote, importance: 'high', basis: 'stated', quote }],
      languageRequirements: [{ language: 'German', level: '', quote }] };
    const profile = { languages: [{ language: 'English', level: 'C1' }] };
    expect(conciergeProposalEligibility(rows, { matches: [{ index: 0, status: 'met', evidence: 'English C1' }], verdict: 'good' }, { profile }))
      .toMatchObject({ status: 'unverified', reason: 'language_clause_unverified', gaps: [] });
  });
  it('does not accept a short language quote as coverage of a longer combined clause', () => {
    const incomplete = { requirements: [{ requirement: 'German', importance: 'high', basis: 'stated', quote: 'German' }],
      languageRequirements: [{ language: 'German', level: '', quote: 'Strong German and English communication skills' }] };
    expect(conciergeProposalEligibility(incomplete, { matches: [{ index: 0, status: 'met', evidence: 'German C2' }], verdict: 'good' }))
      .toMatchObject({ status: 'unverified', reason: 'requirements_incomplete', gaps: [] });
  });
  it('keeps an empty partial mobility citation a technical failure before and after the guard', async () => {
    const { guardMobilityMatch } = await import('../functions/src/lib/mobilityRequirements.js');
    const rows = { requirements: [{ requirement: 'Residenza in Svizzera', importance: 'critical', basis: 'stated', quote: 'Residence in Switzerland required' }] };
    const match = { matches: [{ index: 0, status: 'partial', evidence: '' }], verdict: 'good', questions: [] };
    const guarded = guardMobilityMatch(rows, match, { profile: {}, sourceText: 'Experienced candidate without residence evidence.' });
    expect(guarded.matches[0]).toMatchObject({ status: 'partial', evidence: '', evidenceUnverified: true });
    expect(guarded.questions).toEqual([]);
    expect(conciergeProposalEligibility(rows, guarded)).toMatchObject({ status: 'unverified', reason: 'evidence_incomplete', gaps: [] });
  });
  it('does not convert a geographic reference into a language requirement', () => {
    const geographic = { requirements: [{ requirement: 'Office location', importance: 'critical', basis: 'stated', quote: 'Office in the German-speaking part of Switzerland' }] };
    expect(conciergeProposalEligibility(geographic, { matches: [{ index: 0, status: 'met', evidence: 'English B2' }], verdict: 'strong' }, { profile: rawProfile }).status).toBe('compatible');
  });
  it('retries unverified evidence as a technical failure without caching a false candidate clarification', async () => {
    const f = fixture({ matches: [{ index: 0, status: 'met', evidence: 'German C2' }], verdict: 'good', questions: [] });
    f.generate.mockImplementation(async system => system === PROFILE_SYSTEM_PROMPT ? { ...rawProfile, languages: [], languagesExplicitList: false } : system === REQUIREMENTS_SYSTEM_PROMPT ? requirements : { matches: [{ index: 0, status: 'met', evidence: 'German C2' }], verdict: 'good', questions: [] });
    const check = await prepareConciergeEligibility({ ...f, profileRecord: {} });
    const job = { id: 'it-lead', title: 'IT Manager', company: 'Example' };
    expect(await check(job)).toMatchObject({ status: 'unverified', reason: 'evidence_incomplete' });
    expect(await check(job)).toMatchObject({ status: 'unverified', reason: 'evidence_incomplete' });
    expect([...f.records.keys()].filter(key => key.includes('/eligibility/job-'))).toEqual([]);
    expect(f.generate.mock.calls.filter(([system]) => system === REQUIREMENTS_SYSTEM_PROMPT)).toHaveLength(2);
  });
  it('does not truncate a long posting into a compatible proposal', async () => {
    const f = fixture({ matches: [], verdict: 'strong' });
    f.readPosting.mockResolvedValue({ text: 'Posting text '.repeat(100), textTruncated: true, source: 'job_detail' });
    const check = await prepareConciergeEligibility({ ...f, profileRecord: {} });
    expect(await check({ id: 'long-posting' })).toMatchObject({ status: 'unverified', reason: 'posting_incomplete' });
    expect(f.generate).toHaveBeenCalledTimes(1);
  });
  it('rejects an HTML response cut before conversion even when its visible prefix fits the posting budget', async () => {
    const { fetchJobPosting } = await import('../functions/src/assistedApplicationAiJob.js');
    const prefix = `<p>${'IT operations and infrastructure experience. '.repeat(20)}</p>`;
    const html = `${prefix}<!--${' '.repeat(1_500_000)}--><p>Critical licence required at the end.</p>`;
    const read = (page: string) => fetchJobPosting({ jobUrl: 'https://example.test/role' }, {
      maxPostingChars: 30_000,
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      fetchImpl: async () => new Response(page, { headers: { 'content-type': 'text/html' } }),
    });
    const posting = await read(html);
    expect(posting.text.length).toBeLessThan(30_000);
    expect(posting.text).not.toContain('Critical licence');
    expect(posting.textTruncated).toBe(true);
    expect((await read(prefix)).textTruncated).toBe(false);
    const f = fixture({ matches: [], verdict: 'strong' });
    f.readPosting.mockResolvedValue(posting);
    const check = await prepareConciergeEligibility({ ...f, profileRecord: {} });
    expect(await check({ id: 'oversized-html' })).toMatchObject({ status: 'unverified', reason: 'posting_incomplete' });
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
    f.generate.mockImplementation(async (system, user) => system === PROFILE_SYSTEM_PROMPT ? rawProfile : system === REQUIREMENTS_SYSTEM_PROMPT ? required
      : system === EVIDENCE_ENTAILMENT_SYSTEM_PROMPT ? supportedEvidence(user) : { matches: [{ index: 0, status: 'met', evidence: 'English B2' }], verdict: 'strong', questions: [] });
    f.readPosting.mockResolvedValue({ text: `English B2 ${'IT operations and infrastructure. '.repeat(20)}`, textTruncated: false, source: 'job_detail' });
    const check = await prepareConciergeEligibility({ ...f, profileRecord: {} });
    const job = { id: 'job', title: 'IT Manager', company: 'Example' };
    const result = await check(job);
    expect(result.status).toBe('compatible');
    await check(job);
    expect(f.generate).toHaveBeenCalledTimes(4);
    f.records.get(`application_concierge_services/service/eligibility/${result.cacheId}`).version = 'full-posting-requirements-v3-source-citations-v1';
    await check(job);
    expect(f.generate).toHaveBeenCalledTimes(7);
    f.records.set('application_concierge_services/service/proposals/proposal', { eligibilityCacheId: result.cacheId, eligibilityFingerprint: result.fingerprint });
    const order = { userId: 'candidate', parentServiceId: 'service', parentProposalId: 'proposal' };
    const input = { db: f.db, order, cvBuffer: f.bytes, postingText: (await f.readPosting()).text };
    expect(await vettedConciergeDraftInputs(input)).toMatchObject({ result: { status: 'compatible' } });
    const cached = f.records.get(`application_concierge_services/service/eligibility/${result.cacheId}`);
    const witness = cached.entailment;
    cached.entailment = undefined;
    expect(await vettedConciergeDraftInputs(input)).toBeNull();
    cached.entailment = witness;
    const oldRequirements = cached.requirements; const oldMatch = cached.match;
    cached.requirements = { ...oldRequirements, requirements: [...oldRequirements.requirements,
      { requirement: 'Analytical work', importance: 'meaningful', basis: 'stated', quote: 'Analytical work' }] };
    cached.match = { ...oldMatch, matches: [...oldMatch.matches, { index: 1, status: 'met', evidence: 'Chronology only' }] };
    expect(await vettedConciergeDraftInputs(input)).toBeNull();
    cached.requirements = oldRequirements; cached.match = oldMatch;
    expect(await vettedConciergeDraftInputs({ ...input, cvBuffer: Buffer.from('different CV') })).toBeNull();
    expect(await vettedConciergeDraftInputs({ ...input, postingText: `${input.postingText} changed` })).toBeNull();
    f.records.set('user_cv_profiles/candidate', { applicationQuestionAnswers: { language_en_any_proficiency: 'C1' } });
    expect(await vettedConciergeDraftInputs(input)).toBeNull();
  });
  it('requires all decisive rows and source-grounded positive evidence', () => {
    expect(conciergeProposalEligibility(requirements, { matches: [], verdict: 'good' })).toMatchObject({ status: 'unverified', reason: 'evidence_incomplete' });
    expect(conciergeProposalEligibility(requirements, { matches: [{ index: 0, status: 'met', evidence: '' }], verdict: 'good' })).toMatchObject({ status: 'unverified', reason: 'evidence_incomplete' });
    expect(conciergeProposalEligibility({ requirements: [] }, { matches: [], verdict: 'strong' }).status).toBe('unverified');
  });
  it('resolves source evidence IDs to the original CV before caching a verified positive', async () => {
    const f = fixture(null);
    f.readPosting.mockResolvedValue({ text: `English B2 required. ${'IT management duties. '.repeat(20)}`, textTruncated: false, source: 'job_detail' });
    f.generate.mockImplementation(async (system, user, schema) => {
      if (system === PROFILE_SYSTEM_PROMPT) return rawProfile;
      if (system === REQUIREMENTS_SYSTEM_PROMPT) return { requirements: [{ requirement: 'English B2', importance: 'critical', basis: 'stated', quote: 'English B2 required' }] };
      if (system === EVIDENCE_ENTAILMENT_SYSTEM_PROMPT) return supportedEvidence(user);
      const payload = JSON.parse(user.split('\n\n<<<POSTING EXCERPT')[0]);
      const source = payload.candidateSourceExcerpts.find((item: any) => item.text.includes('English B2'));
      expect(schema.properties.matches.items.properties.evidence.enum).toContain(source.id);
      expect(payload.candidateSourceText).toBeUndefined();
      return { matches: [{ index: 0, status: 'met', evidence: source.id }], verdict: 'strong', questions: [] };
    });
    const check = await prepareConciergeEligibility({ ...f, profileRecord: {} });
    const result = await check({ id: 'source-job', title: 'IT Manager' });
    expect(result.status).toBe('compatible');
    const cached = f.records.get(`application_concierge_services/service/eligibility/${result.cacheId}`);
    expect(cached.match.matches[0]).toMatchObject({ evidence: 'Languages: English B2, French B2', evidenceUnverified: false });
  });
  it.each(qualificationEvidenceCases().filter(item => item.group === 'sgkb-negative'))('retries unsupported primary quotations through the real evaluator without caching a candidate gap: $name', async item => {
    const f = fixture(null);
    const degree = qualificationEvidenceCases().find(example => example.name === 'computer science degree');
    const cv = `Candidate Example\n${degree.evidence}\n${item.evidence}\nLanguages: English B2, French B2\nDocumented employment history.`;
    vi.mocked(extractCvText).mockResolvedValueOnce(cv);
    const requested = { requirements: [
      { requirement: degree.requirement, quote: degree.quote, importance: 'critical', basis: 'stated' },
      { requirement: item.requirement, quote: item.quote, importance: item.name.includes('chronology') ? 'meaningful' : 'high', basis: 'stated' },
    ] };
    f.readPosting.mockResolvedValue({ text: `${degree.quote}\n${item.quote}\n${'Position duties. '.repeat(20)}`, textTruncated: false, source: 'job_detail' });
    f.generate.mockImplementation(async (system, user) => {
      if (system === PROFILE_SYSTEM_PROMPT) return rawProfile;
      if (system === REQUIREMENTS_SYSTEM_PROMPT) return requested;
      if (system === EVIDENCE_ENTAILMENT_SYSTEM_PROMPT) return { assessments: JSON.parse(user).claims.map((claim: any) => ({
        index: claim.index, proofId: claim.proof.id, verdict: claim.index ? 'unsupported' : 'supported',
        reason: claim.index ? 'unrelated_evidence' : 'explicit_fact',
      })) };
      return { matches: [{ index: 0, status: 'met', evidence: degree.evidence }, { index: 1, status: 'met', evidence: item.evidence }],
        verdict: 'good', questions: [{ id: 'candidate_question', question: 'When are you available?', type: 'date', required: true }] };
    });
    const check = await prepareConciergeEligibility({ ...f, profileRecord: {} });
    for (let retry = 0; retry < 2; retry++) expect(await check({ id: 'unsupported', title: 'Example role' }))
      .toMatchObject({ status: 'unverified', reason: 'evidence_entailment_unverified', gaps: [], questions: [] });
    expect([...f.records.keys()].filter(key => key.includes('/eligibility/job-'))).toEqual([]);
    expect(f.generate.mock.calls.filter(([system]) => system === EVIDENCE_ENTAILMENT_SYSTEM_PROMPT)).toHaveLength(2);
  });
  it('preserves budget cancellation during the verifier instead of caching a retry or candidate gap', async () => {
    const f = fixture(null); const controller = new AbortController();
    let release!: (value: any) => void; let notify!: () => void;
    const started = new Promise<void>(resolve => { notify = resolve; });
    f.readPosting.mockResolvedValue({ text: `English B2 required. ${'IT management duties. '.repeat(20)}`, textTruncated: false, source: 'job_detail' });
    f.generate.mockImplementation(async system => {
      if (system === PROFILE_SYSTEM_PROMPT) return rawProfile;
      if (system === REQUIREMENTS_SYSTEM_PROMPT) return { requirements: [{ requirement: 'English B2', quote: 'English B2 required', importance: 'high', basis: 'stated' }] };
      if (system === EVIDENCE_ENTAILMENT_SYSTEM_PROMPT) { notify(); return new Promise(resolve => { release = resolve; }); }
      return { matches: [{ index: 0, status: 'met', evidence: 'English B2' }], verdict: 'good' };
    });
    const check = await prepareConciergeEligibility({ ...f, profileRecord: {}, signal: controller.signal });
    const pending = check({ id: 'deadline', title: 'IT Manager' });
    await started;
    const rejected = expect(pending).rejects.toThrow('matching deadline');
    controller.abort(new Error('matching deadline'));
    await rejected;
    release({ assessments: [] }); await Promise.resolve();
    expect([...f.records.keys()].filter(key => key.includes('/eligibility/job-'))).toEqual([]);
  });
  it('does not cache invented posting quotes as missing candidate qualifications', async () => {
    const f = fixture({ matches: [{ index: 0, status: 'met', evidence: 'English B2' }], verdict: 'strong' });
    f.generate.mockImplementation(async system => system === PROFILE_SYSTEM_PROMPT ? rawProfile : system === REQUIREMENTS_SYSTEM_PROMPT
      ? { requirements: [{ requirement: 'English B2', importance: 'critical', basis: 'stated', quote: 'An invented requirement quote' }] }
      : { matches: [{ index: 0, status: 'met', evidence: 'English B2' }], verdict: 'strong' });
    const check = await prepareConciergeEligibility({ ...f, profileRecord: {} });
    expect(await check({ id: 'bad-quote' })).toMatchObject({ status: 'unverified', reason: 'evidence_incomplete' });
    expect([...f.records.keys()].filter(key => key.includes('/eligibility/job-'))).toEqual([]);
  });
  it('uses a ready private CV projection for the single-checkout preflight', async () => {
    const f = fixture({ matches: [{ index: 0, status: 'missing', evidence: 'English' }], verdict: 'poor', questions: [] });
    f.records.set('user_cv_profiles/candidate', {
      status: 'ready',
      profile: { languages: ['English'], languagesExplicitList: true },
    });
    const result = await preflightExistingCvEligibility({
      db: f.db,
      userId: 'candidate',
      job: { id: 'job', url: 'https://example.test/job', title: 'IT Manager', company: 'Example' },
      generate: f.generate,
      readPosting: f.readPosting,
    });
    expect(result).toMatchObject({ status: 'incompatible', gaps: [{ status: 'missing' }] });
    expect(result.gaps[0]).not.toHaveProperty('profile');
  });
  it('keeps a missing or unreadable projection unknown instead of blocking payment', async () => {
    const f = fixture({ matches: [{ index: 0, status: 'missing', evidence: '' }], verdict: 'poor', questions: [] });
    expect(await preflightExistingCvEligibility({
      db: f.db,
      userId: 'candidate',
      job: { id: 'job', url: 'https://example.test/job' },
      generate: f.generate,
      readPosting: f.readPosting,
    })).toEqual({ status: 'unverified', reason: 'profile_not_ready' });
    f.records.set('user_cv_profiles/candidate', { status: 'ready', profile: { extractedTextAvailable: false } });
    expect(await preflightExistingCvEligibility({
      db: f.db,
      userId: 'candidate',
      job: { id: 'job', url: 'https://example.test/job' },
      generate: f.generate,
      readPosting: f.readPosting,
    })).toEqual({ status: 'unverified', reason: 'profile_not_ready' });
  });
});


describe('retained clear metadata before known-missing language guards', () => {
  it.each(['de', 'fr'])('uses the verified sidecar for compound German captions (cleared %s)', async languageCode => {
    const quote = 'Verhandlungssichere Deutschkenntnisse erforderlich';
    const requirements = { requirements: [{ requirement: 'Deutschkenntnisse', quote, basis: 'stated', importance: 'high' }],
      languageRequirements: [{ language: 'de-CH', level: 'verhandlungssicher', quote }] };
    const generate = vi.fn(async (system: string) => system === REQUIREMENTS_SYSTEM_PROMPT ? requirements
      : { matches: [{ index: 0, status: 'met', evidence: '[[cv:0]]' }], verdict: 'good', questions: [] });
    const result = await evaluateConciergePosting({ job: { id: 'compound-language' }, profile: { languages: [{ language: 'de', level: 'A2' }], languagesExplicitList: true },
      sourceText: 'Current German A2', cvHash: 'a'.repeat(64), answerSourceConflicts: [{ key: `language_${languageCode}_any_proficiency`, property: 'language_proficiency',
        languageCode, scope: 'candidate', cvHash: 'a'.repeat(64), reason: 'explicit_clear', at: 1 }], generate,
      readPosting: async () => ({ text: quote + '. ' + 'Company and role duties. '.repeat(10), source: 'job_detail', textTruncated: false }) });
    if (languageCode === 'de') {
      expect(result).toMatchObject({ status: 'unverified', reason: 'answer_source_conflict', gaps: [], questions: [] });
      expect(generate).toHaveBeenCalledTimes(1);
    } else {
      expect(result.status).toBe('incompatible');
      expect(result.gaps).toEqual(expect.arrayContaining([expect.objectContaining({ knownMissing: true })]));
      expect(generate).toHaveBeenCalledTimes(2);
    }
  });
});
