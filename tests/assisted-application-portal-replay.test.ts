import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { installPortalReplayFence, sealPortalReplayContext } from '../scripts/assisted-application/lib/portal/replay-fence.mjs';
import {
  affectedPortalReplayPaths,
  aggregatePortalReplayGate,
  comparePortalReplayFamily,
  extractPortalStopHosts,
  sanitizePortalReplayReport,
  selectPortalReplayCorpus,
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
    addInitScript: async (script: () => void) => { context.initScript = script; },
    on: (event: string, handler: (value: any) => void) => { context.listeners[event] = handler; },
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
    expect(await runRequest(replayContext, { method: 'GET', url: 'https://careers.example.test/job/123', navigation: true })).toBe('continue');
    expect(await runRequest(replayContext, { method: 'GET', url: 'https://ats.example.test/apply?apply=guest' })).toBe('continue');
    expect(await runRequest(replayContext, { method: 'HEAD', url: 'https://ats.example.test/apply' })).toBe('continue');
    expect(await runRequest(replayContext, { method: 'OPTIONS', url: 'https://ats.example.test/apply' })).toBe('continue');

    let websocketClosed = false;
    replayContext.webSocketHandler({ close: () => { websocketClosed = true; } });
    expect(websocketClosed).toBe(true);
    expect(typeof context.initScript).toBe('function');
    const pageGlobal: Record<string, unknown> = {};
    runInNewContext(`(${context.initScript.toString()})()`, pageGlobal);
    expect(pageGlobal.Worker).toBeUndefined();
    expect(pageGlobal.SharedWorker).toBeUndefined();
    expect(pageGlobal.WebTransport).toBeUndefined();
    expect(pageGlobal.RTCPeerConnection).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(pageGlobal, 'Worker')?.writable).toBe(false);
    expect(metrics.blockedNonGet).toBe(4);
    expect(metrics.blockedMutationGets).toBe(4);
    expect(metrics.blockedWebSockets).toBe(1);
    expect(metrics.finalClickAttempts).toBe(0);
  });

  it('fails closed for a private or unresolvable host', async () => {
    const context = fakeContext();
    const metrics = await installPortalReplayFence(context, { isPublicHost: async () => false });
    expect(await runRequest(context, { method: 'GET', url: 'https://internal.example.test/job/1', navigation: true })).toBe('abort');
    expect(metrics.blockedUnsafeHosts).toBe(1);
  });

  it('starts both runners at the selected listing and prevents later route.fetch handlers', async () => {
    const context: any = {
      route: async () => { context.registeredRoutes += 1; },
      newPage: async () => ({
        goto: async (url: string) => { context.navigations.push(url); return url; },
      }),
      registeredRoutes: 0,
      navigations: [] as string[],
    };
    const replayContext = sealPortalReplayContext(context, { firstNavigationUrl: 'https://listing.example.test/job/fake' });
    const page = await replayContext.newPage();
    await page.goto('https://ats.example.test/apply');
    await page.goto('https://ats.example.test/login');
    await replayContext.route('**/*', async () => {});

    expect(context.navigations).toEqual([
      'https://listing.example.test/job/fake',
      'https://ats.example.test/login',
    ]);
    expect(context.registeredRoutes).toBe(0);
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
      'diff --git a/packages/portal-runner/index.mjs b/packages/portal-runner/index.mjs',
      'diff --git a/package-lock.json b/package-lock.json',
      'diff --git a/services/router.ts b/services/router.ts',
    ].join('\n');
    expect(affectedPortalReplayPaths(diff)).toEqual([
      'functions/src/assistedApplicationAnswerEvidence.js',
      'functions/src/lib/permitStatus.js',
      'package-lock.json',
      'packages/portal-runner/index.mjs',
      'scripts/assisted-application/agent.mjs',
      'scripts/assisted-application/lib/liveness.mjs',
      'scripts/assisted-application/lib/portal/agent.mjs',
      'scripts/assisted-application/lib/portal/removed.mjs',
      'scripts/lib/ai-models.mjs',
    ]);
    expect(affectedPortalReplayPaths('scripts/assisted-application/lib/submit.mjs\nservices/router.ts')).toEqual([
      'scripts/assisted-application/lib/submit.mjs',
    ]);
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
