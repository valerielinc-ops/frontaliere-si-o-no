import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CRAWLER_GENERATION_REF_RETENTION_MS,
  DIRECT_RUN_HYDRATION_BACKOFF_MS,
  DIRECT_RUN_HYDRATION_TIMEOUT_MS,
  GITHUB_API_VERSION,
  LEGACY_DISPATCH_POST_ATTEMPTS,
  LEGACY_DISPATCH_RETRY_DELAY_MS,
  MAX_CRAWLER_GENERATION_REAPER_CANDIDATES,
  cleanupCrawlerGenerationDispatchRef,
  createGitHubActionsRequester,
  dispatchWorkflowOnce,
  ensureCrawlerGenerationDispatchRef,
  DISPATCH_REF_CONFLICT_BACKOFF_MS,
  evaluateCrawlerGenerationPreflight,
  reapStaleCrawlerGenerationDispatchRefs,
  runPreflight,
  runCrawlerGenerationDispatchCli,
  runCrawlerGenerationDispatchWave,
} from '../scripts/crawler-generation-dispatch.mjs';
import {
  GROUP_IDS,
  crawlerGenerationSentinelWorkflowIdentity,
  crawlerGenerationLegacyWorkflowIdentity,
  crawlerGenerationWorkflowIdentity,
  isCrawlerGenerationToken,
  validateCrawlerGenerationWorkflowRun,
} from '../scripts/lib/crawler-generation-contract.mjs';

const repository = 'nanakokyobashi-rgb/frontaliere-articles';
const generationToken = '9001-2';
const siteCodeCommit = 'a'.repeat(40);
const corpusCodeCommit = 'b'.repeat(40);
const dispatchRef = `crawler-generation-shadow-${generationToken}`;
const tempRoots: string[] = [];

function boundRun(group = '01', id = 7001, corpusCommit: string | null = null) {
  const binding = crawlerGenerationWorkflowIdentity(group, generationToken, String(id), corpusCommit);
  return {
    id,
    repository: { full_name: repository },
    name: binding.workflowName,
    display_title: binding.runName,
    path: `.github/workflows/${binding.workflowFile}`,
    event: 'workflow_dispatch',
    head_branch: corpusCommit === null ? 'main' : dispatchRef,
    head_sha: corpusCommit ?? corpusCodeCommit,
    run_attempt: 1,
    status: 'queued',
    conclusion: null,
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('crawler generation dispatch protocol', () => {
  it('uses REST 2026-03-10, the exact dispatch body, one POST and direct-ID GET binding', async () => {
    const requests: any[] = [];
    const request = vi.fn(async (input: any) => {
      requests.push(input);
      if (input.method === 'POST') return {
        status: 200,
        body: {
          workflow_run_id: 7001,
          run_url: 'https://api.github.com/repos/nanakokyobashi-rgb/frontaliere-articles/actions/runs/7001',
          html_url: 'https://github.com/nanakokyobashi-rgb/frontaliere-articles/actions/runs/7001',
        },
      };
      return { status: 200, body: boundRun('01', 7001, corpusCodeCommit) };
    });

    const result = await dispatchWorkflowOnce({
      repository,
      workflowFile: 'crawler-group-01.yml',
      group: '01',
      generationToken,
      corpusCodeCommit,
      inputs: { skip_ai_translation: '1', generation_token: generationToken },
      request,
    });

    expect(result).toEqual({ status: 'direct', runId: '7001' });
    expect(requests.filter(({ method }) => method === 'POST')).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: 'POST',
      apiVersion: GITHUB_API_VERSION,
      body: {
        ref: dispatchRef,
        inputs: { skip_ai_translation: '1', generation_token: generationToken },
      },
    });
    expect(JSON.stringify(requests[0].body)).not.toContain('return_run_details');
    expect(requests[1]).toMatchObject({
      method: 'GET',
      path: '/repos/nanakokyobashi-rgb/frontaliere-articles/actions/runs/7001',
    });
  });

  it('accepts the dynamic name/display_title shape returned by the three incident runs after completion', () => {
    const token = '33454436082-1';
    const fixtures = [
      {
        binding: crawlerGenerationWorkflowIdentity('01', token, '33454460732'),
        run: {
          id: 33454460732,
          name: 'crawler-generation-33454436082-1-group-01',
          display_title: 'crawler-generation-33454436082-1-group-01',
          path: '.github/workflows/crawler-group-01.yml',
          event: 'workflow_dispatch', head_branch: 'main',
          head_sha: '079cc61cf369366083ccdb56255c4b86f0d099ce',
          run_attempt: 1, status: 'completed', conclusion: 'success',
          repository: { full_name: repository },
        },
      },
      {
        binding: crawlerGenerationWorkflowIdentity('23', token, '33455982350'),
        run: {
          id: 33455982350,
          name: 'crawler-generation-33454436082-1-group-23',
          display_title: 'crawler-generation-33454436082-1-group-23',
          path: '.github/workflows/crawler-group-23.yml',
          event: 'workflow_dispatch', head_branch: 'main',
          head_sha: 'e5b77d5a46812ca57b35abdf269900c35e71cc53',
          run_attempt: 1, status: 'completed', conclusion: 'success',
          repository: { full_name: repository },
        },
      },
      {
        binding: crawlerGenerationSentinelWorkflowIdentity(token, '33455984398'),
        run: {
          id: 33455984398,
          name: 'crawler-generation-sentinel-33454436082-1',
          display_title: 'crawler-generation-sentinel-33454436082-1',
          path: '.github/workflows/crawler-generation-observer-shadow.yml',
          event: 'workflow_dispatch', head_branch: 'main',
          head_sha: 'e5b77d5a46812ca57b35abdf269900c35e71cc53',
          run_attempt: 1, status: 'completed', conclusion: 'failure',
          repository: { full_name: repository },
        },
      },
    ];
    for (const { binding, run } of fixtures) {
      expect(validateCrawlerGenerationWorkflowRun(run, binding)).toMatchObject({ valid: true, errors: [] });
    }
  });

  it('derives the dispatch ref from the validated generationToken field, not a runName regex', () => {
    const binding = {
      ...crawlerGenerationWorkflowIdentity('01', generationToken, '7001', corpusCodeCommit),
      runName: 'renamed-run-name-format-that-no-regex-would-parse',
    };
    const run = {
      id: 7001,
      repository: { full_name: repository },
      name: binding.workflowName,
      display_title: binding.runName,
      path: `.github/workflows/${binding.workflowFile}`,
      event: 'workflow_dispatch',
      head_branch: dispatchRef,
      head_sha: corpusCodeCommit,
      run_attempt: 1,
      status: 'queued',
      conclusion: null,
    };
    const result = validateCrawlerGenerationWorkflowRun(run, binding);
    expect(result.errors).not.toContain('head_branch_mismatch');
    expect(result.errors).not.toContain('workflow_path_mismatch');
  });

  it('keeps token validation equivalent to the legacy canonical grammar', () => {
    const legacyToken = /^[1-9][0-9]*-[1-9][0-9]*$/;
    for (const token of ['1-1', '9001-2', '999999999999-42', '0-1', '01-1', '1-0', '1-01', '1', '1-1-extra', '']) {
      expect(isCrawlerGenerationToken(token)).toBe(legacyToken.test(token));
    }
  });

  it('accepts only the canonical run-name fallback for a legacy binding without generationToken', () => {
    const modern = crawlerGenerationWorkflowIdentity('01', generationToken, '7001', corpusCodeCommit);
    const { generationToken: _generationToken, ...legacy } = modern;
    const run = boundRun('01', 7001, corpusCodeCommit);
    expect(validateCrawlerGenerationWorkflowRun(run, legacy)).toMatchObject({ valid: true, errors: [] });

    const renamed = { ...legacy, runName: 'renamed-legacy-binding' };
    expect(validateCrawlerGenerationWorkflowRun({ ...run, display_title: renamed.runName }, renamed)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining(['head_branch_mismatch', 'workflow_path_mismatch']),
    });
  });

  it('fails closed when an explicit generationToken is invalid', () => {
    const binding = { ...crawlerGenerationWorkflowIdentity('01', generationToken, '7001', corpusCodeCommit), generationToken: null };
    const result = validateCrawlerGenerationWorkflowRun(boundRun('01', 7001, corpusCodeCommit), binding);
    expect(result).toMatchObject({
      valid: false,
      errors: expect.arrayContaining(['head_branch_mismatch', 'workflow_path_mismatch']),
    });
  });

  it('rejects translate or a group/workflow mismatch before any POST', async () => {
    const request = vi.fn();
    await expect(dispatchWorkflowOnce({
      repository,
      workflowFile: 'translate-pending.yml',
      group: '01',
      generationToken,
      inputs: { skip_ai_translation: '1' },
      request,
    })).rejects.toThrow(/outside the crawler generation dispatch domain/i);
    await expect(dispatchWorkflowOnce({
      repository,
      workflowFile: 'crawler-group-02.yml',
      group: '01',
      generationToken,
      inputs: { skip_ai_translation: '1' },
      request,
    })).rejects.toThrow(/outside the crawler generation dispatch domain/i);
    expect(request).not.toHaveBeenCalled();
  });

  const invalidDispatchResponses: Array<[Record<string, unknown>, string]> = [
    [{ workflow_run_id: 7001 }, 'missing URLs'],
    [{
      workflow_run_id: 7001,
      run_url: 'https://api.github.com/repos/nanakokyobashi-rgb/frontaliere-articles/actions/runs/9999',
      html_url: 'https://github.com/nanakokyobashi-rgb/frontaliere-articles/actions/runs/7001',
    }, 'incoherent ID'],
    [{
      workflow_run_id: 7001,
      run_url: 'https://api.github.com/repos/wrong/repository/actions/runs/7001',
      html_url: 'https://github.com/wrong/repository/actions/runs/7001',
    }, 'incoherent repository'],
    [{
      workflow_run_id: 7001,
      run_url: 'https://api.github.com.attacker.invalid/repos/nanakokyobashi-rgb/frontaliere-articles/actions/runs/7001',
      html_url: 'https://github.com.attacker.invalid/nanakokyobashi-rgb/frontaliere-articles/actions/runs/7001',
    }, 'untrusted hosts'],
  ];

  it.each(invalidDispatchResponses)('rejects a malformed 200 response (%s)', async (body) => {
    const request = vi.fn(async () => ({ status: 200, body }));
    await expect(dispatchWorkflowOnce({
      repository,
      workflowFile: 'crawler-group-01.yml',
      group: '01',
      generationToken,
      inputs: { skip_ai_translation: '1', generation_token: generationToken },
      request,
    })).resolves.toEqual({ status: 'invalid_200_response', runId: null });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('sends the pinned API version as a real HTTP header', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      new Response(null, { status: 204 })
    ));
    const request = createGitHubActionsRequester({
      apiUrl: 'https://api.github.test',
      token: 'test-token',
      fetchImpl,
    });
    await request({ method: 'POST', path: '/dispatch', body: { ref: 'main', inputs: {} } });
    const firstCall = fetchImpl.mock.calls.at(0);
    if (!firstCall) throw new Error('fetch was not called');
    const [, requestInit] = firstCall;
    expect(requestInit?.headers).toMatchObject({
      'x-github-api-version': '2026-03-10',
    });
    expect(requestInit?.body).toBe(JSON.stringify({ ref: 'main', inputs: {} }));
  });

  it('exposes Retry-After metadata for preflight read retries', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, {
      status: 429,
      headers: { 'retry-after': '3' },
    }));
    const request = createGitHubActionsRequester({
      apiUrl: 'https://api.github.test', token: 'test-token', fetchImpl,
    });

    await expect(request({ method: 'GET', path: '/rate-limited' })).resolves.toMatchObject({
      status: 429, retryAfter: '3',
    });
  });

  it('pins one corpus ref so main advancing between dispatches cannot split workflow code', async () => {
    let nextRunId = 7100;
    let mainCommit = 'c'.repeat(40);
    const resolvedCommits = new Map<number, string>();
    const request = vi.fn(async (input: any) => {
      if (input.path.includes('/git/ref/heads/')) {
        return {
          status: 200,
          body: {
            ref: `refs/heads/${dispatchRef}`,
            object: { type: 'commit', sha: corpusCodeCommit },
          },
        };
      }
      if (input.method === 'POST') {
        expect(input.body.ref).toBe(dispatchRef);
        nextRunId += 1;
        resolvedCommits.set(nextRunId, input.body.ref === 'main' ? mainCommit : corpusCodeCommit);
        return {
          status: 200,
          body: {
            workflow_run_id: nextRunId,
            run_url: `https://api.github.com/repos/${repository}/actions/runs/${nextRunId}`,
            html_url: `https://github.com/${repository}/actions/runs/${nextRunId}`,
          },
        };
      }
      const group = nextRunId === 7101 ? '01' : '02';
      return { status: 200, body: boundRun(group, nextRunId, resolvedCommits.get(nextRunId) ?? null) };
    });

    await expect(ensureCrawlerGenerationDispatchRef({ request, generationToken, corpusCodeCommit }))
      .resolves.toBe(dispatchRef);
    await expect(dispatchWorkflowOnce({
      repository,
      workflowFile: 'crawler-group-01.yml',
      group: '01',
      generationToken,
      corpusCodeCommit,
      inputs: { skip_ai_translation: '1', generation_token: generationToken, site_code_commit: siteCodeCommit },
      request,
    })).resolves.toEqual({ status: 'direct', runId: '7101' });
    mainCommit = 'd'.repeat(40);
    await expect(dispatchWorkflowOnce({
      repository,
      workflowFile: 'crawler-group-02.yml',
      group: '02',
      generationToken,
      corpusCodeCommit,
      inputs: { skip_ai_translation: '1', generation_token: generationToken, site_code_commit: siteCodeCommit },
      request,
    })).resolves.toEqual({ status: 'direct', runId: '7102' });
    expect(mainCommit).not.toBe(corpusCodeCommit);
    expect([...resolvedCommits.values()]).toEqual([corpusCodeCommit, corpusCodeCommit]);
    expect(request.mock.calls.flatMap(([input]) => input.method).filter((method) => method === 'PATCH')).toEqual([]);
  });

  it('creates a generation-scoped ref instead of sharing mutable code across concurrent waves', async () => {
    const token = '9002-1';
    const expectedRef = `crawler-generation-shadow-${token}`;
    const request = vi.fn(async (input: any) => {
      if (input.method === 'GET') return { status: 404, body: null };
      expect(input).toMatchObject({
        method: 'POST',
        path: `/repos/${repository}/git/refs`,
        body: { ref: `refs/heads/${expectedRef}`, sha: corpusCodeCommit },
      });
      return {
        status: 201,
        body: { ref: `refs/heads/${expectedRef}`, object: { type: 'commit', sha: corpusCodeCommit } },
      };
    });

    await expect(ensureCrawlerGenerationDispatchRef({
      request, generationToken: token, corpusCodeCommit,
    })).resolves.toBe(expectedRef);
    expect(request).toHaveBeenCalledTimes(2);
    expect(expectedRef).not.toBe(dispatchRef);
  });

  it('treats a concurrent same-SHA ref creation as idempotent after an exact reread', async () => {
    let reads = 0;
    const request = vi.fn(async (input: any) => {
      if (input.method === 'GET' && reads++ === 0) return { status: 404, body: null };
      if (input.method === 'POST') return { status: 422, body: { message: 'Reference already exists' } };
      return {
        status: 200,
        body: { ref: `refs/heads/${dispatchRef}`, object: { type: 'commit', sha: corpusCodeCommit } },
      };
    });
    await expect(ensureCrawlerGenerationDispatchRef({ request, generationToken, corpusCodeCommit }))
      .resolves.toBe(dispatchRef);
    expect(request.mock.calls.map(([input]) => input.method)).toEqual(['GET', 'POST', 'GET']);
  });

  it('hydrates the exact ref after multiple transient 404s without repeating the POST', async () => {
    let reads = 0;
    let posts = 0;
    const sleeps: number[] = [];
    const request = vi.fn(async (input: any) => {
      if (input.method === 'POST') {
        posts += 1;
        return { status: 422, body: { message: 'Reference already exists' } };
      }
      reads += 1;
      if (reads <= 4) return { status: 404, body: null };
      return {
        status: 200,
        body: { ref: `refs/heads/${dispatchRef}`, object: { type: 'commit', sha: corpusCodeCommit } },
      };
    });

    await expect(ensureCrawlerGenerationDispatchRef({
      request,
      generationToken,
      corpusCodeCommit,
      sleep: async (milliseconds) => { sleeps.push(milliseconds); },
    })).resolves.toBe(dispatchRef);
    expect(posts).toBe(1);
    expect(reads).toBe(5);
    expect(sleeps).toEqual(DISPATCH_REF_CONFLICT_BACKOFF_MS.slice(0, 3));
    expect(request.mock.calls.every(([input]) => !input.path.includes('/matching-refs/'))).toBe(true);
  });

  it('fails closed after the bounded exact-ref reread budget without repeating the POST', async () => {
    let posts = 0;
    const sleeps: number[] = [];
    const request = vi.fn(async (input: any) => {
      if (input.method === 'POST') {
        posts += 1;
        return { status: 422, body: { message: 'Reference already exists' } };
      }
      return { status: 404, body: null };
    });

    await expect(ensureCrawlerGenerationDispatchRef({
      request,
      generationToken,
      corpusCodeCommit,
      sleep: async (milliseconds) => { sleeps.push(milliseconds); },
    })).rejects.toThrow('crawler_generation_ref_pin_failed');
    expect(posts).toBe(1);
    expect(request.mock.calls.filter(([input]) => input.method === 'GET')).toHaveLength(
      DISPATCH_REF_CONFLICT_BACKOFF_MS.length + 2,
    );
    expect(sleeps).toEqual(DISPATCH_REF_CONFLICT_BACKOFF_MS);
  });

  it('treats a populated commit mismatch and a non-compatible 422 as terminal', async () => {
    const mismatchSleeps: number[] = [];
    const mismatch = vi.fn(async (input: any) => {
      if (input.method === 'POST') {
        return { status: 422, body: { message: 'Reference already exists' } };
      }
      if (mismatch.mock.calls.length === 1) return { status: 404, body: null };
      return {
        status: 200,
        body: { ref: `refs/heads/${dispatchRef}`, object: { type: 'commit', sha: '9'.repeat(40) } },
      };
    });
    await expect(ensureCrawlerGenerationDispatchRef({
      request: mismatch,
      generationToken,
      corpusCodeCommit,
      sleep: async (milliseconds) => { mismatchSleeps.push(milliseconds); },
    })).rejects.toThrow('crawler_generation_ref_pin_failed');
    expect(mismatch.mock.calls.map(([input]) => input.method)).toEqual(['GET', 'POST', 'GET']);
    expect(mismatchSleeps).toEqual([]);

    const generic422 = vi.fn(async (input: any) => (
      input.method === 'GET'
        ? { status: 404, body: null }
        : { status: 422, body: { message: 'Validation failed' } }
    ));
    await expect(ensureCrawlerGenerationDispatchRef({
      request: generic422,
      generationToken,
      corpusCodeCommit,
      sleep: async () => {},
    })).rejects.toThrow('crawler_generation_ref_pin_failed');
    expect(generic422.mock.calls.map(([input]) => input.method)).toEqual(['GET', 'POST']);
  });

  it('fails closed without mutating a generation ref that already binds another commit', async () => {
    const request = vi.fn(async () => ({
      status: 200,
      body: { ref: `refs/heads/${dispatchRef}`, object: { type: 'commit', sha: '9'.repeat(40) } },
    }));

    await expect(ensureCrawlerGenerationDispatchRef({ request, generationToken, corpusCodeCommit }))
      .rejects.toThrow('crawler_generation_ref_pin_failed');
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0].method).toBe('GET');
  });

  it('cleans the current pin only after an exact compare and treats 404 as idempotent', async () => {
    const requests: any[] = [];
    const exact = vi.fn(async (input: any) => {
      requests.push(input);
      if (input.method === 'GET') return {
        status: 200,
        body: { ref: `refs/heads/${dispatchRef}`, object: { type: 'commit', sha: corpusCodeCommit } },
      };
      return { status: 204, body: null };
    });
    await expect(cleanupCrawlerGenerationDispatchRef({
      request: exact, generationToken, corpusCodeCommit,
    })).resolves.toEqual({ status: 'deleted', dispatchRef });
    expect(requests.map(({ method }) => method)).toEqual(['GET', 'DELETE']);

    const missing = vi.fn(async () => ({ status: 404, body: null }));
    await expect(cleanupCrawlerGenerationDispatchRef({
      request: missing, generationToken, corpusCodeCommit,
    })).resolves.toEqual({ status: 'already_missing', dispatchRef });
    expect(missing).toHaveBeenCalledTimes(1);
  });

  it('refuses cleanup when the current ref no longer matches the observed commit', async () => {
    const request = vi.fn(async () => ({
      status: 200,
      body: { ref: `refs/heads/${dispatchRef}`, object: { type: 'commit', sha: '9'.repeat(40) } },
    }));
    await expect(cleanupCrawlerGenerationDispatchRef({ request, generationToken, corpusCodeCommit }))
      .rejects.toThrow('crawler_generation_ref_cleanup_binding_mismatch');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('runs the real cleanup-ref CLI path without requiring GITHUB_OUTPUT or checkpoint arguments', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (init?.method === 'GET') return new Response(JSON.stringify({
        ref: `refs/heads/${dispatchRef}`,
        object: { type: 'commit', sha: corpusCodeCommit },
      }), { status: 200 });
      expect(String(input)).toContain(`/git/refs/heads/${dispatchRef}`);
      expect(init?.method).toBe('DELETE');
      return new Response(null, { status: 204 });
    });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(runCrawlerGenerationDispatchCli([
      'cleanup-ref',
      '--generation-token', generationToken,
      '--corpus-code-commit', corpusCodeCommit,
    ], {
      GITHUB_API_URL: 'https://api.github.test',
      GITHUB_PAT_NANAKO: 'test-token',
    })).resolves.toEqual({ status: 'deleted', dispatchRef });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reaps exact stale cancelled/timed-out owners with one documented list request', async () => {
    const now = Date.parse('2026-09-01T12:00:00.000Z');
    const tokens = [
      '8001-1', '8002-2', generationToken, 'invalid-token',
      '08003-1', '8004-01', '8005-0', '8006-1-extra',
    ];
    const refs = tokens.map((token, index) => ({
      ref: `refs/heads/crawler-generation-shadow-${token}`,
      object: { type: 'commit', sha: String(index + 1).repeat(40) },
    }));
    const stale = new Date(now - CRAWLER_GENERATION_REF_RETENTION_MS - 1).toISOString();
    const owner = (token: string, overrides: Record<string, unknown> = {}) => {
      const [runId, runAttempt] = token.split('-');
      return {
        id: Number(runId),
        repository: { full_name: 'valerielinc-ops/frontaliere-si-o-no' },
        path: '.github/workflows/orchestrate-crawlers.yml@refs/heads/main',
        run_attempt: Number(runAttempt),
        status: 'completed',
        conclusion: 'cancelled',
        updated_at: stale,
        ...overrides,
      };
    };
    const owners: Record<string, any> = {
      '8001': owner('8001-1'),
      '8002': owner('8002-2', { conclusion: 'timed_out' }),
    };
    const deleted: string[] = [];
    const request = vi.fn(async (input: any) => {
      if (input.path.includes('/git/matching-refs/')) return { status: 200, body: refs };
      const ownerMatch = /\/actions\/runs\/(\d+)$/.exec(input.path);
      if (ownerMatch) return { status: 200, body: owners[ownerMatch[1]] };
      const refMatch = /\/git\/ref\/heads\/(.+)$/.exec(input.path);
      if (refMatch) {
        const observed = refs.find(({ ref }) => ref === `refs/heads/${refMatch[1]}`)!;
        return { status: 200, body: observed };
      }
      if (input.method === 'DELETE') {
        deleted.push(input.path);
        return { status: 204, body: null };
      }
      throw new Error(`unexpected request ${input.method} ${input.path}`);
    });

    await expect(reapStaleCrawlerGenerationDispatchRefs({
      request, currentGenerationToken: generationToken, now,
    })).resolves.toEqual({
      status: 'ok', listed: tokens.length, reaped: 2, preserved: tokens.length - 2, truncated: false,
    });
    expect(deleted).toEqual([
      `/repos/${repository}/git/refs/heads/crawler-generation-shadow-8001-1`,
      `/repos/${repository}/git/refs/heads/crawler-generation-shadow-8002-2`,
    ]);
    const listCalls = request.mock.calls.filter(([input]) => input.path.includes('/git/matching-refs/'));
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0]?.[0].path).not.toContain('?');
  });

  it('processes at most four generation refs oldest-first from one unpaginated response', async () => {
    const tokens = ['9100-1', '7000-2', '8000-1', '6000-3', '5000-1', '9200-1'];
    const refs = tokens.map((token) => ({
      ref: `refs/heads/crawler-generation-shadow-${token}`,
      object: { type: 'commit', sha: corpusCodeCommit },
    }));
    const ownerCalls: string[] = [];
    const request = vi.fn(async (input: any) => {
      if (input.path.includes('/git/matching-refs/')) return { status: 200, body: refs };
      ownerCalls.push(input.path);
      return { status: 200, body: { status: 'in_progress' } };
    });
    await expect(reapStaleCrawlerGenerationDispatchRefs({
      request, currentGenerationToken: generationToken,
    })).resolves.toEqual({ status: 'ok', listed: 6, reaped: 0, preserved: 6, truncated: true });
    expect(ownerCalls).toEqual(['5000', '6000', '7000', '8000'].map(
      (runId) => `/repos/valerielinc-ops/frontaliere-si-o-no/actions/runs/${runId}`,
    ));
    expect(ownerCalls).toHaveLength(MAX_CRAWLER_GENERATION_REAPER_CANDIDATES);
    expect(request.mock.calls.filter(([input]) => input.path.includes('/git/matching-refs/'))).toHaveLength(1);
  });

  it('preserves active, young, wrong-owner, malformed, uncertain and changed refs', async () => {
    const now = Date.parse('2026-09-01T12:00:00.000Z');
    const stale = new Date(now - CRAWLER_GENERATION_REF_RETENTION_MS - 1).toISOString();
    const young = new Date(now - CRAWLER_GENERATION_REF_RETENTION_MS + 1).toISOString();
    const baseOwner = {
      id: 8100,
      repository: { full_name: 'valerielinc-ops/frontaliere-si-o-no' },
      path: '.github/workflows/orchestrate-crawlers.yml',
      run_attempt: 1,
      status: 'completed',
      conclusion: 'cancelled',
      updated_at: stale,
    };
    const variants = [
      { owner: { ...baseOwner, status: 'in_progress', conclusion: null } },
      { owner: { ...baseOwner, updated_at: young } },
      { owner: { ...baseOwner, repository: { full_name: 'attacker/untrusted' } } },
      { owner: { ...baseOwner, path: '.github/workflows/other.yml' } },
      { owner: { ...baseOwner, run_attempt: 2 } },
      { owner: { malformed: true } },
      { ownerStatus: 503 },
      { owner: baseOwner, changedRef: true },
    ];
    for (const variant of variants) {
      const observed = {
        ref: 'refs/heads/crawler-generation-shadow-8100-1',
        object: { type: 'commit', sha: corpusCodeCommit },
      };
      const request = vi.fn(async (input: any) => {
        if (input.path.includes('/git/matching-refs/')) return { status: 200, body: [observed] };
        if (input.path.includes('/actions/runs/')) {
          return { status: variant.ownerStatus ?? 200, body: variant.owner ?? null };
        }
        if (input.method === 'GET') return {
          status: 200,
          body: variant.changedRef
            ? { ...observed, object: { type: 'commit', sha: 'f'.repeat(40) } }
            : observed,
        };
        throw new Error('DELETE must not be reached');
      });
      await expect(reapStaleCrawlerGenerationDispatchRefs({
        request, currentGenerationToken: generationToken, now,
      })).resolves.toEqual({ status: 'ok', listed: 1, reaped: 0, preserved: 1, truncated: false });
      expect(request.mock.calls.some(([input]) => input.method === 'DELETE')).toBe(false);
    }
  });

  it('does not derive reaper candidates from a malformed list response', async () => {
    const page = [{ ref: 'refs/heads/crawler-generation-shadow-8001-1' }];

    const malformed = vi.fn(async () => ({ status: 200, body: { refs: page } }));
    await expect(reapStaleCrawlerGenerationDispatchRefs({
      request: malformed, currentGenerationToken: generationToken,
    })).resolves.toEqual({ status: 'list_failed', listed: 0, reaped: 0, preserved: 0, truncated: false });
    expect(malformed).toHaveBeenCalledTimes(1);
  });

  it('streams and cancels a response that exceeds the byte cap without Content-Length', async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(64 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      new Response(body, { status: 200 })
    ));
    const request = createGitHubActionsRequester({
      apiUrl: 'https://api.github.test',
      token: 'test-token',
      fetchImpl,
    });
    await expect(request({
      method: 'GET',
      path: '/oversized',
      body: undefined,
    })).rejects.toThrow('response_too_large');
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(32);
  });

  it('returns a real response that completes an instant before its bound timeout fires', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise((resolve, reject) => {
        const onAbort = () => reject(new DOMException('This operation was aborted', 'AbortError'));
        init?.signal?.addEventListener('abort', onAbort, { once: true });
        setTimeout(() => {
          init?.signal?.removeEventListener('abort', onAbort);
          resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
        }, 749);
      }));
      const request = createGitHubActionsRequester({
        apiUrl: 'https://api.github.test', token: 'test-token', fetchImpl,
      });
      const pending = request({ method: 'GET', path: '/repos/x/actions/runs/1', timeoutMs: 750 });
      await vi.advanceTimersByTimeAsync(749);
      await expect(pending).resolves.toMatchObject({ status: 200 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects instead of fabricating a match when the abort wins the tail race against a slow-but-real response', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise((resolve, reject) => {
        const onAbort = () => reject(new DOMException('This operation was aborted', 'AbortError'));
        init?.signal?.addEventListener('abort', onAbort, { once: true });
        // Arrives one tick after the bound timeout — the abort timer was armed first (registered
        // before the fetch call) and always fires first on an exact tie, so this must never resolve.
        setTimeout(() => {
          resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
        }, 751);
      }));
      const request = createGitHubActionsRequester({
        apiUrl: 'https://api.github.test', token: 'test-token', fetchImpl,
      });
      const pending = request({ method: 'GET', path: '/repos/x/actions/runs/1', timeoutMs: 750 });
      const assertion = expect(pending).rejects.toThrow(/abort/i);
      await vi.advanceTimersByTimeAsync(800);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('never retries POST after a transport failure and reconciles only one exact global run name', async () => {
    let postCalls = 0;
    const request = vi.fn(async (input: any) => {
      if (input.method === 'POST') {
        postCalls += 1;
        throw new Error('timeout after server acceptance');
      }
      if (input.path.endsWith('/actions/runs?event=workflow_dispatch&per_page=100&page=1')) {
        return { status: 200, body: { total_count: 1, workflow_runs: [boundRun()] } };
      }
      return { status: 200, body: boundRun() };
    });

    await expect(dispatchWorkflowOnce({
      repository,
      workflowFile: 'crawler-group-01.yml',
      group: '01',
      generationToken,
      inputs: { skip_ai_translation: '1', generation_token: generationToken },
      request,
      sleep: async () => {},
    })).resolves.toEqual({ status: 'reconciled_transport_error', runId: '7001' });
    expect(postCalls).toBe(1);
  });

  it('retries the POST a bounded number of times in legacy mode after transient transport failures', async () => {
    let postCalls = 0;
    const sleeps: number[] = [];
    const request = vi.fn(async (input: any) => {
      if (input.method === 'POST') {
        postCalls += 1;
        if (postCalls < LEGACY_DISPATCH_POST_ATTEMPTS) throw new Error('timeout before server acceptance');
        return {
          status: 200,
          body: {
            workflow_run_id: 7001,
            run_url: `https://api.github.com/repos/${repository}/actions/runs/7001`,
            html_url: `https://github.com/${repository}/actions/runs/7001`,
          },
        };
      }
      return { status: 200, body: boundRun() };
    });
    await expect(dispatchWorkflowOnce({
      repository,
      workflowFile: 'crawler-group-01.yml',
      group: '01',
      generationToken,
      inputs: { skip_ai_translation: '1' },
      request,
      allowReconciliation: false,
      sleep: async (milliseconds) => { sleeps.push(milliseconds); },
    })).resolves.toEqual({ status: 'direct', runId: '7001' });
    expect(postCalls).toBe(LEGACY_DISPATCH_POST_ATTEMPTS);
    expect(sleeps).toEqual(
      Array.from({ length: LEGACY_DISPATCH_POST_ATTEMPTS - 1 }, (_, index) => (index + 1) * LEGACY_DISPATCH_RETRY_DELAY_MS),
    );
  });

  it('gives up after the bounded legacy POST retry budget on a persistent transport failure', async () => {
    let postCalls = 0;
    const request = vi.fn(async (input: any) => {
      if (input.method === 'POST') {
        postCalls += 1;
        throw new Error('persistent timeout');
      }
      return { status: 200, body: boundRun() };
    });
    await expect(dispatchWorkflowOnce({
      repository,
      workflowFile: 'crawler-group-01.yml',
      group: '01',
      generationToken,
      inputs: { skip_ai_translation: '1' },
      request,
      allowReconciliation: false,
      sleep: async () => {},
    })).resolves.toEqual({ status: 'missing', runId: null });
    expect(postCalls).toBe(LEGACY_DISPATCH_POST_ATTEMPTS);
  });

  it('never exceeds the legacy POST retry budget on a persistent 204 protocol mismatch', async () => {
    let postCalls = 0;
    const request = vi.fn(async (input: any) => {
      if (input.method === 'POST') {
        postCalls += 1;
        return { status: 204, body: null };
      }
      return { status: 200, body: boundRun() };
    });
    await expect(dispatchWorkflowOnce({
      repository,
      workflowFile: 'crawler-group-01.yml',
      group: '01',
      generationToken,
      inputs: { skip_ai_translation: '1' },
      request,
      allowReconciliation: false,
      sleep: async () => {},
    })).resolves.toEqual({ status: 'api_protocol_mismatch', runId: null });
    expect(postCalls).toBe(LEGACY_DISPATCH_POST_ATTEMPTS);
  });

  it('polls read-only discovery until an accepted POST becomes visible without retrying POST', async () => {
    let postCalls = 0;
    let listCalls = 0;
    const sleeps: number[] = [];
    const request = vi.fn(async (input: any) => {
      if (input.method === 'POST') {
        postCalls += 1;
        throw new Error('timeout after server acceptance');
      }
      if (input.path.includes('/actions/runs?')) {
        listCalls += 1;
        return {
          status: 200,
          body: { total_count: listCalls === 1 ? 0 : 1, workflow_runs: listCalls === 1 ? [] : [boundRun()] },
        };
      }
      return { status: 200, body: boundRun() };
    });
    await expect(dispatchWorkflowOnce({
      repository,
      workflowFile: 'crawler-group-01.yml',
      group: '01',
      generationToken,
      inputs: { skip_ai_translation: '1', generation_token: generationToken },
      request,
      sleep: async (milliseconds) => { sleeps.push(milliseconds); },
    })).resolves.toEqual({ status: 'reconciled_transport_error', runId: '7001' });
    expect(postCalls).toBe(1);
    expect(listCalls).toBe(2);
    expect(sleeps).toEqual([3_000]);
  });

  it('continues bounded reconciliation when a listed run is not yet readable by exact ID', async () => {
    let postCalls = 0;
    let listCalls = 0;
    let exactGetCalls = 0;
    const request = vi.fn(async (input: any) => {
      if (input.method === 'POST') {
        postCalls += 1;
        throw new Error('timeout after server acceptance');
      }
      if (input.path.includes('/actions/runs?')) {
        listCalls += 1;
        return { status: 200, body: { total_count: 1, workflow_runs: [boundRun()] } };
      }
      exactGetCalls += 1;
      return exactGetCalls <= 3
        ? { status: 404, body: null }
        : { status: 200, body: boundRun() };
    });
    await expect(dispatchWorkflowOnce({
      repository,
      workflowFile: 'crawler-group-01.yml',
      group: '01',
      generationToken,
      inputs: { skip_ai_translation: '1', generation_token: generationToken },
      request,
      sleep: async () => {},
    })).resolves.toEqual({ status: 'reconciled_transport_error', runId: '7001' });
    expect(postCalls).toBe(1);
    expect(listCalls).toBe(2);
    expect(exactGetCalls).toBe(4);
  });

  it.each([
    { runs: [], expected: { status: 'missing', runId: null }, listCalls: 6 },
    {
      runs: [boundRun('01', 7001), boundRun('01', 7002)],
      expected: { status: 'duplicate', runId: null },
      listCalls: 1,
    },
  ])('fails closed for zero or duplicate exact reconciliation matches', async ({ runs, expected, listCalls }) => {
    let postCalls = 0;
    let observedListCalls = 0;
    const request = vi.fn(async (input: any) => {
      if (input.method === 'POST') {
        postCalls += 1;
        throw new Error('ambiguous transport');
      }
      observedListCalls += 1;
      return { status: 200, body: { total_count: runs.length, workflow_runs: runs } };
    });
    await expect(dispatchWorkflowOnce({
      repository,
      workflowFile: 'crawler-group-01.yml',
      group: '01',
      generationToken,
      inputs: { skip_ai_translation: '1', generation_token: generationToken },
      request,
      sleep: async () => {},
    })).resolves.toEqual(expected);
    expect(postCalls).toBe(1);
    expect(observedListCalls).toBe(listCalls);
  });

  it('retries only the direct-ID GET when propagation returns 404, never the POST', async () => {
    let postCalls = 0;
    let getCalls = 0;
    const request = vi.fn(async (input: any) => {
      if (input.method === 'POST') {
        postCalls += 1;
        return {
          status: 200,
          body: {
            workflow_run_id: 7001,
            run_url: 'https://api.github.com/repos/nanakokyobashi-rgb/frontaliere-articles/actions/runs/7001',
            html_url: 'https://github.com/nanakokyobashi-rgb/frontaliere-articles/actions/runs/7001',
          },
        };
      }
      getCalls += 1;
      return getCalls === 1 ? { status: 404, body: null } : { status: 200, body: boundRun() };
    });
    await expect(dispatchWorkflowOnce({
      repository,
      workflowFile: 'crawler-group-01.yml',
      group: '01',
      generationToken,
      inputs: { skip_ai_translation: '1', generation_token: generationToken },
      request,
      sleep: async () => {},
    })).resolves.toEqual({ status: 'direct', runId: '7001' });
    expect(postCalls).toBe(1);
    expect(getCalls).toBe(2);
  });

  it('hydrates the authoritative run ID after more than three partial GET snapshots', async () => {
    let getCalls = 0;
    const sleeps: number[] = [];
    const request = vi.fn(async (input: any) => {
      if (input.method === 'POST') return {
        status: 200,
        body: {
          workflow_run_id: 7001,
          run_url: `https://api.github.com/repos/${repository}/actions/runs/7001`,
          html_url: `https://github.com/${repository}/actions/runs/7001`,
        },
      };
      getCalls += 1;
      return {
        status: 200,
        body: getCalls <= 4
          ? { ...boundRun(), display_title: 'Crawler Group 01 (sparse cross-repo execution)', path: null }
          : boundRun(),
      };
    });
    await expect(dispatchWorkflowOnce({
      repository,
      workflowFile: 'crawler-group-01.yml',
      group: '01',
      generationToken,
      inputs: { skip_ai_translation: '1', generation_token: generationToken },
      request,
      sleep: async (milliseconds) => { sleeps.push(milliseconds); },
    })).resolves.toEqual({ status: 'direct', runId: '7001' });
    expect(getCalls).toBe(5);
    expect(sleeps).toEqual(DIRECT_RUN_HYDRATION_BACKOFF_MS.slice(0, 4));
    expect(request.mock.calls.some(([input]) => input.path.includes('/actions/runs?'))).toBe(false);
  });

  it('fails shadow binding closed if corpus main advances between preflight and POST', async () => {
    let postCalls = 0;
    const request = vi.fn(async (input: any) => {
      if (input.method === 'POST') {
        postCalls += 1;
        return {
          status: 200,
          body: {
            workflow_run_id: 7001,
            run_url: `https://api.github.com/repos/${repository}/actions/runs/7001`,
            html_url: `https://github.com/${repository}/actions/runs/7001`,
          },
        };
      }
      return { status: 200, body: boundRun('01', 7001, 'c'.repeat(40)) };
    });
    await expect(dispatchWorkflowOnce({
      repository,
      workflowFile: 'crawler-group-01.yml',
      group: '01',
      generationToken,
      corpusCodeCommit,
      inputs: { skip_ai_translation: '1', generation_token: generationToken },
      request,
      sleep: async () => {},
    })).resolves.toEqual({ status: 'binding_mismatch', runId: null });
    expect(postCalls).toBe(1);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('times out bounded direct-ID hydration without duplicating the POST or using list discovery', async () => {
    let postCalls = 0;
    let getCalls = 0;
    let nowMs = 0;
    const sleeps: number[] = [];
    const request = vi.fn(async (input: any) => {
      if (input.method === 'POST') {
        postCalls += 1;
        return {
          status: 200,
          body: {
            workflow_run_id: 7001,
            run_url: 'https://api.github.com/repos/nanakokyobashi-rgb/frontaliere-articles/actions/runs/7001',
            html_url: 'https://github.com/nanakokyobashi-rgb/frontaliere-articles/actions/runs/7001',
          },
        };
      }
      getCalls += 1;
      nowMs += 6_000;
      return { status: 404, body: null };
    });
    await expect(dispatchWorkflowOnce({
      repository,
      workflowFile: 'crawler-group-01.yml',
      group: '01',
      generationToken,
      inputs: { skip_ai_translation: '1', generation_token: generationToken },
      request,
      now: () => nowMs,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        nowMs += milliseconds;
      },
    })).resolves.toEqual({ status: 'missing', runId: null });
    expect(postCalls).toBe(1);
    expect(getCalls).toBe(2);
    expect(sleeps).toEqual([250]);
    expect(nowMs).toBeGreaterThan(DIRECT_RUN_HYDRATION_TIMEOUT_MS);
    expect(request.mock.calls.some(([input]) => input.path.includes('/actions/runs?'))).toBe(false);
    expect(request.mock.calls.filter(([input]) => input.method === 'GET').map(([input]) => input.timeoutMs))
      .toEqual([10_000, 3_750]);
  });

  it('classifies direct through the real requester when hydration completes just before its bound abort fires', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'POST') {
          return Promise.resolve(new Response(JSON.stringify({
            workflow_run_id: 7001,
            run_url: `https://api.github.com/repos/${repository}/actions/runs/7001`,
            html_url: `https://github.com/${repository}/actions/runs/7001`,
          }), { status: 200 }));
        }
        return new Promise((resolve, reject) => {
          const onAbort = () => reject(new DOMException('This operation was aborted', 'AbortError'));
          init?.signal?.addEventListener('abort', onAbort, { once: true });
          setTimeout(() => {
            init?.signal?.removeEventListener('abort', onAbort);
            resolve(new Response(JSON.stringify(boundRun('01', 7001, null)), { status: 200 }));
          }, DIRECT_RUN_HYDRATION_TIMEOUT_MS - 1);
        });
      });
      const request = createGitHubActionsRequester({
        apiUrl: 'https://api.github.test', token: 'test-token', fetchImpl,
      });
      const pending = dispatchWorkflowOnce({
        repository,
        workflowFile: 'crawler-group-01.yml',
        group: '01',
        generationToken,
        inputs: { skip_ai_translation: '1', generation_token: generationToken },
        request,
      });
      await vi.advanceTimersByTimeAsync(DIRECT_RUN_HYDRATION_TIMEOUT_MS);
      await expect(pending).resolves.toEqual({ status: 'direct', runId: '7001' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('never fabricates direct when every hydration GET loses the tail race against its own bound abort', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'POST') {
          return Promise.resolve(new Response(JSON.stringify({
            workflow_run_id: 7001,
            run_url: `https://api.github.com/repos/${repository}/actions/runs/7001`,
            html_url: `https://github.com/${repository}/actions/runs/7001`,
          }), { status: 200 }));
        }
        return new Promise((resolve, reject) => {
          const onAbort = () => reject(new DOMException('This operation was aborted', 'AbortError'));
          init?.signal?.addEventListener('abort', onAbort, { once: true });
          // Always arrives after any single attempt's own bound timeout (capped at the 10s
          // hydration deadline), so the abort wins every attempt — this must never surface as
          // 'direct' with a stale/discarded response.
          setTimeout(() => {
            resolve(new Response(JSON.stringify(boundRun('01', 7001, null)), { status: 200 }));
          }, DIRECT_RUN_HYDRATION_TIMEOUT_MS + 1_000);
        });
      });
      const request = createGitHubActionsRequester({
        apiUrl: 'https://api.github.test', token: 'test-token', fetchImpl,
      });
      const pending = dispatchWorkflowOnce({
        repository,
        workflowFile: 'crawler-group-01.yml',
        group: '01',
        generationToken,
        inputs: { skip_ai_translation: '1', generation_token: generationToken },
        request,
      });
      await vi.advanceTimersByTimeAsync(DIRECT_RUN_HYDRATION_TIMEOUT_MS + 10_000);
      await expect(pending).resolves.toEqual({ status: 'missing', runId: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a 403 exact-ID response as terminal without retry, list discovery or another POST', async () => {
    let postCalls = 0;
    let getCalls = 0;
    const sleeps: number[] = [];
    const request = vi.fn(async (input: any) => {
      if (input.method === 'POST') {
        postCalls += 1;
        return {
          status: 200,
          body: {
            workflow_run_id: 7001,
            run_url: `https://api.github.com/repos/${repository}/actions/runs/7001`,
            html_url: `https://github.com/${repository}/actions/runs/7001`,
          },
        };
      }
      getCalls += 1;
      return { status: 403, body: null, retryAfter: '1' };
    });

    await expect(dispatchWorkflowOnce({
      repository,
      workflowFile: 'crawler-group-01.yml',
      group: '01',
      generationToken,
      inputs: { skip_ai_translation: '1', generation_token: generationToken },
      request,
      sleep: async (milliseconds) => { sleeps.push(milliseconds); },
    })).resolves.toEqual({ status: 'missing', runId: null });
    expect({ postCalls, getCalls, sleeps }).toEqual({ postCalls: 1, getCalls: 1, sleeps: [] });
    expect(request.mock.calls.some(([input]) => input.path.includes('/actions/runs?'))).toBe(false);
  });

  it('honours a positive 429 Retry-After only while it stays inside the hydration deadline', async () => {
    let postCalls = 0;
    let getCalls = 0;
    let nowMs = 0;
    const sleeps: number[] = [];
    const request = vi.fn(async (input: any) => {
      if (input.method === 'POST') {
        postCalls += 1;
        return {
          status: 200,
          body: {
            workflow_run_id: 7001,
            run_url: `https://api.github.com/repos/${repository}/actions/runs/7001`,
            html_url: `https://github.com/${repository}/actions/runs/7001`,
          },
        };
      }
      getCalls += 1;
      return getCalls === 1
        ? { status: 429, body: null, retryAfter: '2' }
        : { status: 200, body: boundRun() };
    });

    await expect(dispatchWorkflowOnce({
      repository,
      workflowFile: 'crawler-group-01.yml',
      group: '01',
      generationToken,
      inputs: { skip_ai_translation: '1', generation_token: generationToken },
      request,
      now: () => nowMs,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        nowMs += milliseconds;
      },
    })).resolves.toEqual({ status: 'direct', runId: '7001' });
    expect({ postCalls, getCalls, sleeps }).toEqual({ postCalls: 1, getCalls: 2, sleeps: [2_000] });
    expect(request.mock.calls.filter(([input]) => input.method === 'GET').map(([input]) => input.timeoutMs))
      .toEqual([10_000, 8_000]);
  });

  it.each([null, '0', '-1', '1.5', '10', '999999999999999999999'])(
    'fails a 429 closed when Retry-After %s is invalid or exhausts the deadline',
    async (retryAfter) => {
      let postCalls = 0;
      let getCalls = 0;
      const sleeps: number[] = [];
      const request = vi.fn(async (input: any) => {
        if (input.method === 'POST') {
          postCalls += 1;
          return {
            status: 200,
            body: {
              workflow_run_id: 7001,
              run_url: `https://api.github.com/repos/${repository}/actions/runs/7001`,
              html_url: `https://github.com/${repository}/actions/runs/7001`,
            },
          };
        }
        getCalls += 1;
        return { status: 429, body: null, retryAfter };
      });

      await expect(dispatchWorkflowOnce({
        repository,
        workflowFile: 'crawler-group-01.yml',
        group: '01',
        generationToken,
        inputs: { skip_ai_translation: '1', generation_token: generationToken },
        request,
        sleep: async (milliseconds) => { sleeps.push(milliseconds); },
      })).resolves.toEqual({ status: 'missing', runId: null });
      expect({ postCalls, getCalls, sleeps }).toEqual({ postCalls: 1, getCalls: 1, sleeps: [] });
    },
  );

  it('treats 204 as a protocol mismatch even when reconciliation finds a run', async () => {
    const request = vi.fn(async (input: any) => {
      if (input.method === 'POST') return { status: 204, body: null };
      if (input.path.includes('/actions/runs?')) {
        return { status: 200, body: { total_count: 1, workflow_runs: [boundRun()] } };
      }
      return { status: 200, body: boundRun() };
    });
    await expect(dispatchWorkflowOnce({
      repository,
      workflowFile: 'crawler-group-01.yml',
      group: '01',
      generationToken,
      inputs: { skip_ai_translation: '1', generation_token: generationToken },
      request,
    })).resolves.toEqual({ status: 'reconciled_protocol_mismatch', runId: '7001' });
    expect(request.mock.calls.filter(([input]) => input.method === 'POST')).toHaveLength(1);
  });
});

describe('generation checkpoint and fallback', () => {
  function groupArtifactFixture() {
    return Object.fromEntries(GROUP_IDS.map((group) => [
      `crawler-group-${group}.yml`,
      Buffer.from(`name: crawler-group-${group}\n`),
    ]));
  }

  function preflightFixture(observer: Buffer, groupArtifacts = groupArtifactFixture()) {
    return {
      schemaVersion: 1,
      groupCount: 23,
      artifactCount: 24,
      artifacts: [
        ...GROUP_IDS.map((group) => {
          const file = `crawler-group-${group}.yml`;
          return {
            file,
            artifactSha256: crypto.createHash('sha256').update(groupArtifacts[file]).digest('hex'),
          };
        }),
        { file: 'translate-pending.yml' },
      ],
      observerCount: 1,
      crawlerGeneration: { mode: 'shadow', dispatchesTranslation: false },
      observers: [{
        source: 'observers/workflows/crawler-generation-observer-shadow.yml',
        target: '.github/workflows/crawler-generation-observer-shadow.yml',
        sha256: crypto.createHash('sha256').update(observer).digest('hex'),
      }],
    };
  }

  function preflightResponse(input: any, contract: any, observer: Buffer, artifacts: Record<string, Buffer>) {
    if (input.path.endsWith('/commits/main')) return { status: 200, body: { sha: corpusCodeCommit } };
    if (input.path.includes('/actions/workflows/')) {
      return { status: 200, body: { state: 'active', path: '.github/workflows/crawler-generation-observer-shadow.yml' } };
    }
    if (input.path.includes('/generator/data/crawler-cross-repo-contract.json?')) {
      return { status: 200, body: { encoding: 'base64', content: Buffer.from(JSON.stringify(contract)).toString('base64') } };
    }
    if (input.path.includes('/crawler-generation-observer-shadow.yml?')) {
      return { status: 200, body: { encoding: 'base64', content: observer.toString('base64') } };
    }
    const file = /\/contents\/\.github\/workflows\/([^?]+)/.exec(input.path)?.[1];
    const bytes = file ? artifacts[file] : null;
    return bytes
      ? { status: 200, body: { encoding: 'base64', content: bytes.toString('base64') } }
      : { status: 404, body: null };
  }

  it('accepts only an exact 23-group/24-artifact active hash-bound transport', () => {
    const observer = Buffer.from('observer-workflow\n');
    const remoteArtifacts = groupArtifactFixture();
    const contract = preflightFixture(observer, remoteArtifacts);
    const input = {
      corpusCodeCommit,
      localContract: contract,
      remoteContract: structuredClone(contract),
      localObserver: observer,
      remoteObserver: observer,
      remoteArtifacts,
      remoteWorkflow: { state: 'active', path: '.github/workflows/crawler-generation-observer-shadow.yml' },
    };
    expect(evaluateCrawlerGenerationPreflight(input)).toEqual({
      ready: true, dispatchMode: 'shadow', corpusCodeCommit, reasons: [],
    });
    const missingGroup = structuredClone(contract);
    missingGroup.artifacts.splice(3, 1);
    missingGroup.artifactCount -= 1;
    expect(evaluateCrawlerGenerationPreflight({
      ...input,
      localContract: missingGroup,
      remoteContract: structuredClone(missingGroup),
    })).toMatchObject({ ready: false, dispatchMode: 'legacy' });
  });

  it('resolves one immutable corpus commit and hash-checks all 23 workflows at that exact ref', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-generation-preflight-'));
    tempRoots.push(root);
    const observer = Buffer.from('observer-workflow\n');
    const remoteArtifacts = groupArtifactFixture();
    const contract = preflightFixture(observer, remoteArtifacts);
    const contractPath = path.join(root, 'contract.json');
    const observerPath = path.join(root, 'observer.yml');
    fs.writeFileSync(contractPath, JSON.stringify(contract));
    fs.writeFileSync(observerPath, observer);
    const requests: any[] = [];
    const request = vi.fn(async (input: any) => {
      requests.push(input);
      if (input.path.endsWith('/commits/main')) return { status: 200, body: { sha: corpusCodeCommit } };
      if (input.path.includes('/actions/workflows/')) {
        return {
          status: 200,
          body: { state: 'active', path: '.github/workflows/crawler-generation-observer-shadow.yml' },
        };
      }
      let bytes: Buffer | null = null;
      if (input.path.includes('/generator/data/crawler-cross-repo-contract.json?')) {
        bytes = Buffer.from(JSON.stringify(contract));
      } else if (input.path.includes('/crawler-generation-observer-shadow.yml?')) {
        bytes = observer;
      } else {
        const file = /\/contents\/\.github\/workflows\/([^?]+)/.exec(input.path)?.[1];
        bytes = file ? remoteArtifacts[file] : null;
      }
      return bytes
        ? { status: 200, body: { encoding: 'base64', content: bytes.toString('base64') } }
        : { status: 404, body: null };
    });

    await expect(runPreflight({ request, contractPath, observerPath })).resolves.toEqual({
      ready: true, dispatchMode: 'shadow', corpusCodeCommit, reasons: [],
    });
    expect(requests[0]).toMatchObject({
      method: 'GET', path: `/repos/${repository}/commits/main`,
    });
    const contentRequests = requests.filter(({ path: requestPath }) => requestPath.includes('/contents/'));
    expect(contentRequests).toHaveLength(25);
    expect(contentRequests.every(({ path: requestPath }) => (
      requestPath.endsWith(`?ref=${corpusCodeCommit}`)
    ))).toBe(true);
  });

  it('retries transient preflight GET reads, then succeeds without issuing a POST', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-generation-preflight-retry-'));
    tempRoots.push(root);
    const observer = Buffer.from('observer-workflow\n');
    const artifacts = groupArtifactFixture();
    const contract = preflightFixture(observer, artifacts);
    const contractPath = path.join(root, 'contract.json');
    const observerPath = path.join(root, 'observer.yml');
    fs.writeFileSync(contractPath, JSON.stringify(contract));
    fs.writeFileSync(observerPath, observer);
    let attempts = 0;
    const request = vi.fn(async (input: any) => {
      if (input.path.endsWith('/commits/main') && attempts++ === 0) return { status: 503, body: null };
      return preflightResponse(input, contract, observer, artifacts);
    });
    const sleep = vi.fn(async () => {});

    await expect(runPreflight({ request, contractPath, observerPath, sleep })).resolves.toMatchObject({ ready: true });
    expect(sleep).toHaveBeenCalledWith(250);
    expect(request.mock.calls.filter(([input]) => input.method !== 'GET')).toHaveLength(0);
  });

  it.each([
    ['404', { status: 404, body: null }],
    ['403 without Retry-After', { status: 403, body: null }],
  ])('does not retry a non-retryable preflight %s response', async (_label, failure) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-generation-preflight-no-retry-'));
    tempRoots.push(root);
    const observer = Buffer.from('observer-workflow\n');
    const artifacts = groupArtifactFixture();
    const contract = preflightFixture(observer, artifacts);
    const contractPath = path.join(root, 'contract.json');
    const observerPath = path.join(root, 'observer.yml');
    fs.writeFileSync(contractPath, JSON.stringify(contract));
    fs.writeFileSync(observerPath, observer);
    const request = vi.fn(async (input: any) => (
      input.path.endsWith('/commits/main') ? failure : preflightResponse(input, contract, observer, artifacts)
    ));
    const sleep = vi.fn(async () => {});

    await expect(runPreflight({ request, contractPath, observerPath, sleep })).rejects.toThrow('corpus_commit_response_invalid');
    expect(request).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('caps concurrent immutable group reads at four', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-generation-preflight-concurrency-'));
    tempRoots.push(root);
    const observer = Buffer.from('observer-workflow\n');
    const artifacts = groupArtifactFixture();
    const contract = preflightFixture(observer, artifacts);
    const contractPath = path.join(root, 'contract.json');
    const observerPath = path.join(root, 'observer.yml');
    fs.writeFileSync(contractPath, JSON.stringify(contract));
    fs.writeFileSync(observerPath, observer);
    let active = 0;
    let peak = 0;
    const request = vi.fn(async (input: any) => {
      if (input.path.includes('/contents/.github/workflows/crawler-group-')) {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
      }
      return preflightResponse(input, contract, observer, artifacts);
    });

    await expect(runPreflight({ request, contractPath, observerPath, sleep: async () => {} })).resolves.toMatchObject({ ready: true });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBe(4);
  });

  it('falls back to legacy when one immutable group artifact does not match its contract hash', () => {
    const observer = Buffer.from('observer-workflow\n');
    const remoteArtifacts = groupArtifactFixture();
    const contract = preflightFixture(observer, remoteArtifacts);
    const corrupted = { ...remoteArtifacts, 'crawler-group-07.yml': Buffer.from('corrupted\n') };
    expect(evaluateCrawlerGenerationPreflight({
      corpusCodeCommit,
      localContract: contract,
      remoteContract: structuredClone(contract),
      localObserver: observer,
      remoteObserver: observer,
      remoteArtifacts: corrupted,
      remoteWorkflow: { state: 'active', path: '.github/workflows/crawler-generation-observer-shadow.yml' },
    })).toEqual({
      ready: false,
      dispatchMode: 'legacy',
      corpusCodeCommit: null,
      reasons: ['group_artifact_hash_mismatch'],
    });
  });

  it('persists an all-missing checkpoint before the first POST and after every outcome', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-generation-dispatch-'));
    tempRoots.push(root);
    const checkpointPath = path.join(root, 'checkpoint.json');
    type Checkpoint = Awaited<ReturnType<typeof runCrawlerGenerationDispatchWave>>;
    const snapshots: Checkpoint[] = [];
    const dispatched: any[] = [];
    const result = await runCrawlerGenerationDispatchWave({
      generationToken,
      siteCodeCommit,
      corpusCodeCommit,
      shadowReady: true,
      checkpointPath,
      delayMs: 0,
      dispatch: async (input) => {
        dispatched.push(input);
        return { status: 'direct', runId: String(8000 + Number(input.group)) };
      },
      onCheckpoint: (checkpoint) => {
        snapshots.push(structuredClone(checkpoint));
      },
    });

    expect(snapshots).toHaveLength(GROUP_IDS.length + 1);
    const firstSnapshot = snapshots[0];
    if (!firstSnapshot) throw new Error('initial checkpoint was not persisted');
    expect(Object.values(firstSnapshot.dispatchDiagnostics).every(
      (entry) => entry.status === 'missing' && entry.runId === null,
    )).toBe(true);
    expect(snapshots.at(-1)).toEqual(result);
    expect(JSON.parse(fs.readFileSync(checkpointPath, 'utf8'))).toEqual(result);
    expect(dispatched).toHaveLength(23);
    expect(dispatched.every(({ inputs }) => inputs.site_code_commit === siteCodeCommit)).toBe(true);
  });

  it('classifies all 23 hydrated authoritative IDs deterministically in the final checkpoint', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-generation-hydrated-wave-'));
    tempRoots.push(root);
    let nextRunId = 12_000;
    let postCalls = 0;
    const groupsByRunId = new Map<number, string>();
    const getCallsByRunId = new Map<number, number>();
    const request = vi.fn(async (input: any) => {
      if (input.method === 'POST') {
        postCalls += 1;
        nextRunId += 1;
        groupsByRunId.set(nextRunId, String(postCalls).padStart(2, '0'));
        return {
          status: 200,
          body: {
            workflow_run_id: nextRunId,
            run_url: `https://api.github.com/repos/${repository}/actions/runs/${nextRunId}`,
            html_url: `https://github.com/${repository}/actions/runs/${nextRunId}`,
          },
        };
      }
      expect(input.path).not.toContain('/actions/runs?');
      const runId = Number(input.path.split('/').at(-1));
      const group = groupsByRunId.get(runId);
      if (!group) throw new Error(`unbound test run ${runId}`);
      const getCalls = (getCallsByRunId.get(runId) ?? 0) + 1;
      getCallsByRunId.set(runId, getCalls);
      const run = boundRun(group, runId, corpusCodeCommit);
      return {
        status: 200,
        body: getCalls <= 4 ? { ...run, display_title: run.name, path: null } : run,
      };
    });

    const checkpoint = await runCrawlerGenerationDispatchWave({
      generationToken,
      siteCodeCommit,
      corpusCodeCommit,
      shadowReady: true,
      checkpointPath: path.join(root, 'checkpoint.json'),
      delayMs: 0,
      dispatch: ({ group, workflowFile, inputs }: any) => dispatchWorkflowOnce({
        repository,
        workflowFile,
        group,
        generationToken,
        corpusCodeCommit,
        inputs,
        request,
        allowReconciliation: false,
        sleep: async () => {},
      }),
    });

    expect(postCalls).toBe(23);
    expect([...getCallsByRunId.values()]).toEqual(Array(23).fill(5));
    expect(checkpoint.dispatchDiagnostics).toEqual(Object.fromEntries(GROUP_IDS.map((group, index) => [
      group, { status: 'direct', runId: String(12_001 + index) },
    ])));
    expect(GROUP_IDS.map((group) => checkpoint.groups[group].runId)).toEqual(
      GROUP_IDS.map((_, index) => String(12_001 + index)),
    );
  });

  it('fails preflight closed but explicitly selects legacy inputs instead of blocking crawlers', () => {
    const observer = Buffer.from('observer-workflow\n');
    const contract = {
      schemaVersion: 1,
      artifactCount: 24,
      observerCount: 1,
      crawlerGeneration: { mode: 'shadow', dispatchesTranslation: false },
      observers: [{
        source: 'observers/workflows/crawler-generation-observer-shadow.yml',
        target: '.github/workflows/crawler-generation-observer-shadow.yml',
        sha256: '0'.repeat(64),
      }],
    };
    expect(evaluateCrawlerGenerationPreflight({
      corpusCodeCommit,
      localContract: contract,
      remoteContract: structuredClone(contract),
      localObserver: observer,
      remoteObserver: observer,
      remoteArtifacts: groupArtifactFixture(),
      remoteWorkflow: { state: 'active', path: '.github/workflows/crawler-generation-observer-shadow.yml' },
    })).toMatchObject({ ready: false, dispatchMode: 'legacy' });
  });

  it('fails malformed observer schemas closed instead of throwing', () => {
    const observer = Buffer.from('observer-workflow\n');
    const contract = preflightFixture(observer);
    const remoteArtifacts = groupArtifactFixture();
    const malformed = { ...contract, observers: { find: 'not-a-function' } };
    expect(evaluateCrawlerGenerationPreflight({
      corpusCodeCommit,
      localContract: malformed,
      remoteContract: structuredClone(malformed),
      localObserver: observer,
      remoteObserver: observer,
      remoteArtifacts,
      remoteWorkflow: { state: 'active', path: '.github/workflows/crawler-generation-observer-shadow.yml' },
    })).toMatchObject({ ready: false, dispatchMode: 'legacy' });
  });

  it('reports missing preflight API configuration as a legacy infrastructure fallback', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await expect(runCrawlerGenerationDispatchCli([
      'preflight', '--contract', 'not-read.json', '--observer', 'not-read.yml',
    ], {})).resolves.toEqual({
      ready: false,
      dispatchMode: 'legacy',
      corpusCodeCommit: null,
      reasons: ['preflight_infrastructure_error'],
    });
  });

  it('removes generation_token from every fallback dispatch input', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-generation-legacy-'));
    tempRoots.push(root);
    const calls: any[] = [];
    await runCrawlerGenerationDispatchWave({
      generationToken,
      siteCodeCommit,
      shadowReady: false,
      checkpointPath: path.join(root, 'checkpoint.json'),
      delayMs: 0,
      dispatch: async (input: any) => {
        calls.push(input);
        return { status: 'missing', runId: null };
      },
    });
    expect(calls).toHaveLength(23);
    expect(calls.every(({ inputs }) => (
      JSON.stringify(inputs) === JSON.stringify({ skip_ai_translation: '1' })
    ))).toBe(true);
  });

  it('accepts 23 direct-ID legacy runs after a failed preflight without dispatching a sentinel', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-generation-legacy-direct-'));
    tempRoots.push(root);
    let nextRunId = 9000;
    const postBodies: any[] = [];
    const runs = new Map<number, any>();
    const request = vi.fn(async (input: any) => {
      if (input.method === 'POST') {
        nextRunId += 1;
        const group = String(nextRunId - 9000).padStart(2, '0');
        postBodies.push(input.body);
        const binding = crawlerGenerationLegacyWorkflowIdentity(group, String(nextRunId));
        runs.set(nextRunId, {
          id: nextRunId,
          repository: { full_name: repository },
          name: binding.workflowName,
          display_title: binding.runName,
          path: `.github/workflows/${binding.workflowFile}`,
          event: 'workflow_dispatch',
          head_branch: 'main',
          run_attempt: 1,
          status: 'queued',
          conclusion: null,
        });
        return {
          status: 200,
          body: {
            workflow_run_id: nextRunId,
            run_url: `https://api.github.com/repos/${repository}/actions/runs/${nextRunId}`,
            html_url: `https://github.com/${repository}/actions/runs/${nextRunId}`,
          },
        };
      }
      const runId = Number(input.path.split('/').at(-1));
      return { status: 200, body: runs.get(runId) };
    });
    const checkpoint = await runCrawlerGenerationDispatchWave({
      generationToken,
      siteCodeCommit,
      shadowReady: false,
      checkpointPath: path.join(root, 'checkpoint.json'),
      delayMs: 0,
      dispatch: ({ group, workflowFile, inputs }: any) => dispatchWorkflowOnce({
        repository,
        workflowFile,
        group,
        generationToken,
        inputs,
        request,
        allowReconciliation: false,
        identityForRunId: (runId: string) => crawlerGenerationLegacyWorkflowIdentity(group, runId),
      }),
    });
    expect(Object.values(checkpoint.dispatchDiagnostics).every(
      (entry: any) => entry.status === 'direct',
    )).toBe(true);
    expect(postBodies).toHaveLength(23);
    expect(postBodies.every((body) => !('generation_token' in body.inputs))).toBe(true);
    expect(checkpoint).not.toHaveProperty('groups');
  });
});
