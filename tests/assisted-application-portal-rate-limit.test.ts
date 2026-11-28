import { describe, expect, it, vi } from 'vitest';

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({ getRemoteConfigValue: vi.fn(async () => '') }));

const { transition } = await import('../functions/src/assistedApplicationFlow.js');
const { RATE_LIMIT_AUTO_RETRY_DELAYS_MS, autoRetryDelaysForFlow, isAutoRetryablePortalHold, portalRetryDueAt } = await import('../functions/src/assistedApplicationPortalRetryPolicy.js');
const { portalStopContract } = await import('../functions/src/lib/portalStopCodes.js');
const { RETRY_AFTER_MAX_MS, clampRetryAfterMs, isRateLimitStatus, parseRetryAfterMs } = await import('../functions/src/lib/retryAfter.js');
const { classifyLiveness } = await import('../functions/src/assistedApplicationLiveness.js');
const portalModule = await import('../scripts/assisted-application/lib/portal/portal.mjs');
const { portalRateLimitOf } = portalModule;
const { startPortalDiagnostics } = await import('../scripts/assisted-application/lib/portal/diagnostics.mjs');

const T0 = Date.UTC(2026, 10, 28, 5, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const draft = { verdict: 'good', job: { source: 'job_detail' }, channel: { type: 'portal' }, factCheck: { ok: true, unsupported: [] }, questions: [], status: 'ready', round: 1 };
const dispatch = { mode: 'submit', round: 1, requestedAt: T0, attempts: 1 };
const submitting = (extra = {}) => ({ state: 'submitting', round: 1, dispatch, ...extra });
const limited = (flow: any, event: any = {}, nowMs = T0) => transition(flow, { type: 'submit_handoff', round: 1, reason: 'portal_rate_limited', ...event }, { draft, nowMs });

describe('Retry-After and the rate-limit status', () => {
  it('reads seconds and dates, bounded to a day, and nothing else', () => {
    expect(parseRetryAfterMs('120', T0)).toBe(120_000);
    expect(parseRetryAfterMs(new Date(T0 + 90 * MIN).toUTCString(), T0)).toBe(90 * MIN);
    expect(parseRetryAfterMs('999999999', T0)).toBe(RETRY_AFTER_MAX_MS);
    expect(parseRetryAfterMs(new Date(T0 - HOUR).toUTCString(), T0)).toBe(0);
    for (const bad of ['', 'soon', '-5', undefined, null]) expect(parseRetryAfterMs(bad as any, T0)).toBe(0);
    expect(clampRetryAfterMs(5 * HOUR)).toBe(5 * HOUR);
    expect(clampRetryAfterMs(-1)).toBe(0);
    expect(clampRetryAfterMs(10 * RETRY_AFTER_MAX_MS)).toBe(RETRY_AFTER_MAX_MS);
  });

  it('is a rate limit for 429, and for 503 only when the site says when to come back', () => {
    expect(isRateLimitStatus(429)).toBe(true);
    expect(isRateLimitStatus(503, 60_000)).toBe(true);
    expect(isRateLimitStatus(503)).toBe(false);
    // The header's presence counts, not its delay: `Retry-After: 0` or a past date still says the site is limiting us.
    expect(isRateLimitStatus(503, '0')).toBe(true);
    expect(isRateLimitStatus(503, new Date(T0 - HOUR).toUTCString())).toBe(true);
    expect(isRateLimitStatus(503, '')).toBe(false);
    expect(isRateLimitStatus(503, 'soon')).toBe(false);
    expect(isRateLimitStatus(403)).toBe(false);
    expect(isRateLimitStatus(200)).toBe(false);
  });

  it('marks the posting page that answered 429 without changing its liveness code', () => {
    expect(classifyLiveness({ status: 429, retryAfter: '600' })).toMatchObject({ result: 'uncertain', code: 'access_blocked', httpStatus: 429, rateLimited: true, retryAfterMs: 600_000 });
    expect(classifyLiveness({ status: 503, retryAfter: '30' })).toMatchObject({ code: 'access_blocked', rateLimited: true, retryAfterMs: 30_000 });
    expect(classifyLiveness({ status: 503, retryAfter: '0' })).toMatchObject({ code: 'access_blocked', httpStatus: 503, rateLimited: true });
    expect(classifyLiveness({ status: 503 })).toEqual({ result: 'uncertain', code: 'access_blocked', reason: 'HTTP 503' });
    expect(classifyLiveness({ status: 403 })).toEqual({ result: 'uncertain', code: 'access_blocked', reason: 'HTTP 403' });
  });
});

describe('the runner stops on a rate-limited main document', () => {
  const response = (status: number, headers: Record<string, string> = {}) => ({ status: () => status, headers: () => headers });
  it('reads a 429 or a 503 with Retry-After from the response, nothing else', () => {
    expect(portalRateLimitOf(response(429))).toEqual({ retryAfterMs: 0 });
    expect(portalRateLimitOf(response(429, { 'retry-after': '1800' }))).toEqual({ retryAfterMs: 1_800_000 });
    expect(portalRateLimitOf(response(503, { 'retry-after': '60' }))).toEqual({ retryAfterMs: 60_000 });
    expect(portalRateLimitOf(response(503, { 'retry-after': '0' }))).toEqual({ retryAfterMs: 0 });
    expect(portalRateLimitOf(response(503))).toBeNull();
    expect(portalRateLimitOf(response(200))).toBeNull();
    expect(portalRateLimitOf(response(404))).toBeNull();
    expect(portalRateLimitOf(null)).toBeNull();
  });

  const fakeContext = () => {
    const handlers = new Map<string, Array<(value: any) => void>>();
    return {
      pages: () => [],
      on: (event: string, handler: (value: any) => void) => { handlers.set(event, [...(handlers.get(event) || []), handler]); },
      off: () => {},
      emit: (event: string, value: any) => (handlers.get(event) || []).forEach((handler) => handler(value)),
    };
  };
  const documentResponse = (status: number, url: string, headers: Record<string, string> = {}, { main = true, type = 'document' } = {}) => ({
    status: () => status, url: () => url, headers: () => headers,
    request: () => ({ resourceType: () => type, isNavigationRequest: () => type === 'document', frame: () => ({ parentFrame: () => (main ? null : {}) }), method: () => 'GET', url: () => url }),
  });

  it('records the limit of a main document until a later main document loads', () => {
    const context = fakeContext();
    const diagnostics = startPortalDiagnostics(context as any);
    context.emit('response', documentResponse(429, 'https://www.example-agency.test/stellen/job-1/', { 'retry-after': '900' }));
    expect(diagnostics.data.rateLimit).toMatchObject({ host: 'www.example-agency.test', status: 429, retryAfterMs: 900_000 });
    // A sub-frame or a script that answers 429 does not make the page rate limited.
    context.emit('response', documentResponse(200, 'https://www.example-agency.test/x', {}, { main: false }));
    context.emit('response', documentResponse(429, 'https://www.example-agency.test/a.js', {}, { type: 'script' }));
    expect(diagnostics.data.rateLimit).toBeDefined();
    context.emit('response', documentResponse(200, 'https://www.example-agency.test/stellen/job-1/'));
    expect(diagnostics.data.rateLimit).toBeUndefined();
    context.emit('response', documentResponse(503, 'https://www.example-agency.test/stellen/job-1/'));
    expect(diagnostics.data.rateLimit).toBeUndefined();
  });

  it('forgets the limit when a later main document answers with another error: a 429 then a 404 is a 404', () => {
    for (const later of [404, 500, 502, 410, 403]) {
      const context = fakeContext();
      const diagnostics = startPortalDiagnostics(context as any);
      context.emit('response', documentResponse(429, 'https://www.example-agency.test/stellen/job-1/'));
      expect(diagnostics.data.rateLimit).toBeDefined();
      context.emit('response', documentResponse(later, 'https://www.example-agency.test/stellen/job-2/'));
      expect(diagnostics.data.rateLimit).toBeUndefined();
    }
    const context = fakeContext();
    const diagnostics = startPortalDiagnostics(context as any);
    context.emit('response', documentResponse(503, 'https://www.example-agency.test/a/', { 'retry-after': '0' }));
    expect(diagnostics.data.rateLimit).toMatchObject({ status: 503 });
    context.emit('response', documentResponse(429, 'https://www.example-agency.test/b/', { 'retry-after': '60' }));
    expect(diagnostics.data.rateLimit).toMatchObject({ status: 429, retryAfterMs: 60_000 });
  });
});

describe('the stop contract', () => {
  it('is a transient, automatically retried stop on its own lane', () => {
    expect(portalStopContract('portal:portal_rate_limited')).toMatchObject({ known: true, retryLane: 'rate_limit', automaticRetry: true, sourceRecovery: false });
    expect(isAutoRetryablePortalHold({ heldBy: ['portal:portal_rate_limited'] })).toBe(true);
    expect(autoRetryDelaysForFlow({ heldBy: ['portal:portal_rate_limited'] })).toEqual([30 * MIN, 2 * HOUR, 6 * HOUR]);
    // Not a block of the runner: it never marks the order for the Swiss runner.
    const held = limited(submitting());
    expect(held.flow.egress).toBeUndefined();
  });
});

describe('the retry ladder of a rate-limited portal', () => {
  it('holds the order with the scheduled retry, nothing sent, no e-mail to the owner', () => {
    const held = limited(submitting());
    expect(held.flow).toMatchObject({ state: 'owner_takeover', heldBy: ['portal:portal_rate_limited'], portalAutoRetryAt: T0 + 30 * MIN });
    expect(held.effects).toEqual([]);
    expect(portalRetryDueAt(held.flow)).toBe(T0 + 30 * MIN);
  });

  it('a 503 with Retry-After: 0 still waits the first step of 30 minutes', () => {
    expect(limited(submitting(), { retryAfterMs: 0 }).flow.portalAutoRetryAt).toBe(T0 + 30 * MIN);
  });

  it('waits at least the Retry-After of the site, never less than the step, never more than a day', () => {
    expect(limited(submitting(), { retryAfterMs: 3 * HOUR }).flow.portalAutoRetryAt).toBe(T0 + 3 * HOUR);
    expect(limited(submitting(), { retryAfterMs: 5 * MIN }).flow.portalAutoRetryAt).toBe(T0 + 30 * MIN);
    expect(limited(submitting(), { retryAfterMs: 10 * RETRY_AFTER_MAX_MS }).flow.portalAutoRetryAt).toBe(T0 + RETRY_AFTER_MAX_MS);
  });

  it('retries three times at 30 min, 2 h and 6 h, and the fourth consecutive 429 is the owner\'s', () => {
    const steps: number[] = [];
    let flow: any = submitting();
    let at = T0;
    for (let round = 0; round < RATE_LIMIT_AUTO_RETRY_DELAYS_MS.length; round += 1) {
      const held = limited(flow, {}, at);
      steps.push(held.flow.portalAutoRetryAt - at);
      expect(held.effects).toEqual([]);
      // Not before it is due: nothing is dispatched twice.
      expect(transition(held.flow, { type: 'portal_auto_retry' }, { draft, nowMs: held.flow.portalAutoRetryAt - 1 }).ignored).toBe('portal_retry_not_due');
      at = held.flow.portalAutoRetryAt;
      const retry = transition({ ...held.flow, dispatch }, { type: 'portal_auto_retry' }, { draft, nowMs: at });
      expect(retry.flow).toMatchObject({ state: 'submitting', portalRateLimitRetryCount: round + 1 });
      expect(retry.effects).toEqual([{ type: 'dispatch', mode: 'submit', reason: 'portal_auto_retry' }]);
      // The same due retry is not run twice: the flow is already submitting.
      expect(transition(retry.flow, { type: 'portal_auto_retry' }, { draft, nowMs: at }).ignored).toBe('not_taken_over');
      flow = { ...retry.flow, dispatch };
    }
    expect(steps).toEqual([30 * MIN, 2 * HOUR, 6 * HOUR]);
    const fourth = limited(flow, {}, at);
    expect(fourth.flow).toMatchObject({ state: 'owner_takeover', heldBy: ['portal:portal_rate_limited'], portalAutoRetryAt: null });
    expect(fourth.effects).toEqual([{ type: 'email', kind: 'owner_takeover', reason: 'portal:portal_rate_limited', stage: 'submit', attempts: 1 }]);
    expect(portalRetryDueAt(fourth.flow)).toBeNull();
    expect(transition({ ...fourth.flow }, { type: 'portal_auto_retry' }, { draft, nowMs: at + 24 * HOUR }).ignored).toMatch(/portal_retry_not_due|portal_retry_limit|not_auto_retryable/);
  });

  it('counts consecutive 429s only: another stop starts the count again, and so does the owner\'s retry', () => {
    const afterTwo = limited({ ...submitting(), portalRateLimitRetryCount: 2 });
    expect(afterTwo.flow.portalAutoRetryAt).toBe(T0 + 6 * HOUR);
    const other = transition({ ...submitting(), portalRateLimitRetryCount: 2 }, { type: 'submit_handoff', round: 1, reason: 'posting_mismatch' }, { draft, nowMs: T0 });
    expect(other.flow.portalRateLimitRetryCount).toBe(0);
    const exhausted = limited({ ...submitting(), portalRateLimitRetryCount: 3 }).flow;
    const ownerRetry = transition({ ...exhausted, dispatch }, { type: 'owner_retry_submit', round: 1, confirmedNotSent: true }, { draft, nowMs: T0 });
    expect(ownerRetry.ignored).toBeUndefined();
    expect(ownerRetry.flow.portalRateLimitRetryCount).toBe(0);
  });
});

describe('submitViaPortal on a rate-limited entry page', () => {
  const { submitViaPortal } = portalModule;
  const applyUrl = 'https://www.example-agency.test/stellen/metallbauer-1/';
  const run = async (status: number, headers: Record<string, string>) => {
    const goto = vi.fn(async () => ({ status: () => status, headers: () => headers }));
    const search = vi.fn();
    const page: any = {
      url: () => applyUrl, title: async () => '', frames: () => [page], mainFrame: () => page, goto,
      evaluate: async (fn: Function) => (String(fn).includes('navigator.userAgent') ? 'Chrome' : ''),
      waitForLoadState: async () => {}, waitForTimeout: async () => {}, screenshot: async () => Buffer.from('fixture'),
      locator: search, getByRole: search, on: () => {}, off: () => {},
    };
    const context: any = {
      route: async () => {}, waitForEvent: async () => null, newPage: async () => page, close: async () => {},
      pages: () => [page], on: () => {}, off: () => {}, addInitScript: async () => {}, cookies: async () => [], addCookies: async () => {},
    };
    const browser = { newContext: async () => context, close: async () => {}, version: () => '151' };
    const guard = vi.fn();
    const result = await submitViaPortal({
      applyUrl, job: { title: 'Metallbauer', company: 'STA Personal AG' }, language: 'de', candidate: { identity: {}, profile: {} }, files: {},
      skipPostingCheck: true, maxSteps: 2, codex: vi.fn(), launch: async () => browser, onBeforeSubmit: guard,
    });
    return { result, goto, search, guard };
  };

  it('stops at once with the rate-limit cause and the site\'s Retry-After: no search, no second goto, nothing sent', async () => {
    const { result, goto, search, guard } = await run(429, { 'retry-after': '900' });
    expect(result.event).toMatchObject({ type: 'submit_handoff', reason: 'portal_rate_limited', retryAfterMs: 900_000 });
    expect(goto).toHaveBeenCalledTimes(1);
    expect(search).not.toHaveBeenCalled();
    expect(guard).not.toHaveBeenCalled();
    // A rate limit is no code fix: no stop report for the fixer.
    expect(result.evidence.stopReport).toBeUndefined();
  });

  it('stops on a 429 without Retry-After, with no delay of its own for the ladder to lengthen', async () => {
    const { result } = await run(429, {});
    expect(result.event).toMatchObject({ type: 'submit_handoff', reason: 'portal_rate_limited' });
    expect((result.event as any).retryAfterMs).toBeUndefined();
  });
});

describe('what the owner reads about a rate-limited portal', () => {
  it('says nothing was sent, when the robot comes back, and what the fourth limit means', async () => {
    const { buildOwnerAutomationEmail } = await import('../functions/src/assistedApplicationAutomationEmails.js');
    const waiting = buildOwnerAutomationEmail('owner_takeover', { job: 'Metallbauer', company: 'STA Personal AG', orderId: 'o', reason: 'portal:portal_rate_limited', stage: 'submit', attempts: 1, portalAutoRetryAt: T0 + 30 * MIN });
    expect(waiting.subject).toMatch(/Nuovo tentativo automatico/);
    expect(waiting.text).toMatch(/troppe richieste/);
    expect(waiting.text).toMatch(/non è partito nulla/);
    const handedOver = buildOwnerAutomationEmail('owner_takeover', { job: 'Metallbauer', company: 'STA Personal AG', orderId: 'o', reason: 'portal:portal_rate_limited', stage: 'submit', attempts: 1 });
    expect(handedOver.subject).toMatch(/Presa in carico necessaria/);
    expect(handedOver.text).toMatch(/HTTP 429/);
  });
});
