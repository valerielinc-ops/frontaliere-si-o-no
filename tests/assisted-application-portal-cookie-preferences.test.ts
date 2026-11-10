import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { extractFieldsInPage } from '../scripts/assisted-application/lib/portal/fields.mjs';
import {
  COOKIE_AGENT_RESERVED_BUTTONS,
  COOKIE_SAVE_RE,
  dismissCookieBanner,
  resolveCookieConsent,
} from '../scripts/assisted-application/lib/portal/portal.mjs';
import { HINTS, refusal } from '../scripts/assisted-application/lib/portal/agent.mjs';

// Synthetic fixtures rebuilt from the structure of the public pages (CMP
// markup, labels, ARIA state). No candidate value, no account data, no person.

type Frame = { window: any; url: string };

/** Every element matching the selector, in the document and in its open shadow roots (like a Playwright locator). */
function deepQuery(document: Document, selector: string): Element | null {
  const roots: Array<Document | ShadowRoot> = [document];
  for (let index = 0; index < roots.length; index += 1) {
    const found = roots[index].querySelector(selector);
    if (found) return found;
    for (const element of roots[index].querySelectorAll('*')) if ((element as any).shadowRoot) roots.push((element as any).shadowRoot);
  }
  return null;
}

/** A page of one or more JSDOM frames the runner can read and click like a Playwright page. */
function domPage(htmlByFrame: string[], url: string, onClick: (element: Element, frame: number) => void = () => {}) {
  const frames: Frame[] = htmlByFrame.map((html, index) => {
    const frameUrl = index === 0 ? url : `${new URL(url).origin}/consent-frame-${index}`;
    const { window } = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: frameUrl });
    Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
      configurable: true,
      get() { return this.textContent || ''; },
    });
    window.Element.prototype.getBoundingClientRect = function rect(this: Element) {
      const size = Number(this.getAttribute('data-size') || 20);
      return { width: size, height: size, top: 0, left: 0, right: size, bottom: size, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    };
    return { window, url: frameUrl };
  });
  const enter = (index: number) => {
    const { window } = frames[index];
    vi.stubGlobal('window', window);
    vi.stubGlobal('document', window.document);
    vi.stubGlobal('location', window.location);
    vi.stubGlobal('getComputedStyle', window.getComputedStyle.bind(window));
    vi.stubGlobal('CSS', { escape: (value: string) => String(value).replace(/["\\\]]/g, '\\$&') });
  };
  enter(0);
  const clicked: string[] = [];
  const inFrame = async <T>(index: number, run: () => T): Promise<T> => {
    enter(index);
    try {
      return run();
    } finally {
      enter(0);
    }
  };
  const locatorIn = (index: number) => (selector: string) => ({
    innerText: vi.fn(async () => {
      const element = deepQuery(frames[index].window.document, selector);
      if (!element) throw new Error(`missing ${selector}`);
      return (element.textContent || '').replace(/\s+/g, ' ').trim();
    }),
    first: () => ({
      click: vi.fn(async () => {
        const element = deepQuery(frames[index].window.document, selector);
        if (!element) throw new Error(`missing ${selector}`);
        clicked.push((element.textContent || '').replace(/\s+/g, ' ').trim());
        await inFrame(index, () => onClick(element, index));
      }),
      evaluate: vi.fn(async (fn: (element: Element) => unknown) => {
        const element = deepQuery(frames[index].window.document, selector);
        if (element) await inFrame(index, () => fn(element));
      }),
    }),
  });
  const frameAdapters: any[] = frames.map((frame, index) => ({
    url: () => frame.url,
    evaluate: vi.fn(async (fn: Function, args: unknown) => inFrame(index, () => fn(args))),
    locator: locatorIn(index),
  }));
  const page: any = {
    url: () => url,
    frames: () => frameAdapters,
    mainFrame: () => frameAdapters[0],
    waitForTimeout: vi.fn(async () => {}),
    evaluate: vi.fn(async (fn: Function, args: unknown) => inFrame(0, () => fn(args))),
    locator: locatorIn(0),
  };
  const read = () => {
    const merged: any = { url, fields: [], buttons: [], links: [], dialogs: [], errors: [], text: '' };
    frames.forEach((_frame, index) => {
      enter(index);
      const snapshot = extractFieldsInPage({});
      if (index === 0) merged.text = snapshot.text;
      merged.fields.push(...snapshot.fields.map((field: any) => ({ ...field, frame: index })));
      merged.buttons.push(...snapshot.buttons.map((button: any) => ({ ...button, frame: index })));
      merged.links.push(...(snapshot.links || []).map((link: any) => ({ ...link, frame: index })));
      merged.dialogs.push(...(snapshot.dialogs || []).map((dialog: any) => ({ ...dialog, frame: index })));
    });
    enter(0);
    return merged;
  };
  const doc = (index = 0) => frames[index].window.document as Document;
  return { page, read, clicked, doc };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// Complianz as served on the Yellowshark posting of order 1EpmkrDu (run of
// 2026-11-10): an aria-modal banner with «Alle akzeptieren», «Ablehnen»,
// «Einstellungen anzeigen» and a hidden «Einstellungen speichern»; after any
// choice the banner gets `cmplz-dismissed` and the floating «Manage consent»
// tab (aria-controls → the banner) appears. The posting keeps its Apply.
const complianzPosting = ({ bannerVisible = true, tabVisible = false } = {}) => `
  <header class="site-header"><nav><a href="/jobs">Job suchen</a></nav></header>
  <main>
    <h1>Synthetic Role</h1>
    <a class="btn apply" href="#apply" role="button">JETZT BEWERBEN</a>
    <p>Stellenbeschreibung ohne Personendaten.</p>
  </main>
  <div id="cmplz-cookiebanner-container">
    <div id="cmplz-cookiebanner-1-optin" class="cmplz-cookiebanner banner-1 optin cmplz-bottom-right ${bannerVisible ? 'cmplz-show' : 'cmplz-dismissed'}"
      aria-modal="true" role="dialog" aria-labelledby="cmplz-header-1-optin" ${bannerVisible ? '' : 'style="display:none"'}>
      <div class="cmplz-header"><div class="cmplz-title" id="cmplz-header-1-optin">Cookie-Einwilligung</div>
        <div class="cmplz-close" tabindex="0" role="button" aria-label="Dialog schliessen"></div></div>
      <div class="cmplz-body"><div class="cmplz-message">Um das beste Erlebnis zu bieten, verwenden wir Technologien wie Cookies, um Geräteinformationen zu speichern und/oder darauf zuzugreifen.</div>
        <div class="cmplz-categories" style="display:none">
          <div class="cmplz-category cmplz-functional"><span class="cmplz-category-title">Funktional</span>
            <span class="cmplz-always-active"><input type="checkbox" id="cmplz-functional-optin" checked> Immer aktiv</span></div>
          <div class="cmplz-category cmplz-statistics"><span class="cmplz-category-title">Statistiken</span>
            <input type="checkbox" id="cmplz-statistics-optin"></div>
        </div>
      </div>
      <div class="cmplz-buttons">
        <button class="cmplz-btn cmplz-accept">Alle akzeptieren</button>
        <button class="cmplz-btn cmplz-deny">Ablehnen</button>
        <button class="cmplz-btn cmplz-view-preferences">Einstellungen anzeigen</button>
        <button class="cmplz-btn cmplz-save-preferences" style="display:none">Einstellungen speichern</button>
      </div>
    </div>
  </div>
  <div id="cmplz-manage-consent" data-nosnippet="true">
    <button class="cmplz-btn cmplz-manage-consent manage-consent-1" aria-haspopup="dialog" aria-controls="cmplz-cookiebanner-1-optin"
      ${tabVisible ? '' : 'style="display:none"'}>Manage consent</button>
  </div>`;

/** Complianz's own behaviour: a choice hides the banner and shows the tab; the tab shows the banner again. */
const complianzClick = (element: Element) => {
  const document = element.ownerDocument;
  const banner = document.getElementById('cmplz-cookiebanner-1-optin')!;
  const tab = document.querySelector('.cmplz-manage-consent') as HTMLElement;
  if (element.matches('.cmplz-accept, .cmplz-deny, .cmplz-save-preferences')) {
    banner.setAttribute('style', 'display:none');
    banner.classList.replace('cmplz-show', 'cmplz-dismissed');
    tab.removeAttribute('style');
  } else if (element === tab) {
    banner.removeAttribute('style');
    banner.classList.replace('cmplz-dismissed', 'cmplz-show');
  }
};

describe('Complianz consent on a job posting (order 1EpmkrDu)', () => {
  const url = 'https://jobs.yellowshark.com/job/synthetic/';

  it('refuses the optional cookies and takes the collapsed «Manage consent» tab as the persistent opener', async () => {
    const { page, read, clicked } = domPage([complianzPosting()], url, complianzClick);
    const result = await dismissCookieBanner(page, read());
    expect(clicked).toEqual(['Ablehnen']);
    expect(result.status).toBe('dismissed');
    // The stop report of the run showed exactly this page: the Apply and the tab.
    expect(result.snapshot.buttons.map((button: any) => button.text)).toEqual(expect.arrayContaining(['JETZT BEWERBEN', 'Manage consent']));
  });

  it('does not reopen the collapsed tab on the next hop of the same posting', async () => {
    const { page, read, clicked } = domPage([complianzPosting({ bannerVisible: false, tabVisible: true })], url, complianzClick);
    const result = await dismissCookieBanner(page, read());
    expect(clicked).toEqual([]);
    expect(result.status).toBe('none');
  });

  it('reads the same structure on any host: the rule is the tab’s ARIA state, not the portal', async () => {
    const generic = 'https://careers.example-employer.test/job/synthetic/';
    // Another CMP's floating opener: a «cookie notice» tab with a cookie word in its label.
    const html = complianzPosting()
      .replace('<div id="cmplz-manage-consent" data-nosnippet="true">', '<div id="consent-tab" class="cookie-notice-tab">')
      .replace('>Manage consent<', '>Cookie-Einstellungen<');
    const { page, read, clicked } = domPage([html], generic, (element) => {
      if (element.matches('.cmplz-deny')) complianzClick(element);
    });
    const result = await dismissCookieBanner(page, read());
    expect(clicked).toEqual(['Ablehnen']);
    expect(result.status).toBe('dismissed');
  });

  it('keeps the page unresolved when the tab stays expanded over a banner that did not close', async () => {
    const { page, read, clicked } = domPage([complianzPosting()], url, (element) => {
      // The decision is ignored: the banner stays and the tab says it is expanded.
      if (element.matches('.cmplz-deny')) {
        const tab = element.ownerDocument.querySelector('.cmplz-manage-consent')!;
        tab.removeAttribute('style');
        tab.setAttribute('aria-expanded', 'true');
      }
    });
    const result = await dismissCookieBanner(page, read());
    expect(clicked).toEqual(['Ablehnen']);
    expect(result.status).toBe('unresolved');
    expect(clicked).not.toContain('JETZT BEWERBEN');
  });
});

// A preference centre that opens instead of the banner: category switches,
// «Einstellungen speichern» and «Alle akzeptieren», no reject control.
const preferenceCentre = `
  <main><button type="button">Jetzt bewerben</button></main>
  <div id="consent-preferences" class="cookie-preferences-modal" role="dialog" aria-modal="true">
    <h2>Cookie-Einstellungen</h2>
    <p>Wir verwenden Cookies. Wählen Sie, welche Kategorien Sie erlauben.</p>
    <div class="category"><label for="c-necessary">Notwendige Cookies</label><input id="c-necessary" type="checkbox" checked disabled></div>
    <div class="category"><label for="c-stats">Statistik</label><input id="c-stats" type="checkbox" checked>
      <p>Die technische Speicherung ist für statistische Zwecke notwendig.</p></div>
    <div class="category"><span>Marketing</span><button id="c-marketing" role="switch" aria-checked="true">Marketing erlauben</button></div>
    <button type="button" id="save">Einstellungen speichern</button>
    <button type="button" id="all">Alle akzeptieren</button>
  </div>`;

describe('cookie preference centre without a reject control', () => {
  const url = 'https://jobs.example-employer.test/stelle/synthetic';

  it('withdraws every optional category, then saves: necessary cookies only', async () => {
    const { page, read, clicked, doc } = domPage([preferenceCentre], url, (element) => {
      if (element.id === 'save' || element.id === 'all') element.closest('[role="dialog"]')?.remove();
    });
    const document = doc();
    document.getElementById('c-marketing')!.addEventListener('click', (event) => {
      const target = event.currentTarget as Element;
      target.setAttribute('aria-checked', target.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
    });
    const stats = document.getElementById('c-stats') as HTMLInputElement;
    const necessary = document.getElementById('c-necessary') as HTMLInputElement;
    const marketing = document.getElementById('c-marketing')!;
    const result = await dismissCookieBanner(page, read());
    expect(clicked).toEqual(['Einstellungen speichern']);
    expect(result.status).toBe('dismissed');
    // The optional categories were withdrawn before the save; the necessary one stays as the manager keeps it.
    expect({ stats: stats.checked, necessary: necessary.checked, marketing: marketing.getAttribute('aria-checked') })
      .toEqual({ stats: false, necessary: true, marketing: 'false' });
    expect(clicked).not.toContain('Alle akzeptieren');
  });

  it('accepts all cookies only when no other choice closes the manager', async () => {
    const html = `<div class="cookie-banner" role="dialog"><p>Diese Website verwendet Cookies.</p><button id="all">Alle akzeptieren</button></div>`;
    const { page, read, clicked } = domPage([html], url, (element) => element.closest('[role="dialog"]')?.remove());
    const result = await dismissCookieBanner(page, read());
    expect(clicked).toEqual(['Alle akzeptieren']);
    expect(result.status).toBe('dismissed');
  });

  it('never presses a «save selection» control of an application dialog without cookie copy', async () => {
    const html = `
      <div role="dialog" aria-modal="true"><h2>Standorte</h2><p>Bitte wählen Sie die Standorte für Ihre Bewerbung.</p>
        <label for="loc-a">Standort A</label><input id="loc-a" type="checkbox" checked>
        <button type="button">Auswahl speichern</button></div>`;
    const { page, read, clicked, doc } = domPage([html], url);
    expect(COOKIE_SAVE_RE.test('Auswahl speichern')).toBe(true);
    const result = await dismissCookieBanner(page, read());
    expect(result.status).toBe('none');
    expect(clicked).toEqual([]);
    expect((doc().getElementById('loc-a') as HTMLInputElement).checked).toBe(true);
  });
});

describe('cookie managers in an iframe and a shadow root', () => {
  const url = 'https://jobs.example-employer.test/job/synthetic';

  it('rejects inside an embedded consent frame’s shadow root and confirms the frame is clear', async () => {
    const { page, read, clicked, doc } = domPage([
      '<main><button type="button">Bewerben</button></main>',
      '<consent-banner class="cookie-banner"></consent-banner>',
    ], url, (element, frame) => {
      if (frame === 1) (element.getRootNode() as ShadowRoot).innerHTML = '<p>Cookies saved.</p>';
    });
    const host = doc(1).querySelector('consent-banner')!;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<p>We use cookies on this website.</p><button>Accept all cookies</button><button>Reject all cookies</button>';
    const result = await dismissCookieBanner(page, read());
    expect(clicked).toEqual(['Reject all cookies']);
    expect(result.status).toBe('dismissed');
  });
});

describe('bounded cookie resolution with the agentic fallback', () => {
  const url = 'https://jobs.yellowshark.com/job/synthetic/';
  const stuckBanner = `<main><a role="button" href="#apply">JETZT BEWERBEN</a></main>
    <div class="cookie-banner" role="dialog"><p>Diese Website verwendet Cookies.</p><button class="deny">Ablehnen</button></div>`;

  it('tries the deterministic path a bounded number of times, then the agent once, then hands over', async () => {
    const { page, read, clicked } = domPage([stuckBanner], url);
    const agent = vi.fn(async () => ({ status: 'stuck', acted: false }));
    const result = await resolveCookieConsent(page, read(), { agent });
    expect(result.status).toBe('unresolved');
    expect(clicked).toEqual(['Ablehnen', 'Ablehnen', 'Ablehnen']);
    expect(agent).toHaveBeenCalledTimes(1);
    expect(result.attempts).toEqual(['unresolved', 'unresolved', 'unresolved']);
    expect(clicked).not.toContain('JETZT BEWERBEN');
  });

  it('accepts the agent’s work only after the deterministic check sees the manager gone', async () => {
    const { page, read, doc } = domPage([stuckBanner], url);
    const agent = vi.fn(async () => {
      doc().querySelector('.cookie-banner')?.remove();
      return { status: 'done', acted: true };
    });
    const result = await resolveCookieConsent(page, read(), { agent });
    expect(agent).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('none');
    expect(result.agent).toBe('done');
  });

  it('does not call the agent when the deterministic path resolves the banner', async () => {
    const { page, read, clicked } = domPage([complianzPosting()], url, complianzClick);
    const agent = vi.fn();
    const result = await resolveCookieConsent(page, read(), { agent });
    expect(result.status).toBe('dismissed');
    expect(clicked).toEqual(['Ablehnen']);
    expect(agent).not.toHaveBeenCalled();
  });

  it('keeps every application, sign-in and submit control away from the cookie agent', () => {
    expect(HINTS.cookie_preferences_unresolved).toMatch(/necessary/i);
    for (const name of ['JETZT BEWERBEN', 'Apply now', 'Candidati ora', 'Postuler', 'Sign in', 'Konto erstellen', 'Bewerbung absenden']) {
      expect(refusal({ action: 'click' }, { button: true, name }, { reservedButtons: COOKIE_AGENT_RESERVED_BUTTONS })).not.toBe('');
    }
    for (const name of ['Ablehnen', 'Nur notwendige Cookies', 'Einstellungen speichern']) {
      expect(refusal({ action: 'click' }, { button: true, name }, { reservedButtons: COOKIE_AGENT_RESERVED_BUTTONS })).toBe('');
    }
  });
});
