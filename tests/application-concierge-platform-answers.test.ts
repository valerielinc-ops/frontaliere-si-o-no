import { describe, expect, it, vi } from 'vitest';

vi.mock('firebase-admin/firestore', () => {
  class DeleteTransform {}
  return {
    FieldValue: {
      delete: () => new DeleteTransform(),
      serverTimestamp: () => '__server_timestamp__',
      increment: (value: number) => ({ __increment: value }),
    },
    Timestamp: { now: () => new Date(), fromMillis: (value: number) => new Date(value) },
  };
});
vi.mock('../functions/src/remoteConfigSecrets.js', () => ({ getRemoteConfigValue: vi.fn(async () => '') }));
vi.mock('../functions/src/geminiGenerate.js', () => ({ generateServerText: vi.fn() }));
vi.mock('../functions/src/assistedApplicationAiDocuments.js', () => ({
  MAX_CV_SOURCE_BYTES: 12 * 1024 * 1024,
  extractCvText: vi.fn(async () => 'Candidate Example\nHR Administrator, Example Services SA, Lugano, 2019-2025\nPersonnel administration and onboarding for 300 employees.\nLanguages: Italian native, German B2, English C1'),
}));

const { prepareConciergeEligibility, vettedConciergeDraftInputs } = await import('../functions/src/applicationConciergeEligibility.js');
const {
  answerConciergeClarifications, conciergePlatformFacts, conciergePlatformInputs, platformAnswerInputs, platformQuestionShape,
} = await import('../functions/src/applicationConciergePlatformAnswers.js');
const { PROFILE_SYSTEM_PROMPT, REQUIREMENTS_SYSTEM_PROMPT } = await import('../functions/src/assistedApplicationAiPrompts.js');
const { decisionsSystemPrompt } = await import('../functions/src/assistedApplicationDecisionAnswers.js');
const { platformAnswerEvidenceSources } = await import('../functions/src/lib/sourceCitations.js');

const CV = 'Candidate Example\nHR Administrator, Example Services SA, Lugano, 2019-2025\nPersonnel administration and onboarding for 300 employees.\nLanguages: Italian native, German B2, English C1';
const SERVICE = {
  userId: 'candidate',
  cvStorageKey: 'application-concierge-uploads/service/cv.pdf',
  locale: 'it',
  applicantLocation: 'Como',
  candidateFacts: { workPermit: 'permit_g', passport: 'eu_efta', nationality: 'Italia' },
};
const PROFILE = {
  fullName: 'Candidate Example',
  languages: [{ language: 'Italiano', level: 'Madrelingua' }, { language: 'Tedesco', level: 'B2' }, { language: 'Inglese', level: 'C1' }],
  languagesExplicitList: true,
  experience: [{ role: 'HR Administrator', employer: 'Example Services SA', location: 'Lugano', start: '2019', end: '2025', kind: 'job', highlights: [] }],
};
const JOB = { id: 'payroll', title: 'Payroll Specialist', company: 'Example AG', url: 'https://example.test/jobs/payroll/', salaryMax: 92000, currency: 'CHF' };
const POSTING = `Payroll Specialist. Several years of payroll accounting experience required. ${'Personnel administration in a Swiss company. '.repeat(40)}`;
const REQUIREMENTS = { requirements: [{ requirement: 'Payroll accounting experience', sourceRequirement: 'Several years of payroll accounting experience required',
  importance: 'critical', basis: 'stated', quote: 'Several years of payroll accounting experience required' }] };

const permitQuestion = { id: 'work_permit', question: 'Qual è il tuo stato attuale del permesso di lavoro in Svizzera?', why: 'Diritto al lavoro.', type: 'text', options: [], required: true };
const startQuestion = { id: 'availability', question: 'Da quale data saresti disponibile a iniziare?', why: 'Data di inizio.', type: 'text', options: [], required: true };
const payrollQuestion = { id: 'payroll_experience', question: 'Hai diversi anni di esperienza nella contabilità salariale?', why: 'Requisito.', type: 'yes_no', options: [], required: true };
const diplomaQuestion = { id: 'payroll_diploma', question: 'Possiedi un diploma federale di specialista in contabilità salariale?', why: 'Requisito.', type: 'yes_no', options: [], required: true };
const recordQuestion = { id: 'record_copy', question: 'Puoi allegare una copia del casellario giudiziale?', why: 'Richiesto.', type: 'yes_no', options: [], required: true };

const gap = (questions: any[]) => ({ matches: [{ index: 0, status: 'missing', evidence: '' }], verdict: 'good', summaryIt: '', checksIt: [], questions });
const decisions = (items: any[]) => ({ decisions: items.map(item => ({ decision: 'answer', principle: 'plausible_deduction', category: '', evidence: [], reason: 'Plausible from the CV.', ...item })) });

function fixture({ firstMatch, secondMatch, decided = decisions([]), service = SERVICE }: any) {
  const records = new Map<string, any>();
  function ref(path: string): any {
    return { id: path.split('/').at(-1), get: async () => ({ exists: records.has(path), data: () => records.get(path) }),
      set: async (value: any, options?: any) => { records.set(path, options?.merge ? { ...records.get(path), ...value } : value); },
      collection: (name: string) => ({ doc: (id: string) => ref(`${path}/${name}/${id}`) }) };
  }
  const serviceRef = ref('application_concierge_services/service');
  records.set('application_concierge_services/service', { ...service });
  const bytes = Buffer.from('%PDF-1.7 synthetic CV');
  const bucket: any = { file: () => ({ getMetadata: async () => [{ size: bytes.length }], download: async () => [bytes] }) };
  let matchCalls = 0;
  const generate = vi.fn(async (system: string, _user: string, _schema: any) => {
    if (system === PROFILE_SYSTEM_PROMPT) return PROFILE;
    if (system === REQUIREMENTS_SYSTEM_PROMPT) return REQUIREMENTS;
    if (system === decisionsSystemPrompt()) return decided;
    matchCalls += 1;
    return typeof (matchCalls === 1 ? firstMatch : secondMatch) === 'function'
      ? (matchCalls === 1 ? firstMatch : secondMatch)(_user) : (matchCalls === 1 ? firstMatch : secondMatch);
  });
  const readPosting = vi.fn(async () => ({ text: POSTING, source: 'job_detail', textTruncated: false }));
  const db: any = {
    collection: (name: string) => ({ doc: (id: string) => ref(`${name}/${id}`) }),
    runTransaction: async (callback: (transaction: any) => Promise<unknown>) => callback({
      get: (documentRef: any) => documentRef.get(),
      set: (documentRef: any, value: any, options?: any) => documentRef.set(value, options),
    }),
  };
  return { records, serviceRef, service: { ...service }, bucket, generate, readPosting, db };
}

const cacheRow = (records: Map<string, any>) => [...records.entries()].find(([key]) => /\/eligibility\/job-[a-f0-9]{32}$/.test(key))?.[1];
const callsOf = (generate: any, system: string) => generate.mock.calls.filter(([prompt]: any[]) => prompt === system);

describe('the platform answers what the concierge eligibility check asks', () => {
  it('answers permit, start date, salary, workload, languages and availabilities by rule, without the model', async () => {
    const facts = conciergePlatformFacts({ service: SERVICE, profile: PROFILE, job: JOB });
    const generate = vi.fn();
    const result = await answerConciergeClarifications({ facts, generate, cvText: CV, locale: 'it', questions: [
      permitQuestion,
      startQuestion,
      { id: 'salary', question: 'Qual è la tua aspettativa salariale annua in CHF?', type: 'number', required: true },
      { id: 'german', question: 'Qual è il tuo livello di conoscenza della lingua tedesca?', type: 'text', required: true },
      { id: 'relocation', question: 'Sei disponibile a trasferirti a Zurigo?', type: 'yes_no', required: true },
      { id: 'hybrid', question: 'Sei disponibile a lavorare in modalità ibrida?', type: 'yes_no', required: true },
    ] });
    expect(generate).not.toHaveBeenCalled();
    expect(result.left).toEqual([]);
    const byId = Object.fromEntries(result.entries.map((entry: any) => [entry.questionId, entry.answer]));
    expect(byId.work_permit).toMatch(/\bG\b/);
    expect(byId.availability).toMatch(/^\d{2}\.\d{2}\.\d{4}$/);
    expect(byId.salary).toBe('92000');
    expect(byId.german).toBe('B2');
    expect(byId.relocation).toBe('Sì');
    expect(byId.hybrid).toBe('Sì');
    // The language answer also reaches the eligibility language rule.
    expect(platformAnswerInputs(result.entries, [{ id: 'german', question: 'Qual è il tuo livello di conoscenza della lingua tedesca?' }]).answers)
      .toMatchObject({ german: 'B2', language_de_any_proficiency: 'B2' });
  });

  it('uses a verified combined-passport answer and foreign permit for every passport form', async () => {
    const facts = conciergePlatformFacts({
      service: { ...SERVICE, candidateFacts: { workPermit: 'permit_g' } }, profile: {}, job: JOB,
    });
    const passportQuestions = [
      { id: 'passport_binary', question: 'Do you hold a Swiss/EU/EFTA passport?', type: 'yes_no', options: [], required: true },
      { id: 'passport_type_no_options', question: 'Type of valid passport', type: 'choice', options: [], required: true },
      { id: 'passport_type_select', question: 'Type of valid passport', type: 'choice', options: ['Swiss', 'EU/EFTA', 'Other'], required: true },
    ];
    const generate = vi.fn(async () => decisions([{ id: 'passport_binary', value: 'yes' }]));
    const result = await answerConciergeClarifications({ facts, generate, cvText: CV, locale: 'en', questions: passportQuestions });
    const byId = Object.fromEntries(result.entries.map((entry: any) => [entry.questionId, entry.answer]));

    expect(generate).toHaveBeenCalledTimes(1);
    expect(byId).toEqual({ passport_binary: 'Yes', passport_type_no_options: 'EU/EFTA', passport_type_select: 'EU/EFTA' });
    expect(result.left).toEqual([]);
    expect(result.decisions).toMatchObject({ passport_binary: expect.objectContaining({ value: 'yes' }) });
  });

  it('decides experience with the engine in one call and never says yes to a formal title the CV lacks', async () => {
    const facts = conciergePlatformFacts({ service: SERVICE, profile: PROFILE, job: JOB });
    const generate = vi.fn(async () => decisions([
      { id: 'payroll_experience', value: 'yes' },
      { id: 'payroll_diploma', value: 'yes' },
    ]));
    const result = await answerConciergeClarifications({ facts, generate, cvText: CV, locale: 'it', questions: [payrollQuestion, diplomaQuestion] });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ questionId: 'payroll_experience', answer: 'Sì', principle: 'plausible_deduction' }),
      expect.objectContaining({ questionId: 'payroll_diploma', answer: 'No', principle: 'cv_fact' }),
    ]));
    expect(result.refusals.map((entry: any) => entry.questionId)).toEqual(['payroll_diploma']);
  });

  it('leaves to the candidate only what is theirs, and never overrides their own answer', async () => {
    const facts = conciergePlatformFacts({ service: SERVICE, profile: PROFILE, job: JOB });
    const generate = vi.fn(async () => decisions([]));
    const result = await answerConciergeClarifications({ facts, generate, cvText: CV, locale: 'it',
      candidateAnswers: { work_permit: 'synthetic candidate answer' }, questions: [permitQuestion, recordQuestion] });
    expect(generate).not.toHaveBeenCalled();
    expect(result.entries).toEqual([]);
    expect(result.left.map((question: any) => question.id)).toEqual(['record_copy']);
  });

  it('shapes a free-text skill question as whether the candidate has it', () => {
    expect(platformQuestionShape({ id: 'sap', question: 'Qual è il tuo livello di conoscenza di SAP HCM?', type: 'text', required: true }))
      .toMatchObject({ type: 'yes_no', source: 'match' });
    expect(platformQuestionShape({ id: 'de', question: 'Qual è il tuo livello di tedesco?', type: 'text', required: true }))
      .toMatchObject({ type: 'choice', options: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'Madrelingua'] });
  });

  it('declares the platform as the source of its answers, never the candidate', () => {
    const sources = platformAnswerEvidenceSources({ provenance: 'platform', answers: [{ questionId: 'q', question: 'Q?', answer: 'Sì' }] });
    expect(Object.keys(sources)).toEqual(['platform_answers']);
    expect(sources.platform_answers).toContain('Platform answer on the candidate\'s behalf');
    expect(platformAnswerEvidenceSources({ provenance: 'candidate_confirmed', answers: [{ question: 'Q?', answer: 'Sì' }] })).toEqual({});
  });
});

describe('a concierge proposal never waits on a deducible question', () => {
  it('re-runs the match with the platform answers as cited evidence and publishes the compatible result', async () => {
    const f = fixture({
      firstMatch: gap([permitQuestion, payrollQuestion]),
      secondMatch: (user: string) => {
        const id = /\[\[platform_answers:\d+\]\]/.exec(user)?.[0] || '';
        return { matches: [{ index: 0, status: 'met', evidence: id }], verdict: 'good', summaryIt: '', checksIt: [], questions: [] };
      },
      decided: decisions([{ id: 'payroll_experience', value: 'yes' }]),
    });
    const check = await prepareConciergeEligibility({ ...f, profileRecord: {} });
    const result = await check(JOB);

    expect(result).toMatchObject({ status: 'compatible' });
    expect(result.platformAnswers).toEqual(expect.arrayContaining([
      expect.objectContaining({ questionId: 'work_permit', provenance: 'platform' }),
      expect.objectContaining({ questionId: 'payroll_experience', provenance: 'platform', principle: 'plausible_deduction' }),
    ]));
    expect(callsOf(f.generate, decisionsSystemPrompt())).toHaveLength(1);
    const cached = cacheRow(f.records);
    expect(cached).toMatchObject({ result: { status: 'compatible' }, platformAnswersHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(cached.match.matches[0].evidence).toContain('Platform answer on the candidate\'s behalf');

    // Cached: the same listing is not analysed again.
    const calls = f.generate.mock.calls.length;
    const again = await prepareConciergeEligibility({ ...f, profileRecord: {} });
    expect(await again(JOB)).toMatchObject({ status: 'compatible' });
    expect(f.generate.mock.calls.length).toBe(calls);
  });

  it('accepts a requirement the platform answered when the match asks it again, without a second model decision', async () => {
    // The second match asks again; the last one reads every platform answer as evidence (review of #18010).
    let later = 0;
    const f = fixture({
      firstMatch: gap([permitQuestion, payrollQuestion]),
      secondMatch: (user: string) => {
        later += 1;
        if (later === 1) return gap([{ ...payrollQuestion, id: 'payroll_years' }]);
        const id = /\[\[platform_answers:\d+\]\]/.exec(user)?.[0] || '';
        return { matches: [{ index: 0, status: 'met', evidence: id }], verdict: 'good', summaryIt: '', checksIt: [], questions: [] };
      },
      decided: decisions([{ id: 'payroll_experience', value: 'yes' }]),
    });
    const check = await prepareConciergeEligibility({ ...f, profileRecord: {} });
    const result = await check(JOB);
    expect(result).toMatchObject({ status: 'compatible' });
    expect(result.questions ?? []).toEqual([]);
    expect(later).toBe(2);
    expect(callsOf(f.generate, decisionsSystemPrompt())).toHaveLength(1);
    // The cached match is the final one, with the platform's answer as evidence, never the match that asked.
    expect(cacheRow(f.records).match.matches[0]).toMatchObject({ status: 'met' });
    expect(cacheRow(f.records).match.matches[0].evidence).toContain('Platform answer on the candidate\'s behalf');
  });

  it('keeps the platform fingerprint per listing: a new salary estimate is a new platform answer (review of #18010)', () => {
    const service = { candidateFacts: null, applicantLocation: 'Como', locale: 'it' };
    expect(conciergePlatformInputs(service, { salaryMax: 60000 })).not.toBe(conciergePlatformInputs(service, { salaryMax: 80000 }));
    expect(conciergePlatformInputs(service, { salaryMax: 60000 })).toBe(conciergePlatformInputs(service, { salaryMax: 60000 }));
  });

  it('treats a no to a formal title the CV lacks as a known gap, not a question', async () => {
    const f = fixture({ firstMatch: gap([diplomaQuestion]), secondMatch: gap([]), decided: decisions([{ id: 'payroll_diploma', value: 'yes' }]) });
    const check = await prepareConciergeEligibility({ ...f, profileRecord: {} });
    const result = await check(JOB);
    expect(result).toMatchObject({ status: 'incompatible', reason: 'platform_answer_requirement_missing', questions: [] });
    expect(result.gaps).toContainEqual(expect.objectContaining({ knownMissing: true, source: 'platform' }));
  });

  it('keeps for the candidate only the question nothing can answer', async () => {
    const f = fixture({
      firstMatch: gap([permitQuestion, recordQuestion]),
      secondMatch: gap([permitQuestion, recordQuestion]),
    });
    const check = await prepareConciergeEligibility({ ...f, profileRecord: {} });
    const result = await check(JOB);
    expect(result.status).toBe('clarification_required');
    expect(result.questions.map((question: any) => question.id)).toEqual(['record_copy']);
    expect(result.platformAnswers).toEqual([expect.objectContaining({ questionId: 'work_permit', provenance: 'platform' })]);
  });

  it('checks again a clarification cached before the platform answered it', async () => {
    const f = fixture({ firstMatch: gap([permitQuestion]), secondMatch: { matches: [{ index: 0, status: 'met', evidence: 'Personnel administration and onboarding for 300 employees.' }], verdict: 'good', summaryIt: '', checksIt: [], questions: [] } });
    const check = await prepareConciergeEligibility({ ...f, profileRecord: {} });
    await check(JOB);
    const [key, row] = [...f.records.entries()].find(([path]) => /\/eligibility\/job-[a-f0-9]{32}$/.test(path))!;
    // A row written by the previous code: the same clarification, no platform inputs in its fingerprint.
    f.records.set(key, { ...row, platformAnswersHash: '', fingerprint: 'f'.repeat(64), result: { status: 'clarification_required', gaps: [], questions: [permitQuestion] } });
    const calls = f.generate.mock.calls.length;
    const recheck = await prepareConciergeEligibility({ ...f, profileRecord: {} });
    expect(await recheck(JOB)).toMatchObject({ status: 'compatible' });
    expect(f.generate.mock.calls.length).toBeGreaterThan(calls);
  });

  it('never hands the letter writer a qualification the platform completed', async () => {
    const f = fixture({ firstMatch: gap([permitQuestion]), secondMatch: { matches: [{ index: 0, status: 'met', evidence: 'Personnel administration and onboarding for 300 employees.' }], verdict: 'good', summaryIt: '', checksIt: [], questions: [] } });
    const check = await prepareConciergeEligibility({ ...f, profileRecord: {} });
    const result = await check(JOB);
    f.records.set('application_concierge_services/service/proposals/proposal', {
      eligibilityVersion: (await import('../functions/src/applicationConciergeEligibility.js')).CONCIERGE_ELIGIBILITY_VERSION,
      eligibilityCacheId: result.cacheId, eligibilityFingerprint: result.fingerprint,
    });
    expect(await vettedConciergeDraftInputs({ db: f.db, order: { userId: 'candidate', parentServiceId: 'service', parentProposalId: 'proposal' },
      cvBuffer: Buffer.from('%PDF-1.7 synthetic CV'), postingText: POSTING })).toBeNull();
  });
});
