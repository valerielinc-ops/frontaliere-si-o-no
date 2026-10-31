import assert from 'node:assert/strict';
import { describe, it, vi } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';

const runtime = vi.hoisted(() => ({ db: null as any }));
vi.mock('../functions/src/githubProxy.js', () => ({
  GITHUB_API: 'https://example.invalid/', getRepoConfig: async () => { throw new Error('unexpected_network'); },
}));
vi.mock('../functions/src/newsletterResendWebhookCore.js', () => ({
  getAdminDb: () => runtime.db, ensureAdminApp: () => {},
}));
vi.mock('../functions/src/stripePublisherCore.js', () => ({
  verifyCaller: async () => ({ uid: 'candidate-test' }), db: () => runtime.db,
  getStripe: () => { throw new Error('unexpected_payment'); },
}));

const { publicSubmissionState, submissionIrreversibility } = await import('../functions/src/assistedApplicationSubmissionState.js');
const { applyAutomationEvent } = await import('../functions/src/assistedApplicationAutomation.js');
const { handleAssistedApplicationReview, buildReviewPayload } = await import('../functions/src/assistedApplicationReview.js');
const { handleApplicationConcierge } = await import('../functions/src/applicationConciergeCore.js');
const { mintReviewToken } = await import('../functions/src/assistedApplicationReviewToken.js');

const ORDER = 'order_SENT123';
const BASE = `assisted_applications/${ORDER}`;
const SERVICE = 'service_SENT123';
const SERVICE_BASE = `application_concierge_services/${SERVICE}`;
const SECRET = 'submission-state-test-secret'.repeat(2);
const NOW = Date.now();
const readyDraft = () => ({ status: 'ready', round: 1, verdict: 'good', factCheck: { ok: true, unsupported: [] },
  questions: [], job: { source: 'job_detail', title: 'Test role' }, channel: { type: 'lever' },
  coverLetterPdfKey: `assisted-application-uploads/${ORDER}/current-unsent-letter.pdf`,
  coverLetter: { subject: 'Application', text: 'Application text' },
});

function seed(submission: Record<string, any> = {}, state = 'candidate_review', extra: Record<string, any> = {}) {
  const store = createMemoryFirestore({
    [BASE]: { paymentStatus: 'paid', submissionStatus: 'in_progress', locale: 'it', userId: 'candidate-test',
      parentServiceId: SERVICE, parentProposalId: 'proposal-test', ...extra.order },
    [`${BASE}/automation/flow`]: { state, round: 1, answers: {}, feedback: [], ...extra.flow },
    [`${BASE}/ai_drafts/current`]: { ...readyDraft(), ...extra.draft },
    [`${BASE}/automation/submission`]: submission,
    [SERVICE_BASE]: { userId: 'candidate-test', serviceStatus: 'active', paymentStatus: 'paid' },
    [`${SERVICE_BASE}/proposals/proposal-test`]: { status: 'accepted', childApplicationId: ORDER },
  });
  runtime.db = store.db;
  let writes = 0;
  const transaction = store.db.runTransaction.bind(store.db);
  store.db.runTransaction = (callback: any) => transaction((tx: any) => callback({ ...tx,
    set: (...args: any[]) => { writes++; return tx.set(...args); },
    delete: (...args: any[]) => { writes++; return tx.delete(...args); },
  }));
  const effects: any[] = [];
  const runEffect = async ({ effect }: any) => { effects.push(effect); return { ok: true }; };
  const deps = { db: store.db, runEffect, getSecret: async () => SECRET, nowMs: NOW,
    signUrl: async (key: string) => `https://signed.example/${key.split('/').pop()}` };
  return { store, deps, effects, writes: () => writes };
}

const token = (round = 1) => mintReviewToken({ secret: SECRET, orderId: ORDER, round, nowMs: NOW });
const post = (action: string) => ({ method: 'POST', body: { t: token(), action, feedback: 'Please revise the application.', answers: { available: 'yes' } } });

describe('durable submission public state', () => {
  for (const state of ['submitting', 'owner_takeover', 'candidate_review']) {
    it(`GET detail and concierge agree on SENT with stale ${state}, without attributing current files`, async () => {
      const { store, deps, writes } = seed({ r1: { state: 'sent', channel: 'lever' } }, state, {
        flow: { portalAutoRetryAt: NOW + 1000 },
        order: { employerResponse: { category: 'interview_invite', receivedAt: NOW, needsReply: true } },
      });
      const before = JSON.stringify([...store.docs]);
      const detail = await handleAssistedApplicationReview({ method: 'GET', query: { t: token() } }, deps);
      assert.equal(detail.status, 200);
      assert.equal(detail.body.state, 'submitted');
      assert.equal(detail.body.keptDocuments, null);
      assert.ok(Object.values(detail.body.can).every(value => value === false));
      const list = await handleApplicationConcierge({ method: 'GET', query: { serviceId: SERVICE } });
      assert.equal(list.status, 200);
      const proposal = list.body.service.proposals[0];
      assert.equal(proposal.status, 'accepted');
      assert.equal(proposal.childApplicationState, 'submitted');
      assert.equal(proposal.childCandidateStatus, 'submitted');
      assert.equal(proposal.childSendState, 'sent');
      assert.equal(proposal.childRetryScheduled, false);
      assert.equal(proposal.childEmployerResponse.category, 'interview_invite');
      assert.equal(writes(), 0);
      assert.equal(JSON.stringify([...store.docs]), before);
    });
  }

  it('does not promote a different round or reopen a withdrawn/closed slot', () => {
    assert.equal(publicSubmissionState({ flow: { round: 2, state: 'candidate_review' }, submission: { r1: { state: 'sent' } } }), 'candidate_review');
    for (const submissionStatus of ['withdrawn', 'closed', 'cancelled', 'refunded']) {
      assert.equal(publicSubmissionState({ order: { submissionStatus }, flow: { state: 'withdrawn', round: 1 }, submission: { r1: { state: 'sent' } } }), 'withdrawn');
    }
  });

  it('does not graft prepared documents into a stale flow projected as submitted', () => {
    const payload = buildReviewPayload({ orderId: ORDER, order: {}, flow: { state: 'owner_takeover', round: 1 },
      draft: readyDraft(), round: 1, submission: { r1: { state: 'sent' } },
      keptDocuments: { source: 'prepared', files: [{ name: 'current-unsent.pdf', url: 'https://signed.example/current-unsent.pdf' }] },
    });
    assert.equal(payload.state, 'submitted');
    assert.equal(payload.keptDocuments, null);
  });

  it('keeps only files bound to the canonical sent snapshot even when the flow already says submitted', () => {
    const sent = { at: NOW, files: [{ kind: 'letter', key: `assisted-application-uploads/${ORDER}/actually-sent.pdf` }] };
    const keptDocuments = { source: 'sent', files: [{ name: 'actually-sent.pdf', url: 'https://signed.example/actually-sent.pdf' }] };
    const input = { orderId: ORDER, order: {}, flow: { state: 'submitted', round: 1 }, round: 1, keptDocuments,
      submission: { r1: { state: 'sent', sent } }, draft: { ...readyDraft(), sent } };
    assert.deepEqual(buildReviewPayload(input).keptDocuments, keptDocuments);
    assert.equal(buildReviewPayload({ ...input, draft: { ...readyDraft(), sent: { ...sent, at: NOW + 1 } } }).keptDocuments, null);
    assert.equal(buildReviewPayload({ ...input, draft: readyDraft() }).keptDocuments, null);
    assert.equal(buildReviewPayload({ ...input, keptDocuments: { ...keptDocuments, source: 'prepared' } }).keptDocuments, null);
  });
});

describe('order-wide irreversible submission fence', () => {
  const irreversible = [
    { r1: { state: 'sent' } },
    { r3: { state: 'sent' } },
    { r1: { state: 'sending', channel: 'lever', clickedAt: NOW } },
    { r1: { state: 'sending', channel: 'email', clickedAt: null } },
  ];
  for (const [index, submission] of irreversible.entries()) {
    for (const action of ['approve', 'reject', 'answers']) {
      it(`POST ${action} refuses irreversible ledger ${index} before any write or effect`, async () => {
        const { store, deps, effects, writes } = seed(submission, 'candidate_review', {
          draft: { questions: [{ id: 'available', question: 'Available?', type: 'text' }] },
        });
        const before = JSON.stringify([...store.docs]);
        const result = await handleAssistedApplicationReview(post(action), deps);
        assert.equal(result.status, 409);
        assert.equal(result.body.error, index < 2 ? 'already_sent' : 'submission_unconfirmed');
        assert.equal(result.body.state, index === 0 ? 'submitted' : 'candidate_review');
        assert.equal(writes(), 0);
        assert.deepEqual(effects, []);
        assert.equal(JSON.stringify([...store.docs]), before);
      });
    }
  }

  for (const type of ['candidate_approve', 'candidate_reject', 'candidate_answers', 'owner_approve', 'owner_regenerate', 'owner_resume', 'owner_retry_submit', 'portal_auto_retry', 'tick', 'posting_closed', 'draft_ready']) {
    it(`transaction refuses ${type} after an older-round SENT, without even claiming a runner event`, async () => {
      const { store, deps, effects, writes } = seed({ r2: { state: 'sent' } });
      const result = await applyAutomationEvent({ db: deps.db, orderId: ORDER,
        event: { type, round: 1, feedback: 'Please revise' }, runEffect: deps.runEffect, nowMs: NOW,
        claimRef: store.db.collection('events').doc('unapplied-test'),
      });
      assert.equal(result.ignored, 'already_sent');
      assert.equal(result.state, 'candidate_review');
      assert.equal(store.read(`${BASE}/automation/flow`).round, 1);
      assert.equal(writes(), 0);
      assert.deepEqual(effects, []);
    });
  }

  for (const type of ['candidate_approve', 'candidate_reject', 'owner_retry_submit', 'owner_regenerate', 'candidate_answers']) {
    it(`transaction refuses ${type} after an ambiguous final click`, async () => {
      const { deps, effects, writes } = seed({ r1: { state: 'sending', channel: 'lever', clickedAt: NOW } });
      const result = await applyAutomationEvent({ db: deps.db, orderId: ORDER, event: { type }, runEffect: deps.runEffect, nowMs: NOW });
      assert.equal(result.ignored, 'submission_unconfirmed');
      assert.equal(writes(), 0);
      assert.deepEqual(effects, []);
    });
  }

  for (const submission of [
    { r1: { state: 'failed', channel: 'lever', clickedAt: null } },
    { r1: { state: 'failed', channel: 'lever', clickedAt: NOW - 1000 } },
    { r1: { state: 'sending', channel: 'lever', clickedAt: null } },
    {},
  ]) {
    it(`keeps normal approval/recovery available for ${JSON.stringify(submission)} despite stale preparation`, async () => {
      const { deps, effects } = seed(submission, 'candidate_review', {
        order: { submittedAt: NOW - 1000 },
        flow: { sentRounds: [1], approvedAt: NOW - 1000 },
        draft: { sentAttempt: { at: NOW - 1000 }, sent: { files: [] } },
      });
      const result = await applyAutomationEvent({ db: deps.db, orderId: ORDER, event: { type: 'candidate_approve' }, runEffect: deps.runEffect, nowMs: NOW });
      assert.equal(result.ok, true);
      assert.equal(result.flow.state, 'submitting');
      assert.equal(result.flow.round, 1);
      assert.ok(effects.some(effect => effect.type === 'dispatch' && effect.mode === 'submit'));
    });
  }

  it('keeps a normal unsent POST approval working', async () => {
    const { deps, effects } = seed({ r1: { state: 'failed', channel: 'lever' } });
    const result = await handleAssistedApplicationReview(post('approve'), deps);
    assert.equal(result.status, 200);
    assert.equal(result.body.state, 'submitting');
    assert.ok(effects.some(effect => effect.type === 'dispatch' && effect.mode === 'submit'));
  });

  for (const type of ['submit_succeeded', 'submit_acknowledged']) {
    it(`allows confirmed outcome ${type} from a legacy SENT without receipt frames`, async () => {
      const { deps, effects } = seed({ r1: { state: 'sent', channel: 'lever' } }, 'submitting');
      const result = await applyAutomationEvent({ db: deps.db, orderId: ORDER, event: { type, round: 1 }, runEffect: deps.runEffect, nowMs: NOW });
      assert.equal(result.ok, true);
      assert.equal(result.flow.state, 'submitted');
      assert.ok(effects.every(effect => effect.type === 'mark_submitted'));
    });
  }

  it('allows an acknowledgement to settle an ambiguous hold with a stale retry clock', async () => {
    const { deps } = seed({ r1: { state: 'sent', channel: 'email' } }, 'owner_takeover', {
      flow: { heldBy: ['email_ambiguous'], portalAutoRetryAt: NOW + 1000 },
    });
    const result = await applyAutomationEvent({ db: deps.db, orderId: ORDER,
      event: { type: 'submit_acknowledged' }, runEffect: deps.runEffect, nowMs: NOW });
    assert.equal(result.ok, true);
    assert.equal(result.flow.state, 'submitted');
  });

  for (const type of ['submit_succeeded', 'submit_acknowledged', 'owner_submitted', 'candidate_confirmed_submitted']) {
    it(`does not attribute an older-round SENT to the current round via ${type}`, async () => {
      const { deps, effects, writes } = seed({ r2: { state: 'sent' } }, 'submitting');
      const result = await applyAutomationEvent({ db: deps.db, orderId: ORDER, event: { type, round: 1 }, runEffect: deps.runEffect, nowMs: NOW });
      assert.equal(result.ignored, 'already_sent');
      assert.equal(writes(), 0);
      assert.deepEqual(effects, []);
    });
  }

  it('records an ambiguous handoff but refuses a transient failure that would dispatch another send', async () => {
    const { deps, effects } = seed({ r1: { state: 'sending', channel: 'lever', clickedAt: NOW } }, 'submitting');
    const retry = await applyAutomationEvent({ db: deps.db, orderId: ORDER,
      event: { type: 'submit_failed', round: 1, error: 'temporarily unavailable' }, runEffect: deps.runEffect, nowMs: NOW });
    assert.equal(retry.ignored, 'submission_unconfirmed');
    assert.deepEqual(effects, []);
    const outcome = await applyAutomationEvent({ db: deps.db, orderId: ORDER,
      event: { type: 'submit_handoff', round: 1, reason: 'submit_unconfirmed' }, runEffect: deps.runEffect, nowMs: NOW });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.flow.state, 'owner_takeover');
    assert.ok(effects.every(effect => !['dispatch', 'refund'].includes(effect.type)));
  });

  it('does not request impossible candidate answers or schedule a delayed retry after a final click', async () => {
    const { deps, effects, writes } = seed({ r1: { state: 'sending', channel: 'lever', clickedAt: NOW } }, 'submitting');
    for (const event of [
      { type: 'submit_needs_candidate', round: 1, questions: ['new_question'] },
      { type: 'submit_handoff', round: 1, reason: 'portal_needs_candidate' },
    ]) {
      const result = await applyAutomationEvent({ db: deps.db, orderId: ORDER, event, runEffect: deps.runEffect, nowMs: NOW });
      assert.equal(result.ignored, 'submission_unconfirmed');
      assert.equal(writes(), 0);
      assert.deepEqual(effects, []);
    }
  });

  it('ignores non-round metadata and distinguishes definitive failure from an unknown send', () => {
    assert.equal(submissionIrreversibility({ submission: { metadata: { state: 'sent' }, r0: { state: 'sent' }, r1: { state: 'failed', channel: 'email' } } }), null);
    assert.equal(submissionIrreversibility({ submission: { r1: { state: 'sending', channel: 'email' } } }), 'submission_unconfirmed');
  });
});

describe('review direct writers race with the final send fence', () => {
  const requiredDocuments = [{ id: 'certificate', label: 'Certificate', kind: 'other', required: true }];
  const oldKey = `assisted-application-uploads/${ORDER}/retained-certificate.pdf`;
  const draft = { tailoredCv: { status: 'ready' }, requiredDocuments };
  const flow = { documents: { certificate: { files: [{ key: oldKey, name: 'certificate.pdf' }] } } };

  for (const action of ['cv_choice', 'document_remove']) {
    it(`refuses ${action} if SENT arrives after the POST read and before its transaction`, async () => {
      const { store, deps, effects, writes } = seed({}, 'candidate_review', { draft, flow });
      const transaction = store.db.runTransaction.bind(store.db);
      store.db.runTransaction = (callback: any) => {
        store.docs.set(`${BASE}/automation/submission`, { r1: { state: 'sent' } });
        return transaction(callback);
      };
      const deleted: string[] = [];
      const bucket = { file: (key: string) => ({ delete: async () => { deleted.push(key); } }) };
      const result = await handleAssistedApplicationReview({ method: 'POST', body: {
        t: token(), action, cvChoice: 'original', documentId: 'certificate', fileId: 'retained-certificate.pdf',
      } }, { ...deps, bucket });
      assert.equal(result.status, 409);
      assert.equal(result.body.error, 'already_sent');
      assert.equal(writes(), 0);
      assert.equal(store.read(`${BASE}/automation/flow`).cvChoice, undefined);
      assert.equal(store.read(`${BASE}/automation/flow`).documents.certificate.files[0].key, oldKey);
      assert.deepEqual(effects, []);
      assert.deepEqual(deleted, []);
    });
  }

  it('does not associate an uploaded file when SENT arrives while Storage is saving it', async () => {
    const { store, deps, effects, writes } = seed({}, 'candidate_review', { draft, flow });
    const saved: string[] = [];
    const deleted: string[] = [];
    const bucket = { file: (key: string) => ({
      save: async () => { saved.push(key); store.docs.set(`${BASE}/automation/submission`, { r1: { state: 'sent' } }); },
      delete: async () => { deleted.push(key); },
    }) };
    const result = await handleAssistedApplicationReview({ method: 'POST', body: { t: token(), action: 'document_upload',
      documentId: 'certificate', fileName: 'new-certificate.pdf', contentBase64: Buffer.from('%PDF-1.4\nfixture').toString('base64'),
    } }, { ...deps, bucket });
    assert.equal(result.status, 409);
    assert.equal(result.body.error, 'already_sent');
    assert.equal(writes(), 0);
    assert.equal(store.read(`${BASE}/automation/flow`).documents.certificate.files.length, 1);
    assert.deepEqual(effects, []);
    assert.equal(saved.length, 1);
    assert.deepEqual(deleted, saved);
    assert.ok(!deleted.includes(oldKey));
  });

  it('keeps a failed pre-click attempt editable despite its stale prepared payload', async () => {
    const { store, deps } = seed({ r1: { state: 'failed', clickedAt: null } }, 'candidate_review', {
      draft: { ...draft, sentAttempt: { at: NOW - 1000 } }, flow,
    });
    const result = await handleAssistedApplicationReview({ method: 'POST', body: { t: token(), action: 'cv_choice', cvChoice: 'original' } }, deps);
    assert.equal(result.status, 200);
    assert.equal(store.read(`${BASE}/automation/flow`).cvChoice, 'original');
  });
});
