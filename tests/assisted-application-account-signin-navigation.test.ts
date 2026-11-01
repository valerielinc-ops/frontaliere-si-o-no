import { describe, expect, it, vi } from 'vitest';
import { openVerifiedSignInNavigation } from '../scripts/assisted-application/lib/portal/portal.mjs';

const HOST = 'sunrise.wd3.myworkdayjobs.com';
const CURRENT_URL = `https://${HOST}/de/registration`;

function pageWithLink({ href, label, finalUrl, visible = true, tagName = 'A', cookieOverlay = false }: {
  href?: string; label: string; finalUrl?: string; visible?: boolean; tagName?: string; cookieOverlay?: boolean;
}) {
  let url = CURRENT_URL;
  let cookieVisible = cookieOverlay;
  const goto = vi.fn(async (target: string) => { url = finalUrl || target; });
  const linkLocator = {
    first() { return this; },
    isVisible: vi.fn(async () => visible),
    click: vi.fn(async () => {}),
    innerText: vi.fn(async () => label),
    evaluate: vi.fn(async () => ({
      tagName,
      text: label,
      ariaLabel: '',
      title: '',
      labelledBy: '',
      href: href ?? null,
    })),
    getAttribute: vi.fn(async (name: string) => {
      if (name === 'href') return href ?? null;
      if (name === 'aria-label' || name === 'title') return '';
      return null;
    }),
  };
  const cookieLocator = {
    first() { return this; },
    isVisible: vi.fn(async () => cookieVisible),
    click: vi.fn(async () => { cookieVisible = false; }),
    innerText: vi.fn(async () => 'Reject all cookies'),
    evaluate: vi.fn(async () => 'BUTTON'),
    getAttribute: vi.fn(async (name: string) => name === 'href' ? null : ''),
  };
  const frame = {
    url: () => url,
    locator: vi.fn((selector: string) => selector.includes('cookie-reject') || selector.includes('data-aa-dialog-id="d1"')
      ? cookieLocator : linkLocator),
    goto,
    evaluate: vi.fn(async () => ({
      url,
      fields: [],
      buttons: cookieVisible ? [{ id: 'cookie-reject', text: 'Reject all cookies', dialog: true, frame: 0 }] : [],
      links: [{ id: 'auth-link', text: label, label: '', title: '', ariaLabel: '', frame: 0 }],
      dialogs: cookieVisible ? [{ dialog: true, dialogId: 'd1', frame: 0 }] : [],
      captcha: false,
      passwordVisible: false,
      errors: [],
      text: '',
    })),
  };
  const page = {
    url: () => url,
    frames: () => [frame],
    mainFrame: () => frame,
    waitForTimeout: vi.fn(async () => {}),
    request: { post: vi.fn() },
    evaluate: vi.fn(async () => false),
  };
  return { page, frame, locator: linkLocator, cookieLocator };
}

describe('verified sign-in navigation from an existing-account registration page', () => {
  it.each([
    ['Already have an account? Sign in to continue', '/de/login'],
    ['Jetzt anmelden', '/de/login'],
    ['Accedi al tuo account', '/it/login'],
    ['Vous avez déjà un compte ? Se connecter', '/fr/login'],
  ])('follows an explicit same-site login link without clicking or submitting a form: %s', async (label, href) => {
    const { page, frame, locator } = pageWithLink({ label, href });
    const snapshot = { dialogs: [], links: [{ id: 'auth-link', frame: 0, text: label }] };

    await expect(openVerifiedSignInNavigation(page as any, snapshot as any)).resolves.toBe(true);

    expect(frame.goto).toHaveBeenCalledOnce();
    expect(frame.goto).toHaveBeenCalledWith(`https://${HOST}${href}`, {
      waitUntil: 'domcontentloaded', timeout: 60_000,
    });
    expect(locator.click).not.toHaveBeenCalled();
    expect(page.request.post).not.toHaveBeenCalled();
  });

  it.each([
    'Create account or Sign in',
    'Create account — already registered? Sign in',
    'Continue',
    'Register now',
  ])('rejects ambiguous, creation, or generic controls: %s', async (label) => {
    const { page, frame, locator } = pageWithLink({ label, href: '/de/login' });
    const snapshot = { dialogs: [], links: [{ id: 'auth-link', frame: 0, text: label }] };

    await expect(openVerifiedSignInNavigation(page as any, snapshot as any)).resolves.toBe(false);

    expect(frame.goto).not.toHaveBeenCalled();
    expect(locator.click).not.toHaveBeenCalled();
    expect(page.request.post).not.toHaveBeenCalled();
  });

  it('rejects an external destination and a non-anchor control that only carries a fake href', async () => {
    const external = pageWithLink({ label: 'Sign in', href: 'https://evil.example/login' });
    await expect(openVerifiedSignInNavigation(external.page as any, {
      dialogs: [], links: [{ id: 'auth-link', frame: 0, text: 'Sign in' }],
    } as any)).resolves.toBe(false);
    expect(external.frame.goto).not.toHaveBeenCalled();
    expect(external.locator.click).not.toHaveBeenCalled();

    const button = pageWithLink({ label: 'Log in', href: '/de/login', tagName: 'BUTTON' });
    await expect(openVerifiedSignInNavigation(button.page as any, {
      dialogs: [], buttons: [{ id: 'auth-link', frame: 0, text: 'Log in', href: '/de/login' }],
    } as any)).resolves.toBe(false);
    expect(button.frame.goto).not.toHaveBeenCalled();
    expect(button.locator.click).not.toHaveBeenCalled();
    expect(button.page.request.post).not.toHaveBeenCalled();
  });

  it('refuses an unknown overlay and leaves its sign-in-looking link untouched', async () => {
    const { page, frame, locator } = pageWithLink({ label: 'Sign in', href: '/de/login' });
    const snapshot = {
      dialogs: [{ dialog: true, dialogId: 'd2', frame: 0 }],
      buttons: [{ id: 'auth-link', frame: 0, text: 'Accept', dialog: true, dialogId: 'd2' }],
      links: [{ id: 'auth-link', frame: 0, text: 'Sign in' }],
    };

    await expect(openVerifiedSignInNavigation(page as any, snapshot as any)).resolves.toBe(false);

    expect(frame.goto).not.toHaveBeenCalled();
    expect(locator.isVisible).not.toHaveBeenCalled();
    expect(locator.click).not.toHaveBeenCalled();
    expect(page.request.post).not.toHaveBeenCalled();
  });

  it('dismisses a known cookie banner, then uses the verified login link', async () => {
    const { page, frame, locator, cookieLocator } = pageWithLink({
      label: 'Already registered? Log in', href: '/de/login', cookieOverlay: true,
    });
    const snapshot = {
      dialogs: [{ dialog: true, dialogId: 'd1', frame: 0 }],
      buttons: [{ id: 'cookie-reject', frame: 0, text: 'Reject all cookies', dialog: true, dialogId: 'd1' }],
      links: [],
    };

    await expect(openVerifiedSignInNavigation(page as any, snapshot as any)).resolves.toBe(true);

    expect(cookieLocator.click).toHaveBeenCalledOnce();
    expect(frame.goto).toHaveBeenCalledOnce();
    expect(locator.click).not.toHaveBeenCalled();
    expect(page.request.post).not.toHaveBeenCalled();
  });

  it('stops if a same-site auth route redirects outside the verified portal family', async () => {
    const { page, frame } = pageWithLink({ label: 'Anmelden', href: '/de/login', finalUrl: 'https://evil.example/login' });
    const snapshot = { dialogs: [], links: [{ id: 'auth-link', frame: 0, text: 'Anmelden' }] };

    await expect(openVerifiedSignInNavigation(page as any, snapshot as any)).resolves.toBe(false);

    expect(frame.goto).toHaveBeenCalledOnce();
    expect(page.request.post).not.toHaveBeenCalled();
  });
});
