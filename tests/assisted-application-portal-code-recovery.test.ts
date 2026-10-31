import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { reconcilePortalCode } from '../scripts/assisted-application/reconcile-portal-code.mjs';
import { currentPortalCodeVersion } from '../scripts/assisted-application/lib/portal-code-version.mjs';
import { transition } from '../functions/src/assistedApplicationFlow.js';

const now = Date.now();
const version = 'b'.repeat(64);
const base = 'assisted_applications/order_code_test';
function fixture() {
  return createMemoryFirestore({
    [base]: { paymentStatus: 'paid', submissionStatus: 'in_progress', automationState: 'owner_takeover', automationDueAt: null, cvUploadedAt: now - 1000,
      cvStorageKey: 'assisted-application-uploads/order_code_test/cv.pdf',
      cvFileCheck: { key: 'assisted-application-uploads/order_code_test/cv.pdf', verdict: 'ok', detectedType: 'pdf' },
      consentVersion: 'assisted-application-v2', consentedAt: now - 1000 },
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

  it.each(['not_approved', 'same_code', 'withdrawn', 'sent', 'ambiguous', 'clicked', 'hard_question', 'confirmed_history', 'expired', 'disabled'])('does not resume %s', async kind => {
    const store = fixture();
    const flowPath = `${base}/automation/flow`;
    if (kind === 'not_approved') store.docs.set(flowPath, { ...store.read(flowPath), dispatch: { mode: 'draft', round: 1 } });
    if (kind === 'same_code') store.docs.set(flowPath, { ...store.read(flowPath), portalCodeVersion: version });
    if (kind === 'withdrawn') store.docs.set(base, { ...store.read(base), withdrawnAt: now });
    if (kind === 'expired') store.docs.set(flowPath, { ...store.read(flowPath), postingExpiredAt: now });
    if (kind === 'confirmed_history') store.docs.set(flowPath, { ...store.read(flowPath), history: [{ state: 'submitted', event: 'submit_succeeded' }] });
    if (kind === 'hard_question') store.docs.set(`${base}/ai_drafts/current`, { ...store.read(`${base}/ai_drafts/current`), questions: [{ id: 'salary', question: 'Desired salary?', required: true, type: 'text' }] });
    if (['sent', 'ambiguous', 'clicked'].includes(kind)) store.docs.set(`${base}/automation/submission`, { r1: {
      state: kind === 'sent' ? 'sent' : kind === 'ambiguous' ? 'sending' : 'failed', channel: 'portal', clickedAt: now, releasedAt: now,
    } });
    expect(await reconcilePortalCode({ db: store.db, version, apply: true, nowMs: now, isEnabled: async () => kind !== 'disabled' })).toMatchObject({ eligible: 0, queued: 0 });
    expect(store.read(base).automationDueAt).toBeNull();
  });

  it.each(['portal:upload_failed', 'portal:cv_upload_failed', 'portal:question_label_unreadable', 'portal:portal_choice_not_registered', 'portal:captcha', 'portal:portal_antibot', 'portal:remote_executor_unavailable'])('recovers a fixed portal stop only with pre-click failed proof: %s', async reason => {
    const store = fixture();
    store.docs.set(`${base}/automation/flow`, { ...store.read(`${base}/automation/flow`), heldBy: [reason] });
    const ctx = { db: store.db, version, apply: true, nowMs: now, isEnabled: async () => true };
    expect(await reconcilePortalCode(ctx)).toMatchObject({ queued: 1 });
    const ambiguous = fixture();
    ambiguous.docs.set(`${base}/automation/flow`, { ...ambiguous.read(`${base}/automation/flow`), heldBy: [reason] });
    ambiguous.docs.set(`${base}/automation/submission`, { r1: { state: 'failed', channel: 'portal', clickedAt: now, releasedAt: now } });
    expect(await reconcilePortalCode({ ...ctx, db: ambiguous.db })).toMatchObject({ queued: 0 });
  });

  it.each(['unpaid', 'not_approved', 'wrong_round', 'same_code', 'already_recovered', 'withdrawn', 'purged', 'refunded', 'sent_attempt', 'sent', 'ambiguous', 'clicked', 'other_round_sent', 'hard_question', 'no_source', 'expired', 'disabled', 'reason_not_exact'])('retains the existing recovery fences for an unregistered choice: %s', async kind => {
    const store = fixture();
    const flowPath = `${base}/automation/flow`, draftPath = `${base}/ai_drafts/current`, submissionPath = `${base}/automation/submission`;
    store.docs.set(flowPath, { ...store.read(flowPath), heldBy: ['portal:portal_choice_not_registered'] });
    if (kind === 'unpaid') store.docs.set(base, { ...store.read(base), paymentStatus: 'pending' });
    if (kind === 'not_approved') store.docs.set(flowPath, { ...store.read(flowPath), dispatch: { mode: 'draft', round: 1 } });
    if (kind === 'wrong_round') store.docs.set(draftPath, { ...store.read(draftPath), round: 2 });
    if (kind === 'same_code') store.docs.set(flowPath, { ...store.read(flowPath), portalCodeVersion: version });
    if (kind === 'already_recovered') store.docs.set(flowPath, { ...store.read(flowPath), portalRecoveryVersion: version });
    if (kind === 'withdrawn') store.docs.set(base, { ...store.read(base), withdrawnAt: now });
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

  it('retains the provider-outage lane instead of treating it as an unanswered personal question', async () => {
    const store = fixture();
    store.docs.set(`${base}/automation/flow`, { ...store.read(`${base}/automation/flow`), heldBy: ['portal:captcha_provider_unavailable'] });
    await reconcilePortalCode({ db: store.db, version, apply: true, nowMs: now, isEnabled: async () => true });
    expect(store.read(`${base}/automation/flow`).heldBy).toEqual(['portal:captcha_provider_unavailable']);
  });

  it('changes the fingerprint only for runner sources and covers those files in the workflow trigger', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'portal-source-version-'));
    const sourceFiles = [
      'scripts/assisted-application/agent.mjs', 'scripts/assisted-application/lib/submit.mjs',
      'scripts/assisted-application/lib/portal-code-version.mjs', 'scripts/assisted-application/extension/apply-control.js',
      'scripts/assisted-application/install-nopecha.sh', 'scripts/assisted-application/lib/portal/fields.mjs',
      'functions/src/assistedApplicationReceiptReconcile.js', 'functions/src/lib/submissionReceiptContract.js', 'functions/src/lib/qualificationCounterContext.js', 'functions/src/lib/submittedOrderFields.js', 'functions/src/assistedApplicationExecution.js', 'functions/src/assistedApplicationEligibility.js', 'functions/src/codexFallback.js',
      'functions/src/lib/assistedApplicationRetentionPolicy.js', 'functions/src/lib/assistedApplicationArtifactRetention.js', 'functions/src/assistedApplicationFollowup.js', 'scripts/assisted-application/lib/secure-run.mjs', 'scripts/assisted-application/lib/draft.mjs', 'scripts/assisted-application/lib/docx-inplace.mjs',
      'functions/src/lib/portalChannels.js', 'functions/src/lib/portalInfrastructureEvidence.js',
      'scripts/assisted-application/remote-controller.mjs', 'scripts/assisted-application/remote-executor.mjs',
      'scripts/assisted-application/supervised-agent.mjs', 'scripts/assisted-application/lib/execution-runtime.mjs',
      'scripts/assisted-application/lib/execution-release.mjs', 'scripts/assisted-application/lib/execution-artifacts.mjs',
      'scripts/assisted-application/lib/execution-process.mjs',
      'scripts/assisted-application/lib/browser-ownership.mjs', 'scripts/assisted-application/lib/process-registry.mjs',
      'scripts/assisted-application/lib/browser-egress.mjs', 'scripts/lib/prospector/public-fetch-policy.mjs',
      'scripts/assisted-application/nopecha-e2e.mjs',
      'scripts/assisted-application/lib/darwin-isolation.mjs', 'scripts/assisted-application/report-runner-failure.mjs',
      '.github/actions/setup-codex-darwin-broker/bootstrap.mjs', '.github/actions/setup-codex-darwin-broker/native-auth.mjs', '.github/actions/setup-codex-darwin-broker/sandbox-probe.mjs', '.github/actions/setup-codex-darwin-broker/process-privacy-probe.mjs',
      '.github/actions/setup-claude-haiku-fallback/codex-auth-broker.mjs', '.github/actions/setup-claude-haiku-fallback/broker-permissions.mjs', '.github/actions/setup-claude-haiku-fallback/concierge-tools.mjs', '.github/actions/setup-claude-haiku-fallback/concierge-model-source.json', '.github/actions/setup-claude-haiku-fallback/concierge-tool-probe.mjs', '.github/actions/setup-claude-haiku-fallback/action.yml',
      ...['assistedApplicationOperationalAnswers.js', 'assistedApplicationCandidateEdits.js', 'assistedApplicationFlow.js',
        'assistedApplicationPortalRetryPolicy.js', 'assistedApplicationPortalRecoveryPolicy.js', 'assistedApplicationSubmissionGuard.js', 'lib/answerRules.js', 'lib/portalQuestionText.js', 'lib/portalNativeContract.js'].map(file => `functions/src/${file}`),
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
      write('functions/src/lib/portalQuestionText.js', 'fixed question readability');
      expect(currentPortalCodeVersion(root)).not.toBe(afterFields);
      const workflow = YAML.parse(readFileSync(new URL('../.github/workflows/assisted-application-portal-recovery.yml', import.meta.url), 'utf8'));
      expect(workflow.jobs.recover.steps.find((step: any) => step.uses?.startsWith('actions/checkout@')).with['sparse-checkout']).toContain('.github/actions');
      for (const file of sourceFiles) expect(workflow.on.push.paths.some((pattern: string) => pattern.endsWith('/**') ? file.startsWith(pattern.slice(0, -2)) : file === pattern)).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
