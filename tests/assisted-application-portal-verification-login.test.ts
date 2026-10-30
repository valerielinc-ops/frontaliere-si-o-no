import { JSDOM } from 'jsdom';
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
import { COOKIE_REJECT_RE } from '../scripts/assisted-application/lib/portal/portal.mjs';
import { isVerificationCookieReject, verifyPortalApplication } from '../scripts/assisted-application/lib/portal/verify.mjs';

const applyUrl = 'https://careers.example/ApplicationMethods?jobId=42';
const targetUrl = 'https://careers.example/ApplicationReview?jobId=42';
const loginUrl = 'https://careers.example/Login?jobId=42';
const email = { id: 'f1', kind: 'text', inputType: 'email', label: 'Email', frame: 0 };
const password = { id: 'f2', kind: 'text', inputType: 'password', label: 'Password', frame: 0 };

describe('verification credential ownership at the frame boundary', () => {
  it.each([
    ['<div id="onetrust-banner-sdk"><button>Decline optional cookies</button></div>', true],
    ['<div id="onetrust-banner-sdk"><button>Decline optional\ncookies</button></div>', true],
    ['<body class="cookies-enabled"><main><button>Decline</button></main></body>', false],
    ['<body class="cookies-enabled"><main><button>Decline optional cookies</button></main></body>', false],
    ['<body id="onetrust-banner-sdk"><button>Decline optional cookies</button></body>', false],
    ['<div id="onetrust-banner-sdk"><form><button>Decline optional cookies</button></form></div>', false],
    ['<div id="onetrust-banner-sdk"><button>OK</button></div>', false],
    ['<div id="onetrust-banner-sdk"><button>Accept optional cookies</button></div>', false],
  ])('requires an actual CMP boundary and an explicit cookie rejection: %s', (html, owned) => {
    const dom = new JSDOM(html);
    expect(isVerificationCookieReject(dom.window.document.querySelector('button'), COOKIE_REJECT_RE.source)).toBe(owned);
    dom.window.close();
  });

  it.each([{ signinFrame: 0, duplicateIds: false, cookieBanner: false }, { signinFrame: 1, duplicateIds: false, cookieBanner: false }, { signinFrame: 0, duplicateIds: true, cookieBanner: false }, { signinFrame: 0, duplicateIds: false, cookieBanner: true }, { signinFrame: 0, duplicateIds: false, cookieBanner: true, cookieOwned: false }, { signinFrame: 0, duplicateIds: false, cookieBanner: true, cookieLabel: 'OK' }].map(row => ({ cookieOwned: true, cookieLabel: 'Decline optional cookies', ...row })))('does not send credentials to duplicate or foreign controls: %j', async ({ signinFrame, duplicateIds, cookieBanner, cookieOwned, cookieLabel }) => {
    state.filled = [];
    let signedIn = false;
    let currentUrl = loginUrl;
    const ownPassword = { ...password, id: duplicateIds ? email.id : password.id };
    const login = { fields: [email, ownPassword, { ...email, frame: 1 }, { ...ownPassword, frame: 1 }],
      buttons: [{ id: 'f3', text: 'Sign in', frame: signinFrame }], passwordVisible: true, captcha: false, text: 'Sign in', errors: [] };
    const review = { fields: [], buttons: [], passwordVisible: false, captcha: false, errors: [], text: 'Please review your application.' };
    if (cookieBanner) login.buttons.unshift({ id: 'cookie', text: cookieLabel, frame: 0 });
    state.snapshot = login;
    const control = { evaluate: async () => ({ action: loginUrl, method: 'post', credentialsOwned: true }), click: async () => { signedIn = true; } };
    const cookieClick = vi.fn(async () => { login.buttons = login.buttons.filter(button => button.id !== 'cookie'); });
    const cookieControl = { evaluate: async () => cookieOwned, click: cookieClick };
    const foreignLocator = vi.fn(() => { throw new Error('foreign_frame_credential_access'); });
    const page: any = {
      url: () => currentUrl,
      frames: () => [page, { locator: foreignLocator }], mainFrame: () => page,
      locator: (selector: string) => ({ first: () => selector.includes('cookie') ? cookieControl : control }),
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
    expect(cookieClick).toHaveBeenCalledTimes(cookieBanner && cookieOwned && cookieLabel !== 'OK' ? 1 : 0);
    if (signinFrame === 0 && !duplicateIds) expect(state.filled).toEqual([email, ownPassword]);
    else { expect(state.filled).toEqual([]); expect(accounts.load).not.toHaveBeenCalled(); }
  });
});
