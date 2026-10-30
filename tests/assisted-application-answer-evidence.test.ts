import { describe, expect, it } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { loadCandidateAnswerEvidence, loadRunnerAnswerContext, planCandidateAnswerEvidence, purgeCandidateAnswerEvidence, rememberCandidateAnswerEvidence } from '../functions/src/assistedApplicationAnswerEvidence.js';
import { candidateQuestionAnswerKey } from '../functions/src/assistedApplicationCandidateEdits.js';

const now = Date.now();
const question = { id: 'english', question: 'What is your English proficiency level?', type: 'text' };
const order = { userId: 'candidate', jobId: 'source-job', jobUrl: 'https://example.test/jobs/source/', cvUploadedAt: now };
const target = { id: 'other-job', url: 'https://example.test/jobs/other/' };
function fixture(q = question, answer: any = 'C1', actor = 'candidate') {
  const key = candidateQuestionAnswerKey(q);
  const records = rememberCandidateAnswerEvidence({ questions: [q], changed: { [q.id]: answer }, orderId: 'source', order,
    flow: { round: 1 }, draft: { round: 1 }, actor, nowMs: now });
  const profileRecord = { applicationQuestionAnswers: { [key]: answer }, applicationQuestionAnswerEvidence: records };
  const store = createMemoryFirestore({
    'assisted_applications/source': order,
    'assisted_applications/source/automation/flow': { round: 1, answers: { [q.id]: answer } },
    'assisted_applications/source/ai_drafts/current': { round: 1, questions: [q] },
  });
  return { key, records, profileRecord, store, load: () => loadCandidateAnswerEvidence({ db: store.db, userId: 'candidate', profileRecord }) };
}

describe('attested shared candidate answer evidence', () => {
  it.each(['candidate', 'owner'])('retains an explicit personal language fact with its question, unit and %s provenance', async actor => {
    const f = fixture(question, 'C1', actor);
    const context = (await f.load())(target);
    expect(context.answers).toEqual({ [f.key]: 'C1' });
    expect(context.answerEvidence).toEqual([expect.objectContaining({ id: expect.stringMatching(/^answer-[a-f0-9]{24}$/), question: expect.objectContaining(question),
      answer: 'C1', category: 'language', unit: 'CEFR_or_stated_level', scope: 'candidate',
      provenance: expect.objectContaining({ actor, userId: 'candidate', orderId: 'source', round: 1, confirmedAt: now }) })]);
  });
  it('does not promote opaque legacy values, even a fixed language key without attested source', async () => {
    const db: any = { collection: () => { throw new Error('no source should be read'); } };
    const context = await loadCandidateAnswerEvidence({ db, userId: 'candidate', profileRecord: {
      applicationQuestionAnswers: { question_opaque: 'Yes', language_en_any_proficiency: 'C1' },
    } });
    expect(context(target).answers).toEqual({});
    expect(context(target).answerEvidence).toEqual([]);
  });
  it.each([{}, { actor: 'policy_default' }, { actor: 'candidate', draft: { round: 2 } }])('does not infer author or promote a stale draft round: %j', patch => {
    expect(rememberCandidateAnswerEvidence({ questions: [question], changed: { english: 'C1' }, orderId: 'source', order,
      flow: { round: 1 }, draft: { round: 1 }, nowMs: now, ...patch })).toEqual({});
  });
  it.each(['Do you accept our privacy policy?', 'Consent to WhatsApp marketing', 'Accetti il trattamento dei dati?', 'Stimmen Sie dem Datenschutz zu?', "Autorizzi l'uso dei tuoi dati personali?", 'Ich bin mit der Speicherung meiner Bewerbungsunterlagen einverstanden'])('never exposes a consent as qualification evidence: %s', text => {
    const f = fixture({ id: 'consent', question: text, type: 'yes_no' }, 'Yes');
    expect(f.records[f.key]).toMatchObject({ cleared: true });
    expect(f.records[f.key]).not.toHaveProperty('question');
    expect(f.records[f.key]).not.toHaveProperty('answer');
  });
  it.each([
    { id: 'number', question: 'What is your notice period in months?', type: 'number' },
    { id: 'salary', question: 'What is your requested salary in CHF per year?', type: 'number' },
    { id: 'certificate', question: 'Do you hold the certificate required for this posting?', type: 'yes_no' },
    { id: 'relocate', question: 'Can you relocate to Zurich within 30 days?', type: 'yes_no' },
  ])('keeps constraints and units attached to their original posting: $id', async q => {
    const f = fixture(q, q.type === 'number' ? '3' : 'Yes');
    const context = await f.load();
    expect(context(target).answerEvidence).toEqual([]);
    expect(context({ id: order.jobId, url: order.jobUrl }, { purpose: 'form' }).answerEvidence[0]).toMatchObject({ question: expect.objectContaining(q), scope: 'job' });
    expect(context({ id: order.jobId, url: target.url }).answerEvidence).toEqual([]);
  });
  it.each(['owner', 'round', 'question', 'answer', 'retention', 'unit', 'raw_value', 'section', 'deadline', 'missing_anchor'])('refuses evidence whose source or semantics changed: %s', async change => {
    const f = fixture();
    if (change === 'owner') f.store.docs.set('assisted_applications/source', { ...order, userId: 'someone-else' });
    if (change === 'round') f.store.docs.set('assisted_applications/source/automation/flow', { round: 2, answers: { english: 'C1' } });
    if (change === 'question') f.store.docs.set('assisted_applications/source/ai_drafts/current', { round: 1, questions: [{ ...question, context: 'Written only for this employer' }] });
    if (change === 'answer') f.store.docs.set('assisted_applications/source/automation/flow', { round: 1, answers: { english: 'A1' } });
    if (change === 'retention') f.store.docs.set('assisted_applications/source', { ...order, retentionPurgedAt: now });
    if (change === 'section') f.store.docs.set('assisted_applications/source/ai_drafts/current', { round: 1, questions: [{ ...question, section: 'Written translations for this employer' }] });
    if (change === 'deadline') f.store.docs.set('assisted_applications/source', { ...order, cvUploadedAt: now - 91 * 86400000 });
    if (change === 'missing_anchor') { const { cvUploadedAt, ...missing } = order; f.store.docs.set('assisted_applications/source', missing); }
    if (change === 'unit') f.records[f.key].unit = 'different_unit';
    if (change === 'raw_value') f.profileRecord.applicationQuestionAnswers[f.key] = 'A1';
    expect((await f.load())(target).answerEvidence).toEqual([]);
  });
  it('changes the cache fingerprint when question context, scope or provenance changes', async () => {
    const f = fixture();
    const initial = (await f.load())(target).fingerprint;
    f.records[f.key].provenance.actor = 'owner';
    expect((await f.load())(target).fingerprint).not.toBe(initial);
    f.records[f.key].question.context = 'Different employer constraint';
    expect((await f.load())(target).answers).toEqual({});
  });
});

describe('positive portability and source retention', () => {
  it.each(['What is your English proficiency level?', 'Qual è il tuo livello di inglese?', 'Wie ist Ihr Niveau in Englisch?', 'Quel est votre niveau en anglais ?'])('recognizes a complete personal level question: %s', text => {
    const f = fixture({ ...question, question: text });
    expect(f.records[f.key]).toMatchObject({ category: 'language', unit: 'CEFR_or_stated_level', scope: 'candidate' });
  });
  it.each([
    { ...question, question: 'What is your English proficiency level after training?' },
    { ...question, question: 'What is your written English proficiency in legal drafting?' },
    { ...question, section: 'Written translations for this employer' },
    { ...question, autocomplete: 'employer-specific-level' },
    { ...question, question: 'Is your English proficiency sufficient to negotiate legal contracts?', type: 'yes_no' },
  ])('retains a constrained capability question only on its job: $question', async q => {
    const f = fixture(q, q.type === 'yes_no' ? 'Yes' : 'C1');
    expect(f.records[f.key]).toMatchObject({ scope: 'job' });
    if (q.type === 'yes_no') expect(f.records[f.key].unit).toBe('boolean');
    expect((await f.load())(target).answerEvidence).toEqual([]);
    expect(candidateQuestionAnswerKey(q)).not.toBe(candidateQuestionAnswerKey(question));
  });
  it('does not reuse a language source after its retention deadline even before the purger runs', async () => {
    const f = fixture();
    f.store.docs.set('assisted_applications/source', { ...order, cvUploadedAt: now - 90 * 86400000 });
    expect((await f.load())(target).answerEvidence).toEqual([]);
  });
  it('uses the canonical separate talent-pool consent and stops when it is withdrawn', async () => {
    const f = fixture();
    const retained = { ...order, cvUploadedAt: now - 91 * 86400000, talentPoolConsent: true };
    f.store.docs.set('assisted_applications/source', retained);
    expect((await f.load())(target).answers[f.key]).toBe('C1');
    f.store.docs.set('assisted_applications/source', { ...retained, talentPoolConsent: false });
    expect((await f.load())(target).answerEvidence).toEqual([]);
  });
  it('keeps Firestore map field ordering out of semantic comparisons and fingerprints', async () => {
    const f = fixture();
    const initial = (await f.load())(target);
    const reversed = (value: any): any => Array.isArray(value) ? value.map(reversed) : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reversed(item)])) : value;
    f.profileRecord.applicationQuestionAnswerEvidence = reversed(f.profileRecord.applicationQuestionAnswerEvidence);
    expect((await f.load())(target).answers[f.key]).toBe('C1');
    expect((await f.load())(target).fingerprint).toBe(initial.fingerprint);
  });
  it('purges copies and ordering clocks belonging to a source while preserving newer facts from another source', async () => {
    const f = fixture();
    const old = f.records[f.key];
    const other = { ...old, provenance: { ...old.provenance, orderId: 'newer-source', confirmedAt: now + 1 } };
    f.store.docs.set('user_cv_profiles/candidate', { profile: { retained: true }, applicationQuestionAnswers: { [f.key]: 'C1', old: 'removed' },
      applicationQuestionAnswerEvidence: { [f.key]: other, old: { provenance: { orderId: 'source' }, cleared: true } } });
    await purgeCandidateAnswerEvidence({ db: f.store.db, userId: 'candidate', orderId: 'source', nowMs: now + 2 });
    const profile = f.store.read('user_cv_profiles/candidate');
    expect(profile.applicationQuestionAnswerEvidence).toEqual({ [f.key]: other });
    expect(profile.applicationQuestionAnswers).toEqual({ [f.key]: 'C1' });
    expect(profile.profile).toEqual({ retained: true });
    expect(profile.applicationQuestionAnswersUpdatedAt).toBe(now + 2);
    await purgeCandidateAnswerEvidence({ db: f.store.db, userId: 'candidate', orderId: 'newer-source', nowMs: now + 3 });
    expect(f.store.read('user_cv_profiles/candidate').applicationQuestionAnswers).toEqual({});
    expect(f.store.read('user_cv_profiles/candidate').applicationQuestionAnswerEvidence).toEqual({});
  });
});


describe('ordering survives source cleanup and bounded clocks', () => {
  it.each([now - 1, now])('does not resurrect an evicted key from an older/equal writer at %i', nowMs => {
    const plan = planCandidateAnswerEvidence({ questions: [question], changed: { english: 'C1' }, previous: {}, latestWriteAt: now,
      orderId: 'source', order, flow: { round: 1 }, draft: { round: 1 }, actor: 'candidate', nowMs });
    expect(plan.accepted.size).toBe(0);
    expect(plan.records).toEqual({});
  });
});

describe('policy preferences are never confirmed candidate facts', () => {
  it('does not attest a policy_default value even when a caller labels itself owner', () => {
    const q = { id: 'notice', question: 'What is your notice period in months?', type: 'number', source: 'policy_default' };
    const f = fixture(q, '3', 'owner');
    expect(f.records[f.key]).toMatchObject({ cleared: true });
    expect(f.records[f.key]).not.toHaveProperty('answer');
    expect(f.records[f.key]).not.toHaveProperty('question');
  });
});

describe('birthplace is not a date of birth', () => {
  it.each(['Place of birth', 'Geburtsort', 'Comune di nascita', 'Luogo di nascita', 'Lieu de naissance'])('does not alias %s to a birth date', label => {
    const dob = { id: 'birth_date', question: 'Date of birth', type: 'date' };
    const place = { id: 'birth_place', question: label, type: 'text' };
    expect(candidateQuestionAnswerKey(place)).not.toBe(candidateQuestionAnswerKey(dob));
    const f = fixture(place, 'Example municipality');
    expect(f.records[f.key]).toMatchObject({ cleared: true });
    expect(f.records[f.key]).not.toHaveProperty('answer');
  });
});


describe('runner answer context preserves its raw lease/CAS snapshot', () => {
  it('passes attested sources to the writer and filters legacy memory without changing raw flow or current hard answers', async () => {
    const f = fixture();
    f.store.docs.set('user_cv_profiles/candidate', f.profileRecord);
    const local = { id: 'notice', question: 'What is your notice period in months?', type: 'number' };
    const raw = { round: 1, state: 'submitting', answers: { notice: '2' }, questionAnswers: { question_legacy_consent: 'Yes' }, dispatch: { attempts: 2 } };
    const before = structuredClone(raw);
    const result = await loadRunnerAnswerContext({ db: f.store.db, order: { userId: 'candidate', jobId: target.id, jobUrl: target.url }, flow: raw,
      draft: { round: 1, questions: [local] }, nowMs: now });
    expect(result.answerEvidence).toHaveLength(1);
    expect(result.answerEvidence[0].question.question).toBe(question.question);
    expect(result.flow.questionAnswers).toMatchObject({ [f.key]: 'C1', [candidateQuestionAnswerKey(local)]: '2' });
    expect(result.flow.questionAnswers).not.toHaveProperty('question_legacy_consent');
    expect(result.flow.answers).toEqual({ notice: '2' });
    expect(raw).toEqual(before);
  });
});
