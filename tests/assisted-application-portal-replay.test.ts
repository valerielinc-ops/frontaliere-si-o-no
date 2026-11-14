import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
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
  bestEffortPortalReplayPreflight,
  comparePortalReplayFamily,
  completeUnmeasuredReplaySide,
  createPortalReplayDeadline,
  extractPortalStopHosts,
  markdownForAggregate,
  PORTAL_REPLAY_ALLOWED_PATHS,
  PORTAL_REPLAY_FAMILIES,
  PORTAL_REPLAY_MAX_RETRIES,
  portalReplayPathScope,
  postingLinkStatus,
  retryClass,
  sanitizePortalReplayReport,
  selectPortalReplayCorpus,
  trustedPortalReplayFenceRoot,
  mergePortalReplayRetryEvidence,
  violationsFor,
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
      'diff --git a/scripts/lib/ensure-chromium.mjs b/scripts/lib/ensure-chromium.mjs',
      'diff --git a/scripts/lib/molecular-partners-job-parser.mjs b/scripts/lib/molecular-partners-job-parser.mjs',
      'diff --git a/packages/portal-runner/index.mjs b/packages/portal-runner/index.mjs',
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
      'scripts/lib/ensure-chromium.mjs',
    ]);
    expect(affectedPortalReplayPaths('scripts/assisted-application/lib/submit.mjs\nservices/router.ts')).toEqual([
      'scripts/assisted-application/lib/submit.mjs',
    ]);
    expect(affectedPortalReplayPaths('scripts/lib/molecular-partners-job-parser.mjs')).toEqual([]);

    const unrelatedSharedDirectories = [
      'diff --git a/.github/workflows/social-publish-readiness-watch.yml b/.github/workflows/social-publish-readiness-watch.yml',
      'diff --git a/scripts/check-social-publish-readiness.mjs b/scripts/check-social-publish-readiness.mjs',
      'diff --git a/scripts/lib/social-readiness.mjs b/scripts/lib/social-readiness.mjs',
      'diff --git a/functions/src/lib/unrelated-site-helper.js b/functions/src/lib/unrelated-site-helper.js',
      'diff --git a/packages/portal-runner/index.mjs b/packages/portal-runner/index.mjs',
      'diff --git a/services/locales/it-core.ts b/services/locales/it-core.ts',
      'diff --git a/tests/social-publish-readiness.test.ts b/tests/social-publish-readiness.test.ts',
    ].join('\n');
    expect(affectedPortalReplayPaths(unrelatedSharedDirectories)).toEqual([]);
  });

  it('limits family replay to family-specific paths and expands shared paths to all families', () => {
    expect(PORTAL_REPLAY_ALLOWED_PATHS).toContain('functions/src/assistedApplicationAiJob.js');
    expect(affectedPortalReplayFamilies(['scripts/assisted-application/lib/portal/workday-route.mjs'])).toEqual(['workday']);
    expect(affectedPortalReplayFamilies(['scripts/assisted-application/lib/portal/successfactors-route.mjs'])).toEqual(['successfactors']);
    expect(affectedPortalReplayFamilies(['scripts/assisted-application/lib/portal/portal.mjs'])).toEqual([...PORTAL_REPLAY_FAMILIES].sort());
    expect(affectedPortalReplayFamilies(['scripts/lib/ats-adapters/jobsch-adapter.mjs'])).toEqual(['jobs_ch']);
    expect(affectedPortalReplayFamilies([
      'scripts/assisted-application/lib/portal/workday-route.mjs',
      'scripts/lib/molecular-partners-job-parser.mjs',
    ])).toEqual(['workday']);
    expect(affectedPortalReplayFamilies(['scripts/lib/ats-adapters/index.mjs'])).toEqual([...PORTAL_REPLAY_FAMILIES].sort());
    expect(affectedPortalReplayFamilies(['scripts/lib/ensure-chromium.mjs'])).toEqual([...PORTAL_REPLAY_FAMILIES].sort());
    expect(affectedPortalReplayFamilies([
      'functions/src/assistedApplicationAiJob.js',
      'functions/src/lib/permitStatus.js',
      'functions/src/assistedApplicationAnswerEvidence.js',
    ])).toEqual([...PORTAL_REPLAY_FAMILIES].sort());
    expect(affectedPortalReplayFamilies(['scripts/assisted-application/portal-replay.mjs'])).toEqual([...PORTAL_REPLAY_FAMILIES].sort());
  });

  it('keeps parser/runtime scope explicit and fails closed for unknown parser modules', () => {
    expect(portalReplayPathScope('scripts/lib/ats-adapters/jobsch-adapter.mjs')).toBe('parser');
    expect(portalReplayPathScope('scripts/lib/ats-adapters/unknown-adapter.mjs')).toBe('parser');
    expect(portalReplayPathScope('scripts/lib/ensure-chromium.mjs')).toBe('runtime');
    expect(portalReplayPathScope('/SCRIPTS/LIB/ENSURE-CHROMIUM.MJS')).toBe('runtime');
    expect(portalReplayPathScope('/FUNCTIONS/SRC/LIB/PERMITSTATUS.JS')).toBe('shared');
    expect(portalReplayPathScope('scripts/lib/molecular-partners-job-parser.mjs')).toBeNull();
    expect(portalReplayPathScope('scripts/lib/new-unclassified-helper.mjs')).toBeNull();
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
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain('            .github/actions/setup-codex-sandbox');
    expect(workflow).toContain('source_action="$GITHUB_WORKSPACE/.portal-base/.github/actions/setup-codex-sandbox/action.yml"');
    expect(workflow).toContain('target_action="$GITHUB_WORKSPACE/.github/actions/setup-codex-sandbox/action.yml"');
    expect(brokerGuard).toBeGreaterThan(codex);
    expect(brokerGuard).toBeLessThan(replay);
    expect(workflow).toContain('! -S "$CODEX_AUTH_BROKER_SOCKET"');
    const replayGate = workflow.indexOf('\n  portal-replay-gate:');
    const replayBlock = workflow.slice(replay, replayGate);
    expect(replayBlock).toContain('portal_replay_cli=scripts/assisted-application/portal-replay.mjs');
    expect(workflow).toContain('portal_replay_cli=.portal-base/scripts/assisted-application/portal-replay.mjs');
    const gateBlock = workflow.slice(replayGate);
    expect(gateBlock).toContain('ref: ${{ github.event.pull_request.merge_commit_sha }}');
    expect(gateBlock).toContain('path: .portal-head');
    expect(gateBlock).toContain("PORTAL_REPLAY_GATE_SEMANTICS = 'measured-baseline-v2'");
    expect(gateBlock).toContain('gate_cli=.portal-head/scripts/assisted-application/portal-replay.mjs');
    expect(gateBlock).toContain('node "$gate_cli" aggregate');
  });

  it('runs bounded family groups in parallel workers and keeps one group scheduler per worker', () => {
    const workflow = readFileSync(new URL('../.github/workflows/assisted-application-portal-replay.yml', import.meta.url), 'utf8');
    expect(workflow).toContain('name: replay portal families (group ${{ matrix.group }})');
    expect(workflow).toContain('group: [0, 1, 2]');
    expect(workflow).toContain('node "$portal_replay_cli" compare');
    expect(workflow).toContain('run_family "$family" &');
    expect(workflow).toContain('group_script="$RUNNER_TEMP/portal-replay-group.sh"');
    expect(workflow).toContain('declare -f run_group > "$group_script"');
    expect(workflow).not.toContain("bash -c 'run_group'");
    expect(workflow).toContain('PORTAL_REPLAY_REPORT_DIR');
    expect(workflow).toContain('name: assisted-application-portal-replay-reports-${{ github.run_id }}-${{ matrix.group }}');
    expect(workflow).not.toContain('max-parallel: 6');
    expect(workflow).not.toContain('matrix.family');
  });

  it('keeps the concurrent Codex callers within the broker lanes so no listing waits in the queue', () => {
    const workflow = readFileSync(new URL('../.github/workflows/assisted-application-portal-replay.yml', import.meta.url), 'utf8');
    // One source of truth: the lanes the broker opens and the families the
    // worker starts both come from PORTAL_REPLAY_BROKER_LANES.
    const lanes = /PORTAL_REPLAY_BROKER_LANES: '(\d+)'/u.exec(workflow);
    expect(lanes).not.toBeNull();
    const laneCount = Number(lanes?.[1]);
    expect(laneCount).toBeGreaterThanOrEqual(2);
    expect(laneCount).toBeLessThanOrEqual(6);
    expect(workflow).toContain('broker_max_concurrency: ${{ env.PORTAL_REPLAY_BROKER_LANES }}');
    expect(workflow).not.toContain("broker_max_concurrency: '2'");
    // base + head replay at once: two callers per family.
    expect(workflow).toContain('max_parallel=$(( lanes / 2 ))');
    expect(workflow).toContain('while (( $(jobs -pr | wc -l) >= max_parallel )); do sleep 1; done');
    expect(workflow).not.toContain('max_parallel=13');
    expect(workflow).not.toContain('wait_for_wave');
    // the per-family exit status survives the sliding window
    expect(workflow).toContain('echo "$status" > "$PORTAL_REPLAY_LOG_DIR/portal-replay-${family}.exit"');
    expect(workflow).toContain('finished with exit $status after');
    // the job budget covers a worst-case bound derived from the largest family
    // (a family holds a slot for its whole workload), not from an average
    const cli = readFileSync(new URL('../scripts/assisted-application/portal-replay.mjs', import.meta.url), 'utf8');
    const limits = /minPerFamily: (\d+), base: (\d+), hardCases: (\d+), maxPerFamily: (\d+), retries: (\d+|PORTAL_REPLAY_MAX_RETRIES)/u.exec(cli);
    expect(limits).not.toBeNull();
    const maxPerFamily = Number(limits?.[4]);
    const retries = limits?.[5] === 'PORTAL_REPLAY_MAX_RETRIES' ? PORTAL_REPLAY_MAX_RETRIES : Number(limits?.[5]);
    const minPerFamily = Number(limits?.[1]);
    const listingMs = Number(/--timeout-ms (\d+)/u.exec(workflow)?.[1]);
    expect(listingMs).toBe(75_000);
    const preflightS = 60;
    // a side gets (retries + 1) attempts, each bounded by the wall cap of an
    // attempt; the broker limit of one call must fit inside that cap
    const wallCapMs = Number(/REPLAY_WALL_CAP_MS = ([\d_]+)/u.exec(cli)?.[1]?.replaceAll('_', ''));
    const callMs = Number(/REPLAY_CODEX_CALL_TIMEOUT_MS = ([\d_]+)/u.exec(cli)?.[1]?.replaceAll('_', ''));
    expect(wallCapMs).toBeGreaterThanOrEqual(listingMs + callMs);
    expect(Number(/broker_max_timeout_ms: '(\d+)'/u.exec(workflow.slice(workflow.indexOf('  replay:')))?.[1])).toBe(callMs);
    expect(workflow).toContain(`REPLAY_CODEX_CALL_TIMEOUT_MS (${callMs / 1000} s`);
    expect(workflow).toContain(`REPLAY_WALL_CAP_MS (${wallCapMs / 1000} s)`);
    const listingS = ((retries + 1) * wallCapMs) / 1000;
    const largestS = maxPerFamily * listingS + preflightS;
    const smallS = minPerFamily * listingS + preflightS;
    // The modulo partition puts at most four families in a worker. Bound all
    // four at maxPerFamily so the timeout remains safe for any affected subset.
    const groupLargeFamilies = 4;
    const groupSmallFamilies = 0;
    const workS = groupLargeFamilies * largestS + groupSmallFamilies * smallS;
    const slots = Math.floor(laneCount / 2);
    // greedy list scheduling: makespan <= work / slots + (1 - 1 / slots) * largest family
    const makespanS = workS / slots + (1 - 1 / slots) * largestS;
    const setupMin = 6;
    const boundMin = Math.ceil(makespanS / 60) + setupMin;
    const budget = Number(/timeout-minutes: (\d+)/u.exec(workflow.slice(workflow.indexOf('  replay:')))?.[1]);
    expect(budget).toBeGreaterThanOrEqual(boundMin);
    expect(workflow).toContain(`${Math.round(makespanS)} s`);
  });

  it('warms the broker up before the burst and fails by name when the Codex backend is unusable', () => {
    const workflow = readFileSync(new URL('../.github/workflows/assisted-application-portal-replay.yml', import.meta.url), 'utf8');
    const guard = workflow.indexOf('      - name: Require trusted Codex broker\n');
    const warmup = workflow.indexOf('      - name: Warm up the Codex broker and measure its lanes\n');
    const replay = workflow.indexOf('      - name: Replay portal families in parallel inside this worker\n');
    expect(warmup).toBeGreaterThan(guard);
    expect(warmup).toBeLessThan(replay);
    const step = workflow.slice(warmup, replay);
    // trusted base module only: PR code never talks to the broker outside the fence
    expect(step).toContain('.portal-base/scripts/lib/ai-models.mjs');
    expect(step).not.toMatch(/path\.resolve\("scripts\//u);
    expect(step).toContain('requestCodexBrokerJson');
    expect(step).toContain('::error::blocked: the Codex backend did not answer a minimal request');
    expect(step).toContain('process.exit(1)');
    expect(step).toContain('Codex broker lanes probe');
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

  it('retries a read-only replay timeout once', () => {
    expect(PORTAL_REPLAY_MAX_RETRIES).toBe(1);
    expect(retryClass('stopped', 0, 'portal_replay_timeout')).toBe('portal_replay_timeout');
    expect(retryClass('stopped')).toBe('');
  });

  it('measures the active budget without the time spent waiting for the Codex broker', () => {
    let clock = 1_000;
    const deadline = createPortalReplayDeadline({ activeBudgetMs: 75_000, wallCapMs: 180_000, now: () => clock });
    clock += 20_000; // navigation and clicks
    expect(deadline.expired()).toBe('');
    deadline.agentStarted();
    clock += 100_000; // one slow Codex call: 100 s that are not the runner's
    expect(deadline.expired()).toBe('');
    expect(deadline.snapshot()).toMatchObject({ wallMs: 120_000, agentMs: 100_000, activeMs: 20_000, calls: 1 });
    deadline.agentSettled();
    clock += 54_000;
    expect(deadline.expired()).toBe('');
    clock += 1_000; // 20 s + 55 s of runner time: the same 75 s every listing gets
    expect(deadline.expired()).toBe('active');
  });

  it('counts overlapping Codex calls once and still ends at the wall cap', () => {
    let clock = 0;
    const deadline = createPortalReplayDeadline({ activeBudgetMs: 75_000, wallCapMs: 180_000, now: () => clock });
    deadline.agentStarted();
    clock += 10_000;
    deadline.agentStarted();
    clock += 10_000;
    deadline.agentSettled();
    clock += 10_000;
    deadline.agentSettled();
    expect(deadline.snapshot()).toMatchObject({ wallMs: 30_000, agentMs: 30_000, activeMs: 0, calls: 2 });
    deadline.agentStarted(); // a call that never answers
    clock += 149_999;
    expect(deadline.expired()).toBe('');
    clock += 1;
    expect(deadline.expired()).toBe('wall');
  });

  it('logs how long each Codex call took and whether it failed', () => {
    let clock = 0;
    const deadline = createPortalReplayDeadline({ activeBudgetMs: 75_000, now: () => clock });
    const first = deadline.agentStarted();
    clock += 41_000;
    deadline.agentSettled(first, true);
    const second = deadline.agentStarted();
    clock += 150_000;
    deadline.agentSettled(second, false);
    expect(deadline.snapshot().callLog).toEqual([{ ms: 41_000, ok: true }, { ms: 150_000, ok: false }]);
  });

  describe('completing an unmeasured side', () => {
    const attempt = (stage: string, overrides: Record<string, unknown> = {}) => ({
      stage, status: 'measured', stopCode: 'posting_mismatch', agentCalls: 1, retryCount: 0,
      blockedNonGet: 0, securityViolations: [], timing: { wallMs: 1, activeMs: 1, agentMs: 0, timeout: '' },
      timings: [{ wallMs: 1, activeMs: 1, agentMs: 0, timeout: '' }], ...overrides,
    });
    const timedOut = (overrides: Record<string, unknown> = {}) => attempt('stopped', { status: 'error', stopCode: 'portal_replay_timeout', ...overrides });

    it('replays the head once, alone, when only the head lost its measurement', async () => {
      const calls: string[] = [];
      const result = await completeUnmeasuredReplaySide({
        base: attempt('form'), head: timedOut(),
        rerun: async (side: string) => { calls.push(side); return attempt('form'); },
      });
      expect(calls).toEqual(['head']);
      expect(result.completed).toBe('head');
      expect(result.head.status).toBe('measured');
      expect(result.head.retryCount).toBe(1);
      expect(result.head.agentCalls).toBe(2);
      expect(result.head.timings).toHaveLength(2);
      expect(result.base.stage).toBe('form');
    });

    it('applies the same rule when the base is the side that lost its measurement', async () => {
      const calls: string[] = [];
      const result = await completeUnmeasuredReplaySide({
        base: timedOut(), head: attempt('form'),
        rerun: async (side: string) => { calls.push(side); return attempt('form'); },
      });
      expect(calls).toEqual(['base']);
      expect(result.completed).toBe('base');
      expect(result.base.status).toBe('measured');
    });

    it('never takes a side past its attempts: a side that already used its neutral retry is not replayed again', async () => {
      const twice = timedOut({ timings: [{ wallMs: 1, activeMs: 1, agentMs: 0, timeout: '' }, { wallMs: 1, activeMs: 1, agentMs: 0, timeout: 'active' }] });
      const result = await completeUnmeasuredReplaySide({
        base: attempt('form'), head: twice,
        rerun: async () => { throw new Error('must not rerun'); },
      });
      expect(result.completed).toBe('');
      expect(result.head).toBe(twice);
    });

    it('does not replay when both sides measured, both are unmeasured, or the miss is a neutral portal fact', async () => {
      const rerun = async () => { throw new Error('must not rerun'); };
      for (const [base, head] of [
        [attempt('form'), attempt('form')],
        [timedOut(), timedOut()],
        [attempt('form'), attempt('captcha', { status: 'neutral', stopCode: 'captcha' })],
        [attempt('form'), undefined],
      ]) {
        const result = await completeUnmeasuredReplaySide({ base, head, rerun });
        expect(result.completed).toBe('');
        expect(result.head).toBe(head);
      }
    });

    it('keeps the criterion: a side that stays unmeasured is still replay_unmeasured', async () => {
      const result = await completeUnmeasuredReplaySide({
        base: attempt('form'), head: timedOut(), rerun: async () => timedOut(),
      });
      expect(result.completed).toBe('head');
      const gate = comparePortalReplayFamily({
        family: 'greenhouse', baseRecords: [{ caseId: 'one', ...result.base }], headRecords: [{ caseId: 'one', ...result.head }],
      });
      expect(gate.status).toBe('fail');
      expect(gate.findingCodes).toContain('replay_unmeasured');
    });

    it('retains a violation observed by the first attempt when the retry is the record we keep', async () => {
      const result = await completeUnmeasuredReplaySide({
        base: attempt('form'),
        head: timedOut({ finalClickAttempts: 1, securityViolations: ['final_click_attempt'] }),
        rerun: async () => attempt('form'),
      });
      expect(result.head.securityViolations).toContain('final_click_attempt');
      expect(result.head.status).toBe('fail');
    });
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

  it('keeps a pre-form mismatch stop from becoming a wrong-module finding', () => {
    const comparison = comparePortalReplayFamily({
      family: 'manatal',
      baseRecords: ['one', 'two', 'three'].map((caseId) => measured(caseId, 'ad_opened', {
        stopCode: 'posting_mismatch', formLinkedToPosting: 'no',
      })),
      headRecords: ['one', 'two', 'three'].map((caseId) => measured(caseId, 'ad_opened', {
        stopCode: 'posting_mismatch', formLinkedToPosting: 'no',
      })),
    });
    const report = sanitizePortalReplayReport(comparison);

    expect(report.status).toBe('pass');
    expect(report.findingCodes).not.toContain('wrong_posting_or_talent_pool');
    expect(report.cases[0].head.formLinkedToPosting).toBe('unknown');
  });

  it('keeps contradictory posting-match evidence unknown and flags explicit form mismatch', () => {
    const mismatchEvent = { type: 'submit_handoff', reason: 'posting_mismatch' };
    const matchingEvidence = { formReady: true, postingMatch: 'match' };
    const mismatchingEvidence = { formReady: true, postingMatch: 'mismatch' };

    expect(postingLinkStatus(mismatchEvent, matchingEvidence, 'form')).toBe('unknown');
    expect(violationsFor({ event: mismatchEvent, evidence: matchingEvidence, metrics: {}, stage: 'form' }))
      .not.toContain('wrong_posting_or_talent_pool');
    expect(postingLinkStatus(mismatchEvent, mismatchingEvidence, 'form')).toBe('no');
    expect(violationsFor({ event: mismatchEvent, evidence: mismatchingEvidence, metrics: {}, stage: 'form' }))
      .toContain('wrong_posting_or_talent_pool');
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

  it('retains submission security evidence when a neutral retry becomes the final result', () => {
    const firstAttempt = { submissionAttempted: true, retryClass: 'neutral', securityViolations: [] };
    const neutralRetry = { submissionAttempted: false, securityViolations: [] };
    const merged = mergePortalReplayRetryEvidence(firstAttempt, neutralRetry);

    expect(merged.submissionAttempted).toBe(true);
    expect(merged.securityViolations).toContain('submission_attempted');

    const result = comparePortalReplayFamily({
      family: 'workday',
      baseRecords: [measured('one', 'dry_run_ready')],
      headRecords: [measured('one', 'dry_run_ready', merged)],
    });
    expect(result.status).toBe('fail');
    expect(result.findingCodes).toContain('submission_attempted');
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

  it('prints only sanitized replay finding codes in the aggregate report', () => {
    const summary = markdownForAggregate({
      status: 'fail', code: 'matrix_incomplete_or_failed', failedFamilies: ['manatal'], reportCount: 1,
    }, [{
      family: 'manatal',
      familyRates: { baseReady: 0, headReady: 0, comparable: 1 },
      cases: [{
        host: 'careers.example.test', path: '/jobs/*', findingCodes: ['wrong_posting_or_talent_pool', 'replay_unmeasured'],
        base: { stage: 'ad_opened' },
        head: {
          stage: 'form', stopCode: 'posting_mismatch', agentCalls: 0, blockedNonGet: 0,
          nodeEgressBlocked: 0, finalClickAttempts: 0, formLinkedToPosting: 'unknown',
        },
      }],
    }], true);

    expect(summary).toContain('wrong_posting_or_talent_pool, replay_unmeasured');
    expect(summary).not.toContain('https://');
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

describe('portal replay live preflight', () => {
  it('keeps a transient public endpoint failure local to the case', async () => {
    const result = await bestEffortPortalReplayPreflight(async () => {
      throw Object.assign(new Error('upstream timeout'), { code: 'ETIMEDOUT' });
    });
    expect(result).toEqual([{ status: 0 }]);
  });

  it('preserves successful preflight responses for the retry classifier', async () => {
    const responses = [{ status: 503 }];
    await expect(bestEffortPortalReplayPreflight(async () => responses)).resolves.toBe(responses);
  });

  it('normalizes a malformed preflight result without aborting the family', async () => {
    await expect(bestEffortPortalReplayPreflight(async () => null)).resolves.toEqual([{ status: 0 }]);
  });
});

describe('portal replay gate determinism (F2)', () => {
  const workflow = () => readFileSync(new URL('../.github/workflows/assisted-application-portal-replay.yml', import.meta.url), 'utf8');

  it('lists the changed paths from the merge commit with git, never through the REST API', () => {
    const text = workflow();
    expect(text).not.toMatch(/gh pr diff/u);
    expect(text).not.toContain('portal-replay-paths.patch');
    expect(text).toContain('ref: ${{ github.sha }}');
    expect(text).toContain('fetch-depth: 2');
    expect(text).toContain('filter: blob:none');
    expect(text).toContain('git diff --name-only --no-renames HEAD^1 HEAD');
    // un diff a due punti contro la base corrente darebbe falsi positivi quando main avanza
    expect(text).not.toMatch(/git diff[^\n]*(BASE_SHA|base\.sha)/u);
    // prepare riusa l'elenco di detect invece di richiederlo di nuovo
    expect(text).toContain('name: portal-replay-paths-${{ github.run_id }}');
    expect(text).toContain('uses: actions/download-artifact@v8');
  });

  it('keeps trusted base setup while running comparison semantics from the PR CLI', () => {
    const text = workflow();
    expect(text).toContain('portal_replay_cli=.portal-base/scripts/assisted-application/portal-replay.mjs');
    const replayStart = text.indexOf('Replay portal families in parallel inside this worker');
    const gateStart = text.indexOf('\n  portal-replay-gate:');
    expect(text.slice(replayStart, gateStart)).toContain('portal_replay_cli=scripts/assisted-application/portal-replay.mjs');
    expect(text).toContain('--diff-file "$RUNNER_TEMP/portal-replay-paths.txt"');
  });

  it('keeps the required gate fail-closed and comments only on uncancelled runs, once per PR', () => {
    const text = workflow();
    // a job skipped by `if` counts as success for a required check: the gate must not use `!cancelled()`
    expect(text).toMatch(/name: portal replay gate\n(?:\s*#.*\n)*\s*if: always\(\)\n\s*needs: \[detect, prepare, replay\]/u);
    expect(text).toContain("if: ${{ !cancelled() && needs.detect.outputs.run == 'true' }}");
    expect(text).not.toContain('if: always() && needs.detect.outputs.run');
    expect(text).toContain('upsertStickyComment');
    expect(text).toContain('<!-- portal-replay-gate -->');
    expect(text).toContain('portal-replay-gate-head:');
    expect(text).not.toMatch(/gh pr comment "\$PR_NUMBER"/u);
    expect(text).toContain('cancel-in-progress: false');
  });

  it('treats a cancelled run as transient for the red-check fixer and the auto-merge evaluator', () => {
    const fixer = readFileSync(new URL('../.github/workflows/pr-redcheck-fixer.yml', import.meta.url), 'utf8');
    // il fixer agisce solo su una run `tests` con conclusione `failure`: `cancelled` esce in skip
    expect(fixer).toContain('[ "$run_conclusion" != "failure" ]');
    const evaluator = readFileSync(new URL('../scripts/ci/auto-merge-eval.mjs', import.meta.url), 'utf8');
    expect(evaluator).toContain("if (conclusion !== 'success') {");
    expect(evaluator).toContain("conclusion !== 'failure'");
  });

  it('merge-commit parent diff lists only the PR paths even when main moved on', () => {
    const repo = mkdtempSync(join(tmpdir(), 'portal-replay-merge-'));
    try {
      const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
      git('init', '-q', '-b', 'main');
      writeFileSync(join(repo, 'a.txt'), 'a');
      git('add', '.'); git('commit', '-q', '-m', 'base');
      git('checkout', '-q', '-b', 'pr');
      writeFileSync(join(repo, 'pr-only.txt'), 'pr');
      git('add', '.'); git('commit', '-q', '-m', 'pr');
      git('checkout', '-q', 'main');
      writeFileSync(join(repo, 'main-only.txt'), 'main');
      git('add', '.'); git('commit', '-q', '-m', 'main moved');
      git('checkout', '-q', '-b', 'merge-ref');
      git('merge', '-q', '--no-ff', '-m', 'merge', 'pr');
      const names = git('diff', '--name-only', '--no-renames', 'HEAD^1', 'HEAD').trim().split('\n');
      expect(names).toEqual(['pr-only.txt']);
      // la forma scartata: un diff a due punti fra base corrente e head include i file di main
      const staleBase = git('diff', '--name-only', '--no-renames', 'pr', 'main').trim().split('\n').sort();
      expect(staleBase).toEqual(['main-only.txt', 'pr-only.txt']);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
