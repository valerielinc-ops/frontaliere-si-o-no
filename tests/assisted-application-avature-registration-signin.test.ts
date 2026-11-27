import { JSDOM, VirtualConsole } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { openVerifiedSignInNavigation } from '../scripts/assisted-application/lib/portal/portal.mjs';

// Synthetic page shaped like an Avature custom portal registration view: the only route back to sign-in is the
// site-header «Login» anchor (an icon with the label in a span); the content has no sign-in link at all.
const ORIGIN = 'https://careers.example.test';
const REGISTER_URL = `${ORIGIN}/ExampleCareers/Register?tempJobid=4711`;
const DEFAULT_HEADER = '<a class="nav__item__link nav__item__link--icon-only" href="https://careers.example.test/ExampleCareers/Login?tempJobid=4711"><img src="/i.svg" alt="User icon" title="Login"/><span> Login </span></a>';

function registerHtml({ header = DEFAULT_HEADER, page = 'Register', urlPath = 'ExampleCareers', bootstrap = true }: {
  header?: string; page?: string; urlPath?: string; bootstrap?: boolean;
} = {}) {
  return `<!doctype html><html><head>
    <meta name="avature.portal.id" content="23"/><meta name="avature.portal.urlPath" content="${urlPath}"/>
    <meta name="avature.portal.page" content="${page}"/></head><body>
    <header class="header"><nav>${header}</nav></header>
    <main><form><input type="password" name="a"/><input type="password" name="b"/><button type="submit">Submit</button></form></main>
    ${bootstrap ? '<portal-data id="synapserBootstrap" data-applicationName="customPortal" data-applicationCode="customPortal_23"></portal-data>' : ''}
    </body></html>`;
}

function liveFrame(html: string, url = REGISTER_URL, finalUrl?: string) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', virtualConsole: new VirtualConsole() });
  // jsdom has no layout: every element counts as rendered.
  dom.window.Element.prototype.getBoundingClientRect = () => ({ width: 10, height: 10 }) as DOMRect;
  let current = url;
  const goto = vi.fn(async (target: string) => { current = finalUrl || target; });
  const frame = {
    url: () => current,
    goto,
    evaluate: vi.fn(async (expression: string) => JSON.parse(JSON.stringify(dom.window.eval(expression) ?? null))),
    locator: vi.fn(),
  };
  const page = { url: () => current, frames: () => [frame], mainFrame: () => frame, waitForTimeout: vi.fn(async () => {}), request: { post: vi.fn() } };
  return { page, frame };
}

const createSnapshot = {
  fields: [
    { id: 'p1', inputType: 'password', frame: 0, formId: 'f1' },
    { id: 'p2', inputType: 'password', frame: 0, formId: 'f1' },
  ],
  buttons: [{ id: 'b1', frame: 0, text: 'Submit', formId: 'f1' }],
  links: [],
  dialogs: [],
};

describe('Avature registration page: sign-in through the verified header Login route', () => {
  it('navigates to the portal Login page by URL, never clicking or posting', async () => {
    const { page, frame } = liveFrame(registerHtml());
    await expect(openVerifiedSignInNavigation(page as any, createSnapshot as any)).resolves.toBe(true);
    expect(frame.goto).toHaveBeenCalledOnce();
    expect(frame.goto).toHaveBeenCalledWith(`${ORIGIN}/ExampleCareers/Login?tempJobid=4711`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    expect(frame.locator).not.toHaveBeenCalled();
    expect(page.request.post).not.toHaveBeenCalled();
  });

  it.each([
    ['German label', 'Anmelden'],
    ['French label', 'Connexion'],
    ['Italian label', 'Accedi'],
  ])('reads the control by its own name, not by the English copy: %s', async (_name, label) => {
    const header = `<a href="/ExampleCareers/Login"><span>${label}</span></a>`;
    const { page, frame } = liveFrame(registerHtml({ header }));
    await expect(openVerifiedSignInNavigation(page as any, createSnapshot as any)).resolves.toBe(true);
    expect(frame.goto).toHaveBeenCalledWith(`${ORIGIN}/ExampleCareers/Login`, expect.anything());
  });

  it('refuses an anchor whose name is account creation, even when it points at Login', async () => {
    const { page, frame } = liveFrame(registerHtml({ header: '<a href="/ExampleCareers/Login">Create profile</a>' }));
    await expect(openVerifiedSignInNavigation(page as any, createSnapshot as any)).resolves.toBe(false);
    expect(frame.goto).not.toHaveBeenCalled();
  });

  it('refuses a Login-named anchor that leads elsewhere (other path or other origin)', async () => {
    for (const href of ['/ExampleCareers/ResetPassword', '/OtherCareers/Login', 'https://evil.example/ExampleCareers/Login']) {
      const { page, frame } = liveFrame(registerHtml({ header: `<a href="${href}">Login</a>` }));
      await expect(openVerifiedSignInNavigation(page as any, createSnapshot as any)).resolves.toBe(false);
      expect(frame.goto).not.toHaveBeenCalled();
    }
  });

  it('fails closed when two different Login destinations are offered', async () => {
    const header = '<a href="/ExampleCareers/Login?tempJobid=1">Login</a><a href="/ExampleCareers/Login?tempJobid=2">Login</a>';
    const { page, frame } = liveFrame(registerHtml({ header }));
    await expect(openVerifiedSignInNavigation(page as any, createSnapshot as any)).resolves.toBe(false);
    expect(frame.goto).not.toHaveBeenCalled();
  });

  it('does nothing when the page does not attest an Avature portal', async () => {
    const { page, frame } = liveFrame(registerHtml({ bootstrap: false }));
    await expect(openVerifiedSignInNavigation(page as any, createSnapshot as any)).resolves.toBe(false);
    expect(frame.goto).not.toHaveBeenCalled();
  });

  it('does nothing away from the Register view, or when the namespace disagrees with the URL', async () => {
    const other = liveFrame(registerHtml({ page: 'Login' }), `${ORIGIN}/ExampleCareers/Login`);
    await expect(openVerifiedSignInNavigation(other.page as any, createSnapshot as any)).resolves.toBe(false);
    const mismatch = liveFrame(registerHtml({ urlPath: 'Else' }));
    await expect(openVerifiedSignInNavigation(mismatch.page as any, createSnapshot as any)).resolves.toBe(false);
    expect(other.frame.goto).not.toHaveBeenCalled();
    expect(mismatch.frame.goto).not.toHaveBeenCalled();
  });

  it('is not tried on a page that is not a create-account form', async () => {
    const { page, frame } = liveFrame(registerHtml());
    const signInOnly = { ...createSnapshot, fields: [createSnapshot.fields[0]] };
    await expect(openVerifiedSignInNavigation(page as any, signInOnly as any)).resolves.toBe(false);
    expect(frame.evaluate).not.toHaveBeenCalled();
  });

  it('reports failure when the navigation lands outside the portal Login page', async () => {
    const { page, frame } = liveFrame(registerHtml(), REGISTER_URL, 'https://evil.example/ExampleCareers/Login');
    await expect(openVerifiedSignInNavigation(page as any, createSnapshot as any)).resolves.toBe(false);
    expect(frame.goto).toHaveBeenCalledOnce();
  });
});
