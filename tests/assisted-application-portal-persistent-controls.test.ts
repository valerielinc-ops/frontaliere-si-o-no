import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { extractFieldsInPage } from '../scripts/assisted-application/lib/portal/fields.mjs';
import { applicationEntryControls, dismissCookieBanner } from '../scripts/assisted-application/lib/portal/portal.mjs';

// Synthetic fixtures with the structure observed on the public pages (labels,
// landmarks, ARIA state); no candidate value, URL id or account data.

/** A JSDOM page that the runner can read and click like a Playwright page. */
function domPage(html: string, url: string, onClick: (element: Element, document: Document) => void = () => {}) {
  const { window } = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url });
  Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
    configurable: true,
    get() { return this.textContent || ''; },
  });
  window.Element.prototype.getBoundingClientRect = function rect(this: Element) {
    const size = Number(this.getAttribute('data-size') || 20);
    return { width: size, height: size, top: 0, left: 0, right: size, bottom: size, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('location', window.location);
  vi.stubGlobal('CSS', { escape: (value: string) => String(value).replace(/["\\\]]/g, '\\$&') });
  const clicked: string[] = [];
  const locator = (selector: string) => ({
    first: () => ({
      click: vi.fn(async () => {
        const element = window.document.querySelector(selector);
        if (!element) throw new Error(`missing ${selector}`);
        clicked.push((element.textContent || '').replace(/\s+/g, ' ').trim());
        onClick(element, window.document);
      }),
      evaluate: vi.fn(async () => {}),
    }),
  });
  const frame: any = {
    url: () => url,
    evaluate: vi.fn(async (fn: Function, args: unknown) => fn(args)),
    locator,
  };
  const page: any = {
    url: () => url,
    frames: () => [frame],
    mainFrame: () => frame,
    waitForTimeout: vi.fn(async () => {}),
    evaluate: vi.fn(async (fn: Function, args: unknown) => fn(args)),
    locator,
  };
  const read = () => {
    const snapshot = extractFieldsInPage({});
    return {
      ...snapshot,
      url,
      fields: snapshot.fields.map((field: any) => ({ ...field, frame: 0 })),
      buttons: snapshot.buttons.map((button: any) => ({ ...button, frame: 0 })),
    };
  };
  return { page, read, clicked };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// SBB's SuccessFactors registration page: a cookie banner region, a site
// header landmark with a permanent «Cookie-Einstellungen» link, and the form.
const successFactorsRegistration = (headerClass = 'header headermain') => `
  <div id="outershell" class="outershell">
    <div class="cookiePolicy cookiemanager" role="region">
      <div class="centered">
        <p>Wir verwenden Cookies, um die Nutzung der Website zu analysieren.</p>
        <button id="cookie-bannershow" type="button">Cookie-Einstellungen ändern</button>
        <div id="reject-accept-cookiewrapper">
          <button id="cookie-reject" type="button">Alle Cookies ablehnen</button>
          <button id="cookie-accept" type="button">Alle Cookies akzeptieren</button>
        </div>
      </div>
    </div>
    <div id="header" class="${headerClass}" role="banner">
      <div class="inner" role="navigation"><ul class="nav nav-pills" role="list">
        <li><a role="button" href="/career?view=jobs">Offene Stellen</a></li>
        <li><a role="button" href="/career">Cookie-Einstellungen</a></li>
      </ul></div>
    </div>
    <div id="rmkContent" role="main"><form id="careerform">
      <label for="email">E-Mail-Adresse: *</label><input id="email" type="text">
      <label for="email2">E-Mail-Adresse erneut eingeben: *</label><input id="email2" type="text">
      <label for="first">Vorname: *</label><input id="first" type="text">
      <label for="last">Nachname: *</label><input id="last" type="text">
      <a href="#" class="privacy">Lese und akzeptiere die Datenschutzerklärung.</a>
      <button id="create" type="button">Konto anlegen</button>
    </form></div>
  </div>`;

const removeBannerOnDecision = (element: Element, document: Document) => {
  if (/^cookie-(?:reject|accept)$/.test(element.id)) document.querySelector('.cookiePolicy')?.remove();
};

describe('persistent cookie-settings opener in the site header (SBB, ifB89NW2)', () => {
  const url = 'https://career5.successfactors.eu/career?company=synthetic&career_ns=job_application&login_ns=register';

  it('does not mark a header-landmark link as a cookie banner control', () => {
    const { read } = domPage(successFactorsRegistration(), url);
    const snapshot = read();
    const opener = snapshot.buttons.find((button: any) => button.text === 'Cookie-Einstellungen');
    expect(opener).toMatchObject({ chrome: true });
    expect(opener).not.toHaveProperty('cookieSurface');
    expect(snapshot.buttons.find((button: any) => button.text === 'Alle Cookies ablehnen')).toMatchObject({ cookieSurface: 'banner' });
  });

  it('rejects the optional cookies and treats the remaining header link as resolved', async () => {
    const { page, read, clicked } = domPage(successFactorsRegistration(), url, removeBannerOnDecision);
    const result = await dismissCookieBanner(page, read());
    expect(clicked).toEqual(['Alle Cookies ablehnen']);
    expect(result.status).toBe('dismissed');
    expect(result.snapshot.buttons.map((button: any) => button.text)).toContain('Cookie-Einstellungen');
  });

  it('keeps a site-chrome opener whose header class says banner from blocking a completed choice', async () => {
    const { page, read, clicked } = domPage(successFactorsRegistration('site-banner header'), url, removeBannerOnDecision);
    const before = read();
    expect(before.buttons.find((button: any) => button.text === 'Cookie-Einstellungen')).toMatchObject({ chrome: true, cookieSurface: 'banner' });
    const result = await dismissCookieBanner(page, before);
    expect(clicked).toEqual(['Alle Cookies ablehnen']);
    expect(result.status).toBe('dismissed');
  });

  it('still reports a banner whose decision controls survive the click', async () => {
    const { page, read, clicked } = domPage(successFactorsRegistration(), url);
    const result = await dismissCookieBanner(page, read());
    expect(clicked).toEqual(['Alle Cookies ablehnen']);
    expect(result.status).toBe('unresolved');
  });
});

// Helsana's Career Site Builder posting: the same Apply dropdown above and
// below the vacancy; its menu holds the manual entry and a LinkedIn entry.
const postingUrl = 'https://careers.helsana.ch/job/Synthetic-Role/123/';
const role = 'IT Management Assistenz (a) 80%';
const applyDropdown = (position: string, manualHref = '#') => `
  <div class="btn-group btn-social btn-social-apply">
    <button id="toggle-${position}" class="btn btn-primary dropdown-toggle" data-toggle="dropdown" aria-haspopup="true" aria-label="Jetzt bewerben">Jetzt bewerben <span class="caret"></span></button>
    <ul class="dropdown-menu socialbutton" style="display: none">
      <li role="none"><a role="menuitem" href="${manualHref}" id="applyOption-${position}-manual" class="networkContainer applyOption socialbutton-link">Jetzt bewerben</a></li>
      <li role="none"><a role="menuitem" href="#" id="applyOption-${position}-linkedin" class="networkContainer applyOption socialbutton-link">Apply with LinkedIn</a></li>
    </ul>
  </div>`;
const posting = (manualHref = '#', heading = role) => `
  <header role="banner"><a role="button" href="/profile">Profil anzeigen</a></header>
  <main><section>
    <h1>${heading}</h1>
    ${applyDropdown('top', manualHref)}
    <p>Wir freuen uns auf Ihre Online-Bewerbung!</p>
    ${applyDropdown('bottom', manualHref)}
  </section></main>`;
const openMenu = (element: Element) => {
  if (!element.classList.contains('dropdown-toggle')) return;
  element.setAttribute('aria-expanded', 'true');
  (element.parentElement?.querySelector('.dropdown-menu') as HTMLElement).style.display = 'block';
};
const entryContext = {
  postingUrl,
  applyUrl: postingUrl,
  allowSingleExternalApplicationEntry: true,
  job: { title: role, company: 'Helsana Versicherungen AG' },
};

describe('Career Site Builder Apply dropdown (Helsana, s2Tbwwjd)', () => {
  it('exposes the toggles as disclosure controls and their menu items only once opened', async () => {
    const { page, read } = domPage(posting(), postingUrl, openMenu);
    const closed = read();
    const toggles = closed.buttons.filter((button: any) => button.text === 'Jetzt bewerben');
    expect(toggles).toHaveLength(2);
    expect(toggles.every((button: any) => button.popup === true && !button.menuItem)).toBe(true);
    expect(closed.buttons.some((button: any) => button.text === 'Apply with LinkedIn')).toBe(false);

    await page.locator('#toggle-top').first().click();
    const open = read();
    const items = open.buttons.filter((button: any) => button.menuItem === true);
    expect(items.map((button: any) => button.text)).toEqual(['Jetzt bewerben', 'Apply with LinkedIn']);
  });

  it('opens the first of identical toggles, then picks the own manual entry over LinkedIn', async () => {
    const { page, read } = domPage(posting(), postingUrl, openMenu);
    const [toggle, ...others] = applicationEntryControls(read(), entryContext);
    expect(others).toEqual([]);
    expect(toggle).toMatchObject({ text: 'Jetzt bewerben', popup: true, domId: 'toggle-top' });

    await page.locator('#toggle-top').first().click();
    expect(applicationEntryControls(read(), entryContext)).toEqual([
      expect.objectContaining({ text: 'Jetzt bewerben', menuItem: true, domId: 'applyOption-top-manual' }),
    ]);
  });

  it('picks the manual menu item when it has no navigable href', async () => {
    const { page, read } = domPage(posting('javascript:void(0)'), postingUrl, openMenu);
    await page.locator('#toggle-top').first().click();
    expect(applicationEntryControls(read(), entryContext)).toEqual([
      expect.objectContaining({ text: 'Jetzt bewerben', menuItem: true, domId: 'applyOption-top-manual' }),
    ]);
  });

  it.each([
    ['an unverified posting', posting(), { ...entryContext, allowSingleExternalApplicationEntry: false }],
    ['another posting route', posting(), { ...entryContext, postingUrl: postingUrl.replace('123', '456') }],
    ['a heading naming another role', posting('#', 'Senior Data Engineer'), entryContext],
  ])('keeps the dropdown unresolved on %s', (_name, html, context) => {
    const { read } = domPage(html as string, postingUrl);
    expect(applicationEntryControls(read(), context as any)).toEqual([]);
  });

  it('does not merge toggles with different labels', () => {
    const html = posting().replace('aria-label="Jetzt bewerben">Jetzt bewerben <span', 'aria-label="Apply now">Apply now <span');
    const { read } = domPage(html, postingUrl);
    expect(applicationEntryControls(read(), entryContext)).toEqual([]);
  });

  it('does not open a social-only menu entry', async () => {
    const html = posting().replace(/<li role="none"><a role="menuitem" href="#" id="applyOption-(?:top|bottom)-manual"[^]*?<\/li>/g, '');
    const { page, read } = domPage(html, postingUrl, openMenu);
    await page.locator('#toggle-top').first().click();
    const entries = applicationEntryControls(read(), entryContext);
    expect(entries.some((control: any) => /linkedin/i.test(control.text))).toBe(false);
  });
});
