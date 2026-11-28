import { describe, expect, it, vi } from 'vitest';
import { clickPortalLink } from '../scripts/assisted-application/lib/portal/portal.mjs';
import { navigationInfrastructureFailure } from '../functions/src/assistedApplicationTransportRetryPolicy.js';

const ORIGIN = 'https://careers.example-portal.test/jobs/42';
const ENTRY = 'https://apply.example-portal.test/start/42';

/** A popup whose address is about:blank until `navigateOnWait` (if any) moves it, as Chromium announces it first. */
function popup({ navigateOnWait = '' } = {}) {
  let url = 'about:blank';
  const page: any = {
    url: () => url,
    waitForURL: vi.fn(async () => { if (navigateOnWait) url = navigateOnWait; }),
    close: vi.fn(async () => {}),
  };
  return page;
}

function setup(opened: any, { href = ENTRY } = {}) {
  let url = ORIGIN;
  const page: any = { url: () => url, goto: vi.fn(async (target: string) => { url = target; }) };
  const link: any = {
    getAttribute: vi.fn(async (name: string) => (name === 'href' ? (href || null) : '_blank')),
    click: vi.fn(async () => {}),
  };
  const context: any = { waitForEvent: vi.fn(async () => opened) };
  return { page, link, context };
}

describe('a window the application entry opened that never navigated', () => {
  it('a blank popup after the full wait is closed and the link address opens once in the origin page', async () => {
    const opened = popup();
    const { page, link, context } = setup(opened);
    const adopted = await clickPortalLink(page, link, { context });
    expect(opened.waitForURL).toHaveBeenCalledTimes(1);
    expect(opened.close).toHaveBeenCalledTimes(1);
    expect(page.goto).toHaveBeenCalledTimes(1);
    expect(page.goto).toHaveBeenCalledWith(ENTRY, expect.objectContaining({ waitUntil: 'domcontentloaded' }));
    expect(adopted).toBe(page);
  });

  it('without an http(s) address it stops as navigation_unavailable, never on the empty page', async () => {
    for (const href of ['', '#', 'javascript:void(0)']) {
      const opened = popup();
      const { page, link, context } = setup(opened, { href });
      const error: any = await clickPortalLink(page, link, { context }).catch((caught) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(error.code).toBe('popup_never_navigated');
      expect(navigationInfrastructureFailure(error)).toBe(true);
      expect(opened.close).toHaveBeenCalledTimes(1);
      expect(page.goto).not.toHaveBeenCalled();
    }
  });

  it('a popup that navigates late, within the wait, is used as it is', async () => {
    const opened = popup({ navigateOnWait: ENTRY });
    const { page, link, context } = setup(opened);
    const adopted = await clickPortalLink(page, link, { context });
    expect(adopted).toBe(opened);
    expect(opened.close).not.toHaveBeenCalled();
    expect(page.goto).not.toHaveBeenCalled();
  });

  it('a relative href resolves against the origin URL captured before the click, not the one after it', async () => {
    const opened = popup();
    let url = 'https://careers.example/jobs/123';
    const page: any = { url: () => url, goto: vi.fn(async (target: string) => { url = target; }) };
    const link: any = {
      getAttribute: vi.fn(async (name: string) => (name === 'href' ? 'apply' : '_blank')),
      click: vi.fn(async () => { url = 'https://careers.example/redirect/'; }),
    };
    const context: any = { waitForEvent: vi.fn(async () => opened) };
    await clickPortalLink(page, link, { context });
    expect(page.goto).toHaveBeenCalledWith('https://careers.example/jobs/apply', expect.objectContaining({ waitUntil: 'domcontentloaded' }));
  });
});
