import { describe, expect, it } from 'vitest';
import {
  TARGET_WORKFLOW_ID,
  TARGET_WORKFLOW_PATH,
  expectedRecoveryClaim,
  verifyRecoverySuccessor,
} from '../scripts/ci/translate-recovery-successor-guard.mjs';

const RUN_ID = '33534757741';
const HEAD_SHA = 'a'.repeat(40);
const WORKFLOW_BLOB_SHA = 'b'.repeat(40);

function response(status: number, body: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    async text() { return JSON.stringify(body); },
  };
}

describe('translate successor guard', () => {
  it('allows normal attempt 1 without an API call', async () => {
    let calls = 0;
    await expect(verifyRecoverySuccessor({ runAttempt: '1', fetchImpl: async () => { calls += 1; } }))
      .resolves.toMatchObject({ allowed: true, required: false });
    expect(calls).toBe(0);
  });

  it('rejects attempts beyond the one authorized successor', async () => {
    await expect(verifyRecoverySuccessor({ runAttempt: '3' })).rejects
      .toThrow('successor_guard_attempt_not_authorized');
  });

  it('accepts only the exact claim bound to the rerun commit and workflow blob', async () => {
    const expected = expectedRecoveryClaim({
      targetRunId: RUN_ID,
      sourceHeadSha: HEAD_SHA,
      workflowBlobSha: WORKFLOW_BLOB_SHA,
    });
    const calls: string[] = [];
    const result = await verifyRecoverySuccessor({
      apiUrl: 'https://api.github.com',
      token: 'test-token',
      runId: RUN_ID,
      runAttempt: '2',
      headSha: HEAD_SHA,
      eventName: 'workflow_dispatch',
      fetchImpl: async (url) => {
        calls.push(String(url));
        if (calls.length === 1) return response(200, { type: 'file', sha: WORKFLOW_BLOB_SHA });
        return response(200, {
          type: 'file',
          path: expected.claimPath,
          encoding: 'base64',
          content: expected.bytes.toString('base64'),
          size: expected.bytes.length,
          sha: expected.gitBlobSha,
        });
      },
    });
    expect(result).toMatchObject({ allowed: true, required: true, state: 'claim_verified' });
    expect(result.claimKey).toBe(expected.claimKey);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain(`/repos/nanakokyobashi-rgb/frontaliere-articles/contents/${TARGET_WORKFLOW_PATH.replaceAll('/', '/')}`);
    expect(TARGET_WORKFLOW_ID).toBe(342441975);
  });

  it('fails closed on a changed claim byte', async () => {
    const expected = expectedRecoveryClaim({
      targetRunId: RUN_ID,
      sourceHeadSha: HEAD_SHA,
      workflowBlobSha: WORKFLOW_BLOB_SHA,
    });
    await expect(verifyRecoverySuccessor({
      apiUrl: 'https://api.github.com',
      token: 'test-token',
      runId: RUN_ID,
      runAttempt: '2',
      headSha: HEAD_SHA,
      eventName: 'workflow_dispatch',
      fetchImpl: async (_url, options) => {
        if (String(_url).includes('/contents/.github/')) return response(200, { type: 'file', sha: WORKFLOW_BLOB_SHA });
        const tampered = Buffer.from(`${expected.bytes.toString('utf8')} `);
        return response(200, {
          type: 'file', path: expected.claimPath, encoding: 'base64',
          content: tampered.toString('base64'), size: tampered.length, sha: expected.gitBlobSha,
        });
      },
    })).rejects.toThrow('successor_guard_claim_mismatch');
  });
});
