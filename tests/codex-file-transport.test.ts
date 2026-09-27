import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createConnection, createServer } from '../.github/actions/claude-codex-fallback/bridge-transport.mjs';
import {
  bodyCasDecision,
  bodyRevisionFromPullRequest,
  isPullRequestReviewArgs,
  isTransientReviewFailure,
  normalizeBodyRevision,
  parseBodyCasConfig,
  prBodyWriteTarget,
  reviewRetryDetails,
} from '../.github/actions/claude-codex-fallback/gh-bridge-server.mjs';
import {
  normalizeReviewInputRevision,
  reviewInputRevisionFromBody,
  reviewInputRevisionFromPullRequest,
} from '../scripts/ci/lib/review-input-revision.mjs';

const run = promisify(execFile);
const roots: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];
function setup(handler: (client: any) => void) {
  vi.stubEnv('CODEX_BRIDGE_TRANSPORT', 'files');
  const root = mkdtempSync(join(tmpdir(), 'codex-ipc-'));
  roots.push(root);
  const endpoint = join(root, 'mailbox');
  const server = createServer({}, handler);
  server.listen(endpoint);
  servers.push(server);
  return { root, endpoint };
}
function request(endpoint: string, body: string) {
  return new Promise<string>((resolve, reject) => {
    const client = createConnection(endpoint);
    let output = '';
    client.setTimeout(1000, () => { client.destroy(); reject(new Error('response timeout')); });
    client.on('data', (data: string) => { output += data; });
    client.on('error', reject);
    client.on('end', () => resolve(output));
    client.end(body);
  });
}
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('Codex file IPC', () => {
  it('delivers concurrent bounded requests without mixing responses and cleans mailboxes', async () => {
    const { endpoint } = setup(client => {
      let body = '';
      client.on('data', (data: string) => { body += data; });
      client.on('end', () => client.end(`response:${body}`));
    });
    const values = await Promise.all(Array.from({ length: 12 }, (_, n) => request(endpoint, `${n}`)));
    expect(values).toEqual(Array.from({ length: 12 }, (_, n) => `response:${n}`));
    expect(readdirSync(endpoint)).toEqual([]);
  });
  it('rejects oversized requests before publishing them', async () => {
    const handler = vi.fn();
    const { endpoint } = setup(handler);
    await expect(request(endpoint, 'x'.repeat(65537))).rejects.toThrow('limit');
    expect(handler).not.toHaveBeenCalled();
    expect(readdirSync(endpoint)).toEqual([]);
  });
  it('does not follow a request symlink or read an oversized attacker-written file', async () => {
    const handler = vi.fn();
    const { root, endpoint } = setup(handler);
    const outside = join(root, 'outside');
    writeFileSync(outside, 'private fixture');
    symlinkSync(outside, join(endpoint, `${randomUUID()}.request`));
    writeFileSync(join(endpoint, `${randomUUID()}.request`), 'x'.repeat(65537));
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(handler).not.toHaveBeenCalled();
    expect(readFileSync(outside, 'utf8')).toBe('private fixture');
  });
  it('notifies the host when a waiting client disconnects', async () => {
    let peer: any;
    const { endpoint } = setup(client => { peer = client; });
    const client = createConnection(endpoint);
    client.end('[]');
    await vi.waitFor(() => expect(peer).toBeDefined());
    const closed = vi.fn();
    peer.on('close', closed);
    client.destroy();
    await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
  });
  it('recognizes only retryable review failures and requires a complete idempotency key', () => {
    const headSha = 'a'.repeat(40);
    const args = ['pr', 'review', '8488', '--comment', '--body', '## LGTM'];
    expect(isPullRequestReviewArgs(args)).toBe(true);
    expect(isPullRequestReviewArgs(['pr', 'comment', '8488', '--body', '## LGTM'])).toBe(false);
    expect(isTransientReviewFailure({ code: 1, stderr: '502 Bad Gateway' })).toBe(true);
    expect(isTransientReviewFailure({ code: 1, stderr: 'permission denied' })).toBe(false);
    expect(reviewRetryDetails(args, 0, { cwd: process.cwd(), workspaceRoot: process.cwd(), scratchRoot: process.cwd(), headSha }))
      .toEqual({ pullNumber: '8488', body: '## LGTM', headSha });
    expect(reviewRetryDetails(['pr', 'review', '8488', '--comment', '--body', '## LGTM'], 0, {
      cwd: process.cwd(), workspaceRoot: process.cwd(), scratchRoot: process.cwd(), headSha: 'short',
    })).toBeNull();
  });
  it('retains authenticated GH reads, auth denial, and repository scope through the real bridge', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-gh-files-'));
    roots.push(root);
    const endpoint = join(root, 'mailbox');
    const fakeGh = join(root, 'gh');
    writeFileSync(fakeGh, '#!/bin/sh\n[ "$GH_TOKEN" = fixture-token ] || exit 9\nprintf "owner/repo\\n"\n', { mode: 0o755 });
    const action = resolve('.github/actions/claude-codex-fallback');
    const server = spawn(process.execPath, [join(action, 'gh-bridge-server.mjs')], {
      env: { PATH: '/usr/bin:/bin', CODEX_BRIDGE_TRANSPORT: 'files', CODEX_GH_SOCKET: endpoint,
        CODEX_GH_AUTH: 'fixture-token', CODEX_REAL_GH: fakeGh, CODEX_GH_CWD: root,
        CODEX_GH_WORKSPACE: root, CODEX_GH_SCRATCH: root, CODEX_GH_REPOSITORY: 'owner/repo', CODEX_GH_HOST: 'github.com' },
      stdio: 'ignore',
    });
    try {
      await vi.waitFor(() => expect(existsSync(endpoint)).toBe(true));
      const call = (args: string[]) => run(process.execPath, [join(action, 'gh-bridge-client.mjs'), ...args], {
        env: { CODEX_BRIDGE_TRANSPORT: 'files', CODEX_GH_SOCKET: endpoint }, timeout: 2000,
      });
      expect((await call(['api', 'repos/owner/repo'])).stdout.trim()).toBe('owner/repo');
      await expect(call(['auth', 'token'])).rejects.toMatchObject({ code: 2 });
      await expect(call(['api', 'repos/other/repo'])).rejects.toMatchObject({ code: 2 });
      expect(readdirSync(endpoint)).toEqual([]);
    } finally {
      server.kill('SIGTERM');
      await new Promise(resolve => server.once('exit', resolve));
    }
  });
  it('retries a transient review POST only after an idempotency probe', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-gh-review-'));
    roots.push(root);
    const endpoint = join(root, 'mailbox');
    const state = join(root, 'review-attempts');
    writeFileSync(state, '0');
    const fakeGh = join(root, 'gh');
    writeFileSync(fakeGh, `#!/bin/sh
set -eu
state='${state}'
case "\${1:-}" in
  api)
    printf '%s\\n' '[]'
    ;;
  pr)
    [ "\${2:-}" = review ] || exit 2
    count=$(cat "$state")
    count=$((count + 1))
    printf '%s' "$count" > "$state"
    if [ "$count" -eq 1 ]; then
      printf '%s\\n' 'failed to create review: non-200 OK status code: 502 Bad Gateway' >&2
      exit 1
    fi
    printf '%s\\n' 'reviewed'
    ;;
  *)
    exit 2
    ;;
esac
`, { mode: 0o755 });
    const action = resolve('.github/actions/claude-codex-fallback');
    const headSha = 'b'.repeat(40);
    const server = spawn(process.execPath, [join(action, 'gh-bridge-server.mjs')], {
      env: { PATH: '/usr/bin:/bin', HEAD_SHA: headSha, CODEX_BRIDGE_TRANSPORT: 'files', CODEX_GH_SOCKET: endpoint,
        CODEX_GH_AUTH: 'fixture-token', CODEX_REAL_GH: fakeGh, CODEX_GH_CWD: root,
        CODEX_GH_WORKSPACE: root, CODEX_GH_SCRATCH: root, CODEX_GH_REPOSITORY: 'owner/repo', CODEX_GH_HOST: 'github.com' },
      stdio: 'ignore',
    });
    try {
      await vi.waitFor(() => expect(existsSync(endpoint)).toBe(true));
      const result = await run(process.execPath, [join(action, 'gh-bridge-client.mjs'),
        'pr', 'review', '8488', '--comment', '--body', '## LGTM'], {
        env: { CODEX_BRIDGE_TRANSPORT: 'files', CODEX_GH_SOCKET: endpoint }, timeout: 10_000,
      });
      expect(result.stdout).toContain('reviewed');
      expect(readFileSync(state, 'utf8')).toBe('2');
    } finally {
      server.kill('SIGTERM');
      await new Promise(resolve => server.once('exit', resolve));
    }
  });
  it('accepts a transient review response when the probe finds the exact review already persisted', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-gh-review-persisted-'));
    roots.push(root);
    const endpoint = join(root, 'mailbox');
    const state = join(root, 'review-attempts');
    writeFileSync(state, '0');
    const fakeGh = join(root, 'gh');
    const headSha = 'c'.repeat(40);
    writeFileSync(fakeGh, `#!/bin/sh
set -eu
state='${state}'
case "\${1:-}" in
  api)
    printf '%s\\n' '[{"commit_id":"${headSha}","body":"## LGTM"}]'
    ;;
  pr)
    [ "\${2:-}" = review ] || exit 2
    count=$(cat "$state")
    count=$((count + 1))
    printf '%s' "$count" > "$state"
    printf '%s\\n' 'failed to create review: non-200 OK status code: 502 Bad Gateway' >&2
    exit 1
    ;;
  *)
    exit 2
    ;;
esac
`, { mode: 0o755 });
    const action = resolve('.github/actions/claude-codex-fallback');
    const server = spawn(process.execPath, [join(action, 'gh-bridge-server.mjs')], {
      env: { PATH: '/usr/bin:/bin', HEAD_SHA: headSha, CODEX_BRIDGE_TRANSPORT: 'files', CODEX_GH_SOCKET: endpoint,
        CODEX_GH_AUTH: 'fixture-token', CODEX_REAL_GH: fakeGh, CODEX_GH_CWD: root,
        CODEX_GH_WORKSPACE: root, CODEX_GH_SCRATCH: root, CODEX_GH_REPOSITORY: 'owner/repo', CODEX_GH_HOST: 'github.com' },
      stdio: 'ignore',
    });
    try {
      await vi.waitFor(() => expect(existsSync(endpoint)).toBe(true));
      const result = await run(process.execPath, [join(action, 'gh-bridge-client.mjs'),
        'pr', 'review', '8488', '--comment', '--body', '## LGTM'], {
        env: { CODEX_BRIDGE_TRANSPORT: 'files', CODEX_GH_SOCKET: endpoint }, timeout: 10_000,
      });
      expect(result.stderr).toContain('confirmed the review');
      expect(readFileSync(state, 'utf8')).toBe('1');
    } finally {
      server.kill('SIGTERM');
      await new Promise(resolve => server.once('exit', resolve));
    }
  });
  it('starts the real gh bridge with HEAD_SHA, the last piece of the review idempotency key (#9778)', () => {
    // I test end-to-end qui sopra passano HEAD_SHA al server da soli: senza
    // questa riga nell'`env -i` della action, in produzione la chiave era
    // sempre null e né il retry transitorio né l'anti-duplicato scattavano.
    const action = readFileSync(resolve('.github/actions/claude-codex-fallback/action.yml'), 'utf8');
    const launch = action.split('\n');
    const serverLine = launch.findIndex((line) => line.includes('"$bridge_dir/gh-server.mjs"'));
    expect(serverLine).toBeGreaterThan(0);
    let start = serverLine;
    while (start > 0 && !/^\s*env -i \\$/.test(launch[start])) start -= 1;
    expect(launch[start]).toMatch(/^\s*env -i \\$/);
    expect(launch.slice(start, serverLine + 1).join('\n')).toMatch(/^\s*HEAD_SHA="\$\{HEAD_SHA:-\}" \\$/m);
  });
  it('confirms a posted review and never posts the same body twice on one HEAD (#9705)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-gh-review-once-'));
    roots.push(root);
    const endpoint = join(root, 'mailbox');
    const state = join(root, 'review-attempts');
    writeFileSync(state, '0');
    const fakeGh = join(root, 'gh');
    // `gh pr review` riuscito senza TTY non stampa nulla: è il silenzio che
    // sulla #9705 ha fatto ripubblicare la stessa review.
    writeFileSync(fakeGh, `#!/bin/sh
set -eu
state='${state}'
[ "\${1:-}" = pr ] && [ "\${2:-}" = review ] || exit 2
count=$(cat "$state")
printf '%s' "$((count + 1))" > "$state"
`, { mode: 0o755 });
    const action = resolve('.github/actions/claude-codex-fallback');
    const server = spawn(process.execPath, [join(action, 'gh-bridge-server.mjs')], {
      env: { PATH: '/usr/bin:/bin', HEAD_SHA: 'd'.repeat(40), CODEX_BRIDGE_TRANSPORT: 'files', CODEX_GH_SOCKET: endpoint,
        CODEX_GH_AUTH: 'fixture-token', CODEX_REAL_GH: fakeGh, CODEX_GH_CWD: root,
        CODEX_GH_WORKSPACE: root, CODEX_GH_SCRATCH: root, CODEX_GH_REPOSITORY: 'owner/repo', CODEX_GH_HOST: 'github.com' },
      stdio: 'ignore',
    });
    const post = (body: string) => run(process.execPath, [join(action, 'gh-bridge-client.mjs'),
      'pr', 'review', '9705', '--comment', '--body', body], {
      env: { CODEX_BRIDGE_TRANSPORT: 'files', CODEX_GH_SOCKET: endpoint }, timeout: 10_000,
    });
    try {
      await vi.waitFor(() => expect(existsSync(endpoint)).toBe(true));
      const first = await post('## Findings (Important: 0, Nit: 0)\n\n## LGTM\n');
      expect(first.stderr).toContain('review posted on PR #9705');
      expect(readFileSync(state, 'utf8')).toBe('1');

      const repeat = await post('## Findings (Important: 0, Nit: 0)\n\n## LGTM');
      expect(repeat.stderr).toContain('already posted on PR #9705');
      expect(readFileSync(state, 'utf8')).toBe('1');

      await post('## Findings (Important: 1, Nit: 0)\n\n🔴 Important: altro verdetto');
      expect(readFileSync(state, 'utf8')).toBe('2');
    } finally {
      server.kill('SIGTERM');
      await new Promise(resolve => server.once('exit', resolve));
    }
  });

  describe('host-side PR body CAS (run 36302768673, PR #9959)', () => {
    const action = resolve('.github/actions/claude-codex-fallback');
    const SHIM = resolve('scripts/gh-pr-body-check.mjs');
    const TRUSTED_BODY = '## Implementato\n\n- body letto dal preflight in questa PR\n\n## Non implementato (ancora)\n\nNessuno\n';
    const NEW_BODY = '## Implementato\n\n- body riscritto dal fixer in questa PR\n\n## Non implementato (ancora)\n\nNessuno\n';
    const EXPECTED = reviewInputRevisionFromBody(TRUSTED_BODY);

    /**
     * Real bridge server + client, fake host gh. The fake answers the PR read
     * from a state file (the "current" remote body) and records every write.
     */
    async function startBridge(serverEnv: Record<string, string>) {
      const root = mkdtempSync(join(tmpdir(), 'codex-gh-body-cas-'));
      roots.push(root);
      const endpoint = join(root, 'mailbox');
      const current = join(root, 'current-body.json');
      const writes = join(root, 'writes');
      writeFileSync(current, JSON.stringify({ body: TRUSTED_BODY }));
      writeFileSync(writes, '');
      const fakeGh = join(root, 'gh');
      writeFileSync(fakeGh, `#!/bin/sh
set -eu
if [ "$1" = api ] && [ "$#" -eq 2 ]; then
  cat '${current}'
  exit 0
fi
if [ "$1" = api ] && [ "$2" = --include ]; then
  printf 'HTTP/2.0 200 OK\\r\\nEtag: W/"v1"\\r\\n\\r\\n'
  cat '${current}'
  exit 0
fi
if [ "$1" = pr ] && [ "$2" = view ]; then
  cat '${current}'
  exit 0
fi
printf '%s\\n' "$*" >> '${writes}'
if [ "$1" = api ]; then
  printf '%s' '${JSON.stringify({ body: NEW_BODY })}'
fi
`, { mode: 0o755 });
      const bodyFile = join(root, 'body.md');
      writeFileSync(bodyFile, NEW_BODY);
      const server = spawn(process.execPath, [join(action, 'gh-bridge-server.mjs')], {
        env: { PATH: '/usr/bin:/bin', CODEX_BRIDGE_TRANSPORT: 'files', CODEX_GH_SOCKET: endpoint,
          CODEX_GH_AUTH: 'fixture-token', CODEX_REAL_GH: fakeGh, CODEX_GH_CWD: root,
          CODEX_GH_WORKSPACE: root, CODEX_GH_SCRATCH: root, CODEX_GH_REPOSITORY: 'owner/repo',
          CODEX_GH_HOST: 'github.com', ...serverEnv },
        stdio: 'ignore',
      });
      await vi.waitFor(() => expect(existsSync(endpoint)).toBe(true));
      // A client whose environment empties the revision, as Codex did with
      // `PR_BODY_EXPECTED_REVISION= ...`: it must not change the verdict.
      const call = (args: string[]) => run(process.execPath, [join(action, 'gh-bridge-client.mjs'), ...args], {
        env: { CODEX_BRIDGE_TRANSPORT: 'files', CODEX_GH_SOCKET: endpoint, PR_BODY_EXPECTED_REVISION: '' },
        timeout: 10_000,
      });
      const stop = async () => {
        server.kill('SIGTERM');
        await new Promise(resolve => server.once('exit', resolve));
      };
      const setCurrent = (body: string | null) => writeFileSync(current, JSON.stringify({ body }));
      const recordedWrites = () => readFileSync(writes, 'utf8').split('\n').filter(Boolean);
      return { root, endpoint, bodyFile, call, stop, setCurrent, recordedWrites };
    }

    const CAS_ENV = { CODEX_GH_PR_BODY_EXPECTED_REVISION: EXPECTED, CODEX_GH_PR_BODY_PR_NUMBER: '123' };

    it('mirrors the trusted revision function exactly', () => {
      for (const body of ['', 'x', TRUSTED_BODY, 'accenti è ü — 🔴\r\nfine', 'trailing\n\n']) {
        expect(bodyRevisionFromPullRequest({ body })).toBe(reviewInputRevisionFromPullRequest({ body }));
      }
      expect(bodyRevisionFromPullRequest({ body: null })).toBe(reviewInputRevisionFromPullRequest({ body: null }));
      for (const bad of [null, [], {}, { body: 1 }]) {
        expect(() => bodyRevisionFromPullRequest(bad)).toThrow();
        expect(() => reviewInputRevisionFromPullRequest(bad)).toThrow();
      }
      for (const value of [EXPECTED, ` ${EXPECTED.toUpperCase()} `, '', 'body:xyz', `${EXPECTED}0`]) {
        expect(normalizeBodyRevision(value)).toBe(normalizeReviewInputRevision(value));
      }
    });

    it('parses the launch configuration fail-closed', () => {
      expect(parseBodyCasConfig('', '123')).toEqual({ config: null });
      expect(parseBodyCasConfig(undefined, undefined)).toEqual({ config: null });
      expect(parseBodyCasConfig(EXPECTED, '123')).toEqual({ config: { revision: EXPECTED, prNumber: '123' } });
      expect(parseBodyCasConfig('body:nope', '123').error).toMatch(/malformed/);
      expect(parseBodyCasConfig(EXPECTED, '').error).toMatch(/PR number/);
    });

    it('classifies every PR body write form the bridge admits', () => {
      const repo = 'owner/repo';
      expect(prBodyWriteTarget(['pr', 'edit', '123', '--body-file', 'b.md'], repo)).toEqual({ selector: '123' });
      expect(prBodyWriteTarget(['pr', 'edit', '123', '-F', 'b.md', '--title', 't'], repo)).toEqual({ selector: '123' });
      expect(prBodyWriteTarget(['--repo', repo, 'pr', 'edit', '--body-file=b.md'], repo)).toEqual({ selector: '' });
      expect(prBodyWriteTarget(['issue', 'edit', '123', '--body', 'x'], repo)).toEqual({ selector: '123' });
      expect(prBodyWriteTarget(['api', 'repos/owner/repo/pulls/123', '--method', 'PATCH',
        '--header', 'If-Match: W/"v1"', '--field', 'body=@b.md'], repo)).toEqual({ selector: '123' });
      expect(prBodyWriteTarget(['pr', 'edit', '123', '--title', 't'], repo)).toBeNull();
      expect(prBodyWriteTarget(['pr', 'create', '--body-file', 'b.md'], repo)).toBeNull();
      expect(prBodyWriteTarget(['pr', 'comment', '123', '--body-file', 'b.md'], repo)).toBeNull();
      expect(prBodyWriteTarget(['api', 'repos/owner/repo/pulls/123'], repo)).toBeNull();
      const config = { revision: EXPECTED, prNumber: '123' };
      const decide = (args: string[], scopeKind = 'site') => bodyCasDecision(args, { repository: repo, scopeKind, config });
      expect(decide(['pr', 'edit', '#123', '--body-file', 'b.md'])).toEqual({ check: '123' });
      expect(decide(['pr', 'edit', '--body-file', 'b.md'])).toEqual({ check: '123' });
      expect(decide(['pr', 'edit', 'some-branch', '--body-file', 'b.md'])?.error).toMatch(/numeric PR selector/);
      expect(decide(['pr', 'edit', '456', '--body-file', 'b.md'])).toBeNull();
      expect(decide(['pr', 'edit', '123', '--body-file', 'b.md'], 'corpus')).toBeNull();
      expect(bodyCasDecision(['pr', 'edit', '123', '--body-file', 'b.md'], { repository: repo, scopeKind: 'site', config: null })).toBeNull();
    });

    it('admits a body write when the current body matches the trusted revision', async () => {
      const bridge = await startBridge(CAS_ENV);
      try {
        await bridge.call(['pr', 'edit', '123', '--repo', 'owner/repo', '--body-file', bridge.bodyFile]);
        expect(bridge.recordedWrites()).toEqual([`pr edit 123 --repo owner/repo --body-file ${bridge.bodyFile}`]);
      } finally {
        await bridge.stop();
      }
    });

    it('rejects every body write form when the current body diverged, whatever the client env says', async () => {
      const bridge = await startBridge(CAS_ENV);
      bridge.setCurrent(`${TRUSTED_BODY}\nmodifica concorrente di un umano`);
      try {
        for (const args of [
          ['pr', 'edit', '123', '--repo', 'owner/repo', '--body-file', bridge.bodyFile],
          // The #9959 bypass: title + body skips the wrapper's body-only CAS.
          ['pr', 'edit', '123', '--repo', 'owner/repo', '--title', 'nuovo titolo', '--body-file', bridge.bodyFile],
          ['pr', 'edit', '--body-file', bridge.bodyFile],
          ['issue', 'edit', '123', '--body-file', bridge.bodyFile],
          ['api', 'repos/owner/repo/pulls/123', '--method', 'PATCH',
            '--header', 'If-Match: W/"v1"', '--field', `body=@${bridge.bodyFile}`],
        ]) {
          await expect(bridge.call(args)).rejects.toMatchObject({ code: 2, stderr: expect.stringMatching(/PR body CAS: body of PR #123 changed/) });
        }
        await expect(bridge.call(['pr', 'edit', 'feature-branch', '--body-file', bridge.bodyFile]))
          .rejects.toMatchObject({ code: 2, stderr: expect.stringMatching(/numeric PR selector/) });
        expect(bridge.recordedWrites()).toEqual([]);
        // Non-body edits and other PRs keep their previous behavior.
        await bridge.call(['pr', 'edit', '123', '--add-label', 'needs-human']);
        await bridge.call(['pr', 'edit', '456', '--body-file', bridge.bodyFile]);
        expect(bridge.recordedWrites()).toHaveLength(2);
      } finally {
        await bridge.stop();
      }
    });

    it('rejects the write when the current body cannot be verified', async () => {
      const bridge = await startBridge(CAS_ENV);
      writeFileSync(join(bridge.root, 'current-body.json'), 'not json');
      try {
        await expect(bridge.call(['pr', 'edit', '123', '--body-file', bridge.bodyFile]))
          .rejects.toMatchObject({ code: 2, stderr: expect.stringMatching(/not verifiable/) });
        expect(bridge.recordedWrites()).toEqual([]);
      } finally {
        await bridge.stop();
      }
    });

    it('keeps the previous behavior when no revision is configured', async () => {
      const bridge = await startBridge({});
      bridge.setCurrent('body cambiato');
      try {
        await bridge.call(['pr', 'edit', '123', '--body-file', bridge.bodyFile]);
        expect(bridge.recordedWrites()).toHaveLength(1);
      } finally {
        await bridge.stop();
      }
    });

    it('refuses to start with a malformed configuration instead of running without CAS', async () => {
      const root = mkdtempSync(join(tmpdir(), 'codex-gh-body-cas-bad-'));
      roots.push(root);
      const server = spawn(process.execPath, [join(action, 'gh-bridge-server.mjs')], {
        env: { PATH: '/usr/bin:/bin', CODEX_BRIDGE_TRANSPORT: 'files', CODEX_GH_SOCKET: join(root, 'mailbox'),
          CODEX_GH_AUTH: 'fixture-token', CODEX_REAL_GH: '/bin/false', CODEX_GH_CWD: root,
          CODEX_GH_WORKSPACE: root, CODEX_GH_SCRATCH: root, CODEX_GH_REPOSITORY: 'owner/repo',
          CODEX_GH_HOST: 'github.com', CODEX_GH_PR_BODY_EXPECTED_REVISION: EXPECTED },
        stdio: 'ignore',
      });
      const code = await new Promise(resolve => server.once('exit', resolve));
      expect(code).toBe(2);
    });

    it('blocks the #9959 bypass end to end: wrapper with the revision unset, bridge still refuses', async () => {
      const bridge = await startBridge(CAS_ENV);
      bridge.setCurrent(`${TRUSTED_BODY}\nmodifica concorrente`);
      const shimBin = join(bridge.root, 'client-bin');
      await run('/bin/mkdir', [shimBin]);
      writeFileSync(join(shimBin, 'gh'),
        `#!/bin/sh\nexec '${process.execPath}' '${join(action, 'gh-bridge-client.mjs')}' "$@"\n`, { mode: 0o755 });
      const env: Record<string, string> = {
        PATH: `${shimBin}:/usr/bin:/bin`,
        PR_BODY_GATE_BIN: join(bridge.root, 'wrapper-bin'),
        CODEX_BRIDGE_TRANSPORT: 'files',
        CODEX_GH_SOCKET: bridge.endpoint,
        PR_NUMBER: '123',
        REPO: 'owner/repo',
      };
      try {
        for (const extra of [[], ['--title', 'nuovo titolo']]) {
          await expect(run(process.execPath, [SHIM, 'pr', 'edit', '123', '--repo', 'owner/repo', ...extra,
            '--body-file', bridge.bodyFile], { env, cwd: bridge.root, timeout: 20_000 }))
            .rejects.toMatchObject({ stderr: expect.stringMatching(/PR body CAS: body of PR #123 changed/) });
        }
        expect(bridge.recordedWrites()).toEqual([]);
      } finally {
        await bridge.stop();
      }
    });

    it('launches the server with the step revision and PR number under env -i', () => {
      const lines = readFileSync(resolve('.github/actions/claude-codex-fallback/action.yml'), 'utf8').split('\n');
      const serverLine = lines.findIndex((line) => line.includes('"$bridge_dir/gh-server.mjs"'));
      let start = serverLine;
      while (start > 0 && !/^\s*env -i \\$/.test(lines[start])) start -= 1;
      const launch = lines.slice(start, serverLine + 1).join('\n');
      expect(launch).toMatch(/^\s*CODEX_GH_PR_BODY_EXPECTED_REVISION="\$codex_body_expected_revision" \\$/m);
      expect(launch).toMatch(/^\s*CODEX_GH_PR_BODY_PR_NUMBER="\$codex_body_pr_number" \\$/m);
      const before = lines.slice(0, start).join('\n');
      expect(before).toMatch(/codex_body_expected_revision="\$\{PR_BODY_EXPECTED_REVISION:-\}"/);
      expect(before).toMatch(/codex_body_pr_number="\$\{PR_NUMBER:-\}"/);
    });
  });
});
