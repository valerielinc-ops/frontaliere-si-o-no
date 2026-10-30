import { describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ snapshot: null as any, filled: [] as any[] }));
vi.mock('../scripts/assisted-application/lib/portal/fields.mjs', async importOriginal => ({
  ...await importOriginal<any>(), extractFields: async () => state.snapshot,
}));
vi.mock('../scripts/assisted-application/lib/portal/account.mjs', async importOriginal => ({
  ...await importOriginal<any>(), authPageKind: () => 'sign_in',
}));
vi.mock('../scripts/assisted-application/lib/portal/fill.mjs', async importOriginal => ({
  ...await importOriginal<any>(), applyActions: async (_page: any, fields: any[]) => { state.filled = fields; return []; },
}));
import { verifyPortalApplication } from '../scripts/assisted-application/lib/portal/verify.mjs';

const applyUrl = 'https://careers.example/ApplicationMethods?jobId=42';
const targetUrl = 'https://careers.example/ApplicationReview?jobId=42';
const loginUrl = 'https://careers.example/Login?jobId=42';
const email = { id: 'f1', kind: 'text', inputType: 'email', label: 'Email', frame: 0 };
const password = { id: 'f2', kind: 'text', inputType: 'password', label: 'Password', frame: 0 };

describe('verification credential ownership at the frame boundary', () => {
  it.each([0, 1])('does not send credentials to duplicate field IDs in another frame (sign-in frame %s)', async signinFrame => {
    state.filled = [];
    let signedIn = false;
    let currentUrl = loginUrl;
    const login = { fields: [email, password, { ...email, frame: 1 }, { ...password, frame: 1 }],
      buttons: [{ id: 'f3', text: 'Sign in', frame: signinFrame }], passwordVisible: true, captcha: false, text: 'Sign in', errors: [] };
    const review = { fields: [], buttons: [], passwordVisible: false, captcha: false, errors: [], text: 'Please review your application.' };
    state.snapshot = login;
    const control = { evaluate: async () => ({ action: loginUrl, method: 'post', credentialsOwned: true }), click: async () => { signedIn = true; } };
    const foreignLocator = vi.fn(() => { throw new Error('foreign_frame_credential_access'); });
    const page: any = {
      url: () => currentUrl,
      frames: () => [page, { locator: foreignLocator }], mainFrame: () => page,
      locator: () => ({ first: () => control }),
      goto: async () => { currentUrl = signedIn ? targetUrl : loginUrl; state.snapshot = signedIn ? review : login; },
      waitForLoadState: async () => {}, waitForTimeout: async () => {}, evaluate: async () => state.snapshot.text,
      screenshot: async () => Buffer.from('fixture'),
    };
    const context = { route: async () => {}, routeWebSocket: async () => {}, addInitScript: async () => {}, newPage: async () => page, close: async () => {} };
    const accounts = { load: vi.fn(async () => ({ email: 'candidate@example.test', password: 'test-only-credential' })) };
    const proof = await verifyPortalApplication({ applyUrl, targetUrl, job: {}, accounts,
      launch: async () => ({ newContext: async () => context, close: async () => {} }) });
    expect(proof.conclusion).toBe('unknown');
    expect(foreignLocator).not.toHaveBeenCalled();
    if (signinFrame === 0) expect(state.filled).toEqual([email, password]);
    else { expect(state.filled).toEqual([]); expect(accounts.load).not.toHaveBeenCalled(); }
  });
});
