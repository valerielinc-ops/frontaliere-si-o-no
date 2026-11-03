#!/usr/bin/env node
/** Deterministic proof for CAPTCHA recovery before a final application click. */
import assert from 'node:assert/strict';
import { portalHandoffReason } from './lib/portal/diagnostics.mjs';
import { transition } from '../../functions/src/assistedApplicationFlow.js';
import { TRANSPORT_AUTO_RETRY_DELAYS_MS } from '../../functions/src/assistedApplicationPortalRetryPolicy.js';

const nowMs = 1_700_000_000_000;
const draft = { status: 'ready', round: 1, questions: [], job: { source: 'job_detail' }, channel: { type: 'employer_site' } };
const approved = { state: 'submitting', round: 1, dispatch: { mode: 'submit', round: 1, attempts: 1 } };
const providerResponse = { host: 'api.nopecha.com', path: '/v1/recognition/turnstile', status: 520, attempt: 2 };

// A previous click must not poison the next, still pre-click attempt.
const diagnostics = { responses: [providerResponse] };
assert.equal(portalHandoffReason('captcha', { diagnostics, attempt: 2, finalClickAttempt: 1 }), 'captcha_provider_unavailable');
assert.equal(portalHandoffReason('captcha', { diagnostics, attempt: 2, finalClickAttempt: 2 }), 'captcha');

// The flow queues only a retry and never turns the provider failure into sent.
const held = transition(approved, { type: 'submit_handoff', reason: 'captcha_provider_unavailable' }, { draft, nowMs });
assert.deepEqual(held.effects, []);
assert.equal(held.flow.state, 'owner_takeover');
assert.equal(held.flow.heldBy[0], 'portal:captcha_provider_unavailable');
assert.equal(held.flow.portalAutoRetryAt, nowMs + TRANSPORT_AUTO_RETRY_DELAYS_MS[0]);

const retried = transition(
  { ...held.flow, dispatch: approved.dispatch },
  { type: 'portal_auto_retry' },
  { draft, nowMs: held.flow.portalAutoRetryAt },
);
assert.equal(retried.flow.state, 'submitting');
assert.deepEqual(retried.effects, [{ type: 'dispatch', mode: 'submit', reason: 'portal_auto_retry' }]);

const heldAgain = transition(
  { ...retried.flow, dispatch: approved.dispatch },
  { type: 'submit_handoff', reason: 'captcha_provider_unavailable' },
  { draft, nowMs: held.flow.portalAutoRetryAt + 1 },
);
assert.equal(heldAgain.flow.state, 'owner_takeover');
assert.equal(heldAgain.flow.heldBy[0], 'portal:captcha_provider_unavailable');
assert.equal(transition(heldAgain.flow, { type: 'submit_succeeded' }, { draft, nowMs }).ignored, 'terminal');

process.stdout.write('1\n');
