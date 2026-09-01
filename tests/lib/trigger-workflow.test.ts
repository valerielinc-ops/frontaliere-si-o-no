// Tests for scripts/lib/trigger-workflow.sh — the shared workflow_dispatch
// engine behind trigger-deploy.sh, trigger-self.sh and fast-publish dispatches.
// All HTTP traffic is replaced by a deterministic curl stub.
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve('scripts/lib/trigger-workflow.sh');
const REPOSITORY = 'valerielinc-ops/frontaliere-si-o-no';
const WORKFLOW = 'generate-article.yml';
const RUN_ID = 7001;
const temporaryDirectories: string[] = [];

const validDispatchBody = JSON.stringify({
  workflow_run_id: RUN_ID,
  run_url: `https://api.github.com/repos/${REPOSITORY}/actions/runs/${RUN_ID}`,
  html_url: `https://github.com/${REPOSITORY}/actions/runs/${RUN_ID}`,
});

const validRunBody = JSON.stringify({
  id: RUN_ID,
  repository: { full_name: REPOSITORY },
  path: `.github/workflows/${WORKFLOW}`,
  event: 'workflow_dispatch',
  head_branch: 'main',
  run_attempt: 1,
  status: 'queued',
  conclusion: null,
});

function comparisonBody(base: string, head: string, status = 'ahead'): string {
  return JSON.stringify({
    status,
    ahead_by: status === 'ahead' ? 1 : 0,
    behind_by: 0,
    url: `https://api.github.com/repos/${REPOSITORY}/compare/${base}...${head}`,
    base_commit: { sha: base },
    merge_base_commit: { sha: base },
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

type DispatchOptions = {
  inputsJson?: string;
  env?: Record<string, string>;
  workflow?: string;
  token?: string | null;
};

function readNumber(path: string): number {
  try {
    return Number(readFileSync(path, 'utf8').trim()) || 0;
  } catch {
    return 0;
  }
}

/** Stub curl on PATH, record calls without recording Authorization, and return fixture bodies. */
function dispatch(options: DispatchOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'trigger-workflow-'));
  temporaryDirectories.push(directory);
  const stub = join(directory, 'curl');
  const output = join(directory, 'github-output');

  writeFileSync(
    stub,
    `#!/usr/bin/env bash
set -euo pipefail
method=GET
output_file=""
write_format=""
payload=""
url=""
api_version=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -X|--request) method="$2"; shift 2 ;;
    -o|--output) output_file="$2"; shift 2 ;;
    -w|--write-out) write_format="$2"; shift 2 ;;
    -d|--data|--data-raw) payload="$2"; shift 2 ;;
    -H|--header)
      case "$2" in X-GitHub-Api-Version:*) api_version="\${2#*: }" ;; esac
      shift 2
      ;;
    --connect-timeout|--max-time|--max-filesize) shift 2 ;;
    -s|-S|-sS|--silent|--show-error|--fail-with-body) shift ;;
    http://*|https://*) url="$1"; shift ;;
    *) shift ;;
  esac
done

increment() {
  local file="$1"
  local current=0
  if [ -f "$file" ]; then current="$(cat "$file")"; fi
  printf '%s' "$((current + 1))" > "$file"
}

if [ "$method" = POST ]; then
  increment "${directory}/post-count"
  printf '%s' "$payload" > "${directory}/payload"
  printf '%s' "$api_version" > "${directory}/api-version"
  printf '%s' "$url" > "${directory}/post-url"
  if [ "\${CURL_DISPATCH_TRANSPORT_ERROR:-0}" = 1 ]; then exit 28; fi
  status="\${CURL_DISPATCH_STATUS:-200}"
  body="\${CURL_DISPATCH_BODY:-}"
  if [ "\${CURL_DISPATCH_OVERSIZED:-0}" = 1 ]; then
    body="$(head -c 1100000 /dev/zero | tr '\\0' x)"
  fi
elif [[ "$url" == */commits/* ]]; then
  increment "${directory}/ref-count"
  status="\${CURL_REF_STATUS:-200}"
  body="\${CURL_REF_BODY:-}"
elif [[ "$url" == */compare/* ]]; then
  increment "${directory}/compare-count"
  compare_count="$(cat "${directory}/compare-count")"
  printf '%s' "$url" > "${directory}/compare-url-\${compare_count}"
  status="\${CURL_COMPARE_STATUS:-200}"
  body="\${CURL_COMPARE_BODY:-}"
  if [ "$compare_count" -gt 1 ] && [ -n "\${CURL_COMPARE_POST_BODY:-}" ]; then
    body="$CURL_COMPARE_POST_BODY"
  fi
else
  increment "${directory}/get-count"
  printf '%s' "$url" > "${directory}/get-url"
  get_count="$(cat "${directory}/get-count")"
  if [ "$get_count" -le "\${CURL_GET_TRANSPORT_ERRORS:-0}" ]; then exit 28; fi
  status="\${CURL_GET_STATUS:-200}"
  if [ -n "\${CURL_GET_STATUS_SEQUENCE:-}" ]; then
    IFS=',' read -r -a statuses <<< "$CURL_GET_STATUS_SEQUENCE"
    sequence_index="$((get_count - 1))"
    if [ "$sequence_index" -lt "\${#statuses[@]}" ]; then status="\${statuses[$sequence_index]}"; fi
  fi
  body="\${CURL_GET_BODY:-}"
fi

if [ -n "$output_file" ]; then printf '%s' "$body" > "$output_file"; else printf '%s' "$body"; fi
if [ -n "$write_format" ]; then printf '%s' "$status"; fi
`,
  );
  chmodSync(stub, 0o755);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${directory}:${process.env.PATH}`,
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_OUTPUT: output,
    RUNNER_TEMP: directory,
    CURL_DISPATCH_BODY: validDispatchBody,
    CURL_GET_BODY: validRunBody,
    ...options.env,
  };
  if (options.token === null) {
    delete env.GITHUB_PAT;
    delete env.GH_TOKEN;
  } else {
    env.GITHUB_PAT = options.token ?? 'test-secret-token';
    delete env.GH_TOKEN;
  }

  const args = [SCRIPT, options.workflow ?? WORKFLOW];
  if (options.inputsJson !== undefined) args.push(options.inputsJson);
  const result = spawnSync('bash', args, {
    env,
    encoding: 'utf8',
    timeout: 15_000,
  });

  return {
    ...result,
    apiVersion: readFileIfPresent(join(directory, 'api-version')),
    compareCount: readNumber(join(directory, 'compare-count')),
    comparePostUrl: readFileIfPresent(join(directory, 'compare-url-2')),
    comparePreUrl: readFileIfPresent(join(directory, 'compare-url-1')),
    dispatchSent: readFileIfPresent(output),
    getCount: readNumber(join(directory, 'get-count')),
    getUrl: readFileIfPresent(join(directory, 'get-url')),
    payload: readFileIfPresent(join(directory, 'payload')),
    postCount: readNumber(join(directory, 'post-count')),
    postUrl: readFileIfPresent(join(directory, 'post-url')),
    refCount: readNumber(join(directory, 'ref-count')),
  };
}

function readFileIfPresent(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function expectDispatchFailure(result: ReturnType<typeof dispatch>) {
  expect(result.status).toBe(1);
  expect(result.postCount).toBe(1);
  expect(result.getCount).toBe(0);
  expect(result.dispatchSent).toContain('dispatch_sent=false');
}

describe('scripts/lib/trigger-workflow.sh', () => {
  it('uses REST 2026-03-10, accepts a coherent 200 response and validates its exact run once', () => {
    const result = dispatch();
    expect(result.status).toBe(0);
    expect(result.postCount).toBe(1);
    expect(result.getCount).toBe(1);
    expect(result.refCount).toBe(0);
    expect(result.compareCount).toBe(0);
    expect(result.apiVersion).toBe('2026-03-10');
    expect(result.postUrl).toBe(
      `https://api.github.com/repos/${REPOSITORY}/actions/workflows/${WORKFLOW}/dispatches`,
    );
    expect(result.getUrl).toBe(`https://api.github.com/repos/${REPOSITORY}/actions/runs/${RUN_ID}`);
    expect(result.dispatchSent).toContain('dispatch_sent=true');
  });

  it('forwards caller inputs verbatim and omits inputs when absent', () => {
    const withInputs = dispatch({
      inputsJson: JSON.stringify({ article_id: 'x-y-z', section: 'svizzera', sha: 'deadbeef' }),
    });
    expect(JSON.parse(withInputs.payload)).toEqual({
      ref: 'main',
      inputs: { article_id: 'x-y-z', section: 'svizzera', sha: 'deadbeef' },
    });

    const withoutInputs = dispatch();
    expect(JSON.parse(withoutInputs.payload)).toEqual({ ref: 'main' });
  });

  it('honours TRIGGER_REF in both payload and authoritative run binding', () => {
    const result = dispatch({
      inputsJson: '{}',
      env: {
        TRIGGER_REF: 'release-branch',
        CURL_GET_BODY: JSON.stringify({
          ...JSON.parse(validRunBody),
          head_branch: 'release-branch',
        }),
      },
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.payload).ref).toBe('release-branch');
    expect(result.postCount).toBe(1);
    expect(result.getCount).toBe(1);
  });

  it('binds the exact run head SHA when the caller supplied an expected SHA', () => {
    const expectedSha = 'a'.repeat(40);
    const result = dispatch({
      env: {
        TRIGGER_EXPECTED_SHA: expectedSha,
        TRIGGER_REF_WAIT_ATTEMPTS: '1',
        TRIGGER_REF_WAIT_SECONDS: '0',
        CURL_REF_BODY: JSON.stringify({ sha: expectedSha }),
        CURL_GET_BODY: JSON.stringify({ ...JSON.parse(validRunBody), head_sha: expectedSha }),
      },
    });
    expect(result.status).toBe(0);
    expect(result.postCount).toBe(1);
    expect(result.getCount).toBe(1);
    expect(result.compareCount).toBe(0);
  });

  it('rejects a malformed expected SHA before any HTTP request', () => {
    const result = dispatch({ env: { TRIGGER_EXPECTED_SHA: 'not-a-commit' } });
    expect(result.status).toBe(1);
    expect(result.refCount).toBe(0);
    expect(result.compareCount).toBe(0);
    expect(result.postCount).toBe(0);
    expect(result.getCount).toBe(0);
    expect(result.dispatchSent).toContain('dispatch_sent=false');
  });

  it('accepts a ref descendant of the expected SHA and binds the exact returned run', () => {
    const expectedSha = 'a'.repeat(40);
    const descendantSha = 'b'.repeat(40);
    const result = dispatch({
      env: {
        TRIGGER_EXPECTED_SHA: expectedSha,
        TRIGGER_REF_WAIT_ATTEMPTS: '1',
        TRIGGER_REF_WAIT_SECONDS: '0',
        CURL_REF_BODY: JSON.stringify({ sha: descendantSha }),
        CURL_COMPARE_BODY: comparisonBody(expectedSha, descendantSha),
        CURL_GET_BODY: JSON.stringify({ ...JSON.parse(validRunBody), head_sha: descendantSha }),
      },
    });
    expect(result.status).toBe(0);
    expect(result.refCount).toBe(1);
    expect(result.compareCount).toBe(2);
    expect(result.postCount).toBe(1);
    expect(result.getCount).toBe(1);
    expect(result.comparePreUrl).toContain(`/compare/${expectedSha}...${descendantSha}?per_page=1`);
    expect(result.dispatchSent).toContain('dispatch_sent=true');
  });

  it('fails closed before POST when the ref never reaches the supplied expected SHA', () => {
    const expectedSha = 'a'.repeat(40);
    const result = dispatch({
      env: {
        TRIGGER_EXPECTED_SHA: expectedSha,
        TRIGGER_REF_WAIT_ATTEMPTS: '2',
        TRIGGER_REF_WAIT_SECONDS: '0',
        CURL_REF_BODY: JSON.stringify({ sha: 'b'.repeat(40) }),
        CURL_COMPARE_BODY: comparisonBody(expectedSha, 'b'.repeat(40), 'diverged'),
      },
    });
    expect(result.status).toBe(1);
    expect(result.refCount).toBe(2);
    expect(result.compareCount).toBe(2);
    expect(result.postCount).toBe(0);
    expect(result.getCount).toBe(0);
    expect(result.dispatchSent).toContain('dispatch_sent=false');
  });

  it('fails closed before POST when authenticated ancestry checks stay unreadable', () => {
    const expectedSha = 'a'.repeat(40);
    const result = dispatch({
      env: {
        TRIGGER_EXPECTED_SHA: expectedSha,
        TRIGGER_REF_WAIT_ATTEMPTS: '2',
        TRIGGER_REF_WAIT_SECONDS: '0',
        CURL_REF_BODY: JSON.stringify({ sha: 'b'.repeat(40) }),
        CURL_COMPARE_STATUS: '502',
      },
    });
    expect(result.status).toBe(1);
    expect(result.refCount).toBe(2);
    expect(result.compareCount).toBe(2);
    expect(result.postCount).toBe(0);
    expect(result.dispatchSent).toContain('dispatch_sent=false');
  });

  it('fails closed before POST when the comparison response is bound to another head', () => {
    const expectedSha = 'a'.repeat(40);
    const candidateSha = 'b'.repeat(40);
    const comparison = JSON.parse(comparisonBody(expectedSha, candidateSha));
    comparison.url = comparison.url.replace(candidateSha, 'c'.repeat(40));
    const result = dispatch({
      env: {
        TRIGGER_EXPECTED_SHA: expectedSha,
        TRIGGER_REF_WAIT_ATTEMPTS: '1',
        TRIGGER_REF_WAIT_SECONDS: '0',
        CURL_REF_BODY: JSON.stringify({ sha: candidateSha }),
        CURL_COMPARE_BODY: JSON.stringify(comparison),
      },
    });
    expect(result.status).toBe(1);
    expect(result.compareCount).toBe(1);
    expect(result.postCount).toBe(0);
    expect(result.dispatchSent).toContain('dispatch_sent=false');
  });

  it('accepts when the ref advances again during dispatch and verifies only the returned run ID', () => {
    const expectedSha = 'a'.repeat(40);
    const preDispatchSha = 'b'.repeat(40);
    const dispatchedRunSha = 'c'.repeat(40);
    const result = dispatch({
      env: {
        TRIGGER_EXPECTED_SHA: expectedSha,
        TRIGGER_REF_WAIT_ATTEMPTS: '1',
        TRIGGER_REF_WAIT_SECONDS: '0',
        CURL_REF_BODY: JSON.stringify({ sha: preDispatchSha }),
        CURL_COMPARE_BODY: comparisonBody(expectedSha, preDispatchSha),
        CURL_COMPARE_POST_BODY: comparisonBody(expectedSha, dispatchedRunSha),
        CURL_GET_BODY: JSON.stringify({ ...JSON.parse(validRunBody), head_sha: dispatchedRunSha }),
      },
    });
    expect(result.status).toBe(0);
    expect(result.compareCount).toBe(2);
    expect(result.postCount).toBe(1);
    expect(result.getCount).toBe(1);
    expect(result.comparePostUrl).toContain(`/compare/${expectedSha}...${dispatchedRunSha}?per_page=1`);
    expect(result.dispatchSent).toContain('dispatch_sent=true');
  });

  it('fails closed after one POST when the dispatched run head diverged during the ref race', () => {
    const expectedSha = 'a'.repeat(40);
    const preDispatchSha = 'b'.repeat(40);
    const divergentRunSha = 'd'.repeat(40);
    const result = dispatch({
      env: {
        TRIGGER_EXPECTED_SHA: expectedSha,
        TRIGGER_REF_WAIT_ATTEMPTS: '1',
        TRIGGER_REF_WAIT_SECONDS: '0',
        CURL_REF_BODY: JSON.stringify({ sha: preDispatchSha }),
        CURL_COMPARE_BODY: comparisonBody(expectedSha, preDispatchSha),
        CURL_COMPARE_POST_BODY: comparisonBody(expectedSha, divergentRunSha, 'diverged'),
        CURL_GET_BODY: JSON.stringify({ ...JSON.parse(validRunBody), head_sha: divergentRunSha }),
      },
    });
    expect(result.status).toBe(1);
    expect(result.compareCount).toBe(2);
    expect(result.postCount).toBe(1);
    expect(result.getCount).toBe(1);
    expect(result.dispatchSent).toContain('dispatch_sent=false');
  });

  it('uses the same exact ref and commit binding for an annotated tag', () => {
    const expectedSha = 'c'.repeat(40);
    const tag = 'v43.5.0';
    const result = dispatch({
      env: {
        TRIGGER_REF: tag,
        TRIGGER_EXPECTED_SHA: expectedSha,
        TRIGGER_REF_WAIT_ATTEMPTS: '1',
        TRIGGER_REF_WAIT_SECONDS: '0',
        CURL_REF_BODY: JSON.stringify({ sha: expectedSha }),
        CURL_GET_BODY: JSON.stringify({
          ...JSON.parse(validRunBody),
          head_branch: tag,
          head_sha: expectedSha,
        }),
      },
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.payload).ref).toBe(tag);
  });

  it('fails before dispatch on malformed inputs JSON', () => {
    const result = dispatch({ inputsJson: '{not valid json' });
    expect(result.status).toBe(1);
    expect(result.postCount).toBe(0);
    expect(result.getCount).toBe(0);
  });

  it.each([
    ['malformed 200 body', { CURL_DISPATCH_BODY: '{' }],
    [
      'missing run id',
      {
        CURL_DISPATCH_BODY: JSON.stringify({
          run_url: `https://api.github.com/repos/${REPOSITORY}/actions/runs/${RUN_ID}`,
          html_url: `https://github.com/${REPOSITORY}/actions/runs/${RUN_ID}`,
        }),
      },
    ],
    ['missing run URL', { CURL_DISPATCH_BODY: JSON.stringify({ workflow_run_id: RUN_ID }) }],
    [
      'incoherent API URL',
      {
        CURL_DISPATCH_BODY: JSON.stringify({
          ...JSON.parse(validDispatchBody),
          run_url: `https://evil.example/repos/${REPOSITORY}/actions/runs/${RUN_ID}`,
        }),
      },
    ],
    [
      'incoherent HTML URL',
      {
        CURL_DISPATCH_BODY: JSON.stringify({
          ...JSON.parse(validDispatchBody),
          html_url: `https://github.com/${REPOSITORY}/actions/runs/${RUN_ID + 1}`,
        }),
      },
    ],
    ['transport timeout', { CURL_DISPATCH_TRANSPORT_ERROR: '1' }],
    ['HTTP 502', { CURL_DISPATCH_STATUS: '502' }],
    ['legacy HTTP 204', { CURL_DISPATCH_STATUS: '204', CURL_DISPATCH_BODY: '' }],
    ['oversized body', { CURL_DISPATCH_OVERSIZED: '1' }],
  ])('never retries an ambiguous or invalid dispatch: %s', (_name, env) => {
    expectDispatchFailure(dispatch({ env }));
  });

  it.each([
    ['run id', { id: RUN_ID + 1 }],
    ['repository', { repository: { full_name: 'someone/else' } }],
    ['workflow path', { path: '.github/workflows/other.yml@refs/heads/main' }],
    ['event', { event: 'push' }],
    ['branch', { head_branch: 'other' }],
    ['run attempt', { run_attempt: 0 }],
    ['lifecycle', { status: 'unknown' }],
  ])('fails closed when the direct run has the wrong %s binding', (_name, override) => {
    const result = dispatch({
      env: { CURL_GET_BODY: JSON.stringify({ ...JSON.parse(validRunBody), ...override }) },
    });
    expect(result.status).toBe(1);
    expect(result.postCount).toBe(1);
    expect(result.getCount).toBe(1);
    expect(result.dispatchSent).toContain('dispatch_sent=false');
  });

  it.each(['failure', null])('accepts a completed run regardless of workflow conclusion (%s)', (conclusion) => {
    const result = dispatch({
      env: {
        CURL_GET_BODY: JSON.stringify({
          ...JSON.parse(validRunBody),
          status: 'completed',
          conclusion,
        }),
      },
    });
    expect(result.status).toBe(0);
    expect(result.dispatchSent).toContain('dispatch_sent=true');
  });

  it.each(['404', '429', '502'])(
    'retries only the read-only exact-ID lookup after HTTP %s',
    (status) => {
    const result = dispatch({
      env: {
        CURL_GET_STATUS_SEQUENCE: `${status},200`,
        TRIGGER_RUN_LOOKUP_SECONDS: '0',
      },
    });
    expect(result.status).toBe(0);
    expect(result.postCount).toBe(1);
    expect(result.getCount).toBe(2);
    },
  );

  it('retries a transport failure only on the read-only exact-ID lookup', () => {
    const result = dispatch({
      env: {
        CURL_GET_TRANSPORT_ERRORS: '1',
        TRIGGER_RUN_LOOKUP_SECONDS: '0',
      },
    });
    expect(result.status).toBe(0);
    expect(result.postCount).toBe(1);
    expect(result.getCount).toBe(2);
  });

  it('exhausts bounded exact-ID lookups without sending another POST', () => {
    const result = dispatch({
      env: {
        CURL_GET_STATUS: '404',
        TRIGGER_RUN_LOOKUP_SECONDS: '0',
      },
    });
    expect(result.status).toBe(1);
    expect(result.postCount).toBe(1);
    expect(result.getCount).toBe(3);
    expect(result.dispatchSent).toContain('dispatch_sent=false');
  });

  it('fails closed when an expected SHA does not match the direct run', () => {
    const expectedSha = 'a'.repeat(40);
    const result = dispatch({
      env: {
        TRIGGER_EXPECTED_SHA: expectedSha,
        TRIGGER_REF_WAIT_ATTEMPTS: '1',
        TRIGGER_REF_WAIT_SECONDS: '0',
        CURL_REF_BODY: JSON.stringify({ sha: expectedSha }),
        CURL_GET_BODY: JSON.stringify({ ...JSON.parse(validRunBody), head_sha: 'b'.repeat(40) }),
      },
    });
    expect(result.status).toBe(1);
    expect(result.postCount).toBe(1);
    expect(result.getCount).toBe(1);
    expect(result.dispatchSent).toContain('dispatch_sent=false');
  });

  it('skips cleanly with no token and allocates no HTTP request', () => {
    const result = dispatch({ token: null });
    expect(result.status).toBe(0);
    expect(result.postCount).toBe(0);
    expect(result.getCount).toBe(0);
    expect(result.dispatchSent).toContain('dispatch_sent=false');
  });

  it('never prints the authentication token, including on a failed response', () => {
    const token = 'super-secret-do-not-print';
    const result = dispatch({ token, env: { CURL_DISPATCH_STATUS: '502' } });
    expect(`${result.stdout}${result.stderr}${result.dispatchSent}`).not.toContain(token);
  });
});
