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
      ...['assistedApplicationOperationalAnswers.js', 'assistedApplicationCandidateEdits.js', 'assistedApplicationFlow.js',
        'assistedApplicationPortalRetryPolicy.js', 'assistedApplicationPortalRecoveryPolicy.js', 'lib/answerRules.js'].map(file => `functions/src/${file}`),
    ];
    const write = (file: string, text: string) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), text); };
    try {
      for (const file of sourceFiles) write(file, 'original source');
      const before = currentPortalCodeVersion(root);
      write('data/jobs.json', 'changed public postings');
      expect(currentPortalCodeVersion(root)).toBe(before);
      write('scripts/assisted-application/lib/portal/fields.mjs', 'fixed selector');
      expect(currentPortalCodeVersion(root)).not.toBe(before);
      const workflow = YAML.parse(readFileSync(new URL('../.github/workflows/assisted-application-portal-recovery.yml', import.meta.url), 'utf8'));
      for (const file of sourceFiles) expect(workflow.on.push.paths.some((pattern: string) => pattern.endsWith('/**') ? file.startsWith(pattern.slice(0, -2)) : file === pattern)).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
