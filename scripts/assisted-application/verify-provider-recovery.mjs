#!/usr/bin/env node
// @manual-tool: one-shot proof for the CAPTCHA recovery regression; run manually when portal retry transitions change because it does not exercise a live provider or deployment artifact.
/** Deterministic proof for CAPTCHA recovery before a final application click. */
import assert from 'node:assert/strict';
import { portalHandoffReason } from './lib/portal/diagnostics.mjs';
import { transition } from '../../functions/src/assistedApplicationFlow.js';

const nowMs = 1_700_000_000_000;
const draft = { status: 'ready', round: 1, questions: [], job: { source: 'job_detail' }, channel: { type: 'employer_site' } };
const approved = { state: 'submitting', round: 1, dispatch: { mode: 'submit', round: 1, attempts: 1 } };
const providerResponse = { host: 'api.nopecha.com', path: '/v1/recognition/turnstile', status: 520, attempt: 2 };

// A previous click must not poison the next, still pre-click attempt.
const diagnostics = { responses: [providerResponse] };
assert.equal(portalHandoffReason('captcha', { diagnostics, attempt: 2, finalClickAttempt: 1 }), 'captcha_provider_unavailable');
assert.equal(portalHandoffReason('captcha', { diagnostics, attempt: 2, finalClickAttempt: 2 }), 'captcha');

// Provider outages no longer trigger a second automated submit: Valerie receives
// the owner takeover and can handle the challenge with the fill extension.
const held = transition(approved, { type: 'submit_handoff', reason: 'captcha_provider_unavailable' }, { draft, nowMs });
assert.deepEqual(held.effects, [{ type: 'email', kind: 'owner_takeover', reason: 'portal:captcha_provider_unavailable', stage: 'submit', attempts: 1 }]);
assert.equal(held.flow.state, 'owner_takeover');
assert.equal(held.flow.heldBy[0], 'portal:captcha_provider_unavailable');
assert.equal(held.flow.portalAutoRetryAt, null);
assert.equal(transition(held.flow, { type: 'portal_auto_retry' }, { draft, nowMs: nowMs + 24 * 60 * 60_000 }).ignored, 'not_auto_retryable');
assert.equal(transition(held.flow, { type: 'submit_succeeded' }, { draft, nowMs }).ignored, 'terminal');

process.stdout.write('1\n');
