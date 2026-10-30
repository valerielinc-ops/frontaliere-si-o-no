import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ snapshot: null as any }));
vi.mock('../scripts/assisted-application/lib/portal/fields.mjs', async importOriginal => ({
  ...await importOriginal<any>(), extractFields: vi.fn(async () => state.snapshot), registerPortalChannelType: vi.fn(),
}));
vi.mock('../scripts/assisted-application/lib/portal/plan.mjs', async importOriginal => ({
  ...await importOriginal<any>(), planPage: vi.fn(async () => ({ actions: [], missingRequired: [] })),
}));
vi.mock('../scripts/assisted-application/lib/portal/diagnostics.mjs', async importOriginal => ({
  ...await importOriginal<any>(), startPortalDiagnostics: () => ({ data: {}, currentAttempt: () => 1, installFetchObserver: async () => {},
    beginAttempt: async () => {}, beforeSubmit: async () => {}, finalClick: () => {}, afterSubmit: async () => {}, finish: async () => {} }),
}));
import { submitViaPortal } from '../scripts/assisted-application/lib/portal/portal.mjs';

const title = 'Infrastructure Strategy Manager';
const applyUrl = 'https://careers.example/Careers/ApplicationMethods?jobId=42';
const profileUrl = 'https://careers.example/Careers/ApplicationConfirmation?jobId=42';
const reviewUrl = 'https://careers.example/Careers/ApplicationReview?jobId=42';
const receiptUrl = 'https://careers.example/Careers/ApplicationComplete?jobId=42';
const snapshot = (url: string, text: string, buttons: any[]) => ({ url, title, text: `${title}. ${text}`, fields: [], buttons, errors: [], captcha: false, passwordVisible: false });
const profile = snapshot(profileUrl, 'Since you have already submitted your personal information, the application process will be simpler.', [{ id: 'navigation', text: 'Apply', href: reviewUrl }]);
const review = snapshot(reviewUrl, 'Please review the information below. Once you have reviewed, please select Submit to finalise your application.', [{ id: 'commit', text: 'Apply' }]);
const receipt = snapshot(receiptUrl, 'Thank you for your application.', [{ text: 'My profile' }]);

function fixture(initial = profile) {
  state.snapshot = initial;
  const guard = vi.fn(async () => {
    expect(state.snapshot.url).toBe(reviewUrl);
    expect(click).not.toHaveBeenCalled();
  });
  const click = vi.fn(async () => { expect(guard).toHaveBeenCalledTimes(1); state.snapshot = receipt; });
  const page: any = {
    url: () => state.snapshot.url, title: async () => title, frames: () => [page], mainFrame: () => page,
    goto: vi.fn(async (url: string) => {
      if (url === reviewUrl) { expect(guard).not.toHaveBeenCalled(); state.snapshot = review; }
      return { status: () => 200 };
    }),
    evaluate: async (fn: Function) => String(fn).includes('navigator.userAgent') ? 'Chrome' : state.snapshot.text,
    waitForLoadState: async () => {}, waitForTimeout: async () => {}, screenshot: async () => Buffer.from('fixture'),
    locator: () => ({ count: async () => 0, first: () => ({ click }) }),
  };
  const browser = { newContext: async () => ({ route: async () => {}, newPage: async () => page, close: async () => {} }), close: async () => {}, version: () => '151' };
  const run = () => submitViaPortal({ applyUrl, job: { title }, language: 'en', candidate: { identity: {}, profile: {} }, files: {},
    codex: vi.fn(), launch: async () => browser, onBeforeSubmit: guard });
  return { run, guard, click, page };
}

beforeEach(() => vi.clearAllMocks());
describe('runner final guard across three application stages', () => {
  it('navigates profile → review without a click claim, guards the final Apply once, then confirms this job receipt', async () => {
    const f = fixture();
    const result = await f.run();
    expect(result.event).toEqual({ type: 'submit_succeeded', channel: 'portal' });
    expect(f.page.goto).toHaveBeenCalledWith(reviewUrl, { waitUntil: 'domcontentloaded' });
    expect(f.guard).toHaveBeenCalledTimes(1);
    expect(f.click).toHaveBeenCalledTimes(1);
  });

  it('does not click an account confirmation whose owned review destination is absent', async () => {
    const f = fixture({ ...profile, buttons: [{ id: 'unknown', text: 'Apply' }] });
    const result = await f.run();
    expect(result.event).toMatchObject({ type: 'submit_handoff', reason: 'application_stage_unknown' });
    expect(f.guard).not.toHaveBeenCalled();
    expect(f.click).not.toHaveBeenCalled();
  });
});
