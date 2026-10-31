import { describe, expect, it, vi } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { reconcilePortalQuestions } from '../scripts/assisted-application/reconcile-portal-questions.mjs';
import { revalidatedPortalQuestions, relaxablePortalQuestionTopic, legacyPortalContractEligible } from '../scripts/assisted-application/lib/portal/question-contract-reconciliation.mjs';
import { buildReviewPayload } from '../functions/src/assistedApplicationReview.js';
import { candidateWithEdits, questionsForCandidate } from '../functions/src/assistedApplicationCandidateEdits.js';
import { reconcilePortalCode } from '../scripts/assisted-application/reconcile-portal-code.mjs';
import { operationalPortalRecoveryReady } from '../functions/src/assistedApplicationPortalRecoveryPolicy.js';
import { transition } from '../functions/src/assistedApplicationFlow.js';
import { candidateForForm } from '../scripts/assisted-application/lib/portal/portal.mjs';
import { guardPlan } from '../scripts/assisted-application/lib/portal/plan.mjs';

const now = Date.now();
const daysAgo = (days: number) => now - days * 86400000;
const url = 'https://jobs.example.com/public-application/';
const base = 'assisted_applications/order_contract_test';
const label = 'Come sono venuto a conoscenza del lavoro?';
const question = { id: 'portal_source', source: 'portal', required: true, question: label, applicationQuestion: label,
  context: 'Additional data', section: 'Additional data', type: 'text', options: [], validation: {} };
const nativeAttestation = { nativeControlOwned: true, nativeLabelOwned: true, nativeReferencesComplete: true };
const native = { ...nativeAttestation, id: 'f_source', frame: 0, form: 0, kind: 'select', label, required: false, explicitlyOptional: true,
  context: 'Additional data', section: 'Additional data', options: [{ value: 'site', label: 'Company website' }, { value: 'event', label: 'Event' }] };
function proof(overrides = {}) {
  return { complete: true, stable: true, readOnly: true, observedAt: now, sourceUrl: url, url,
    fields: [native, { ...nativeAttestation, id: 'f_cv', frame: 0, form: 0, kind: 'file', inputType: 'file', label: 'CV', required: true },
      { ...nativeAttestation, id: 'f_email', frame: 0, form: 0, kind: 'text', inputType: 'email', label: 'Email', required: true }], ...overrides };
}
function fixture(id = 'order_contract_test') {
  const path = `assisted_applications/${id}`;
  return createMemoryFirestore({
    [path]: { paymentStatus: 'paid', automationState: 'needs_candidate_action', automationDueAt: null,
      submissionStatus: 'in_progress', companyName: 'Example Motors', locale: 'it', consentVersion: 'assisted-application-v2',
      consentedAt: daysAgo(1), cvUploadedAt: daysAgo(1) },
    [`${path}/automation/flow`]: { state: 'needs_candidate_action', round: 1, heldBy: [`question:${question.id}`],
      heldSince: now - 500, answers: {}, questionAnswers: {}, documents: {}, history: [{ to: 'needs_candidate_action', at: now - 500 }],
      dispatch: { mode: 'submit', round: 1, requestedAt: now - 1000 } },
    [`${path}/ai_drafts/current`]: { status: 'ready', round: 1, completedAt: now - 2000, questions: [question],
      profile: {}, job: { source: 'job_detail', title: 'Sales consultant', applyUrl: url }, channel: { type: 'employer_site', applyUrl: url },
      factCheck: { ok: true }, requiredDocuments: [] },
    [`${path}/automation/submission`]: { r1: { state: 'failed', channel: 'portal', releasedAt: now - 200, clickedAt: null } },
  });
}
function context(store: ReturnType<typeof fixture>, path = base) {
  return { order: store.read(path), flow: store.read(`${path}/automation/flow`),
    draft: store.read(`${path}/ai_drafts/current`), submission: store.read(`${path}/automation/submission`) };
}
const options = (store: ReturnType<typeof fixture>) => ({ db: store.db, now: () => now, isEnabled: async () => true, probe: async () => proof() });

it('keeps a mixed owner hold, or one without resolved draft questions, closed', () => {
  expect(operationalPortalRecoveryReady({ flow: { heldBy: ['question:q1', 'portal:portal_needs_candidate'] } })).toBe(false);
  expect(operationalPortalRecoveryReady({ flow: { heldBy: ['portal:portal_needs_candidate'] } })).toBe(false);
});

describe('legacy operational portal contract reconciliation', () => {
  it('updates only proven metadata, hides the optional question and queues the existing approved clock', async () => {
    const store = fixture();
    const originalFlow = structuredClone(store.read(`${base}/automation/flow`));
    const originalSubmission = structuredClone(store.read(`${base}/automation/submission`).r1);
    const before = context(store);
    expect(legacyPortalContractEligible(before, now)).toBe(true);
    expect(await reconcilePortalQuestions({ ...options(store), apply: true })).toMatchObject({ changed: 1, queued: 1 });
    const after = context(store);
    expect(after.flow).toEqual(originalFlow);
    expect(after.submission.r1).toEqual(originalSubmission);
    expect(after.order.automationDueAt).toBe(now);
    expect(after.draft.questions[0]).toMatchObject({ id: question.id, required: false, type: 'choice',
      options: ['Company website', 'Event'], portalNativeContract: { requiredEvidence: 'aria-required:false', topic: 'recruitment_source' } });
    expect(buildReviewPayload({ ...after, round: 1 }).questions).toEqual([]);
    expect(after.draft.requiredDocuments).toEqual(before.draft.requiredDocuments);
    expect(transition(after.flow, { type: 'tick' }, { draft: after.draft, nowMs: now }).effects)
      .toContainEqual({ type: 'dispatch', mode: 'submit', reason: 'resolved_candidate_answers' });
    expect(await reconcilePortalQuestions({ ...options(store), apply: true })).toMatchObject({ probed: 0, changed: 0, queued: 0 });
  });

  it('repairs only referral metadata in the complete owner-held legacy draft, then queues one retry that cannot fall back to a default', async () => {
    const store = fixture();
    const questions = [
      { id: 'optional-match', source: 'match', question: 'Optional information', required: false, type: 'choice', options: ['A', 'B'] },
      { id: 'optional-rule', source: 'rule', question: 'Optional preference', required: false, type: 'choice', options: ['A', 'B'] },
      { id: 'notice', source: 'portal', question: 'Attuale periodo di preavviso', type: 'choice', required: true, options: [] },
      { id: 'whatsapp', source: 'portal', question: 'Comunicazione via WhatsApp', type: 'yes_no', required: true, options: [] },
      { id: 'workload', source: 'portal', question: 'Grado di occupazione desiderato', type: 'choice', required: true, options: [] },
      { ...question, applicationOptions: Array.from({ length: 20 }, (_, index) => `Source ${index}`) },
    ];
    store.docs.set(base, { ...store.read(base), automationState: 'owner_takeover' });
    store.docs.set(`${base}/automation/flow`, { ...store.read(`${base}/automation/flow`), state: 'owner_takeover', heldBy: ['portal:portal_needs_candidate'], answers: { notice: '7 giorni' } });
    store.docs.set(`${base}/ai_drafts/current`, { ...store.read(`${base}/ai_drafts/current`), questions });
    const before = context(store);
    const seen = proof({ fields: [{ ...native, options: Array.from({ length: 20 }, (_, index) => ({ label: `Source ${index}`, value: `${index}` })) }, ...proof().fields.slice(1)] });
    expect(await reconcilePortalQuestions({ ...options(store), probe: async () => seen, apply: true })).toMatchObject({ changed: 1, queued: 0 });
    const after = context(store);
    expect(after.flow).toEqual(before.flow);
    expect(after.order.automationDueAt).toBeNull();
    expect(after.draft.questions.slice(0, 5)).toEqual(questions.slice(0, 5));
    expect(after.draft.questions[5]).toMatchObject({ id: question.id, required: false, type: 'choice' });
    expect(after.draft.questions[5].options).toHaveLength(20);
    expect(after.flow.answers.notice).toBe('7 giorni');
    expect(buildReviewPayload({ ...after, round: 1 }).questions.some(item => item.id === question.id)).toBe(false);
    // With the operational engine of this branch the repaired draft becomes
    // eligible. Queueing writes the retry clock and its receipt only: no
    // answer, question, approved dispatch or send record changes.
    const version = 'b'.repeat(64);
    const eventsBefore = store.list(`${base}/events/`);
    const recovery = { db: store.db, version, apply: true, nowMs: now, isEnabled: async () => true };
    expect(await reconcilePortalCode(recovery)).toMatchObject({ eligible: 1, queued: 1 });
    const queued = context(store);
    expect(queued.draft).toEqual(after.draft);
    expect(queued.flow).toEqual({ ...after.flow, portalAutoRetryAt: now, portalAutoRetryCount: 0, portalRecoveryVersion: version, updatedAt: now });
    expect(queued.order).toEqual({ ...after.order, automationDueAt: now, automationUpdatedAt: new Date(now) });
    expect(queued.submission).toEqual({ ...after.submission, portalCodeRecovery: { version, round: 1, queuedAt: now } });
    expect(store.list(`${base}/events/`).filter(path => !eventsBefore.includes(path)).map(path => store.read(path)))
      .toEqual([{ type: 'portal_code_recovery_scheduled', actor: 'system', at: now, version }]);
    expect(await reconcilePortalCode(recovery)).toMatchObject({ queued: 0 });
    // The retry is a submit-mode run under the approval already given, so the
    // live planner is what must keep the stated answer binding. Rebuild the
    // candidate as lib/submit.mjs does and prove no source can replace it.
    expect(transition(queued.flow, { type: 'portal_auto_retry' }, { draft: queued.draft, nowMs: now }).effects)
      .toEqual([{ type: 'dispatch', mode: 'submit', reason: 'portal_auto_retry' }]);
    const edited = candidateWithEdits(queued);
    const candidate = candidateForForm({ identity: edited.identity, profile: edited.profile, answers: edited.answers,
      draft: queued.draft, portalQuestions: queued.draft.questions.filter(item => item.source === 'portal') });
    const noticeField = (labels: string[]) => ({ id: 'native-notice', kind: 'select', label: 'Attuale periodo di preavviso',
      required: true, options: labels.map(item => ({ label: item, value: item })) });
    for (const field of [noticeField(['6 mesi', '3 mesi', '1 mesi']), noticeField([])]) {
      for (const source of ['policy_default', 'profile', 'rule']) {
        const held = guardPlan({ actions: [{ fieldId: field.id, action: 'select', value: '3 mesi', source }], missingRequired: [] }, [field], candidate);
        expect(held.actions).toEqual([]);
        expect(held.missingRequired).toEqual([expect.objectContaining({ fieldId: field.id })]);
      }
    }
    const expressible = noticeField(['3 mesi', 'Meno di 1 mese']);
    expect(guardPlan({ actions: [], missingRequired: [] }, [expressible], candidate).actions)
      .toEqual([expect.objectContaining({ fieldId: expressible.id, action: 'select', value: 'Meno di 1 mese', source: 'answers' })]);
    expect(context(store).flow.answers).toEqual({ notice: '7 giorni' });
  });

  it.each([
    ['projects onto one native option', ['3 mesi', 'Meno di 1 mese'], true],
    ['cannot be expressed by the native catalogue', ['6 mesi', '3 mesi'], false],
  ])('judges a preserved notice answer that %s as the live control would', (_, labels, changed) => {
    const store = fixture();
    const current = context(store);
    const notice = { id: 'notice', source: 'portal', question: 'Attuale periodo di preavviso', type: 'choice', required: true, options: labels };
    current.draft.questions = [notice, question];
    current.flow.answers = { notice: '7 giorni' };
    current.flow.heldBy = [`question:${question.id}`];
    const result = revalidatedPortalQuestions(current, proof(), now);
    expect(result.changed).toBe(changed);
    if (!changed) expect(result.reason).toBe('preserved_answer_incompatible');
    expect(current.flow.answers).toEqual({ notice: '7 giorni' });
  });

  it.each(['other_reason', 'mixed_hold', 'active_execution', 'controller_active', 'unknown_execution', 'old_click'])('keeps owner metadata unchanged for %s', async kind => {
    const store = fixture();
    store.docs.set(base, { ...store.read(base), automationState: 'owner_takeover' });
    const flow = { ...store.read(`${base}/automation/flow`), state: 'owner_takeover', heldBy: ['portal:portal_needs_candidate'] };
    if (kind === 'other_reason') flow.heldBy = ['portal:portal_ambiguous'];
    if (kind === 'mixed_hold') flow.heldBy.push('question:hard');
    if (kind.includes('execution') || kind === 'controller_active') {
      flow.executionId = 'current-execution';
      if (kind !== 'unknown_execution') store.docs.set(`${base}/automation/execution`, { id: 'current-execution', state: kind === 'active_execution' ? 'running' : 'finished', controller: { expiresAt: kind === 'controller_active' ? now + 1000 : 0 } });
    }
    store.docs.set(`${base}/automation/flow`, flow);
    if (kind === 'old_click') store.docs.set(`${base}/automation/submission`, { ...store.read(`${base}/automation/submission`), r0: { state: 'failed', clickedAt: now - 1000 } });
    const before = context(store);
    expect(await reconcilePortalQuestions({ ...options(store), apply: true })).toMatchObject({ probed: 0, changed: 0 });
    expect(context(store).draft).toEqual(before.draft);
    expect(context(store).flow).toEqual(before.flow);
  });

  it('fences a worker lease acquired after the owner public proof started', async () => {
    const store = fixture();
    store.docs.set(base, { ...store.read(base), automationState: 'owner_takeover' });
    store.docs.set(`${base}/automation/flow`, { ...store.read(`${base}/automation/flow`), state: 'owner_takeover', heldBy: ['portal:portal_needs_candidate'], executionId: 'current-execution' });
    store.docs.set(`${base}/automation/execution`, { id: 'current-execution', state: 'finished', controller: { expiresAt: 0 }, lease: null });
    const probe = async () => {
      store.docs.set(`${base}/automation/execution`, { id: 'current-execution', state: 'running', controller: { expiresAt: now + 1000 }, lease: { expiresAt: now + 1000 } });
      return proof();
    };
    expect(await reconcilePortalQuestions({ ...options(store), probe, apply: true })).toMatchObject({ raced: 1, changed: 0, queued: 0 });
    expect(store.read(`${base}/ai_drafts/current`).questions).toEqual([question]);
  });

  it('does not treat a blocked initialization POST as complete owner proof', async () => {
    const store = fixture();
    store.docs.set(base, { ...store.read(base), automationState: 'owner_takeover' });
    store.docs.set(`${base}/automation/flow`, { ...store.read(`${base}/automation/flow`), state: 'owner_takeover', heldBy: ['portal:portal_needs_candidate'] });
    expect(await reconcilePortalQuestions({ ...options(store), apply: true, probe: async () => ({ complete: false, readOnly: true, reason: 'incomplete_public_form', deniedRequests: [{ method: 'POST', endpoint: url }] }) })).toMatchObject({ changed: 0, queued: 0, unknown: 1 });
    expect(store.read(`${base}/ai_drafts/current`).questions).toEqual([question]);
    expect(store.read(base).automationDueAt).toBeNull();
  });

  it('does not write receipts, questions, clocks, leases or cursors in dry-run', async () => {
    const store = fixture();
    const before = [...store.docs.entries()];
    expect(await reconcilePortalQuestions(options(store))).toMatchObject({ changed: 1, queued: 1, apply: false });
    expect([...store.docs.entries()]).toEqual(before);
  });

  it.each(['missing_optional_marker', 'wrong_context', 'wrong_section', 'wrong_form', 'duplicate_label', 'duplicate_frame_id', 'incomplete', 'unstable', 'wrong_url'])('leaves a legacy hard hold unchanged for %s', kind => {
    const store = fixture();
    let seen: any = proof();
    if (kind === 'missing_optional_marker') seen.fields[0] = { ...native, explicitlyOptional: false };
    if (kind === 'wrong_context') seen.fields[0] = { ...native, context: 'Newsletter filter' };
    if (kind === 'wrong_section') seen.fields[0] = { ...native, section: 'Job search' };
    if (kind === 'wrong_form') seen.fields[0] = { ...native, form: 1 };
    if (kind === 'duplicate_label') seen.fields.push({ ...native, id: 'another', form: 1 });
    if (kind === 'duplicate_frame_id') seen.fields.push({ ...native, label: 'Unrelated', frame: 1 });
    if (kind === 'incomplete') seen.complete = false;
    if (kind === 'unstable') seen.stable = false;
    if (kind === 'wrong_url') seen.sourceUrl = 'https://another.example.com/apply/';
    expect(revalidatedPortalQuestions(context(store), seen, now).changed).toBe(false);
    expect(store.read(`${base}/automation/flow`).heldBy).toEqual([`question:${question.id}`]);
  });

  it.each(['Do you hold a Swiss work permit?', 'Passaporto valido?', 'Parli tedesco?', 'Diplôme requis?', 'Berufserfahrung in Jahren?', 'Unknown operational-looking field'])('never relaxes hard or unknown topics: %s', hardLabel => {
    const store = fixture();
    const current = context(store);
    current.draft.questions = [{ ...question, question: hardLabel, applicationQuestion: hardLabel }];
    expect(revalidatedPortalQuestions(current, proof({ fields: [{ ...native, label: hardLabel }, ...proof().fields.slice(1)] }), now).changed).toBe(false);
  });

  it('keeps answered questions and every confirmed answer intact', () => {
    const store = fixture();
    const current = context(store);
    current.flow.answers = { [question.id]: 'Company website' };
    expect(revalidatedPortalQuestions(current, proof(), now).changed).toBe(false);
    expect(current.flow.answers).toEqual({ [question.id]: 'Company website' });
  });

  it('does not apply any patch or queue when another preserved answer is incompatible', async () => {
    const store = fixture();
    store.docs.set(`${base}/ai_drafts/current`, { ...store.read(`${base}/ai_drafts/current`), questions: [question,
      { id: 'hard_choice', question: 'Qualification?', source: 'match', required: true, type: 'choice', options: ['A', 'B'] }] });
    store.docs.set(`${base}/automation/flow`, { ...store.read(`${base}/automation/flow`), answers: { hard_choice: 'Invented' } });
    const before = structuredClone(store.read(`${base}/ai_drafts/current`));
    expect(await reconcilePortalQuestions({ ...options(store), apply: true })).toMatchObject({ changed: 0, queued: 0, unknown: 1 });
    expect(store.read(`${base}/ai_drafts/current`)).toEqual(before);
    expect(store.read(base).automationDueAt).toBeNull();
  });

  it.each(['paid', 'retention', 'withdrawn', 'submitting', 'sent', 'sending', 'clicked', 'sent_attempt', 'round', 'unapproved'])('fails closed when eligibility changes: %s', kind => {
    const store = fixture();
    const current: any = context(store);
    if (kind === 'paid') current.order.paymentStatus = 'pending';
    if (kind === 'retention') current.order.cvUploadedAt = daysAgo(91);
    if (kind === 'withdrawn') current.order.withdrawnAt = now;
    if (kind === 'submitting') current.flow.state = 'submitting';
    if (kind === 'sent') current.submission.r1.state = 'sent';
    if (kind === 'sending') current.submission.r1.state = 'sending';
    if (kind === 'clicked') current.submission.r1.clickedAt = now;
    if (kind === 'sent_attempt') current.draft.sentAttempt = { at: now };
    if (kind === 'round') current.draft.round = 2;
    if (kind === 'unapproved') current.flow.dispatch.mode = 'draft';
    expect(legacyPortalContractEligible(current, now)).toBe(false);
  });

  it('rejects a concurrent answer or draft mutation after the public probe', async () => {
    const store = fixture();
    const probe = async () => {
      store.docs.set(`${base}/automation/flow`, { ...store.read(`${base}/automation/flow`), answers: { [question.id]: 'Event' } });
      return proof();
    };
    expect(await reconcilePortalQuestions({ ...options(store), probe, apply: true })).toMatchObject({ raced: 1, changed: 0, queued: 0 });
    expect(store.read(`${base}/ai_drafts/current`).questions).toEqual([question]);
  });

  it('backs off transient probes, caps retries and advances its cursor fairly', async () => {
    const store = fixture('order_a');
    for (const [key, value] of fixture('order_b').docs) store.docs.set(key, value);
    const probe = vi.fn(async () => ({ complete: false, readOnly: true, reason: 'transient_probe_failure' }));
    const ctx = { ...options(store), probe, apply: true, maxProbes: 1 };
    expect(await reconcilePortalQuestions(ctx)).toMatchObject({ probed: 1, unknown: 1 });
    expect(store.read('assisted_application_maintenance/native-contract-v1').cursor).toBe('order_a');
    expect(await reconcilePortalQuestions(ctx)).toMatchObject({ probed: 1, unknown: 1 });
    expect(store.read('assisted_application_maintenance/native-contract-v1').cursor).toBeNull();
    expect(await reconcilePortalQuestions(ctx)).toMatchObject({ probed: 0, alreadyChecked: 2 });
    expect(probe).toHaveBeenCalledTimes(2);
    for (const elapsed of [6 * 60_000, 37 * 60_000]) {
      const afterBackoff = { ...ctx, now: () => now + elapsed };
      await reconcilePortalQuestions(afterBackoff);
      await reconcilePortalQuestions(afterBackoff);
    }
    expect(probe).toHaveBeenCalledTimes(6);
    expect(await reconcilePortalQuestions({ ...ctx, now: () => now + 60 * 60_000 }))
      .toMatchObject({ probed: 0, alreadyChecked: 2 });
  });

  it.each([false, true])('does not declassify a newly returned conditional hold twice, including regenerated IDs: %s', async regenerate => {
    const store = fixture();
    await reconcilePortalQuestions({ ...options(store), apply: true });
    const returned = { ...question, id: regenerate ? 'portal_source_regenerated' : question.id };
    store.docs.set(`${base}/ai_drafts/current`, { ...store.read(`${base}/ai_drafts/current`), questions: [returned] });
    store.docs.set(`${base}/automation/flow`, { ...store.read(`${base}/automation/flow`), heldSince: now + 1, heldBy: [`question:${returned.id}`] });
    expect(await reconcilePortalQuestions({ ...options(store), apply: true })).toMatchObject({ changed: 0, queued: 0 });
    expect(store.read(`${base}/ai_drafts/current`).questions).toEqual([returned]);
  });

  it('invalidates an optional proof when the current apply URL or round changes', async () => {
    const store = fixture();
    await reconcilePortalQuestions({ ...options(store), apply: true });
    const after = context(store);
    for (const draft of [
      { ...after.draft, channel: { applyUrl: 'https://new.example.com/apply/' } },
      { ...after.draft, round: 2 },
    ]) {
      const visible = questionsForCandidate(draft.questions, {}, {}, {}, draft);
      expect(visible).toHaveLength(1);
      expect(visible[0].required).toBe(true);
      expect(transition(after.flow, { type: 'tick' }, { draft, nowMs: now }).effects)
        .not.toContainEqual(expect.objectContaining({ mode: 'submit' }));
    }
  });

  it('does not hide optional hard or unknown questions without native operational proof', () => {
    const hard = { id: 'permit', source: 'portal', question: 'Work permit?', required: false };
    expect(questionsForCandidate([hard], {}, {})).toEqual([hard]);
  });
});

describe('operational routing domain, across candidate and application languages', () => {
  it.each(['Come sono venuto a conoscenza del lavoro?', 'How did you hear about this job?',
    'Wie sind Sie auf uns aufmerksam geworden?', "Comment avez-vous eu connaissance de cette offre d'emploi?"])
  ('recognizes a complete recruitment routing question: %s', label => {
    expect(relaxablePortalQuestionTopic({ question: label, applicationQuestion: label })).toBe('recruitment_source');
  });
  it.each(['Come sei venuto a conoscenza delle norme sul permesso di lavoro?', 'How did you acquire your English skills?',
    'Wie haben Sie Ihre Berufserfahrung erworben?', 'Comment avez-vous obtenu votre diplôme?',
    'How did you hear about this job and do you have a degree?'])('preserves the neighboring hard question: %s', label => {
    expect(relaxablePortalQuestionTopic({ question: label, applicationQuestion: label })).toBeNull();
  });
});
