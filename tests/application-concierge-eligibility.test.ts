import { describe, expect, it, vi } from 'vitest';
vi.mock('../functions/src/remoteConfigSecrets.js', () => ({ getRemoteConfigValue: vi.fn(async () => '') }));
vi.mock('../functions/src/geminiGenerate.js', () => ({ generateServerText: vi.fn() }));
const { generateServerText } = await import('../functions/src/geminiGenerate.js');
vi.mock('../functions/src/assistedApplicationAiDocuments.js', () => ({ extractCvText: vi.fn(async () => 'Candidate Example\nIT Manager, Example Systems, 2020–2025\nLanguages: English B2, French B2\nInfrastructure management and operations experience.') }));
const { CONCIERGE_ELIGIBILITY_VERSION, prepareConciergeEligibility, preflightExistingCvEligibility, vettedConciergeDraftInputs } = await import('../functions/src/applicationConciergeEligibility.js');
const { conciergeProposalEligibility, fitNoticeOf } = await import('../functions/src/assistedApplicationFitNotice.js');
const { hasUncoveredHardEligibilityStatements, hasUnverifiedCurrentStudentEligibility, sanitizeRequirements, verifyQuotes } = await import('../functions/src/assistedApplicationAiDraftCore.js');
const { PROFILE_SYSTEM_PROMPT, REQUIREMENTS_SYSTEM_PROMPT } = await import('../functions/src/assistedApplicationAiPrompts.js');

const requirements = { requirements: [{ requirement: 'Tedesco fluente', sourceRequirement: 'Fluent German required', importance: 'critical', basis: 'stated', quote: 'Fluent German required' }] };
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
  it('fails closed when the extractor omits an exclusive school-placement requirement', async () => {
    const statement = 'Questo tirocinio è riservato esclusivamente a studenti che frequentano il terzo anno della scuola commerciale e devono svolgere una pratica di 52 settimane.';
    const f = fixture({ matches: [{ index: 0, status: 'met', evidence: 'Comunicazione efficace' }], verdict: 'strong', questions: [] });
    f.readPosting.mockResolvedValue({ text: [statement, 'Comunicazione efficace.'].join(' '), source: 'job_detail', textTruncated: false });
    const omitted = { requirements: [{ requirement: 'Comunicazione efficace', sourceRequirement: 'Comunicazione efficace.', importance: 'high', basis: 'stated', quote: 'Comunicazione efficace.' }] };
    f.generate.mockImplementation(async system => system === PROFILE_SYSTEM_PROMPT ? rawProfile : system === REQUIREMENTS_SYSTEM_PROMPT ? omitted : { matches: [{ index: 0, status: 'met', evidence: 'Comunicazione efficace' }], verdict: 'strong' });
    const check = await prepareConciergeEligibility({ ...f, profileRecord: {} });

    expect(await check({ id: 'school-placement' })).toMatchObject({ status: 'unverified', reason: 'requirements_incomplete' });
    expect(f.generate).toHaveBeenCalledTimes(2);
    expect([...f.records.keys()].filter(key => key.includes('/eligibility/job-'))).toEqual([]);
  });

  it('does not let past IT experience satisfy an exclusive current third-year placement', async () => {
    const statement = 'This traineeship is exclusively for current third-year commercial-school students and requires a 52-week placement.';
    const f = fixture({ matches: [{ index: 0, status: 'met', evidence: 'IT Manager, Example Systems, 2020–2025' }], verdict: 'strong', questions: [] });
    f.readPosting.mockResolvedValue({ text: `${statement} ${'The student placement takes place in the commercial school programme. '.repeat(3)}`, source: 'job_detail', textTruncated: false });
    const row = { requirement: 'Studente al terzo anno di scuola commerciale con pratica di 52 settimane', sourceRequirement: statement,
      importance: 'critical', basis: 'stated', quote: statement };
    f.generate.mockImplementation(async (system: string) => system === PROFILE_SYSTEM_PROMPT
      ? { ...rawProfile, experience: [{ role: 'IT Manager', employer: 'Example Systems', start: '2020', end: '2025' }] }
      : system === REQUIREMENTS_SYSTEM_PROMPT ? { requirements: [row] }
        : { matches: [{ index: 0, status: 'met', evidence: 'IT Manager, Example Systems, 2020–2025' }], verdict: 'strong' });
    const check = await prepareConciergeEligibility({ ...f, profileRecord: {} });

    expect(hasUnverifiedCurrentStudentEligibility(statement, { ...rawProfile, currentEducation: {} })).toBe(true);
    expect(hasUnverifiedCurrentStudentEligibility(statement, { ...rawProfile, currentEducation: { degree: 'Third-year commercial-school student' } })).toBe(false);
    expect(await check({ id: 'current-student-placement' })).toMatchObject({ status: 'unverified', reason: 'current_education_unverified' });
    expect(f.generate).toHaveBeenCalledTimes(3);
    expect([...f.records.keys()].filter(key => key.includes('/eligibility/job-'))).toEqual([]);
  });

  it('does not use legacy opaque application answers as eligibility evidence', async () => {
    const statement = 'Candidates must hold a valid Swiss work permit.';
    const f = fixture({ matches: [{ index: 0, status: 'missing', evidence: '' }], verdict: 'poor', questions: [] });
    f.readPosting.mockResolvedValue({ text: `${statement} ${'The selected candidate supports the team. '.repeat(20)}`, source: 'job_detail', textTruncated: false });
    const row = { requirement: 'Permesso di lavoro svizzero', sourceRequirement: statement, importance: 'critical', basis: 'stated', quote: statement };
    f.generate.mockImplementation(async (system, user) => {
      if (system === PROFILE_SYSTEM_PROMPT) return rawProfile;
      if (system === REQUIREMENTS_SYSTEM_PROMPT) return { requirements: [row] };
      const payload = JSON.parse(user.split('\n\n<<<POSTING EXCERPT')[0]);
      expect(payload.previousAnswers).toEqual({});
      expect(payload.candidateSourceExcerpts.map((item: any) => item.text).join('\n')).not.toContain('synthetic legacy permit answer');
      return { matches: [{ index: 0, status: 'missing', evidence: '' }], verdict: 'poor', questions: [] };
    });
    const check = await prepareConciergeEligibility({ ...f, profileRecord: { applicationQuestionAnswers: { work_permit: 'synthetic legacy permit answer' } } });

    expect(await check({ id: 'opaque-answer' })).not.toMatchObject({ status: 'compatible' });
    expect(f.generate).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['it', 'Il concorso si rivolge UNICAMENTE a chi frequenta il terzo anno della scuola commerciale.'],
    ['de', 'Diese Stelle ist ausschliesslich Bewerberinnen vorbehalten, die das dritte Jahr der Handelsschule besuchen.'],
    ['fr', 'Ce stage est réservé uniquement aux élèves qui fréquentent la troisième année de l’école commerciale.'],
    ['en', 'This internship is open exclusively to applicants enrolled in the third year of commercial school.'],
    ['resident', 'Only Swiss residents may apply.'],
    ['apply-if-resident', 'Candidates may apply only if they are Swiss residents.'],
    ['fr-minimum', 'Plus de 5 ans d’expérience en gestion de projets sont exigés.'],
    ['internship-placement', 'This internship requires a 52-week placement at a commercial school.'],
    ['holders', 'This role is exclusively for holders of a valid Swiss work permit.'],
    ['graduates', 'Only graduates of an accredited nursing programme are eligible.'],
    ['people', 'The programme is reserved for people currently enrolled in vocational school.'],
    ['permit', 'Candidates must hold a valid work permit.'],
    ['de-mandatory', 'Bewerberinnen müssen eine gültige Arbeitsbewilligung besitzen.'],
  ])('requires a complete source quote for hard eligibility in %s', (_language, statement) => {
    expect(hasUncoveredHardEligibilityStatements({ requirements: [] }, statement)).toBe(true);
    expect(hasUncoveredHardEligibilityStatements({ requirements: [{ basis: 'stated', importance: 'critical', sourceRequirement: statement, quote: statement }] }, statement)).toBe(false);
  });

  it('does not let a preferred row cover an exclusive eligibility condition', () => {
    const statement = 'Only applicants currently enrolled in the third year of commercial school may apply.';
    expect(hasUncoveredHardEligibilityStatements({ requirements: [{ basis: 'stated', importance: 'preferred', sourceRequirement: statement, quote: statement }] }, statement)).toBe(true);
  });

  it('keeps a hard eligibility sentence intact when the posting wraps it across lines', () => {
    const wrapped = ['Only applicants currently enrolled', 'in the third year of commercial school may apply.'].join('\n');
    expect(hasUncoveredHardEligibilityStatements({ requirements: [{ basis: 'stated', importance: 'critical', sourceRequirement: wrapped, quote: 'Only applicants currently enrolled' }] }, wrapped)).toBe(true);
    expect(hasUncoveredHardEligibilityStatements({ requirements: [{ basis: 'stated', importance: 'critical', sourceRequirement: wrapped, quote: wrapped }] }, wrapped)).toBe(false);
  });

  it('does not let an unrelated row label borrow a hard-eligibility quote', async () => {
    const statement = 'This role requires fluent German and five years of relevant sales experience.';
    const mislabelled = { requirements: [{ requirement: 'Strong communication skills', importance: 'critical', basis: 'stated', quote: statement }] };
    expect(hasUncoveredHardEligibilityStatements(mislabelled, statement)).toBe(true);
    const wrongSourceLabel = { requirements: [{ requirement: 'Strong communication skills', sourceRequirement: 'Strong communication skills', importance: 'critical', basis: 'stated', quote: statement }] };
    expect(hasUncoveredHardEligibilityStatements(wrongSourceLabel, statement)).toBe(true);
    const verifiedWrongMapping = verifyQuotes(sanitizeRequirements(wrongSourceLabel), statement);
    expect(verifiedWrongMapping.requirements[0].sourceRequirement).toBe('');
    expect(hasUncoveredHardEligibilityStatements(verifiedWrongMapping, statement)).toBe(true);

    const mapped = { requirements: [{ requirement: 'Strong communication skills', sourceRequirement: statement, importance: 'critical', basis: 'stated', quote: statement }] };
    expect(hasUncoveredHardEligibilityStatements(mapped, statement)).toBe(false);
    const { matchUserText } = await import('../functions/src/assistedApplicationAiPrompts.js');
    const payload = JSON.parse(matchUserText({ profile: {}, requirements: mapped, answers: {}, postingExcerpt: statement }));
    expect(payload.requirements[0]).toMatchObject({ requirement: statement, displayRequirement: 'Strong communication skills' });
  });

  it('treats listed qualifications under a requirements heading as hard and does not mistake developer for must', () => {
    const qualifications = 'Qualifications\n- German C1\n- Five years of relevant experience';
    expect(hasUncoveredHardEligibilityStatements({ requirements: [] }, qualifications)).toBe(true);
    expect(hasUncoveredHardEligibilityStatements({ requirements: [] }, 'Qualifications: German C1')).toBe(true);
    const correctlyCovered = { requirements: [
      { requirement: 'Tedesco C1', sourceRequirement: 'German C1', importance: 'critical', basis: 'stated', quote: 'German C1' },
      { requirement: 'Esperienza', sourceRequirement: 'Five years of relevant experience', importance: 'critical', basis: 'stated', quote: 'Five years of relevant experience' },
    ] };
    expect(hasUncoveredHardEligibilityStatements(correctlyCovered, qualifications)).toBe(false);

    expect(hasUncoveredHardEligibilityStatements({ requirements: [] }, 'A developer with Java experience is an advantage.')).toBe(false);
    expect(hasUncoveredHardEligibilityStatements({ requirements: [] }, 'Qualifications\nA developer with Java experience is an advantage.')).toBe(false);
  });

  it('recognizes localized profile headings, keeps optional rows soft, and resets at mission headings', () => {
    expect(hasUncoveredHardEligibilityStatements({ requirements: [] }, 'Votre profil\nPlus de 5 ans d’expérience en gestion de projets.')).toBe(true);
    expect(hasUncoveredHardEligibilityStatements({ requirements: [] }, 'Il tuo profilo\nLaurea in economia.')).toBe(true);

    for (const optional of [
      'Qualifications\nOptional\n- French B2',
      'Qualifications\nOpzionale:\n- French B2',
      'Exigences\nFacultatif:\n- Français B2',
      'Exigences facultatives\n- Français B2',
      'Optionale Anforderungen\n- Deutsch B2',
      'Qualifiche opzionali\n- At least 5 years of experience.',
      'Qualifiche opzionali\n- Almeno 5 anni di esperienza.',
      'Exigences\nUn plus:\n- Plus de 5 ans d’expérience.',
      'Exigences -> Un plus:\n- Plus de 5 ans d’expérience.',
      'Un plus:\nPlus de 5 ans d’expérience.',
      'Opzionale\nAlmeno 5 anni di esperienza costituiscono un plus.',
    ]) expect(hasUncoveredHardEligibilityStatements({ requirements: [] }, optional)).toBe(false);

    const posting = 'Qualifications\n- German C1\nVotre mission\n- Support customer projects';
    const covered = { requirements: [{ requirement: 'Tedesco C1', sourceRequirement: 'German C1', importance: 'critical', basis: 'stated', quote: 'German C1' }] };
    expect(hasUncoveredHardEligibilityStatements(covered, posting)).toBe(false);
    expect(hasUncoveredHardEligibilityStatements(covered, 'Qualifications\n- German C1\nCompetenze facoltative\n- French B2')).toBe(false);

    for (const heading of ['Tätigkeiten', 'Ihre Tätigkeiten']) {
      const resetPosting = `Qualifications\n- German C1\n${heading}\n- Manage multilingual support projects`;
      expect(hasUncoveredHardEligibilityStatements(covered, resetPosting)).toBe(false);
    }
  });

  it('does not treat application channel instructions or preferred skills as hard eligibility', () => {
    expect(hasUncoveredHardEligibilityStatements({ requirements: [] }, 'Applications must be submitted online only.')).toBe(false);
    expect(hasUncoveredHardEligibilityStatements({ requirements: [] }, 'Candidates must apply online only.')).toBe(false);
    expect(hasUncoveredHardEligibilityStatements({ requirements: [] }, 'French is a plus.')).toBe(false);
    expect(hasUncoveredHardEligibilityStatements({ requirements: [] }, 'At least 5 years of experience would be useful.')).toBe(true);
    expect(hasUncoveredHardEligibilityStatements({ requirements: [] }, 'French is not necessary.')).toBe(false);
    expect(hasUncoveredHardEligibilityStatements({ requirements: [] }, 'Qualifiche\nLa conoscenza del francese non è obbligatoria.')).toBe(false);
  });

  it('segments mixed hard and soft clauses without letting a soft cue suppress hard eligibility', () => {
    const empty = { requirements: [] };
    const exclusive = 'Only Swiss residents may apply; German is a plus.';
    expect(hasUncoveredHardEligibilityStatements(empty, exclusive)).toBe(true);
    expect(hasUncoveredHardEligibilityStatements({ requirements: [{
      requirement: 'Residente in Svizzera', sourceRequirement: 'Only Swiss residents may apply',
      importance: 'critical', basis: 'stated', quote: 'Only Swiss residents may apply',
    }] }, exclusive)).toBe(false);

    const permit = 'Candidates must hold a valid Swiss work permit; German B2 is a plus.';
    expect(hasUncoveredHardEligibilityStatements(empty, permit)).toBe(true);
    expect(hasUncoveredHardEligibilityStatements({ requirements: [{
      requirement: 'Permesso di lavoro svizzero', sourceRequirement: 'Candidates must hold a valid Swiss work permit',
      importance: 'critical', basis: 'stated', quote: 'Candidates must hold a valid Swiss work permit',
    }] }, permit)).toBe(false);

    const languages = 'German C1 required; French B2 would be useful.';
    expect(hasUncoveredHardEligibilityStatements(empty, languages)).toBe(true);
    expect(hasUncoveredHardEligibilityStatements({ requirements: [{
      requirement: 'Tedesco C1', sourceRequirement: 'German C1 required',
      importance: 'critical', basis: 'stated', quote: 'German C1 required',
    }] }, languages)).toBe(false);

    const optionalMandatory = 'Optional → Candidates must hold a valid Swiss work permit.';
    expect(hasUncoveredHardEligibilityStatements(empty, optionalMandatory)).toBe(true);
    expect(hasUncoveredHardEligibilityStatements({ requirements: [{
      requirement: 'Permesso di lavoro svizzero', sourceRequirement: 'Candidates must hold a valid Swiss work permit',
      importance: 'critical', basis: 'stated', quote: 'Candidates must hold a valid Swiss work permit',
    }] }, optionalMandatory)).toBe(false);
    expect(hasUncoveredHardEligibilityStatements({ requirements: [{
      requirement: 'Tedesco C1', sourceRequirement: 'German C1 is required for this preferred profile',
      importance: 'critical', basis: 'stated', quote: 'German C1 is required for this preferred profile',
    }] }, 'Optional\nGerman C1 is required for this preferred profile.')).toBe(true);

    const contradictorySameRequirement = 'German C1 required; German C1 is a plus.';
    expect(hasUncoveredHardEligibilityStatements(empty, contradictorySameRequirement)).toBe(true);
    expect(hasUncoveredHardEligibilityStatements({ requirements: [{
      requirement: 'Tedesco C1', sourceRequirement: 'German C1 required',
      importance: 'critical', basis: 'stated', quote: 'German C1 required',
    }] }, contradictorySameRequirement)).toBe(true);
    expect(hasUncoveredHardEligibilityStatements(empty, 'German C1 is required and a plus.')).toBe(true);
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
    const omitted = { requirements: [{ requirement: 'IT experience', sourceRequirement: 'IT operations', importance: 'high', basis: 'stated', quote: 'IT operations' }],
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
  it('reuses a verified positive only for identical CV and posting, ignoring opaque legacy answers', async () => {
    const f = fixture({ matches: [{ index: 0, status: 'met', evidence: 'English B2' }], verdict: 'strong', questions: [] });
    const required = { requirements: [{ requirement: 'English B2', sourceRequirement: 'English B2 required', importance: 'critical', basis: 'stated', quote: 'English B2 required' }] };
    f.generate.mockImplementation(async system => system === PROFILE_SYSTEM_PROMPT ? rawProfile : system === REQUIREMENTS_SYSTEM_PROMPT ? required : { matches: [{ index: 0, status: 'met', evidence: 'English B2' }], verdict: 'strong', questions: [] });
    f.readPosting.mockResolvedValue({ text: `English B2 ${'IT operations and infrastructure. '.repeat(20)}`, textTruncated: false, source: 'job_detail' });
    const check = await prepareConciergeEligibility({ ...f, profileRecord: {} });
    const job = { id: 'job', title: 'IT Manager', company: 'Example' };
    const result = await check(job);
    expect(result.status).toBe('compatible');
    await check(job);
    expect(f.generate).toHaveBeenCalledTimes(3);
    f.records.set('application_concierge_services/service/proposals/proposal', {
      eligibilityCacheId: result.cacheId, eligibilityFingerprint: result.fingerprint, eligibilityVersion: CONCIERGE_ELIGIBILITY_VERSION,
    });
    const order = { userId: 'candidate', parentServiceId: 'service', parentProposalId: 'proposal' };
    const input = { db: f.db, order, cvBuffer: f.bytes, postingText: (await f.readPosting()).text };
    expect(await vettedConciergeDraftInputs(input)).toMatchObject({ result: { status: 'compatible' } });
    expect(await vettedConciergeDraftInputs({ ...input, cvBuffer: Buffer.from('different CV') })).toBeNull();
    expect(await vettedConciergeDraftInputs({ ...input, postingText: `${input.postingText} changed` })).toBeNull();
    f.records.set('user_cv_profiles/candidate', { applicationQuestionAnswers: { language_en_any_proficiency: 'C1' } });
    expect(await vettedConciergeDraftInputs(input)).toMatchObject({ result: { status: 'compatible' } });
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
      if (system === REQUIREMENTS_SYSTEM_PROMPT) return { requirements: [{ requirement: 'English B2', sourceRequirement: 'English B2 required', importance: 'critical', basis: 'stated', quote: 'English B2 required' }] };
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
  it('does not cache invented posting quotes as missing candidate qualifications', async () => {
    const f = fixture({ matches: [{ index: 0, status: 'met', evidence: 'English B2' }], verdict: 'strong' });
    f.generate.mockImplementation(async system => system === PROFILE_SYSTEM_PROMPT ? rawProfile : system === REQUIREMENTS_SYSTEM_PROMPT
      ? { requirements: [{ requirement: 'English B2', sourceRequirement: 'English B2', importance: 'critical', basis: 'stated', quote: 'An invented requirement quote' }] }
      : { matches: [{ index: 0, status: 'met', evidence: 'English B2' }], verdict: 'strong' });
    const check = await prepareConciergeEligibility({ ...f, profileRecord: {} });
    expect(await check({ id: 'bad-quote' })).toMatchObject({ status: 'unverified', reason: 'requirements_incomplete' });
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
