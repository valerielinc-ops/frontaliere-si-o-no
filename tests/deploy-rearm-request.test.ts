import { describe, expect, it } from 'vitest';
import { DEPLOY_REARM_REQUEST_CONTEXT, resolveDeployRearmRequest } from '../scripts/ci/deploy-rearm-request.mjs';

const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const REQUESTED_AT = '2026-10-22T10:00:00.000Z';

describe('durable deploy re-arm request', () => {
  it('admits one pending request for the current SHA', () => {
    expect(resolveDeployRearmRequest({
      headSha: SHA,
      statuses: [{ context: DEPLOY_REARM_REQUEST_CONTEXT, state: 'pending', created_at: REQUESTED_AT }],
      runs: [{ id: 7, headSha: SHA, createdAt: '2026-10-22T09:59:00.000Z' }],
    })).toMatchObject({ state: 'pending' });
  });

  it('marks the request fulfilled once a run for that SHA starts after it', () => {
    expect(resolveDeployRearmRequest({
      headSha: SHA,
      statuses: [{ context: DEPLOY_REARM_REQUEST_CONTEXT, state: 'pending', created_at: REQUESTED_AT }],
      runs: [{ id: 8, headSha: SHA, createdAt: '2026-10-22T10:00:01.000Z' }],
    })).toMatchObject({ state: 'fulfilled' });
  });

  it('ignores unrelated statuses and fails closed for a malformed request', () => {
    expect(resolveDeployRearmRequest({
      headSha: SHA,
      statuses: [{ context: 'other/status', state: 'pending', created_at: REQUESTED_AT }],
      runs: [],
    })).toMatchObject({ state: 'none' });
    expect(resolveDeployRearmRequest({
      headSha: SHA,
      statuses: [{ context: DEPLOY_REARM_REQUEST_CONTEXT, state: 'pending' }],
      runs: [],
    })).toMatchObject({ state: 'invalid' });
  });
});
