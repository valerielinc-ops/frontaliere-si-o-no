import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer as createNetServer, connect as connectSocket, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import { startPortalDiagnostics, warmPortalDiagnostics } from '../scripts/assisted-application/lib/portal/diagnostics.mjs';
import { capturePortalReplayFinalClicksInPage, createPinnedPublicHttpsProxy, installPortalReplayFence, installPortalReplayNodeEgressFence, sealPortalReplayContext } from '../scripts/assisted-application/lib/portal/replay-fence.mjs';
import {
  affectedPortalReplayFamilies,
  affectedPortalReplayPaths,
  aggregatePortalReplayGate,
  comparePortalReplayFamily,
  extractPortalStopHosts,
  PORTAL_REPLAY_ALLOWED_PATHS,
  PORTAL_REPLAY_FAMILIES,
  sanitizePortalReplayReport,
  selectPortalReplayCorpus,
  trustedPortalReplayFenceRoot,
} from '../scripts/assisted-application/portal-replay.mjs';

const tempDirs: string[] = [];
const tempDir = () => {
  const directory = mkdtempSync(join(tmpdir(), 'portal-replay-test-'));
  tempDirs.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fakeContext() {
  const context: any = {
    route: async (_pattern: string, handler: (route: any) => Promise<unknown>) => { context.routeHandler = handler; },
    routeWebSocket: async (_pattern: string, handler: (socket: any) => void) => { context.webSocketHandler = handler; },
    addInitScript: async (script: () => void) => { (context.initScripts ||= []).push(script); context.initScript = script; },
    exposeBinding: async (name: string, handler: (...args: any[]) => unknown) => { context.bindings[name] = handler; },
    on: (event: string, handler: (value: any) => void) => { context.listeners[event] = handler; },
    bindings: {} as Record<string, (...args: any[]) => unknown>,
    initScripts: [] as (() => void)[],
    listeners: {} as Record<string, (value: any) => void>,
  };
  return context;
}

async function runRequest(context: any, { method, url, navigation = false }: { method: string; url: string; navigation?: boolean }) {
  const result: { action?: string } = {};
  const request = { method: () => method, url: () => url, isNavigationRequest: () => navigation };
  await context.routeHandler({
    request: () => request,
    abort: async () => { result.action = 'abort'; },
    continue: async () => { result.action = 'continue'; },
  });
  return result.action;
}

describe('portal replay read-only fence', () => {
  it('blocks POST/PUT/DELETE, beacon POST, WebSocket and mutation GETs while allowing cross-origin GET navigation', async () => {
    const context = fakeContext();
    const metrics = await installPortalReplayFence(context, { isPublicHost: async () => true });
    const replayContext = sealPortalReplayContext(context);
    await replayContext.route('**/*', async () => { throw new Error('extra route must not register'); });

    expect(await runRequest(replayContext, { method: 'POST', url: 'https://ats.example.test/login' })).toBe('abort');
    expect(await runRequest(replayContext, { method: 'PUT', url: 'https://ats.example.test/profile' })).toBe('abort');
    expect(await runRequest(replayContext, { method: 'DELETE', url: 'https://ats.example.test/profile' })).toBe('abort');
    expect(await runRequest(replayContext, { method: 'POST', url: 'https://ats.example.test/beacon', navigation: false })).toBe('abort');
    expect(await runRequest(replayContext, { method: 'GET', url: 'https://ats.example.test/apply/save' })).toBe('abort');
    expect(await runRequest(replayContext, { method: 'GET', url: 'https://ats.example.test/route?action=submit' })).toBe('abort');
    expect(await runRequest(replayContext, { method: 'GET', url: 'https://ats.example.test/%252fapplication%252fsave' })).toBe('abort');
    expect(await runRequest(replayContext, { method: 'GET', url: 'https://ats.example.test/apply-now' })).toBe('abort');
    expect(await runRequest(replayContext, { method: 'GET', url: 'https://ats.example.test/api/candidate/update?email=synthetic%40example.invalid' })).toBe('abort');
    expect(await runRequest(replayContext, { method: 'GET', url: 'https://ats.example.test/api/autosave?candidate=synthetic' })).toBe('abort');
    expect(await runRequest(replayContext, { method: 'GET', url: 'https://ats.example.test/api/application?data=%7B%22email%22%3A%22synthetic%40example.invalid%22%7D' })).toBe('abort');
    expect(await runRequest(replayContext, { method: 'GET', url: 'https://ats.example.test/application?%2565mail=synthetic%40example.invalid' })).toBe('abort');
    expect(await runRequest(replayContext, { method: 'GET', url: 'https://ats.example.test/api/application?q=synthetic%40example.invalid' })).toBe('abort');
    expect(await runRequest(replayContext, { method: 'GET', url: 'https://careers.example.test/job/123', navigation: true })).toBe('continue');
    expect(await runRequest(replayContext, { method: 'GET', url: 'https://ats.example.test/apply?apply=guest' })).toBe('continue');
    expect(await runRequest(replayContext, { method: 'HEAD', url: 'https://ats.example.test/apply' })).toBe('continue');
    expect(await runRequest(replayContext, { method: 'OPTIONS', url: 'https://ats.example.test/apply' })).toBe('continue');

    let websocketClosed = false;
    replayContext.webSocketHandler({ close: () => { websocketClosed = true; } });
    expect(websocketClosed).toBe(true);
    expect(typeof context.initScript).toBe('function');
    const pageGlobal: Record<string, unknown> = {};
    for (const script of context.initScripts) runInNewContext(`(${script.toString()})()`, pageGlobal);
    expect(pageGlobal.Worker).toBeUndefined();
    expect(pageGlobal.SharedWorker).toBeUndefined();
    expect(pageGlobal.WebTransport).toBeUndefined();
    expect(pageGlobal.RTCPeerConnection).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(pageGlobal, 'Worker')?.writable).toBe(false);
    expect(metrics.blockedNonGet).toBe(4);
    expect(metrics.blockedMutationGets).toBe(9);
    expect(metrics.blockedWebSockets).toBe(1);
    expect(typeof context.bindings.__frontalierePortalReplayFinalClickAttempt).toBe('function');
    expect(metrics.finalClickAttempts).toBe(0);
  });

  it('blocks final application clicks in trusted page instrumentation and counts them outside the runner', async () => {
    const dom = new JSDOM('<form><label>E-mail<input name="email"></label><button type="submit">Submit application</button></form><button>Continue</button><button id="guarded-final">Apply for a niche vacancy</button>', { url: 'https://ats.example.test/apply' });
    let attempts = 0;
    const page = dom.window as any;
    page.__frontalierePortalReplayFinalClickAttempt = () => { attempts += 1; };
    runInNewContext(`(${capturePortalReplayFinalClicksInPage.toString()})()`, {
      window: page,
      document: page.document,
      HTMLFormElement: page.HTMLFormElement,
      __frontalierePortalReplayFinalClickAttempt: page.__frontalierePortalReplayFinalClickAttempt,
    });
    let submitted = false;
    page.document.querySelector('form').addEventListener('submit', (event: Event) => {
      submitted = true;
      event.preventDefault();
    });

    page.document.querySelector('button[type="submit"]').click();
    expect(attempts).toBe(1);
    expect(submitted).toBe(false);
    page.document.querySelector('button:not([type])').click();
    expect(attempts).toBe(1);
    const guardedFinal = page.document.querySelector('#guarded-final');
    let guardedHandlerRan = false;
    guardedFinal.addEventListener('click', () => { guardedHandlerRan = true; });
    page.__frontaliereFinalFormGuards = { trustedRunnerContract: { status: 'armed', button: guardedFinal } };
    guardedFinal.click();
    expect(attempts).toBe(2);
    expect(guardedHandlerRan).toBe(false);
    dom.window.close();
  });

  it('blocks Node egress before portal modules import while preserving the exact Codex broker socket', async () => {
    const directory = tempDir();
    const brokerPath = join(directory, 'broker.sock');
    const broker = createNetServer((socket) => socket.end('broker-ok'));
    await new Promise<void>((resolve) => broker.listen(brokerPath, resolve));
    let blocked = 0;
    const fence = installPortalReplayNodeEgressFence({ allowedUnixSocket: brokerPath, onBlocked: () => { blocked += 1; } });
    try {
      await expect(fetch('https://public.example.test/')).rejects.toMatchObject({ code: 'portal_replay_node_egress_blocked' });
      expect(() => httpRequest({ hostname: 'public.example.test', method: 'POST' })).toThrow('portal_replay_node_egress_blocked');
      expect(() => connectSocket({ host: '8.8.8.8', port: 443 })).toThrow('portal_replay_node_egress_blocked');
      const rawSocket = new Socket();
      expect(() => rawSocket.connect({ host: '93.184.216.34', port: 80 })).toThrow('portal_replay_node_egress_blocked');
      rawSocket.destroy();
      const response = await new Promise<string>((resolve, reject) => {
        const socket = connectSocket(brokerPath);
        socket.once('data', (value) => { resolve(String(value)); socket.destroy(); });
        socket.once('error', reject);
      });
      expect(response).toBe('broker-ok');
      expect(blocked).toBe(4);
      expect(fence.metrics.blockedAttempts).toBe(4);
    } finally {
      fence.restore();
      await new Promise<void>((resolve) => broker.close(() => resolve()));
    }
  });

  it('connects through the DNS address that passed the public-address check', async () => {
    const upstream = createNetServer((socket) => socket.on('data', (value) => socket.write(value)));
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamPort = (upstream.address() as any).port;
    let connectedTo: any = null;
    const proxy = await createPinnedPublicHttpsProxy({
      resolve: async () => [{ address: '8.8.8.8', family: 4 }],
      isPublicUrl: async () => true,
      connect: (options: any) => {
        connectedTo = options;
        return connectSocket({ host: '127.0.0.1', port: upstreamPort });
      },
    });
    let tunnel: any = null;
    try {
      const response = await new Promise<any>((resolve, reject) => {
        const request = httpRequest({ host: '127.0.0.1', port: new URL(proxy.server).port, method: 'CONNECT', path: 'safe.example.test:443' });
        request.once('connect', (result, socket) => resolve({ result, socket }));
        request.once('response', (result) => resolve({ result, socket: null }));
        request.once('error', reject);
        request.end();
      });
      tunnel = response.socket;
      expect(response.result.statusCode).toBe(200);
      expect(connectedTo).toMatchObject({ host: '8.8.8.8', family: 4, port: 443 });
    } finally {
      tunnel?.destroy();
      await proxy.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it('allows the trusted local replay proxy to bind while external Node DNS stays blocked', async () => {
    const directory = tempDir();
    const brokerPath = join(directory, 'broker.sock');
    const broker = createNetServer((socket) => socket.end('broker-ok'));
    await new Promise<void>((resolve) => broker.listen(brokerPath, resolve));
    const fence = installPortalReplayNodeEgressFence({ allowedUnixSocket: brokerPath });
    let proxy: Awaited<ReturnType<typeof createPinnedPublicHttpsProxy>> | null = null;
    try {
      proxy = await createPinnedPublicHttpsProxy();
      expect(proxy.server).toMatch(/^http:\/\/127\.0\.0\.1:/u);
      expect(fence.metrics.blockedAttempts).toBe(0);
    } finally {
      await proxy?.close();
      fence.restore();
      await new Promise<void>((resolve) => broker.close(() => resolve()));
    }
  });

  it('warms diagnostic bundling before the Node egress fence blocks child processes', async () => {
    await warmPortalDiagnostics();
    const fence = installPortalReplayNodeEgressFence({ allowedUnixSocket: '/tmp/portal-replay-test-broker.sock' });
    const context: any = {
      on: () => {},
      off: () => {},
      pages: () => [],
      exposeBinding: async () => {},
      addInitScript: async () => {},
    };
    try {
      const diagnostics = startPortalDiagnostics(context);
      await diagnostics.installFetchObserver();
      expect(fence.metrics.blockedAttempts).toBe(0);
    } finally {
      fence.restore();
    }
  });

  it('rejects a DNS answer set that contains a private address', async () => {
    const proxy = await createPinnedPublicHttpsProxy({
      resolve: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }],
      isPublicUrl: async () => true,
      connect: () => { throw new Error('must not connect'); },
    });
    try {
      const response = await new Promise<any>((resolve, reject) => {
        const request = httpRequest({ host: '127.0.0.1', port: new URL(proxy.server).port, method: 'CONNECT', path: 'rebinding.example.test:443' });
        request.once('connect', (result, socket) => { socket.destroy(); resolve(result); });
        request.once('response', resolve);
        request.once('error', reject);
        request.end();
      });
      expect(response.statusCode).toBe(403);
    } finally {
      await proxy.close();
    }
  });

  it('fails closed for a private or unresolvable host', async () => {
    const context = fakeContext();
    const metrics = await installPortalReplayFence(context, { isPublicHost: async () => false });
    expect(await runRequest(context, { method: 'GET', url: 'https://internal.example.test/job/1', navigation: true })).toBe('abort');
    expect(metrics.blockedUnsafeHosts).toBe(1);
  });

  it('starts both runners at the selected listing and prevents later route.fetch handlers', async () => {
    const browser = { childContext: true };
    const context: any = {
      route: async () => { context.registeredRoutes += 1; },
      request: { post: async () => ({ ok: true }) },
      browser: () => browser,
      newPage: async () => ({
        context: () => context,
        goto: async (url: string) => { context.navigations.push(url); return url; },
      }),
      registeredRoutes: 0,
      navigations: [] as string[],
    };
    const replayContext = sealPortalReplayContext(context, { firstNavigationUrl: 'https://listing.example.test/job/fake' });
    const page = await replayContext.newPage();
    await page.goto('https://ats.example.test/apply');
    await page.goto('https://ats.example.test/login');
    const popup = await replayContext.newPage();
    await popup.goto('https://ats.example.test/popup');
    await page.route('**/*', async () => { throw new Error('page route must not register'); });
    await replayContext.route('**/*', async () => {});
    replayContext.removeAllListeners();

    expect(context.navigations).toEqual([
      'https://listing.example.test/job/fake',
      'https://ats.example.test/login',
      'https://ats.example.test/popup',
    ]);
    expect(context.registeredRoutes).toBe(0);
    expect(replayContext.request).toBeUndefined();
    expect(replayContext.browser).toBeUndefined();
    expect(replayContext.newCDPSession).toBeUndefined();
    expect(page.context().request).toBeUndefined();
    expect(page.context().browser).toBeUndefined();
  });

  it('keeps Playwright cleanup methods intact on the trusted context while hiding them from the runner', async () => {
    const context = fakeContext() as any;
    let cleanupCalls = 0;
    const cleanup = () => { cleanupCalls += 1; };
    context.off = cleanup;
    context.removeAllListeners = cleanup;
    const replayContext = sealPortalReplayContext(context);

    await replayContext.off('page');
    await replayContext.removeAllListeners();

    expect(context.off).toBe(cleanup);
    expect(context.removeAllListeners).toBe(cleanup);
    expect(cleanupCalls).toBe(0);
  });
});

describe('portal replay corpus', () => {
  it('selects the same latest listings for a fixed seed and adds at most two open stop-host cases', () => {
    const directory = tempDir();
    const nowMs = Date.now();
    for (let index = 0; index < 7; index += 1) {
      const stopHost = index >= 4;
      const assembledAt = new Date(nowMs - index * 86_400_000).toISOString();
      const host = stopHost ? 'ats.issue.example.test' : 'ats.main.example.test';
      const job = {
        id: `fake-${index}`,
        title: `Synthetic role ${index}`,
        company: 'Synthetic Employer',
        url: `https://listing.example.test/job/${index}`,
        applyUrl: `https://${host}/jobs/${index}/apply`,
        validThrough: new Date(nowMs + 10 * 86_400_000).toISOString(),
      };
      writeFileSync(join(directory, `crawler-${index}.json`), JSON.stringify({ assembledAt, jobs: [job] }));
    }
    writeFileSync(join(directory, 'expired.json'), JSON.stringify({
      assembledAt: new Date(nowMs).toISOString(),
      jobs: [{
        id: 'expired', title: 'Expired fake role', company: 'Synthetic Employer',
        url: 'https://listing.example.test/job/expired', applyUrl: 'https://ats.main.example.test/jobs/expired',
        validThrough: new Date(nowMs - 86_400_000).toISOString(),
      }],
    }));
    const options = {
      jobsByCrawler: directory,
      nowMs,
      seed: 'fixed-seed',
      stopIssues: [{ title: '[portal-stop] ats.issue.example.test: stop su /jobs/*' }],
      classify: () => ({ type: 'workday' }),
    };
    const first = selectPortalReplayCorpus(options);
    const second = selectPortalReplayCorpus(options);
    expect(first).toEqual(second);
    expect(first.families.workday.map((record: any) => record.key)).toEqual(second.families.workday.map((record: any) => record.key));
    expect(first.sampleCounts.workday).toBe(5);
    expect(first.families.workday.map((record: any) => record.applyUrl)).toEqual([
      'https://ats.main.example.test/jobs/0/apply',
      'https://ats.main.example.test/jobs/1/apply',
      'https://ats.main.example.test/jobs/2/apply',
      'https://ats.issue.example.test/jobs/4/apply',
      'https://ats.issue.example.test/jobs/5/apply',
    ]);
    expect(first.families.workday.filter((record: any) => record.applyUrl.includes('ats.issue.example.test'))).toHaveLength(2);
    expect(extractPortalStopHosts(options.stopIssues)).toEqual(['ats.issue.example.test']);

    const filtered = selectPortalReplayCorpus({ ...options, families: ['successfactors'] });
    expect(filtered.families).toEqual({});
    expect(filtered.sampleCounts).toEqual({});
  });

  it('matches the required path set, including runner modules and used functions files', () => {
    const diff = [
      'diff --git a/scripts/assisted-application/lib/portal/agent.mjs b/scripts/assisted-application/lib/portal/agent.mjs',
      'diff --git a/scripts/assisted-application/agent.mjs b/scripts/assisted-application/agent.mjs',
      'diff --git a/functions/src/assistedApplicationAnswerEvidence.js b/functions/src/assistedApplicationAnswerEvidence.js',
      'diff --git a/functions/src/lib/permitStatus.js b/functions/src/lib/permitStatus.js',
      'diff --git a/scripts/assisted-application/lib/liveness.mjs b/scripts/assisted-application/lib/liveness.mjs',
      'diff --git a/scripts/assisted-application/lib/portal/removed.mjs b/docs/removed.mjs',
      'rename from scripts/assisted-application/lib/portal/removed.mjs',
      'rename to docs/removed.mjs',
      'diff --git a/scripts/lib/ai-models.mjs b/scripts/lib/ai-models.mjs',
      'diff --git a/package-lock.json b/package-lock.json',
      'diff --git a/services/router.ts b/services/router.ts',
    ].join('\n');
    expect(affectedPortalReplayPaths(diff)).toEqual([
      'functions/src/assistedApplicationAnswerEvidence.js',
      'functions/src/lib/permitStatus.js',
      'package-lock.json',
      'scripts/assisted-application/agent.mjs',
      'scripts/assisted-application/lib/liveness.mjs',
      'scripts/assisted-application/lib/portal/agent.mjs',
      'scripts/assisted-application/lib/portal/removed.mjs',
      'scripts/lib/ai-models.mjs',
    ]);
    expect(affectedPortalReplayPaths('scripts/assisted-application/lib/submit.mjs\nservices/router.ts')).toEqual([
      'scripts/assisted-application/lib/submit.mjs',
    ]);

    const unrelatedSharedDirectories = [
      'diff --git a/.github/workflows/social-publish-readiness-watch.yml b/.github/workflows/social-publish-readiness-watch.yml',
      'diff --git a/scripts/check-social-publish-readiness.mjs b/scripts/check-social-publish-readiness.mjs',
      'diff --git a/scripts/lib/social-readiness.mjs b/scripts/lib/social-readiness.mjs',
      'diff --git a/functions/src/lib/unrelated-site-helper.js b/functions/src/lib/unrelated-site-helper.js',
      'diff --git a/packages/portal-runner/index.mjs b/packages/portal-runner/index.mjs',
      'diff --git a/tests/social-publish-readiness.test.ts b/tests/social-publish-readiness.test.ts',
    ].join('\n');
    expect(affectedPortalReplayPaths(unrelatedSharedDirectories)).toEqual([]);
  });

  it('limits family replay to family-specific paths and expands shared paths to all families', () => {
    expect(PORTAL_REPLAY_ALLOWED_PATHS).toContain('functions/src/assistedApplicationAiJob.js');
    expect(affectedPortalReplayFamilies(['scripts/assisted-application/lib/portal/workday-route.mjs'])).toEqual(['workday']);
    expect(affectedPortalReplayFamilies(['scripts/assisted-application/lib/portal/successfactors-route.mjs'])).toEqual(['successfactors']);
    expect(affectedPortalReplayFamilies(['scripts/assisted-application/lib/portal/portal.mjs'])).toEqual([...PORTAL_REPLAY_FAMILIES].sort());
    expect(affectedPortalReplayFamilies([
      'functions/src/assistedApplicationAiJob.js',
      'functions/src/lib/permitStatus.js',
      'functions/src/assistedApplicationAnswerEvidence.js',
    ])).toEqual([...PORTAL_REPLAY_FAMILIES].sort());
    expect(affectedPortalReplayFamilies(['scripts/assisted-application/portal-replay.mjs'])).toEqual([...PORTAL_REPLAY_FAMILIES].sort());
  });

  it('does not fall back to a PR-controlled replay fence when the trusted base lacks it', () => {
    const baseRoot = tempDir();
    expect(() => trustedPortalReplayFenceRoot(baseRoot)).toThrowError(/portal_replay_fence_unavailable/iu);
  });
});

describe('portal replay workflow wiring', () => {
  it('materializes the trusted sandbox action and fails before replay without a broker socket', () => {
    const workflow = readFileSync(new URL('../.github/workflows/assisted-application-portal-replay.yml', import.meta.url), 'utf8');
    const materialize = workflow.indexOf('Materialize trusted Codex sandbox action');
    const codex = workflow.indexOf('uses: ./.portal-base/.github/actions/setup-claude-haiku-fallback');
    const brokerGuard = workflow.indexOf('      - name: Require trusted Codex broker\n');
    const replay = workflow.indexOf('Replay portal families in parallel inside this worker');

    expect(materialize).toBeGreaterThan(-1);
    expect(materialize).toBeLessThan(codex);
    const prCheckout = workflow.indexOf('      - name: Checkout PR runner\n');
    const mergeCommit = workflow.indexOf('          ref: ${{ github.event.pull_request.merge_commit_sha }}\n');
    expect(prCheckout).toBeGreaterThan(-1);
    expect(mergeCommit).toBeGreaterThan(prCheckout);
    expect(workflow).not.toContain('github.event.pull_request.head.sha');
    expect(workflow).not.toContain('github.event.pull_request.head.repo.full_name');
    expect(workflow).not.toContain('refs/pull/${{ github.event.pull_request.number }}/merge');
    expect(workflow).not.toContain('refs/pull/$PR_NUMBER/merge');
    expect(workflow).not.toContain('gh pr diff "$PR_NUMBER"');
    expect(workflow).toContain('PR_MERGE_SHA: ${{ github.event.pull_request.merge_commit_sha }}');
    expect(workflow).toContain('git -C .portal-base fetch --no-tags --depth=1 origin "$PR_MERGE_SHA"');
    expect(workflow).toContain('git -C .portal-base diff --binary "$BASE_SHA" "$merge_ref"');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain('            .github/actions/setup-codex-sandbox');
    expect(workflow).toContain('source_action="$GITHUB_WORKSPACE/.portal-base/.github/actions/setup-codex-sandbox/action.yml"');
    expect(workflow).toContain('target_action="$GITHUB_WORKSPACE/.github/actions/setup-codex-sandbox/action.yml"');
    expect(brokerGuard).toBeGreaterThan(codex);
    expect(brokerGuard).toBeLessThan(replay);
    expect(workflow).toContain('timeout-minutes: 30');
    expect(workflow).toContain('! -S "$CODEX_AUTH_BROKER_SOCKET"');
    const replayGate = workflow.indexOf('\n  portal-replay-gate:');
    const replayBlock = workflow.slice(replay, replayGate);
    expect(replayBlock).toContain('portal_replay_cli=scripts/assisted-application/portal-replay.mjs');
    expect(workflow).toContain('portal_replay_cli=.portal-base/scripts/assisted-application/portal-replay.mjs');
  });

  it('does shared setup once and runs the family group inside one worker', () => {
    const workflow = readFileSync(new URL('../.github/workflows/assisted-application-portal-replay.yml', import.meta.url), 'utf8');
    expect(workflow).toContain('name: replay portal families (group)');
    expect(workflow).toContain('max_parallel=13');
    expect(workflow).toContain('node "$portal_replay_cli" compare');
    expect(workflow).toContain('run_family "$family" &');
    expect(workflow).toContain('wait_for_wave');
    expect(workflow).toContain('PORTAL_REPLAY_REPORT_DIR');
    expect(workflow).toContain('name: assisted-application-portal-replay-reports-${{ github.run_id }}');
    expect(workflow).not.toContain('max-parallel: 6');
    expect(workflow).not.toContain('matrix.family');
    expect(workflow).not.toContain('      matrix:\n');
  });

});

describe('portal replay base/head gate', () => {
  const measured = (caseId: string, stage: string, overrides: Record<string, unknown> = {}) => ({
    caseId, host: 'careers.example.test', path: '/jobs/*', stage, status: 'measured', stopCode: 'ok',
    agentCalls: 0, blockedNonGet: 0, blockedWebSockets: 0, finalClickAttempts: 0,
    formLinkedToPosting: 'yes', securityViolations: [], ...overrides,
  });

  it('fails a per-listing stage regression and a lower family ready rate', () => {
    const result = comparePortalReplayFamily({
      family: 'workday',
      baseRecords: [measured('one', 'dry_run_ready'), measured('two', 'account_gate')],
      headRecords: [measured('one', 'form'), measured('two', 'form')],
    });
    expect(result.status).toBe('fail');
    expect(result.findingCodes).toContain('stage_regression');
    expect(result.findingCodes).toContain('family_ready_rate_decreased');
  });

  it.each(['http_5xx', 'posting_closed', 'captcha', 'region_blocked'])('treats %s as neutral after its retry', stage => {
    const result = comparePortalReplayFamily({
      family: 'successfactors',
      baseRecords: [measured('one', 'dry_run_ready')],
      headRecords: [measured('one', stage, { status: 'neutral', stopCode: stage, retryCount: 1 })],
    });
    expect(result.status).toBe('pass');
    expect(result.familyRates.comparable).toBe(0);
  });

  it('does not block on a posting mismatch already present on the base', () => {
    const base = (caseId: string) => measured(caseId, 'form', {
      status: 'fail',
      formLinkedToPosting: 'no',
      securityViolations: ['wrong_posting_or_talent_pool'],
    });
    const result = comparePortalReplayFamily({
      family: 'refline',
      baseRecords: ['one', 'two', 'three'].map(base),
      headRecords: ['one', 'two', 'three'].map(base),
    });
    expect(result.status).toBe('pass');
    expect(result.findingCodes).toEqual([]);
    expect(result.familyRates.comparable).toBe(0);
    expect(sanitizePortalReplayReport(result).status).toBe('pass');
  });

  it('compares new security violations against a measured base that already failed', () => {
    const base = measured('one', 'form', {
      status: 'fail',
      formLinkedToPosting: 'no',
      securityViolations: ['wrong_posting_or_talent_pool'],
    });
    const head = measured('one', 'form', {
      status: 'fail',
      formLinkedToPosting: 'no',
      nodeEgressBlocked: 1,
      securityViolations: ['wrong_posting_or_talent_pool', 'node_egress_attempt'],
    });
    const result = comparePortalReplayFamily({
      family: 'refline',
      baseRecords: [base],
      headRecords: [head],
    });
    expect(result.status).toBe('fail');
    expect(result.findingCodes).toEqual(['node_egress_attempt']);
  });

  it('does not block on a timeout already present on the base', () => {
    const timeout = (caseId: string) => measured(caseId, 'stopped', { status: 'error', stopCode: 'portal_replay_timeout' });
    const result = comparePortalReplayFamily({
      family: 'greenhouse',
      baseRecords: ['one', 'two', 'three'].map(timeout),
      headRecords: ['one', 'two', 'three'].map(timeout),
    });
    expect(result.status).toBe('pass');
    expect(result.findingCodes).toEqual([]);
    expect(result.familyRates.comparable).toBe(0);
    expect(sanitizePortalReplayReport(result).status).toBe('pass');
  });

  it('does not infer a security regression from an unmeasured base', () => {
    const result = comparePortalReplayFamily({
      family: 'personio',
      baseRecords: [measured('one', 'stopped', { status: 'error', stopCode: 'runner_error' })],
      headRecords: [measured('one', 'form', { status: 'fail', formLinkedToPosting: 'no' })],
    });
    expect(result.status).toBe('pass');
    expect(result.findingCodes).toEqual([]);
  });

  it('still fails when the PR introduces an unmeasured replay', () => {
    const result = comparePortalReplayFamily({
      family: 'greenhouse',
      baseRecords: [measured('one', 'form')],
      headRecords: [measured('one', 'stopped', { status: 'error', stopCode: 'portal_replay_timeout' })],
    });
    expect(result.status).toBe('fail');
    expect(result.findingCodes).toContain('replay_unmeasured');
  });

  it('fails every security violation, including a final click, a passed mutation, or a wrong posting', () => {
    const result = comparePortalReplayFamily({
      family: 'workday',
      baseRecords: [measured('one', 'dry_run_ready')],
      headRecords: [measured('one', 'dry_run_ready', {
        securityViolations: ['final_click_attempt', 'non_get_passed', 'wrong_posting_or_talent_pool', 'submission_attempted'],
      })],
    });
    expect(result.status).toBe('fail');
    expect(result.findingCodes).toEqual(['final_click_attempt', 'non_get_passed', 'submission_attempted', 'wrong_posting_or_talent_pool']);
  });

  it('fails a blocked attempt to use Node network APIs outside the browser fence', () => {
    const result = comparePortalReplayFamily({
      family: 'workday',
      baseRecords: [measured('one', 'dry_run_ready')],
      headRecords: [measured('one', 'dry_run_ready', { nodeEgressBlocked: 1 })],
    });
    expect(result.status).toBe('fail');
    expect(result.findingCodes).toContain('node_egress_attempt');
  });

  it('preserves unknown posting linkage without inventing a mismatch', () => {
    const result = comparePortalReplayFamily({
      family: 'greenhouse',
      baseRecords: [measured('one', 'form', { formLinkedToPosting: 'unknown' })],
      headRecords: [measured('one', 'form', { formLinkedToPosting: 'unknown' })],
    });
    expect(result.status).toBe('pass');
    expect(result.cases[0].head.formLinkedToPosting).toBe('unknown');
  });

  it('removes case identifiers and unexpected fields from the public replay report', () => {
    const sensitive = 'fake-candidate-personal-token@example.invalid';
    const comparison = comparePortalReplayFamily({
      family: 'workday',
      baseRecords: [measured(sensitive, 'form')],
      headRecords: [measured(sensitive, 'form', { stopCode: sensitive, formLinkedToPosting: sensitive })],
    });
    const publicReport = sanitizePortalReplayReport({
      ...comparison,
      extra: sensitive,
      cases: comparison.cases.map((item: any) => ({ ...item, extra: sensitive })),
    });
    const serialized = JSON.stringify(publicReport);
    expect(serialized).not.toContain(sensitive);
    expect(serialized).not.toContain('caseId');
    expect(publicReport.cases[0].head.stopCode).toBe('unknown');
    expect(publicReport.cases[0].head.formLinkedToPosting).toBe('unknown');
  });

  it('recomputes regressions and safety findings when aggregating a family report', () => {
    const comparison = comparePortalReplayFamily({
      family: 'workday',
      baseRecords: [measured('one', 'dry_run_ready')],
      headRecords: [measured('one', 'form')],
    });
    const forgedAsPass = {
      ...comparison,
      status: 'pass',
      findingCodes: [],
      cases: comparison.cases.map((item: any) => ({
        ...item,
        findingCodes: [],
        head: { ...item.head, finalClickAttempts: 1, formLinkedToPosting: 'no' },
      })),
    };
    const sanitized = sanitizePortalReplayReport(forgedAsPass);
    expect(sanitized.status).toBe('fail');
    expect(sanitized.findingCodes).toContain('stage_regression');
    expect(sanitized.findingCodes).toContain('final_click_attempt');
    expect(sanitized.findingCodes).toContain('wrong_posting_or_talent_pool');
  });

  it('rejects reports with fewer than three cases or a missing base/head measurement', () => {
    const singleCase = comparePortalReplayFamily({
      family: 'workday',
      baseRecords: [measured('one', 'form')],
      headRecords: [measured('one', 'form')],
    });
    const tooSmall = sanitizePortalReplayReport(singleCase);
    expect(tooSmall.status).toBe('fail');
    expect(tooSmall.findingCodes).toContain('sample_count_out_of_range');

    const missingSide = sanitizePortalReplayReport({
      ...singleCase,
      cases: [{ ...singleCase.cases[0], base: null, head: null }],
    });
    expect(missingSide.status).toBe('fail');
    expect(missingSide.findingCodes).toContain('sample_missing');
  });

  it('always passes the aggregator when no runner paths changed and fails an incomplete matrix otherwise', () => {
    expect(aggregatePortalReplayGate({ prepareRun: false, prepareResult: 'success', matrixResult: 'skipped' })).toMatchObject({
      status: 'pass', code: 'no_runner_paths_changed',
    });
    expect(aggregatePortalReplayGate({
      prepareRun: true, prepareResult: 'success', matrixResult: 'failure', families: ['workday'], reports: [],
    })).toMatchObject({ status: 'fail', code: 'matrix_incomplete_or_failed', missingFamilies: ['workday'] });
    expect(aggregatePortalReplayGate({
      prepareRun: true, prepareResult: 'success', matrixResult: 'success', families: ['workday'],
      reports: [{ family: 'workday', status: 'pass' }],
    })).toMatchObject({ status: 'pass', code: 'portal_replay_passed' });
  });
});
