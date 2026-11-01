import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { reconcilePortalCode } from '../scripts/assisted-application/reconcile-portal-code.mjs';
import { currentPortalCodeVersion } from '../scripts/assisted-application/lib/portal-code-version.mjs';
import { transition } from '../functions/src/assistedApplicationFlow.js';
import { candidateQuestionAnswerKey } from '../functions/src/assistedApplicationCandidateEdits.js';
import { operationalPortalRecoveryReady } from '../functions/src/assistedApplicationPortalRecoveryPolicy.js';

const now = Date.now();
const version = 'b'.repeat(64);
const base = 'assisted_applications/order_code_test';
function fixture() {
  return createMemoryFirestore({
    [base]: { paymentStatus: 'paid', submissionStatus: 'in_progress', automationState: 'owner_takeover', automationDueAt: null },
    [`${base}/automation/flow`]: { state: 'owner_takeover', round: 1, heldBy: ['portal:account'], portalCodeVersion: 'a'.repeat(64),
      dispatch: { mode: 'submit', round: 1 }, portalAutoRetryCount: 2 },
    [`${base}/ai_drafts/current`]: { status: 'ready', round: 1, questions: [], job: { source: 'job_detail' }, channel: { type: 'employer_site' }, factCheck: { ok: true } },
    [`${base}/automation/submission`]: { r1: { state: 'failed', channel: 'portal', releasedAt: now - 1000, clickedAt: null } },
  });
}
describe('automatic recovery after a portal fix', () => {
  it('previews and queues an approved unsent application exactly once per engine version', async () => {
    const store = fixture();
    const ctx = { db: store.db, version, nowMs: now, isEnabled: async () => true };
    expect(await reconcilePortalCode(ctx)).toMatchObject({ eligible: 1, queued: 0 });
    expect(store.read(base).automationDueAt).toBeNull();
    expect(await reconcilePortalCode({ ...ctx, apply: true })).toMatchObject({ eligible: 1, queued: 1 });
    const flow = store.read(`${base}/automation/flow`);
    expect(flow).toMatchObject({ state: 'owner_takeover', portalAutoRetryAt: now, portalRecoveryVersion: version, portalAutoRetryCount: 0 });
    expect(transition(flow, { type: 'portal_auto_retry' }, { draft: store.read(`${base}/ai_drafts/current`), nowMs: now }).effects)
      .toEqual([{ type: 'dispatch', mode: 'submit', reason: 'portal_auto_retry' }]);
    expect(await reconcilePortalCode({ ...ctx, apply: true })).toMatchObject({ eligible: 0, queued: 0 });
    // A rolling deployment may omit the new flow field; the separate receipt survives it.
    store.docs.set(`${base}/automation/flow`, { ...flow, portalRecoveryVersion: null });
    expect(await reconcilePortalCode({ ...ctx, apply: true })).toMatchObject({ eligible: 0, queued: 0 });
    expect(store.list(`${base}/events/`)).toHaveLength(1);
  });

  it('requeues an old recovery receipt once when the source resolver version changes', async () => {
    const store = fixture();
    const oldVersion = 'a'.repeat(64);
    const flowPath = `${base}/automation/flow`;
    const submissionPath = `${base}/automation/submission`;
    store.docs.set(flowPath, { ...store.read(flowPath), portalCodeVersion: oldVersion, portalRecoveryVersion: oldVersion });
    store.docs.set(submissionPath, { ...store.read(submissionPath),
      portalCodeRecovery: { version: oldVersion, round: 1, queuedAt: now - 1000 } });

    const ctx = { db: store.db, version, apply: true, nowMs: now, isEnabled: async () => true };
    expect(await reconcilePortalCode(ctx)).toMatchObject({ eligible: 1, queued: 1 });
    expect(store.read(flowPath).portalRecoveryVersion).toBe(version);
    expect(store.read(submissionPath).portalCodeRecovery).toMatchObject({ version, round: 1, queuedAt: now });
    expect(await reconcilePortalCode(ctx)).toMatchObject({ eligible: 0, queued: 0 });
    expect(store.list(`${base}/events/`)).toHaveLength(1);
  });

  it.each(['not_approved', 'same_code', 'withdrawn', 'sent', 'ambiguous', 'clicked', 'hard_question', 'captcha', 'expired', 'disabled'])('does not resume %s', async kind => {
    const store = fixture();
    const flowPath = `${base}/automation/flow`;
    if (kind === 'not_approved') store.docs.set(flowPath, { ...store.read(flowPath), dispatch: { mode: 'draft', round: 1 } });
    if (kind === 'same_code') store.docs.set(flowPath, { ...store.read(flowPath), portalCodeVersion: version });
    if (kind === 'withdrawn') store.docs.set(base, { ...store.read(base), withdrawnAt: now });
    if (kind === 'expired') store.docs.set(flowPath, { ...store.read(flowPath), postingExpiredAt: now });
    if (kind === 'captcha') store.docs.set(flowPath, { ...store.read(flowPath), heldBy: ['portal:captcha'] });
    if (kind === 'hard_question') store.docs.set(`${base}/ai_drafts/current`, { ...store.read(`${base}/ai_drafts/current`), questions: [{ id: 'salary', question: 'Desired salary?', required: true, type: 'text' }] });
    if (['sent', 'ambiguous', 'clicked'].includes(kind)) store.docs.set(`${base}/automation/submission`, { r1: {
      state: kind === 'sent' ? 'sent' : kind === 'ambiguous' ? 'sending' : 'failed', channel: 'portal', clickedAt: now, releasedAt: now,
    } });
    expect(await reconcilePortalCode({ db: store.db, version, apply: true, nowMs: now, isEnabled: async () => kind !== 'disabled' })).toMatchObject({ eligible: 0, queued: 0 });
    expect(store.read(base).automationDueAt).toBeNull();
  });

  it.each(['portal:account_create_unanswered', 'portal:upload_failed', 'portal:cv_upload_failed', 'portal:question_label_unreadable', 'portal:portal_choice_not_registered'])('recovers a fixed portal stop only with pre-click failed proof: %s', async reason => {
    const store = fixture();
    store.docs.set(`${base}/automation/flow`, { ...store.read(`${base}/automation/flow`), heldBy: [reason] });
    const ctx = { db: store.db, version, apply: true, nowMs: now, isEnabled: async () => true };
    expect(await reconcilePortalCode(ctx)).toMatchObject({ queued: 1 });
    const ambiguous = fixture();
    ambiguous.docs.set(`${base}/automation/flow`, { ...ambiguous.read(`${base}/automation/flow`), heldBy: [reason] });
    ambiguous.docs.set(`${base}/automation/submission`, { r1: { state: 'failed', channel: 'portal', clickedAt: now, releasedAt: now } });
    expect(await reconcilePortalCode({ ...ctx, db: ambiguous.db })).toMatchObject({ queued: 0 });
  });

  it.each(['unpaid', 'not_approved', 'wrong_round', 'same_code', 'already_recovered', 'withdrawn', 'purging', 'purged', 'refunded', 'sent_attempt', 'sent', 'ambiguous', 'clicked', 'other_round_sent', 'hard_question', 'no_source', 'expired', 'disabled', 'reason_not_exact'])('retains the existing recovery fences for an unregistered choice: %s', async kind => {
    const store = fixture();
    const flowPath = `${base}/automation/flow`, draftPath = `${base}/ai_drafts/current`, submissionPath = `${base}/automation/submission`;
    store.docs.set(flowPath, { ...store.read(flowPath), heldBy: ['portal:portal_choice_not_registered'] });
    if (kind === 'unpaid') store.docs.set(base, { ...store.read(base), paymentStatus: 'pending' });
    if (kind === 'not_approved') store.docs.set(flowPath, { ...store.read(flowPath), dispatch: { mode: 'draft', round: 1 } });
    if (kind === 'wrong_round') store.docs.set(draftPath, { ...store.read(draftPath), round: 2 });
    if (kind === 'same_code') store.docs.set(flowPath, { ...store.read(flowPath), portalCodeVersion: version });
    if (kind === 'already_recovered') store.docs.set(flowPath, { ...store.read(flowPath), portalRecoveryVersion: version });
    if (kind === 'withdrawn') store.docs.set(base, { ...store.read(base), withdrawnAt: now });
    if (kind === 'purging') store.docs.set(base, { ...store.read(base), retentionPurgingAt: now });
    if (kind === 'purged') store.docs.set(base, { ...store.read(base), retentionPurgedAt: now });
    if (kind === 'refunded') store.docs.set(base, { ...store.read(base), refundStatus: 'succeeded' });
    if (kind === 'sent_attempt') store.docs.set(draftPath, { ...store.read(draftPath), sentAttempt: { at: now } });
    if (['sent', 'ambiguous', 'clicked'].includes(kind)) store.docs.set(submissionPath, { r1: {
      state: kind === 'sent' ? 'sent' : kind === 'ambiguous' ? 'sending' : 'failed', channel: 'portal', clickedAt: now, releasedAt: now,
    } });
    if (kind === 'other_round_sent') store.docs.set(submissionPath, { ...store.read(submissionPath), r2: { state: 'sent', channel: 'portal' } });
    if (kind === 'hard_question') store.docs.set(draftPath, { ...store.read(draftPath), questions: [{ id: 'salary', question: 'Desired salary?', required: true, type: 'text' }] });
    if (kind === 'no_source') store.docs.set(draftPath, { ...store.read(draftPath), job: { source: 'none' } });
    if (kind === 'expired') store.docs.set(flowPath, { ...store.read(flowPath), postingExpiredAt: now });
    if (kind === 'reason_not_exact') store.docs.set(flowPath, { ...store.read(flowPath), heldBy: ['portal:portal_choice_not_registered_extra'] });
    expect(await reconcilePortalCode({ db: store.db, version, apply: true, nowMs: now, isEnabled: async () => kind !== 'disabled' })).toMatchObject({ eligible: 0, queued: 0 });
    expect(store.read(base).automationDueAt).toBeNull();
    expect(store.list(`${base}/events/`)).toHaveLength(0);
  });

  it('queues a resolved choice exactly once without changing its approved round or saved answers', async () => {
    const store = fixture(), flowPath = `${base}/automation/flow`;
    const answers = { confirmed_fact: 'candidate supplied value' };
    const dispatch = { mode: 'submit', round: 1 };
    store.docs.set(flowPath, { ...store.read(flowPath), heldBy: ['portal:portal_choice_not_registered'], answers, dispatch });
    const ctx = { db: store.db, version, apply: true, nowMs: now, isEnabled: async () => true };
    expect(await reconcilePortalCode(ctx)).toMatchObject({ queued: 1 });
    expect(store.read(flowPath)).toMatchObject({ round: 1, answers, dispatch, portalRecoveryVersion: version });
    expect(await reconcilePortalCode(ctx)).toMatchObject({ queued: 0 });
    expect(store.list(`${base}/events/`)).toHaveLength(1);
  });

  it('does not let opaque legacy memories clear a required question during recovery', async () => {
    const store = fixture();
    const flowPath = `${base}/automation/flow`;
    const draftPath = `${base}/ai_drafts/current`;
    const question = { id: 'big_four_experience', question: 'Have you worked in a Big Four consulting firm or equivalent?', required: true, type: 'text' };
    const key = candidateQuestionAnswerKey(question);
    const legacyAnswer = 'Example Consulting GmbH, Project Lead, 2020-2022';
    const userId = 'candidate-answer-evidence-test';
    store.docs.set(base, { ...store.read(base), userId });
    store.docs.set(draftPath, { ...store.read(draftPath), questions: [question] });
    store.docs.set(flowPath, { ...store.read(flowPath), questionAnswers: { [key]: legacyAnswer } });
    store.docs.set(`user_cv_profiles/${userId}`, { applicationQuestionAnswers: { [key]: legacyAnswer } });

    const ctx = { db: store.db, version, apply: true, nowMs: now, isEnabled: async () => true };
    expect(await reconcilePortalCode(ctx)).toMatchObject({ eligible: 0, queued: 0 });
    expect(store.read(base).automationDueAt).toBeNull();

    // The same order's saved answer remains usable, and recovery persists only its order-local projection.
    const orderAnswer = 'Example Consulting GmbH, Senior Consultant, 2021-2023';
    store.docs.set(flowPath, { ...store.read(flowPath), answers: { [question.id]: orderAnswer } });
    expect(await reconcilePortalCode(ctx)).toMatchObject({ eligible: 1, queued: 1 });
    expect(store.read(flowPath).questionAnswers).toEqual({ [key]: orderAnswer });
  });

  it('does not let raw legacy flow or profile answers clear an operational hold', async () => {
    const store = fixture();
    const userId = 'candidate-answer-evidence-test';
    const flowPath = `${base}/automation/flow`, draftPath = `${base}/ai_drafts/current`;
    const question = { id: 'notice_period', source: 'portal', question: 'Qual è il tuo periodo di preavviso?',
      applicationQuestion: 'Qual è il tuo periodo di preavviso?', required: true, type: 'text' };
    const order = { ...store.read(base), userId, consentVersion: 'assisted-application-v2', consentedAt: now,
      talentPoolConsent: true };
    const flow = { ...store.read(flowPath), heldBy: ['portal:portal_needs_candidate'],
      answers: { notice_period: '3 mesi' }, dispatch: { mode: 'submit', round: 1, requestedAt: now } };
    const draft = { ...store.read(draftPath), completedAt: now - 1, questions: [question] };
    store.docs.set(base, order);
    store.docs.set(flowPath, flow);
    store.docs.set(draftPath, draft);
    store.docs.set(`user_cv_profiles/${userId}`, { applicationQuestionAnswers: { notice_period: '3 mesi' } });
    expect(operationalPortalRecoveryReady({ order, flow, draft })).toBe(true);

    expect(await reconcilePortalCode({ db: store.db, version, apply: true, nowMs: now, isEnabled: async () => true }))
      .toMatchObject({ eligible: 0, queued: 0 });
    expect(store.read(base).automationDueAt).toBeNull();
    expect(store.read(flowPath).answers).toEqual(flow.answers);
  });

  it('retains the provider-outage lane instead of treating it as an unanswered personal question', async () => {
    const store = fixture();
    store.docs.set(`${base}/automation/flow`, { ...store.read(`${base}/automation/flow`), heldBy: ['portal:captcha_provider_unavailable'] });
    await reconcilePortalCode({ db: store.db, version, apply: true, nowMs: now, isEnabled: async () => true });
    expect(store.read(`${base}/automation/flow`).heldBy).toEqual(['portal:captcha_provider_unavailable']);
  });

  it('changes the fingerprint only for runner sources and covers those files in the workflow trigger', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'portal-source-version-'));
    const sourceFiles = [
      'scripts/lib/prospector/public-fetch-policy.mjs',
      'scripts/assisted-application/verify-portal.mjs',
      'scripts/assisted-application/reconcile-portal-code.mjs', 'scripts/assisted-application/reconcile-portal-questions.mjs',
      'scripts/assisted-application/agent.mjs', 'scripts/assisted-application/lib/submit.mjs',
      'scripts/assisted-application/lib/portal-code-version.mjs', 'scripts/assisted-application/extension/apply-control.js',
      'scripts/assisted-application/install-nopecha.sh', 'scripts/assisted-application/lib/portal/fields.mjs',
      ...['assistedApplicationConstants.js', 'assistedApplicationPortalSites.js', 'assistedApplicationRetention.js', 'assistedApplicationExtraDocuments.js',
        'assistedApplicationOperationalAnswers.js', 'assistedApplicationCandidateEdits.js', 'assistedApplicationFlow.js',
        'assistedApplicationPortalRetryPolicy.js', 'assistedApplicationPortalRecoveryPolicy.js', 'assistedApplicationSubmissionGuard.js',
        'assistedApplicationAutomation.js', 'assistedApplicationAutomationAdmin.js', 'assistedApplicationCvCommit.js', 'assistedApplicationReview.js',
        'assistedApplicationAnswerEvidence.js', 'assistedApplicationPortalRetryPolicy.js', 'assistedApplicationPortalRecoveryPolicy.js', 'assistedApplicationSubmissionGuard.js',
        'lib/candidateAnswerFacts.js', 'lib/languageFacts.js', 'lib/addressContextContract.js', 'lib/permitStatus.js',
        'lib/applicationConsent.js', 'lib/portalNativeContract.js', 'lib/answerRules.js', 'lib/portalQuestionText.js',
        'lib/assistedApplicationQuestionConstraints.js'].map(file => `functions/src/${file}`),
    ];
    const write = (file: string, text: string) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), text); };
    try {
      for (const file of sourceFiles) write(file, 'original source');
      const before = currentPortalCodeVersion(root);
      write('data/jobs.json', 'changed public postings');
      expect(currentPortalCodeVersion(root)).toBe(before);
      write('scripts/assisted-application/lib/portal/fields.mjs', 'fixed selector');
      expect(currentPortalCodeVersion(root)).not.toBe(before);
      const afterFields = currentPortalCodeVersion(root);
      write('scripts/assisted-application/reconcile-portal-questions.mjs', 'fixed question recovery provenance');
      expect(currentPortalCodeVersion(root)).not.toBe(afterFields);
      const afterQuestionRecovery = currentPortalCodeVersion(root);
      write('functions/src/lib/portalQuestionText.js', 'fixed question readability');
      expect(currentPortalCodeVersion(root)).not.toBe(afterQuestionRecovery);
      const afterQuestions = currentPortalCodeVersion(root);
      write('functions/src/assistedApplicationPortalSites.js', 'fixed exact verification host');
      expect(currentPortalCodeVersion(root)).not.toBe(afterQuestions);
      const afterPortalSites = currentPortalCodeVersion(root);
      write('functions/src/assistedApplicationAnswerEvidence.js', 'updated attested answer resolver');
      expect(currentPortalCodeVersion(root)).not.toBe(afterPortalSites);
      const afterAnswerEvidence = currentPortalCodeVersion(root);
      write('functions/src/assistedApplicationAutomation.js', 'updated runner answer resolver integration');
      expect(currentPortalCodeVersion(root)).not.toBe(afterAnswerEvidence);
      const afterAutomation = currentPortalCodeVersion(root);
      write('functions/src/assistedApplicationCvCommit.js', 'updated answer evidence marker writer');
      expect(currentPortalCodeVersion(root)).not.toBe(afterAutomation);
      const afterCvCommit = currentPortalCodeVersion(root);
      write('functions/src/assistedApplicationReview.js', 'updated question snapshot save validator');
      expect(currentPortalCodeVersion(root)).not.toBe(afterCvCommit);
      const afterReview = currentPortalCodeVersion(root);
      write('functions/src/assistedApplicationAutomationAdmin.js', 'updated owner answer snapshot validator');
      expect(currentPortalCodeVersion(root)).not.toBe(afterReview);
      const afterAdmin = currentPortalCodeVersion(root);
      write('functions/src/lib/assistedApplicationQuestionConstraints.js', 'fixed shared visible question constraints');
      expect(currentPortalCodeVersion(root)).not.toBe(afterAdmin);
      const afterQuestionConstraints = currentPortalCodeVersion(root);
      write('functions/src/lib/applicationConsent.js', 'fixed notice grammar');
      expect(currentPortalCodeVersion(root)).not.toBe(afterQuestionConstraints);
      const workflow = YAML.parse(readFileSync(new URL('../.github/workflows/assisted-application-portal-recovery.yml', import.meta.url), 'utf8'));
      for (const file of sourceFiles) expect(workflow.on.push.paths.some((pattern: string) => pattern.endsWith('/**') ? file.startsWith(pattern.slice(0, -2)) : file === pattern)).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
