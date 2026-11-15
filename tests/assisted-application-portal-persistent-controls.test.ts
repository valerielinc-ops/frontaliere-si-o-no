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
  selectedPostingIsApplicationUrl: true,
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

describe('review round 2 (#17902)', () => {
  it('keeps a cookie banner identified only by role="banner", but not the persistent site header', () => {
    const { read } = domPage('<div role="banner"><button type="button">Cookie-Einstellungen</button></div>', 'https://jobs.example/apply');
    expect(read().buttons.find((button: any) => button.text === 'Cookie-Einstellungen')).toMatchObject({ cookieSurface: 'banner', chrome: true });

    const header = domPage('<header role="banner"><button type="button">Cookie-Einstellungen</button></header>', 'https://jobs.example/apply');
    const opener = header.read().buttons.find((button: any) => button.text === 'Cookie-Einstellungen');
    expect(opener).toMatchObject({ chrome: true });
    expect(opener).not.toHaveProperty('cookieSurface');
  });

  it('returns an own menu item that merely names a brand, and still excludes the social sign-in', async () => {
    const html = posting()
      .replace(/id="applyOption-(top|bottom)-manual" class="networkContainer applyOption socialbutton-link">Jetzt bewerben</g,
        'id="applyOption-$1-own" class="networkContainer applyOption socialbutton-link">Apply to Google<');
    const { page, read } = domPage(html, postingUrl, openMenu);
    await page.locator('#toggle-top').first().click();
    const entries = applicationEntryControls(read(), entryContext);
    expect(entries).toEqual([expect.objectContaining({ text: 'Apply to Google', menuItem: true })]);
    expect(entries.some((control: any) => control.text === 'Apply with LinkedIn')).toBe(false);
  });

  it('keeps the posting Apply button in the snapshot after 60 opened menu items', () => {
    const items = Array.from({ length: 60 }, (_, index) => `<li role="none"><a role="menuitem" href="/topic/${index}">Thema ${index}</a></li>`).join('');
    const html = `<main><section>
      <div class="dropdown"><button class="dropdown-toggle" data-toggle="dropdown" aria-haspopup="true" aria-expanded="true">Themen</button>
        <ul class="dropdown-menu">${items}</ul></div>
      <h1>${role}</h1>
      <button id="apply" type="button">Jetzt bewerben</button>
    </section></main>`;
    const { read } = domPage(html, postingUrl);
    const snapshot = read();
    expect(snapshot.buttons.filter((button: any) => button.menuItem === true).length).toBeLessThan(60);
    const apply = snapshot.buttons.find((button: any) => button.domId === 'apply');
    expect(apply).toBeDefined();
    expect(applicationEntryControls(snapshot, { ...entryContext, job: { title: role } })).toEqual([apply]);
  });
});

describe('review round 4 (#17902)', () => {
  const siblingDropdowns = {
    adjacent: `<main><section><h1>${role}</h1><div class="actions">
      <button class="dropdown-toggle" data-toggle="dropdown" aria-haspopup="true" aria-expanded="true">Jetzt bewerben</button>
      <ul class="dropdown-menu"><li role="none"><a role="menuitem" id="apply-first" href="#">Jetzt bewerben</a></li></ul>
      <button class="dropdown-toggle" data-toggle="dropdown" aria-haspopup="true" aria-expanded="false">Jetzt bewerben</button>
      <ul class="dropdown-menu"><li role="none"><a role="menuitem" id="apply-second" href="#">Jetzt bewerben</a></li></ul>
    </div></section></main>`,
    'aria-controls': `<main><section><h1>${role}</h1><div class="actions">
      <button class="dropdown-toggle" aria-haspopup="true" aria-controls="menu-second" aria-expanded="false">Jetzt bewerben</button>
      <button class="dropdown-toggle" aria-haspopup="true" aria-controls="menu-first" aria-expanded="true">Jetzt bewerben</button>
      <ul id="menu-first" class="dropdown-menu"><li role="none"><a role="menuitem" id="apply-first" href="#">Jetzt bewerben</a></li></ul>
      <ul id="menu-second" class="dropdown-menu"><li role="none"><a role="menuitem" id="apply-second" href="#">Jetzt bewerben</a></li></ul>
    </div></section></main>`,
  };

  it.each(Object.entries(siblingDropdowns))('opens only the items of the expanded sibling dropdown (%s)', (_layout, html) => {
    const { read } = domPage(html, postingUrl);
    const snapshot = read();
    const items = snapshot.buttons.filter((button: any) => button.menuItem === true);
    expect(items.map((button: any) => button.domId)).toEqual(['apply-first']);
    expect(snapshot.buttons.some((button: any) => button.domId === 'apply-second')).toBe(false);
    expect(applicationEntryControls(snapshot, entryContext)).toEqual([items[0]]);
  });

  it('opens no item when two toggles share a container without ownership proof', () => {
    const html = `<main><section><h1>${role}</h1><div class="actions">
      <button class="dropdown-toggle" aria-haspopup="true" aria-expanded="true">Jetzt bewerben</button>
      <button class="dropdown-toggle" aria-haspopup="true" aria-expanded="false">Jetzt bewerben</button>
      <p>Optionen</p>
      <ul class="dropdown-menu"><li role="none"><a role="menuitem" id="apply-unowned" href="#">Jetzt bewerben</a></li></ul>
    </div></section></main>`;
    const { read } = domPage(html, postingUrl);
    const snapshot = read();
    expect(snapshot.buttons.some((button: any) => button.domId === 'apply-unowned')).toBe(false);
    expect(snapshot.links.some((link: any) => link.text === 'Jetzt bewerben')).toBe(false);
    expect(applicationEntryControls(snapshot, entryContext).some((control: any) => control.menuItem || control.domId === 'apply-unowned')).toBe(false);
  });
});

describe('review round 5 (#17902)', () => {
  it('does not let an unrelated expanded toggle in the same card open a separate closed menu', () => {
    const html = `<main><section><h1>${role}</h1><article class="job-card">
      <button class="dropdown-toggle" data-toggle="dropdown" aria-haspopup="true" aria-expanded="true">Teilen</button>
      <p>Stelle mit Freunden teilen</p>
      <div role="menu" aria-label="Bewerbungsoptionen"><a role="menuitem" id="apply-closed" href="#">Jetzt bewerben</a></div>
    </article></section></main>`;
    const { read } = domPage(html, postingUrl);
    const snapshot = read();
    expect(snapshot.buttons.some((button: any) => button.domId === 'apply-closed' || button.menuItem)).toBe(false);
    expect(snapshot.links.some((link: any) => link.text === 'Jetzt bewerben')).toBe(false);
    const entries = applicationEntryControls(snapshot, entryContext);
    expect(entries.some((control: any) => control.menuItem || control.domId === 'apply-closed' || control.text === 'Jetzt bewerben')).toBe(false);
  });

  it('accepts aria-controls only when exactly one toggle names the item menu', () => {
    const html = `<main><section><h1>${role}</h1><div class="actions">
      <button class="dropdown-toggle" aria-haspopup="true" aria-controls="apply-menu" aria-expanded="true">Jetzt bewerben</button>
      <button class="dropdown-toggle" aria-haspopup="true" aria-controls="apply-menu" aria-expanded="false">Jetzt bewerben</button>
      <p>Optionen</p>
      <ul id="apply-menu" role="menu"><li role="none"><a role="menuitem" id="apply-shared" href="#">Jetzt bewerben</a></li></ul>
    </div></section></main>`;
    const { read } = domPage(html, postingUrl);
    expect(read().buttons.some((button: any) => button.domId === 'apply-shared')).toBe(false);
  });
});

describe('review round 3 (#17902)', () => {
  const requisitionContext = { ...entryContext, job: { ...entryContext.job, jobId: '123' } };
  const openMenuSnapshot = (marker: string, href: string) => ({
    url: postingUrl,
    fields: [],
    buttons: [
      { id: 'toggle', text: 'Jetzt bewerben', popup: true, section: role, context: `${role} · Jetzt bewerben`, frame: 0 },
      { id: 'manual', text: 'Jetzt bewerben', menuItem: true, href, section: role, vacancyContext: `${role} · ${marker}`, frame: 0 },
      { id: 'linkedin', text: 'Apply with LinkedIn', menuItem: true, href, section: role, vacancyContext: `${role} · ${marker}`, frame: 0 },
    ],
  });

  it.each([['#-link', `${postingUrl}#`], ['script', '']])('rejects a same-title %s menu item of another requisition', (_name, href) => {
    expect(applicationEntryControls(openMenuSnapshot('Job ID 456', href), requisitionContext)).toEqual([]);
  });

  it.each([['#-link', `${postingUrl}#`], ['script', '']])('returns only the own %s menu item of the right requisition', (_name, href) => {
    const snapshot = openMenuSnapshot('Job ID 123', href);
    expect(applicationEntryControls(snapshot, requisitionContext)).toEqual([snapshot.buttons[1]]);
  });

  it('reserves the posting Apply menu item ahead of 40 earlier actions and 20 foreign menu items', () => {
    const actions = Array.from({ length: 40 }, (_, index) => `<button type="button">Aktion ${index}</button>`).join('');
    const foreign = Array.from({ length: 20 }, (_, index) => `<li role="none"><a role="menuitem" href="/topic/${index}">Thema ${index}</a></li>`).join('');
    const html = `<main><section>
      <h1>${role}</h1>
      ${actions}
      <div class="dropdown"><button class="dropdown-toggle" data-toggle="dropdown" aria-haspopup="true" aria-expanded="true">Themen</button>
        <ul class="dropdown-menu">${foreign}<li role="none"><a role="menuitem" id="apply" href="#">Jetzt bewerben</a></li></ul></div>
    </section></main>`;
    const { read } = domPage(html, postingUrl);
    const snapshot = read();
    expect(snapshot.buttons.length).toBeLessThanOrEqual(60);
    const apply = snapshot.buttons.find((button: any) => button.domId === 'apply');
    expect(apply).toMatchObject({ menuItem: true });
    expect(applicationEntryControls(snapshot, { ...entryContext, job: { title: role } })).toEqual([apply]);
  });
});
