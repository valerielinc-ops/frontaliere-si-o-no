import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  GITHUB_WORKFLOW_DISPATCH_API_VERSION,
} from '../../scripts/lib/githubApiHeaders.mjs';
import {
  classifyWorkflowRunUiOutcome,
  createGitHubWorkflowDispatchRequester,
  dispatchWorkflowOnce,
  githubWorkflowDispatchHeaders,
  isWorkflowRunDispatchLocked,
  mergeWorkflowSnapshotState,
  planWorkflowSnapshotRead,
  readBoundedJsonResponse,
  validateWorkflowDispatchRun,
  workflowDispatchErrorIdentity,
  workflowDispatchResponseRunId,
  WorkflowDispatchError,
} from '../../scripts/lib/githubWorkflowDispatch.mjs';

const REPOSITORY = 'valerielinc-ops/frontaliere-si-o-no';
const WORKFLOW_FILE = 'generate-article.yml';
const RUN_ID = '7001';

const dispatchBody = {
  workflow_run_id: Number(RUN_ID),
  run_url: `https://api.github.com/repos/${REPOSITORY}/actions/runs/${RUN_ID}`,
  html_url: `https://github.com/${REPOSITORY}/actions/runs/${RUN_ID}`,
};

const workflowRun = {
  id: Number(RUN_ID),
  repository: { full_name: REPOSITORY },
  path: `.github/workflows/${WORKFLOW_FILE}`,
  event: 'workflow_dispatch',
  head_branch: 'main',
  run_attempt: 1,
  status: 'queued',
  conclusion: null,
};

describe('github workflow dispatch contract', () => {
  it('pins 2026-03-10 only through the dispatch header helper', () => {
    expect(GITHUB_WORKFLOW_DISPATCH_API_VERSION).toBe('2026-03-10');
    expect(githubWorkflowDispatchHeaders('secret')).toMatchObject({
      Authorization: 'Bearer secret',
      'X-GitHub-Api-Version': '2026-03-10',
    });
  });

  it('accepts only coherent exact-host response URLs', () => {
    expect(workflowDispatchResponseRunId(dispatchBody, REPOSITORY)).toBe(RUN_ID);
    expect(workflowDispatchResponseRunId({ ...dispatchBody, workflow_run_id: null }, REPOSITORY)).toBeNull();
    expect(workflowDispatchResponseRunId({
      ...dispatchBody,
      run_url: `https://api.github.com.attacker.invalid/repos/${REPOSITORY}/actions/runs/${RUN_ID}`,
    }, REPOSITORY)).toBeNull();
    expect(workflowDispatchResponseRunId({
      ...dispatchBody,
      html_url: `https://github.com/${REPOSITORY}/actions/runs/9999`,
    }, REPOSITORY)).toBeNull();
  });

  it.each(['requested', 'queued', 'pending', 'waiting', 'in_progress', 'completed'])(
    'validates the direct run binding for lifecycle %s',
    (status) => {
      const result = validateWorkflowDispatchRun(
        { ...workflowRun, status, conclusion: status === 'completed' ? 'failure' : null },
        { repository: REPOSITORY, workflowFile: WORKFLOW_FILE, ref: 'main', runId: RUN_ID },
      );
      expect(result).toEqual({ valid: true, errors: [] });
    },
  );

  it.each([
    ['id', { id: 9 }],
    ['repository', { repository: { full_name: 'other/repo' } }],
    ['path', { path: '.github/workflows/other.yml' }],
    ['event', { event: 'push' }],
    ['ref', { head_branch: 'release' }],
    ['attempt', { run_attempt: 0 }],
    ['status', { status: 'unknown' }],
  ])('rejects a wrong direct-run %s binding', (_field, override) => {
    const result = validateWorkflowDispatchRun(
      { ...workflowRun, ...override },
      { repository: REPOSITORY, workflowFile: WORKFLOW_FILE, ref: 'main', runId: RUN_ID },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('classifies ambiguous and failed Admin workflow states before rendering success', () => {
    expect(classifyWorkflowRunUiOutcome({ status: 'unknown', error: 'check Actions' })).toBe('unknown');
    expect(classifyWorkflowRunUiOutcome({
      runId: 7001,
      status: 'in_progress',
      error: 'monitor transport failed',
    })).toBe('unknown');
    expect(classifyWorkflowRunUiOutcome({ status: 'error', error: null })).toBe('error');
    expect(classifyWorkflowRunUiOutcome({
      runId: 7001,
      status: 'completed',
      error: 'workflow failed',
    })).toBe('error');
    expect(classifyWorkflowRunUiOutcome({ status: 'completed', error: null })).toBe('success');
  });

  it.each([
    [{ loading: true }, true],
    [{ status: 'dispatching' }, true],
    [{ status: 'requested' }, true],
    [{ status: 'queued' }, true],
    [{ status: 'pending' }, true],
    [{ status: 'waiting' }, true],
    [{ status: 'in_progress' }, true],
    [{ status: 'unknown', runId: 7001 }, true],
    [{ status: 'completed', runId: 7001 }, false],
    [{ status: 'error' }, false],
  ])('keeps a non-terminal or ambiguous workflow state dispatch-locked: %j', (state, expected) => {
    expect(isWorkflowRunDispatchLocked(state)).toBe(expected);
  });

  it('merges refresh evidence without unlocking a concurrent or ambiguous dispatch', () => {
    const unknown = { status: 'unknown', runId: 7001, error: 'check Actions' };
    const oldCompleted = { status: 'completed', runId: 6999, error: null };
    expect(mergeWorkflowSnapshotState(unknown, oldCompleted)).toBe(unknown);
    expect(mergeWorkflowSnapshotState({ status: 'dispatching', runId: null }, oldCompleted))
      .toMatchObject({ status: 'dispatching', runId: null });
    expect(mergeWorkflowSnapshotState(unknown, { status: 'in_progress', runId: 7001, error: null }))
      .toMatchObject({ status: 'in_progress', runId: 7001 });
    expect(mergeWorkflowSnapshotState(unknown, { status: 'completed', runId: 7001, error: null }))
      .toEqual({ status: 'completed', runId: 7001, error: null });
  });

  it('keeps workflow snapshots monotonic across a slow refresh and a completed poll', () => {
    const completed = {
      status: 'completed',
      runId: 7001,
      updatedAt: '2026-08-31T12:00:00.000Z',
      conclusion: 'success',
      error: null,
    };
    const staleRefresh = {
      status: 'in_progress',
      runId: 7001,
      updatedAt: '2026-08-31T11:59:00.000Z',
      conclusion: null,
      error: null,
    };
    expect(mergeWorkflowSnapshotState(completed, staleRefresh)).toBe(completed);
    expect(mergeWorkflowSnapshotState(completed, {
      ...staleRefresh,
      runId: 6999,
      updatedAt: '2026-08-31T12:01:00.000Z',
    })).toBe(completed);
    expect(mergeWorkflowSnapshotState(staleRefresh, completed)).toEqual(completed);
    expect(mergeWorkflowSnapshotState(completed, {
      ...completed,
      runId: 7002,
      status: 'queued',
      updatedAt: '2026-08-31T12:01:00.000Z',
      conclusion: null,
    })).toMatchObject({ runId: 7002, status: 'queued' });
  });

  it('plans exact-only refreshes for locked runs and skips an unbound locked state', () => {
    expect(planWorkflowSnapshotRead({ status: 'unknown', runId: 7001 }))
      .toEqual({ mode: 'exact', runId: '7001' });
    expect(planWorkflowSnapshotRead({ status: 'dispatching', runId: null }))
      .toEqual({ mode: 'skip', runId: null });
    expect(planWorkflowSnapshotRead({ status: 'completed', runId: 7001 }))
      .toEqual({ mode: 'latest', runId: null });
  });

  it('dispatches once with the exact payload and returns the authoritative run', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const request = vi.fn(async (call: Record<string, unknown>) => {
      calls.push(call);
      return calls.length === 1
        ? { status: 200, body: dispatchBody }
        : { status: 200, body: workflowRun };
    });
    const result = await dispatchWorkflowOnce({
      repository: REPOSITORY,
      workflowFile: WORKFLOW_FILE,
      ref: 'main',
      inputs: { url: 'https://example.com/job' },
      request,
      sleep: vi.fn(),
    });
    expect(result).toEqual({ runId: RUN_ID, run: workflowRun });
    expect(calls).toEqual([
      {
        method: 'POST',
        path: `/repos/${REPOSITORY}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
        body: { ref: 'main', inputs: { url: 'https://example.com/job' } },
      },
      { method: 'GET', path: `/repos/${REPOSITORY}/actions/runs/${RUN_ID}` },
    ]);
  });

  it.each([
    ['legacy 204', async () => ({ status: 204, body: null })],
    ['server 502', async () => ({ status: 502, body: null })],
    ['transport error', async () => { throw new Error('timeout'); }],
  ])('never retries an ambiguous POST: %s', async (_name, firstResponse) => {
    const request = vi.fn(async (_call: Record<string, unknown>) => firstResponse());
    await expect(dispatchWorkflowOnce({
      repository: REPOSITORY,
      workflowFile: WORKFLOW_FILE,
      ref: 'main',
      inputs: {},
      request,
      sleep: vi.fn(),
    })).rejects.toThrow(/workflow_dispatch/);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toMatchObject({ method: 'POST' });
  });

  it.each([404, 429, 502])('retries read-only GET HTTP %s without another POST', async (status) => {
    let getCount = 0;
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method === 'POST') return { status: 200, body: dispatchBody };
      getCount += 1;
      return getCount === 1 ? { status, body: null } : { status: 200, body: workflowRun };
    });
    await expect(dispatchWorkflowOnce({
      repository: REPOSITORY,
      workflowFile: WORKFLOW_FILE,
      ref: 'main',
      inputs: {},
      request,
      sleep: vi.fn(),
    })).resolves.toMatchObject({ runId: RUN_ID });
    expect(request.mock.calls.filter(([call]) => call.method === 'POST')).toHaveLength(1);
    expect(request.mock.calls.filter(([call]) => call.method === 'GET')).toHaveLength(2);
  });

  it('retries a read-only GET transport error without another POST', async () => {
    let getCount = 0;
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method === 'POST') return { status: 200, body: dispatchBody };
      getCount += 1;
      if (getCount === 1) throw new Error('temporary network error');
      return { status: 200, body: workflowRun };
    });
    await expect(dispatchWorkflowOnce({
      repository: REPOSITORY,
      workflowFile: WORKFLOW_FILE,
      ref: 'main',
      inputs: {},
      request,
      sleep: vi.fn(),
    })).resolves.toMatchObject({ runId: RUN_ID });
    expect(request.mock.calls.filter(([call]) => call.method === 'POST')).toHaveLength(1);
    expect(request.mock.calls.filter(([call]) => call.method === 'GET')).toHaveLength(2);
  });

  it('uses the 2026 API header and exact fetch transport for POST and GET', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(dispatchBody), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(workflowRun), { status: 200 }));
    const request = createGitHubWorkflowDispatchRequester({
      repository: REPOSITORY,
      token: 'test-token',
      fetchImpl,
      timeoutMs: 1_000,
    });
    await expect(dispatchWorkflowOnce({
      repository: REPOSITORY,
      workflowFile: WORKFLOW_FILE,
      ref: 'main',
      inputs: { source: 'admin' },
      request,
      sleep: vi.fn(),
    })).resolves.toMatchObject({ runId: RUN_ID });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [postUrl, postInit] = fetchImpl.mock.calls[0];
    const [getUrl, getInit] = fetchImpl.mock.calls[1];
    expect(postUrl).toBe(`https://api.github.com/repos/${REPOSITORY}/actions/workflows/${WORKFLOW_FILE}/dispatches`);
    expect(JSON.parse(postInit.body)).toEqual({ ref: 'main', inputs: { source: 'admin' } });
    expect(new Headers(postInit.headers).get('X-GitHub-Api-Version')).toBe('2026-03-10');
    expect(getUrl).toBe(`https://api.github.com/repos/${REPOSITORY}/actions/runs/${RUN_ID}`);
    expect(new Headers(getInit.headers).get('X-GitHub-Api-Version')).toBe('2026-03-10');
    expect(fetchImpl.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
  });

  it('enforces the body cap in the real fetch adapter', async () => {
    const fetchImpl = vi.fn(async () => new Response('x'.repeat(33), { status: 200 }));
    const request = createGitHubWorkflowDispatchRequester({
      repository: REPOSITORY,
      token: 'test-token',
      fetchImpl,
      maxResponseBytes: 32,
    });
    await expect(request({
      method: 'POST',
      path: `/repos/${REPOSITORY}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
      body: { ref: 'main', inputs: {} },
    })).rejects.toThrow(/github_response_too_large/);
  });

  it('fails a wrong 200 GET binding immediately without guessing another run', async () => {
    const request = vi.fn(async ({ method }: { method: string }) => (
      method === 'POST'
        ? { status: 200, body: dispatchBody }
        : { status: 200, body: { ...workflowRun, head_branch: 'other' } }
    ));
    await expect(dispatchWorkflowOnce({
      repository: REPOSITORY,
      workflowFile: WORKFLOW_FILE,
      ref: 'main',
      inputs: {},
      request,
      sleep: vi.fn(),
    })).rejects.toThrow(/workflow_run_binding_invalid/);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('preserves the authoritative run identity when its exact GET returns 403', async () => {
    const request = vi.fn(async ({ method }: { method: string }) => (
      method === 'POST'
        ? { status: 200, body: dispatchBody }
        : { status: 403, body: null }
    ));
    let observed: unknown;
    try {
      await dispatchWorkflowOnce({
        repository: REPOSITORY,
        workflowFile: WORKFLOW_FILE,
        ref: 'main',
        inputs: {},
        request,
        sleep: vi.fn(),
      });
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(WorkflowDispatchError);
    expect(observed).toMatchObject({
      code: 'workflow_run_unavailable_403',
      runId: RUN_ID,
      htmlUrl: dispatchBody.html_url,
    });
    expect(request.mock.calls.filter(([call]) => call.method === 'POST')).toHaveLength(1);
    expect(request.mock.calls.filter(([call]) => call.method === 'GET')).toHaveLength(1);
  });

  it('carries an authoritative ambiguous dispatch into an exact-only Admin refresh plan', async () => {
    const request = vi.fn(async ({ method }: { method: string }) => (
      method === 'POST'
        ? { status: 200, body: dispatchBody }
        : { status: 404, body: null }
    ));
    let observed: unknown;
    try {
      await dispatchWorkflowOnce({
        repository: REPOSITORY,
        workflowFile: WORKFLOW_FILE,
        ref: 'main',
        inputs: {},
        request,
        sleep: vi.fn(),
      });
    } catch (error) {
      observed = error;
    }
    const identity = workflowDispatchErrorIdentity(observed);
    expect(identity).toEqual({ runId: 7001, htmlUrl: dispatchBody.html_url });
    expect(planWorkflowSnapshotRead({ status: 'unknown', ...identity }))
      .toEqual({ mode: 'exact', runId: RUN_ID });
    expect(request.mock.calls.filter(([call]) => call.method === 'POST')).toHaveLength(1);

    expect(workflowDispatchErrorIdentity(
      new WorkflowDispatchError('workflow_dispatch_unknown'),
    )).toEqual({ runId: null, htmlUrl: null });
    expect(planWorkflowSnapshotRead({
      status: 'unknown',
      ...workflowDispatchErrorIdentity(new WorkflowDispatchError('workflow_dispatch_unknown')),
    })).toEqual({ mode: 'skip', runId: null });
  });

  it('bounds response bodies before JSON parsing', async () => {
    await expect(readBoundedJsonResponse(new Response('{"ok":true}'), 32))
      .resolves.toEqual({ ok: true });
    await expect(readBoundedJsonResponse(new Response('x'.repeat(33)), 32))
      .rejects.toThrow(/github_response_too_large/);
    await expect(readBoundedJsonResponse(new Response('{}', {
      headers: { 'content-length': '33' },
    }), 32)).rejects.toThrow(/github_response_too_large/);
  });

  it('wires AdminPanel to exact-ID dispatch without timestamp/newest reconciliation', () => {
    const source = readFileSync(resolve('components/pages/AdminPanel.tsx'), 'utf8');
    const start = source.indexOf('const runWorkflowAction = async');
    const end = source.indexOf('const runCrawlerNow = async', start);
    const dispatchBlock = source.slice(start, end);
    expect(dispatchBlock).toContain('dispatchAdminWorkflow');
    expect(dispatchBlock).not.toContain('beforeIds');
    expect(dispatchBlock).not.toContain('dispatchedAt');
    expect(dispatchBlock).not.toContain('runs[0]');
    expect(source).not.toContain('likely transient). Proceeding to poll for run');
    expect(source).toContain('Non ricliccare; controlla GitHub Actions prima di riprovare.');
    expect(source).toContain('GitHub ha creato il run ${identity.runId}');
    expect(source.indexOf('if (identity.runId !== null && identity.htmlUrl !== null)'))
      .toBeLessThan(source.indexOf('if (error.status === 403)'));
    expect(source).toContain("status: dispatchAmbiguous ? 'unknown' : 'error'");
    expect(source).toContain('⚠️ Esito generazione parser da verificare in GitHub Actions: ${msg}');
    expect(source).toContain('const outcome = classifyWorkflowRunUiOutcome(result)');
    expect(source).toContain("if (outcome === 'unknown')");
    expect(source).toContain("else if (outcome === 'error')");
    expect(source).toContain('const knownRun = knownRunId !== null');
    expect(source).toContain('knownRunId = err.runId');
    expect(source).toContain('runId: knownRunId');
    expect(source).toContain('isWorkflowRunDispatchLocked(wfState)');
    expect(source).toContain("isWorkflowRunDispatchLocked(getWorkflowState('update-jobs.yml'))");
    expect(source).toContain('if (parserDispatchLoading || parserDispatchLocked) return;');
    expect(source).toContain('setParserDispatchLocked(true);');
    expect(source).toContain("if (nlSending || isWorkflowRunDispatchLocked(getWorkflowState('send-newsletter.yml'))) return;");
    expect(source).toContain("disabled={nlSending || isWorkflowRunDispatchLocked(getWorkflowState('send-newsletter.yml'))");
    expect(source).toContain('mergeWorkflowSnapshotState(current, snapshot)');
    expect(source).toContain("githubRequest(connection, `/actions/runs/${snapshotRead.runId}`");
    expect(source).toContain("if (outcome === 'unknown')");
    expect(source).toContain("nlSendResult.startsWith('⚠️')");
    expect(source).toContain('...latestState,');
    expect(source).not.toContain('const finalState = { ...getWorkflowState(workflowId)');
  });
});
