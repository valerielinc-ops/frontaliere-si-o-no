import { afterEach, describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import * as portal from '../scripts/assisted-application/lib/portal/portal.mjs';
import { extractFields } from '../scripts/assisted-application/lib/portal/fields.mjs';
import { guardPlan, ownConsent } from '../scripts/assisted-application/lib/portal/plan.mjs';

const { acceptPrivacyStatement, privacyConsentControls, submitViaPortal } = portal as any;
const preflight = (page: any, options?: any) => (portal as any).registrationPrivacyPreflight(page, options);

// A bounded stand-in for the browser: the real extractFields/applyActions/
// clickButton run against JSDOM documents, one per frame. Time only moves through
// waitForTimeout, so the 8 s windows of the real code are walked without waiting.
const realNow = Date.now;
afterEach(() => { Date.now = realNow; });

function inWindow<T>(window: any, run: () => T): T {
  const names = ['window', 'document', 'location', 'CSS', 'getComputedStyle'];
  const saved = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  const values = [window, window.document, window.location, { escape: (value: string) => value }, window.getComputedStyle.bind(window)];
  names.forEach((name, index) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: values[index] }));
  try {
    return run();
  } finally {
    names.forEach((name, index) => {
      const descriptor = saved[index];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as any)[name];
    });
  }
}

function document_(markup: string, url = 'https://careers.example.test/register') {
  const dom = new JSDOM(`<!doctype html><html><body>${markup}</body></html>`, { url, runScripts: 'outside-only' });
  const { window } = dom;
  Object.defineProperty(window.HTMLElement.prototype, 'innerText', { configurable: true, get() { return this.textContent || ''; } });
  window.Element.prototype.getBoundingClientRect = function box(this: any) {
    const size = this.closest('[hidden]') ? 0 : 60;
    return { width: size, height: size } as DOMRect;
  };
  return window;
}

function fakePage(markups: string[], { boxRegisters = true, url = undefined as string | undefined } = {}) {
  const windows = markups.map((markup) => document_(markup, url));
  let skew = 0;
  const timers: Array<{ at: number; run: () => void }> = [];
  Date.now = () => realNow() + skew;
  const locator = (window: any, selector: string) => {
    const element = () => {
      const found = window.document.querySelector(selector);
      if (!found) throw new Error(`locator.click: ${selector} is gone`);
      return found;
    };
    const handle: any = {
      first: () => handle,
      count: async () => window.document.querySelectorAll(selector).length,
      click: async () => {
        const target = element();
        if (target.disabled) throw new Error('locator.click: element is disabled');
        target.click();
      },
      fill: async (value: string) => { element().value = value; },
      inputValue: async () => element().value,
      setChecked: async (wanted: boolean) => {
        const box = element();
        if (boxRegisters && box.checked !== wanted) box.click();
      },
      isChecked: async () => element().checked,
      evaluate: async (run: any, argument: any) => inWindow(window, () => run(element(), argument)),
    };
    return handle;
  };
  const frames = windows.map((window: any) => ({
    url: () => window.location.href,
    evaluate: async (run: any, argument: any) => inWindow(window, () => run(argument)),
    locator: (selector: string) => locator(window, selector),
  }));
  const page: any = {
    frames: () => frames,
    mainFrame: () => frames[0],
    url: () => frames[0].url(),
    evaluate: (run: any, argument: any) => frames[0].evaluate(run, argument),
    locator: (selector: string) => frames[0].locator(selector),
    waitForLoadState: async () => {},
    waitForTimeout: async (ms: number) => {
      skew += ms;
      for (const timer of timers.splice(0)) {
        if (timer.at <= skew) timer.run();
        else timers.push(timer);
      }
    },
    getByRole: () => {
      const handle: any = { first: () => handle, filter: () => handle, waitFor: async () => { throw new Error('none'); }, isVisible: async () => false };
      return handle;
    },
    after: (ms: number, run: () => void) => timers.push({ at: skew + ms, run }),
    goto: async () => ({ status: () => 200 }),
    title: async () => '',
    on: () => {},
    off: () => {},
    screenshot: async () => Buffer.from(''),
  };
  return { page, windows, window: windows[0], element: (id: string, index = 0) => windows[index].document.getElementById(id) };
}

const NAVIGATION = { listboxOptions: false };

/**
 * A run through the public entry, one step long, so the real handleAuth decides
 * what becomes of the account and what the handoff says. No model, no network.
 */
async function runRegistration(fixture: ReturnType<typeof fakePage>, { account = null as any } = {}) {
  const { page } = fixture;
  const accounts: string[] = [];
  const context: any = { on: () => {}, off: () => {}, pages: () => [page], newPage: async () => page, close: async () => {}, waitForEvent: async () => null };
  page.context = () => context;
  const browser = { newContext: async () => context, close: async () => {}, version: () => '130.0.0.0' };
  const result = await submitViaPortal({
    applyUrl: page.url(), job: { title: 'Synthetische Rolle', company: 'Beispiel AG' }, language: 'de', candidateLocale: 'de',
    candidate: { identity: { email: 'candidate@example.test' }, profile: {} }, files: {}, skipPostingCheck: true, maxSteps: 1,
    codex: async () => ({ actions: [], missingRequired: [] }), launch: async () => browser,
    accounts: {
      load: async () => account,
      save: async () => { accounts.push('save'); },
      mark: async (_host: string, patch: any) => { accounts.push(`mark:${patch.status || Object.keys(patch)}`); },
      discard: async (_host: string, reason: string) => { accounts.push(`discard:${reason}`); },
    },
  });
  return { auth: result.evidence.steps[0]?.auth, reason: result.event.reason, accounts };
}

const SIGNED_UP = '<h1>Willkommen</h1><form><label>Vorname <input name="first"></label><button type="button">Weiter</button></form>';
const ACCOUNT_FORM = (notice: string, cta: string, dialog = NOTICE_DIALOG) => `<form id="registration" action="/register">
  <label for="p1">Wähle ein Kennwort: *</label><input id="p1" type="password" name="p1">
  <label for="p2">Kennwort erneut eingeben: *</label><input id="p2" type="password" name="p2">
  <label for="country">Land/Region des Wohnorts:*</label><select id="country" name="country"><option value="CH" selected>Schweiz</option></select>
  <input type="hidden" id="consent" value="">
  <label for="notice">Datenschutzerklärung:*</label>${notice}
  ${cta}</form>${dialog}`;
const NATIVE_CTA = '<button type="button" id="create" disabled>Konto anlegen</button>';
// Shut with a class only: the DOM says enabled, a press on it answers nothing, and no request leaves.
const STYLED_CTA = '<button type="button" id="create" class="disabled">Konto anlegen</button>';

/** The portal's side of the registration: the notice opens, the box frees Accept, Accept frees the CTA. */
function wireAccount(fixture: ReturnType<typeof fakePage>, { opens = true, enables = true } = {}) {
  const { element, window } = fixture;
  const seen = { noticeClicks: 0, accepted: 0, ctaClicks: 0, requests: 0 };
  element('notice').addEventListener('click', () => { seen.noticeClicks += 1; if (opens) element('noticeDialog').hidden = false; });
  element('noticeReview')?.addEventListener('change', () => { element('noticeAccept').disabled = !element('noticeReview').checked; });
  element('noticeAccept')?.addEventListener('click', () => {
    seen.accepted += 1;
    element('consent').value = '1';
    element('noticeDialog').hidden = true;
    if (enables) { element('create').disabled = false; element('create').classList.remove('disabled'); }
  });
  element('create').addEventListener('click', () => {
    seen.ctaClicks += 1;
    if (element('consent').value !== '1') return;
    seen.requests += 1;
    window.document.body.innerHTML = SIGNED_UP;
  });
  return seen;
}

const NOTICE_LINK = '<a id="notice" role="button" tabindex="0" aria-haspopup="dialog">Lese und akzeptiere die Datenschutzerklärung.</a>';
const NOTICE_DIALOG = `<div role="dialog" id="noticeDialog" hidden><h2>Datenschutzerklärung</h2><p>Ein synthetischer Text.</p>
  <label><input type="checkbox" id="noticeReview" name="noticeReview"> Ich habe die Datenschutzerklärung gelesen und akzeptiere sie.</label>
  <button type="button" id="noticeAccept" disabled>Akzeptieren</button><button type="button" id="noticeRefuse">Ablehnen</button></div>`;
const REGISTRATION = (link = NOTICE_LINK, dialog = NOTICE_DIALOG) => `<form id="registration" action="/register">
  <label for="country">Land/Region des Wohnorts:*</label><select id="country" name="country"><option value="CH" selected>Schweiz</option></select>
  <label for="abo">Job-Abo</label><input type="checkbox" id="abo" name="abo">
  <input type="hidden" id="consent" value="">
  <label for="notice">Datenschutzerklärung:*</label>${link}
  <div role="dialog" id="otherDialog"><label><input type="checkbox" id="otherReview"> I have reviewed this privacy notice.</label><button type="button" id="otherAccept">Accept</button></div>
  <button type="submit" id="create" disabled>Konto anlegen</button></form>${dialog}`;

/** The portal's own wiring: the link opens the dialog, the box enables Accept, Accept enables the form's CTA. */
function wireNotice(fixture: ReturnType<typeof fakePage>, { closes = true, enables = true, enableAfterMs = 0 } = {}) {
  const { element, page } = fixture;
  const clicks = { other: 0, submit: 0 };
  element('notice').addEventListener('click', () => { element('noticeDialog').hidden = false; });
  element('noticeReview').addEventListener('change', () => { element('noticeAccept').disabled = !element('noticeReview').checked; });
  element('noticeAccept').addEventListener('click', () => {
    if (!element('noticeReview').checked) return;
    element('consent').value = '1';
    if (closes) element('noticeDialog').hidden = true;
    if (!enables) return;
    if (enableAfterMs) page.after(enableAfterMs, () => { element('create').disabled = false; });
    else element('create').disabled = false;
  });
  element('otherAccept').addEventListener('click', () => { clicks.other += 1; });
  element('registration').addEventListener('submit', (event: Event) => { event.preventDefault(); clicks.submit += 1; });
  return clicks;
}

describe('required privacy notice trigger', () => {
  const triggerFor = (text: string, extra = {}) => privacyConsentControls({ buttons: [{ id: 'link', text, disabled: false, ...extra }], fields: [] }).trigger?.id || '';

  it.each([
    ['de imperative, the observed portal', 'Lese und akzeptiere die Datenschutzerklärung.'],
    ['de grammatical imperative', 'Lies und akzeptiere die Datenschutzerklärung'],
    ['de infinitive, the Coop portal', 'Datenschutzerklärung lesen und akzeptieren.'],
    ['de formal, object between the verbs', 'Bitte lesen Sie die Datenschutzerklärung und akzeptieren Sie diese.'],
    ['de ampersand', 'Datenschutzhinweise lesen & akzeptieren'],
    ['it imperative', "Leggi e accetta l'informativa sulla privacy"],
    ['it formal', "Legga e accetti l'informativa privacy."],
    ['it infinitive', "Leggere e accettare l'informativa sul trattamento dei dati"],
    ['fr imperative', 'Lisez et acceptez la politique de confidentialité'],
    ['fr infinitive', 'Lire et accepter la déclaration de confidentialité'],
    ['en', 'Read and accept the data privacy statement'],
    ['en review', 'Please review and accept the privacy policy'],
    ['decomposed accents and a soft hyphen', 'Lese und akzeptiere die Datenschutz­erklärung.'],
    ['no-break spaces', 'Lese und akzeptiere die Datenschutzerklärung'],
    ['upper case', 'LESE UND AKZEPTIERE DIE DATENSCHUTZERKLÄRUNG'],
  ])('recognises %s', (_name, text) => {
    expect(triggerFor(text)).toBe('link');
  });

  it.each([
    ['newsletter', 'Lese und akzeptiere die Newsletter-Bedingungen'],
    ['marketing beside privacy', 'Read and accept the privacy policy for marketing'],
    ['job alert', 'Lisez et acceptez les conditions du job alert'],
    ['talent pool', 'Read and accept the talent pool privacy statement'],
    ['third parties', "Leggi e accetta l'informativa per i terzi"],
    ['agency terms', 'Read and accept the recruitment agency terms'],
    ['general site terms', 'Lese und akzeptiere die Nutzungsbedingungen'],
    ['a notice of unknown purpose', 'Lese und akzeptiere die Hausordnung'],
    ['a refusal', 'Datenschutzerklärung lesen und nicht akzeptieren'],
    ['a stated past fact', 'Datenschutzerklärung gelesen und akzeptiert'],
    ['a word that only ends like the verb', 'Blese und akzeptiere die Datenschutzerklärung'],
    ['no accept verb', 'Lese die Datenschutzerklärung'],
    ['two sentences', 'Lese die Datenschutzerklärung. Newsletter und akzeptiere'],
    ['a verb in another language pair', 'Lese et accepter la privacy'],
  ])('leaves alone %s', (_name, text) => {
    expect(triggerFor(text)).toBe('');
  });

  it('does not take a notice from the site header or footer', () => {
    expect(triggerFor('Read and accept the privacy policy', { chrome: true })).toBe('');
  });

  it('ignores a disabled link', () => {
    expect(triggerFor('Read and accept the privacy policy', { disabled: true })).toBe('');
  });

  it('reads a bare verb only through a name bound to the control, never through what surrounds it', () => {
    expect(triggerFor('Lesen und akzeptieren', { ownLabel: 'Datenschutzerklärung:*' })).toBe('link');
    expect(triggerFor('Lesen und akzeptieren', { label: 'Datenschutzerklärung' })).toBe('link');
    expect(triggerFor('Lesen und akzeptieren')).toBe('');
    expect(triggerFor('Lesen und akzeptieren', { ownLabel: 'Hausordnung:*' })).toBe('');
    expect(triggerFor('Lesen und akzeptieren', { ownLabel: 'Datenschutz für Newsletter:*' })).toBe('');
    // The nearest heading or text zone is a guess at a parent, not the control's name.
    expect(triggerFor('Lesen und akzeptieren', { context: 'Datenschutzerklärung:*', section: 'Datenschutz' })).toBe('');
  });

  it('never presses an anchor that would take the page off the form', () => {
    expect(triggerFor('Read and accept the privacy policy', { leavesDocument: true })).toBe('');
  });

  it('counts a plain link of the snapshot as the notice, apart from every button search', () => {
    const link = { id: 'plain', text: 'Lese und akzeptiere die Datenschutzerklärung.' };
    expect(privacyConsentControls({ buttons: [], links: [link], fields: [] }).trigger?.id).toBe('plain');
    expect(privacyConsentControls({ buttons: [], links: [{ ...link, leavesDocument: true }], fields: [] })).toMatchObject({ trigger: null, notice: { id: 'plain' } });
  });

  it('refuses a marketing purpose hidden in the accessible name of a privacy-looking link', () => {
    expect(triggerFor('Read and accept the privacy policy', { ariaLabel: 'Subscribe to the newsletter' })).toBe('');
  });
});

describe('required privacy notice dialog controls', () => {
  const dialogButton = (id: string, text: string, extra = {}) => ({ id, text, disabled: false, dialog: true, dialogId: 'modal', frame: 0, ...extra });
  const box = (id: string, label: string) => ({ id, kind: 'checkbox', name: id, label, checked: false, dialog: true, dialogId: 'modal', frame: 0 });

  it.each(['Akzeptieren', 'Akzeptiere', 'Ich stimme zu', 'Accetto', 'Acceptez', 'I agree', 'Akzeptieren und weiter'])('accepts through %s', (text) => {
    expect(privacyConsentControls({ buttons: [dialogButton('ok', text)], fields: [] }).accept?.id).toBe('ok');
  });

  it.each(['Akzeptieren und Newsletter abonnieren', 'Accept and join our talent pool', 'Accept and receive marketing', 'Ablehnen', 'Nicht akzeptieren'])('never presses %s', (text) => {
    expect(privacyConsentControls({ buttons: [dialogButton('ok', text)], fields: [] }).accept).toBe(null);
  });

  it('blocks Accept when a required mixed review sits beside a safe review', () => {
    const mixed = { ...box('mixed', 'I have read and agree to data sharing with partners'), required: true };
    const controls = privacyConsentControls({
      buttons: [dialogButton('ok', 'Akzeptieren')],
      fields: [mixed, box('review', 'Ich habe die Datenschutzerklärung gelesen und akzeptiere sie.')],
    });
    expect(controls.accept).toBe(null);
  });

  it('never ticks a marketing box beside the notice review', () => {
    const controls = privacyConsentControls({
      buttons: [dialogButton('ok', 'Akzeptieren', { disabled: true })],
      fields: [box('alert', 'Ich habe die Hinweise gelesen und abonniere den Newsletter.'), box('review', 'Ich habe die Datenschutzerklärung gelesen und akzeptiere sie.')],
    });
    expect(controls.review?.id).toBe('review');
  });

});

describe('privacy before the registration click', () => {
  it('opens, reviews, accepts and waits for the CTA: the observed imperative link', async () => {
    const fixture = fakePage([REGISTRATION()]);
    const clicks = wireNotice(fixture);
    const result = await preflight(fixture.page);
    expect(result.privacy).toBe('accepted');
    expect(result.blocked).toBe(false);
    expect(fixture.element('consent').value).toBe('1');
    expect(fixture.element('create').disabled).toBe(false);
    // Nothing else was agreed to, and the form was not sent by the preflight.
    expect(fixture.element('abo').checked).toBe(false);
    expect(fixture.element('otherReview').checked).toBe(false);
    expect(clicks.other).toBe(0);
    expect(clicks.submit).toBe(0);
  });

  it('gives the CTA a bounded time to become enabled after the acceptance', async () => {
    const fixture = fakePage([REGISTRATION()]);
    wireNotice(fixture, { enableAfterMs: 3000 });
    const result = await preflight(fixture.page);
    expect(result.blocked).toBe(false);
    expect(result.filled.buttons.find((button: any) => button.text === 'Konto anlegen').disabled).toBe(false);
  });

  it('stops before the click when the CTA stays disabled after the acceptance', async () => {
    const fixture = fakePage([REGISTRATION()]);
    wireNotice(fixture, { enables: false });
    const result = await preflight(fixture.page);
    expect(result).toMatchObject({ privacy: 'unavailable', blocked: true });
  });

  it('stops when the dialog never opens', async () => {
    const fixture = fakePage([REGISTRATION()]);
    const result = await preflight(fixture.page);
    expect(result).toMatchObject({ privacy: 'unavailable', blocked: true });
  });

  it('stops even when the CTA is enabled: an unfinished notice is never sent past', async () => {
    const fixture = fakePage([REGISTRATION()]);
    fixture.element('create').disabled = false;
    const result = await preflight(fixture.page);
    expect(result).toMatchObject({ privacy: 'unavailable', blocked: true });
  });

  it('does not call an accept that left the dialog open accepted', async () => {
    const fixture = fakePage([REGISTRATION()]);
    wireNotice(fixture, { closes: false, enables: false });
    expect(await acceptPrivacyStatement(fixture.page, await extractFields(fixture.page, NAVIGATION))).toBe('unavailable');
  });

  it('does not press Accept until the review box has registered, and reports a box that never does', async () => {
    const fixture = fakePage([REGISTRATION()], { boxRegisters: false });
    wireNotice(fixture);
    fixture.element('noticeAccept').disabled = false;
    let pressed = 0;
    fixture.element('noticeAccept').addEventListener('click', () => { pressed += 1; });
    const result = await preflight(fixture.page);
    expect(result).toMatchObject({ privacy: 'unavailable', blocked: true });
    expect(pressed).toBe(0);
  });

  it('retries a lost first click in its own window', async () => {
    const fixture = fakePage([REGISTRATION()]);
    wireNotice(fixture);
    const { element } = fixture;
    const link = element('notice');
    const replacement = link.cloneNode(true);
    link.replaceWith(replacement);
    let opens = 0;
    replacement.addEventListener('click', () => { opens += 1; if (opens === 2) element('noticeDialog').hidden = false; });
    const result = await preflight(fixture.page);
    expect(result).toMatchObject({ privacy: 'accepted', blocked: false });
    expect(opens).toBe(2);
  });

  it('does not accept a dialog that opened in another frame', async () => {
    const foreign = `<div role="dialog" id="foreign" hidden><button type="button" id="foreignAccept">Accept</button></div>`;
    const fixture = fakePage([REGISTRATION(NOTICE_LINK, ''), foreign]);
    let pressed = 0;
    fixture.element('notice').addEventListener('click', () => { fixture.element('foreign', 1).hidden = false; });
    fixture.element('foreignAccept', 1).addEventListener('click', () => { pressed += 1; });
    const result = await preflight(fixture.page);
    expect(result).toMatchObject({ privacy: 'unavailable', blocked: true });
    expect(pressed).toBe(0);
  });

  it('does not accept a cookie dialog that opens in place of the notice', async () => {
    const cookie = `<div role="dialog" id="cookie" hidden><h2>Cookie-Einstellungen</h2><button type="button" id="cookieAccept">Akzeptieren</button></div>`;
    const fixture = fakePage([REGISTRATION(NOTICE_LINK, cookie)]);
    let pressed = 0;
    fixture.element('notice').addEventListener('click', () => { fixture.element('cookie').hidden = false; });
    fixture.element('cookieAccept').addEventListener('click', () => { pressed += 1; });
    const result = await preflight(fixture.page);
    expect(result).toMatchObject({ privacy: 'unavailable', blocked: true });
    expect(pressed).toBe(0);
  });

  it.each(['Newsletter', 'Job-Abo'])('leaves unchecked the review of a dialog titled %s', async (title) => {
    const dialog = NOTICE_DIALOG.replace('<h2>Datenschutzerklärung</h2>', `<h2>${title}</h2>`);
    const fixture = fakePage([REGISTRATION(NOTICE_LINK, dialog)]);
    wireNotice(fixture);
    const result = await preflight(fixture.page);
    expect(result).toMatchObject({ privacy: 'unavailable', blocked: true });
    expect(fixture.element('noticeReview').checked).toBe(false);
  });

  it('does not take the title of a titleless dialog from a heading of the page above it', async () => {
    const dialog = NOTICE_DIALOG.replace('<h2>Datenschutzerklärung</h2>', '');
    const fixture = fakePage([`<h3>Job-Abo</h3>${REGISTRATION(NOTICE_LINK, dialog)}`]);
    wireNotice(fixture);
    expect(await preflight(fixture.page)).toMatchObject({ privacy: 'accepted', blocked: false });
  });

  it('names an unrecognised notice behind a disabled CTA without opening it', async () => {
    const link = '<a id="notice" role="button" tabindex="0">Lese und akzeptiere die Hausordnung.</a>';
    const fixture = fakePage([REGISTRATION(link, NOTICE_DIALOG)]);
    wireNotice(fixture);
    const result = await preflight(fixture.page);
    expect(result).toMatchObject({ privacy: 'unavailable', blocked: true });
    expect(fixture.element('noticeDialog').hidden).toBe(true);
  });

  it('opens a notice printed as a plain link of this document, which is no button of the snapshot', async () => {
    const link = '<a id="notice" href="#notice">Lese und akzeptiere die Datenschutzerklärung.</a>';
    const fixture = fakePage([REGISTRATION(link, NOTICE_DIALOG)]);
    wireNotice(fixture);
    const result = await preflight(fixture.page);
    expect(result).toMatchObject({ privacy: 'accepted', blocked: false });
    expect(result.filled.buttons.some((button: any) => /Datenschutz/.test(button.text))).toBe(false);
  });

  it('leaves an optional marketing link alone when the CTA is free', async () => {
    const link = '<a id="notice" role="button" tabindex="0">Lese und akzeptiere die Newsletter-Bedingungen.</a>';
    const fixture = fakePage([REGISTRATION(link, NOTICE_DIALOG)]);
    wireNotice(fixture);
    fixture.element('create').disabled = false;
    const result = await preflight(fixture.page);
    expect(result).toMatchObject({ privacy: 'none', blocked: false });
    expect(fixture.element('noticeDialog').hidden).toBe(true);
  });

  it('does not blame privacy for a CTA disabled on a page with no notice', async () => {
    const fixture = fakePage(['<form><label>Vorname <input name="first"></label><button type="submit" disabled>Konto anlegen</button></form>']);
    const result = await preflight(fixture.page);
    expect(result).toMatchObject({ privacy: 'none', blocked: false });
  });

  it('lets a repair past the shut link of a notice accepted on the first pass', async () => {
    const shut = '<a id="notice" role="button" tabindex="0" aria-disabled="true">Lese und akzeptiere die Datenschutzerklärung.</a>';
    const fixture = fakePage([ACCOUNT_FORM(shut, '<button type="button" id="create">Konto anlegen</button>')]);
    expect(await preflight(fixture.page)).toMatchObject({ privacy: 'unavailable', blocked: true });
    expect(await preflight(fixture.page, { accepted: true })).toMatchObject({ privacy: 'none', blocked: false });
  });

  it('does not press Accept in a dialog that names nothing, whatever the page says around it', async () => {
    const bare = '<div role="dialog" id="bare" hidden><p>Bitte bestätigen.</p><button type="button" id="bareAccept">Akzeptieren</button></div>';
    const fixture = fakePage([`<h3>Datenschutzerklärung</h3>${REGISTRATION(NOTICE_LINK, bare)}`]);
    let pressed = 0;
    fixture.element('notice').addEventListener('click', () => { fixture.element('bare').hidden = false; });
    fixture.element('bareAccept').addEventListener('click', () => { pressed += 1; });
    expect(await preflight(fixture.page)).toMatchObject({ privacy: 'unavailable', blocked: true });
    expect(pressed).toBe(0);
  });

  it('accepts a dialog named by its own label', async () => {
    const dialog = '<div role="dialog" id="noticeDialog" aria-label="Datenschutzerklärung" hidden><button type="button" id="noticeAccept">Akzeptieren</button></div>';
    const fixture = fakePage([ACCOUNT_FORM(NOTICE_LINK, NATIVE_CTA, dialog)]);
    wireAccount(fixture);
    expect(await preflight(fixture.page)).toMatchObject({ privacy: 'accepted', blocked: false });
  });
});

describe('the same grammar on the canonical consent path', () => {
  const candidate = { answers: {}, profile: {}, portalQuestionsAnswered: [] };
  // extractFields -> ownConsent -> mandate: what a real page gives the planner.
  const requiredBox = async (label: string) => {
    const { page } = fakePage([`<form id="f" action="/register"><label><input type="checkbox" id="box" name="box" required> ${label}</label></form>`]);
    const [field] = (await extractFields(page, NAVIGATION)).fields;
    const plan = guardPlan({ actions: [], missingRequired: [] }, [field], candidate);
    return {
      own: ownConsent(field),
      mandated: plan.actions.some((action: any) => action.action === 'check' && action.source === 'consent'),
      asked: plan.missingRequired.length,
    };
  };

  it('keeps the box the guard always knew, so that a refusal below is the guard and not the harness', async () => {
    expect(await requiredBox('Ich habe die Datenschutzerklärung gelesen und akzeptiere sie.')).toEqual({ own: true, mandated: true, asked: 0 });
  });

  it.each([
    ['de imperative', 'Lese und akzeptiere die Datenschutzerklärung.'],
    ['de grammatical imperative', 'Lies und akzeptiere die Datenschutzerklärung.'],
    ['de formal', 'Bitte lesen Sie die Datenschutzerklärung und akzeptieren Sie diese.'],
    ['it imperative', "Leggi e accetta l'informativa sulla privacy."],
    ['it formal', "Legga e accetti l'informativa privacy."],
    ['fr imperative', 'Lisez et acceptez la politique de confidentialité.'],
    ['fr declaration', 'Veuillez lire et accepter la déclaration de confidentialité.'],
    ['en', 'Please read and accept the privacy policy.'],
    ['en review', 'Review and accept the data privacy statement.'],
    ['decomposed accents', 'Lese und akzeptiere die Datenschutzerklärung.'],
    ['a soft hyphen', 'Lese und akzeptiere die Datenschutz­erklärung.'],
    ['upper case', 'LESE UND AKZEPTIERE DIE DATENSCHUTZERKLÄRUNG'],
    ['no-break spaces', 'Lese und akzeptiere die Datenschutzerklärung'],
  ])('binds the mandate to the required notice: %s', async (_name, label) => {
    expect(await requiredBox(label)).toEqual({ own: true, mandated: true, asked: 0 });
  });

  it.each([
    ['marketing', 'Lese und akzeptiere die Datenschutzerklärung für Marketing'],
    ['newsletter behind a soft hyphen', 'Lese und akzeptiere die Datenschutzerklärung und den News­letter'],
    ['talent pool', 'Read and accept the talent pool privacy statement'],
    ['cookies', 'Read and accept the cookie privacy policy'],
    ['third parties', "Leggi e accetta l'informativa per i terzi"],
    ['tiers', 'Lisez et acceptez la politique de confidentialité des tiers'],
    ['a fact beside the notice', 'Read and accept the privacy policy, I hold a valid work permit'],
    ['a refusal', 'Lese und akzeptiere nicht die Datenschutzerklärung'],
    ['a refusal behind a soft hyphen', 'Lese und akzep­tiere nicht die Datenschutzerklärung'],
  ])('never binds it to %s, which stays a question for the candidate', async (_name, label) => {
    expect(await requiredBox(label)).toMatchObject({ own: false, mandated: false, asked: 1 });
  });

  it.each([
    ['cookie', 'Read and accept the cookie policy'],
    ['newsletter', 'Lese und akzeptiere die Newsletter-Bedingungen'],
    ['third parties', "Leggi e accetta l'informativa per i terzi"],
  ])('sees a control and a box alike: %s', async (_name, label) => {
    expect(privacyConsentControls({ buttons: [{ id: 'link', text: label }], fields: [] }).trigger).toBe(null);
  });
});

describe('the registration, through the real handleAuth', () => {
  it.each([['a native disabled', NATIVE_CTA], ['a CSS-disabled', STYLED_CTA]])('accepts the notice before %s CTA and registers once', async (_name, cta) => {
    const fixture = fakePage([ACCOUNT_FORM(NOTICE_LINK, cta)]);
    const seen = wireAccount(fixture);
    const { auth, accounts } = await runRegistration(fixture);
    expect(auth).toMatchObject({ outcome: 'ok', privacy: 'accepted' });
    expect(seen).toEqual({ noticeClicks: 1, accepted: 1, ctaClicks: 1, requests: 1 });
    expect(accounts).toEqual(['save', 'mark:created']);
  });

  it('presses nothing and names privacy when the dialog never opens behind a CSS-disabled CTA', async () => {
    const fixture = fakePage([ACCOUNT_FORM(NOTICE_LINK, STYLED_CTA)]);
    const seen = wireAccount(fixture, { opens: false });
    const { auth, reason, accounts } = await runRegistration(fixture);
    expect(reason).toBe('privacy_not_accepted');
    expect(auth).toMatchObject({ outcome: 'privacy_not_accepted', privacy: 'unavailable' });
    expect(seen).toMatchObject({ ctaClicks: 0, requests: 0 });
    expect(accounts).toEqual(['save', 'discard:privacy_not_accepted']);
    // The rest of the form was valid: only the notice stood in the way.
    expect(fixture.element('p1').value).not.toBe('');
    expect(fixture.element('p2').value).toBe(fixture.element('p1').value);
    expect(fixture.element('country').value).toBe('CH');
  });

  it('names privacy, not an unanswered registration, when the review box does not register', async () => {
    const fixture = fakePage([ACCOUNT_FORM(NOTICE_LINK, STYLED_CTA)], { boxRegisters: false });
    const seen = wireAccount(fixture);
    fixture.element('noticeAccept').disabled = false;
    const { reason, accounts } = await runRegistration(fixture);
    expect(reason).toBe('privacy_not_accepted');
    expect(seen).toMatchObject({ accepted: 0, ctaClicks: 0, requests: 0 });
    expect(accounts).not.toContain('mark:unanswered');
  });

  it('names privacy when a required notice of unknown purpose sits before a CSS-disabled CTA', async () => {
    const notice = '<a id="notice" role="button" tabindex="0">Lese und akzeptiere die Hausordnung.</a>';
    const fixture = fakePage([ACCOUNT_FORM(notice, STYLED_CTA)]);
    const seen = wireAccount(fixture);
    const { reason } = await runRegistration(fixture);
    expect(reason).toBe('privacy_not_accepted');
    expect(seen).toMatchObject({ noticeClicks: 0, ctaClicks: 0, requests: 0 });
  });

  it('keeps the password of a retried, unverified account when the notice stays open', async () => {
    const url = 'https://career5.successfactors.eu/career';
    const signIn = '<form action="/career"><label>E-Mail <input name="user"></label><label>Kennwort <input type="password" name="pass"></label><a id="toCreate" role="button" tabindex="0">Konto anlegen</a></form>';
    const fixture = fakePage([signIn], { url });
    fixture.element('toCreate').addEventListener('click', () => { fixture.window.document.body.innerHTML = ACCOUNT_FORM(NOTICE_LINK, STYLED_CTA); });
    const { reason, accounts } = await runRegistration(fixture, { account: { email: 'alias@example.test', password: 'synthetic', status: 'pending', verifiedAt: null } });
    expect(reason).toBe('privacy_not_accepted');
    expect(accounts).toEqual(['mark:pending']);
  });

  it('opens a plain link of this document and registers', async () => {
    const notice = '<a id="notice" href="#datenschutz">Lese und akzeptiere die Datenschutzerklärung.</a>';
    const fixture = fakePage([ACCOUNT_FORM(notice, STYLED_CTA)]);
    const seen = wireAccount(fixture);
    expect((await runRegistration(fixture)).auth).toMatchObject({ outcome: 'ok', privacy: 'accepted' });
    expect(seen).toEqual({ noticeClicks: 1, accepted: 1, ctaClicks: 1, requests: 1 });
  });

  it.each([
    ['a plain link to another page', '<a id="notice" href="/datenschutz.html">Lese und akzeptiere die Datenschutzerklärung.</a>'],
    ['a plain link to another host', '<a id="notice" href="https://other.example.test/privacy#top">Lese und akzeptiere die Datenschutzerklärung.</a>'],
    ['a plain link to a new tab', '<a id="notice" href="#x" target="_blank">Lese und akzeptiere die Datenschutzerklärung.</a>'],
    ['a styled button link to another page', '<a id="notice" class="btn" href="/datenschutz.html">Lese und akzeptiere die Datenschutzerklärung.</a>'],
  ])('never follows %s, and says why it stopped', async (_name, notice) => {
    const fixture = fakePage([ACCOUNT_FORM(notice, STYLED_CTA)]);
    const seen = wireAccount(fixture);
    expect((await runRegistration(fixture)).reason).toBe('privacy_not_accepted');
    expect(seen).toMatchObject({ noticeClicks: 0, ctaClicks: 0, requests: 0 });
  });

  it('leaves a link of the site footer and an optional link alone, and registers past them', async () => {
    const notice = '<a id="notice" href="#alert">Lese und akzeptiere die Newsletter-Bedingungen.</a>';
    const footer = '<footer><a href="#policy">Lese und akzeptiere die Datenschutzerklärung.</a></footer>';
    const fixture = fakePage([`${ACCOUNT_FORM(notice, '<button type="button" id="create">Konto anlegen</button>', '')}${footer}`]);
    const seen = wireAccount(fixture);
    fixture.element('consent').value = '1';
    expect((await runRegistration(fixture)).auth).toMatchObject({ outcome: 'ok' });
    expect(seen).toMatchObject({ noticeClicks: 0, ctaClicks: 1, requests: 1 });
  });
});


describe('privacy consent boundaries in the registration', () => {
  it.each([
    'I have read this notice and confirm I hold a valid work permit.',
    'I have read this notice and confirm I am over 18.',
    'Ich habe die Datenschutzerklärung gelesen und akzeptiere sie nicht.',
    'I have read this and I refuse.',
    'I have read and agree that my data is shared with partners.',
    'Ho letto e dichiaro di avere la patente di guida.',
  ])('does not bypass an unknown review even when Accept is enabled: %s', async (label) => {
    const dialog = NOTICE_DIALOG.replace('Ich habe die Datenschutzerklärung gelesen und akzeptiere sie.', label)
      .replace('id="noticeAccept" disabled', 'id="noticeAccept"');
    const fixture = fakePage([ACCOUNT_FORM(NOTICE_LINK, STYLED_CTA, dialog)]);
    const seen = wireAccount(fixture);
    expect((await runRegistration(fixture)).reason).toBe('privacy_not_accepted');
    expect(seen).toMatchObject({ accepted: 0, ctaClicks: 0, requests: 0 });
    expect(fixture.element('noticeReview').checked).toBe(false);
  });

  it.each(['Accept and share with partners', 'Accept and confirm I hold a work permit', 'Accetta e condividi con i partner'])('does not accept an additional assertion in %s', async (label) => {
    const dialog = NOTICE_DIALOG.replace('>Akzeptieren</button>', `>${label}</button>`);
    const fixture = fakePage([ACCOUNT_FORM(NOTICE_LINK, STYLED_CTA, dialog)]);
    const seen = wireAccount(fixture);
    expect((await runRegistration(fixture)).reason).toBe('privacy_not_accepted');
    expect(seen).toMatchObject({ accepted: 0, ctaClicks: 0, requests: 0 });
  });

  it.each(['Privacy settings', 'Your privacy choices', 'We value your privacy', 'Privacy and declaration of criminal record'])('does not let a safe review overrule an unrelated dialog title: %s', async (title) => {
    const dialog = NOTICE_DIALOG.replace('<h2>Datenschutzerklärung</h2>', `<h2>${title}</h2>`);
    const fixture = fakePage([ACCOUNT_FORM(NOTICE_LINK, STYLED_CTA, dialog)]);
    const seen = wireAccount(fixture);
    expect((await runRegistration(fixture)).reason).toBe('privacy_not_accepted');
    expect(seen).toMatchObject({ accepted: 0, ctaClicks: 0, requests: 0 });
  });

  it.each(['', ' target="_blank"'])('uses an already checked consent in the same form without following its external link%s', async (target) => {
    const notice = `<label><input type="checkbox" name="privacy" required checked> Ich akzeptiere die Datenschutzerklärung *</label><a id="notice" href="/datenschutz.html"${target}>Lese und akzeptiere die Datenschutzerklärung.</a>`;
    const fixture = fakePage([ACCOUNT_FORM(notice, '<button type="button" id="create">Konto anlegen</button>', '')]);
    const seen = wireAccount(fixture);
    fixture.element('consent').value = '1';
    expect((await runRegistration(fixture)).auth).toMatchObject({ outcome: 'ok' });
    expect(seen).toMatchObject({ noticeClicks: 0, accepted: 0, ctaClicks: 1, requests: 1 });
  });

  it('does not borrow a checked consent from a separate form', async () => {
    const outside = '<form><label><input type="checkbox" name="privacy" required checked> Ich akzeptiere die Datenschutzerklärung *</label></form>';
    const notice = '<a id="notice" href="/datenschutz.html">Lese und akzeptiere die Datenschutzerklärung.</a>';
    const fixture = fakePage([outside + ACCOUNT_FORM(notice, '<button type="button" id="create">Konto anlegen</button>', '')]);
    const seen = wireAccount(fixture);
    fixture.element('consent').value = '1';
    expect((await runRegistration(fixture)).reason).toBe('privacy_not_accepted');
    expect(seen).toMatchObject({ noticeClicks: 0, ctaClicks: 0, requests: 0 });
  });
});


describe('partner data sharing stays a candidate decision in both consent paths', () => {
  it('does not confuse the notice owner Partner AG with permission to share data', () => {
    expect(ownConsent({ kind: 'checkbox', required: true, label: 'I accept the privacy policy of Partner AG' })).toBe(true);
  });
  it.each([
    'I accept privacy and data sharing with partners',
    'Ich akzeptiere Datenschutz und Weitergabe an Partnerfirmen',
    'Accetto la privacy e la condivisione con i partner',
    'J accepte la confidentialité et le partage avec nos partenaires',
  ])('does not mark a required checkbox for %s', (label) => {
    expect(ownConsent({ kind: 'checkbox', required: true, label })).toBe(false);
  });
});


describe('CI review: native ownership and positive acceptance proof', () => {
  it.each(['same frame', 'other frame'])('does not borrow a privacy trigger from an unrelated form in the %s', async (where) => {
    const foreign = `<form><a role="button" id="foreignNotice">Read and accept the privacy policy</a></form><div role="dialog" id="foreignDialog" hidden><h2>Privacy policy</h2><button id="foreignAccept">Accept</button></div>`;
    const target = ACCOUNT_FORM('<a id="notice"></a>', STYLED_CTA, '');
    const fixture = fakePage(where === 'same frame' ? [foreign + target] : [foreign, target]);
    const frame = where === 'same frame' ? 0 : 1;
    const seen = { foreign: 0, accepted: 0, cta: 0 };
    fixture.element('foreignNotice').addEventListener('click', () => { seen.foreign += 1; fixture.element('foreignDialog').hidden = false; });
    fixture.element('foreignAccept').addEventListener('click', () => { seen.accepted += 1; fixture.element('foreignDialog').hidden = true; });
    fixture.element('create', frame).addEventListener('click', () => { seen.cta += 1; });
    expect(await preflight(fixture.page)).toMatchObject({ privacy: 'unavailable', blocked: true });
    expect(seen).toEqual({ foreign: 0, accepted: 0, cta: 0 });
  });

  it.each([false, true])('requires a positive I agree checkbox to register before Accept, registers=%s', async (boxRegisters) => {
    const dialog = NOTICE_DIALOG.replace('Ich habe die Datenschutzerklärung gelesen und akzeptiere sie.', 'I agree to the privacy policy')
      .replace('id="noticeReview"', 'required id="noticeReview"').replace('id="noticeAccept" disabled', 'id="noticeAccept"');
    const fixture = fakePage([ACCOUNT_FORM(NOTICE_LINK, STYLED_CTA, dialog)], { boxRegisters });
    const seen = wireAccount(fixture);
    const result = await preflight(fixture.page);
    expect(result).toMatchObject(boxRegisters ? { privacy: 'accepted', blocked: false } : { privacy: 'unavailable', blocked: true });
    expect(seen.accepted).toBe(boxRegisters ? 1 : 0);
    expect(seen.ctaClicks).toBe(0);
    expect(fixture.element('noticeReview').checked).toBe(boxRegisters);
  });

  it('keeps a spinner-only dialog visible after Accept unaccepted', async () => {
    const fixture = fakePage([ACCOUNT_FORM(NOTICE_LINK, STYLED_CTA)]);
    const seen = wireAccount(fixture);
    fixture.element('noticeAccept').addEventListener('click', () => {
      fixture.element('noticeDialog').hidden = false;
      fixture.element('noticeDialog').innerHTML = '<h2>Privacy policy</h2><span role="status">Working</span>';
    });
    expect((await runRegistration(fixture)).reason).toBe('privacy_not_accepted');
    expect(seen).toMatchObject({ accepted: 1, ctaClicks: 0, requests: 0 });
    const snapshot = await extractFields(fixture.page, NAVIGATION);
    expect(snapshot.dialogs.length).toBeGreaterThan(0);
  });
});


describe('native consent metadata cannot contradict a privacy-looking label', () => {
  it.each([
    ['name', 'workPermit'],
    ['name', 'nationalityConsent'],
    ['name', 'experienceYears'],
    ['name', 'experience\u00adYears'],
    ['name', 'ｗｏｒｋＰｅｒｍｉｔ'],
    ['autocomplete', 'bday'],
    ['autocomplete', 'sex'],
    ['domId', 'workPermitCheckbox'],
  ])('keeps the contradictory native %s=%s unknown', async (key, value) => {
    const label = 'I agree to the privacy policy';
    const field = { kind: 'checkbox', required: true, label, [key]: value };
    expect(ownConsent(field)).toBe(false);
    const native = key === 'domId' ? `id="${value}"` : `id="noticeReview" ${key}="${value}"`;
    const dialog = `<div role="dialog" id="noticeDialog" hidden><h2>Privacy policy</h2><label><input type="checkbox" required ${native}>${label}</label><button id="noticeAccept" type="button">Accept</button></div>`;
    const fixture = fakePage([ACCOUNT_FORM(NOTICE_LINK, STYLED_CTA, dialog)]);
    let accepted = 0;
    fixture.element('notice').addEventListener('click', () => { fixture.element('noticeDialog').hidden = false; });
    fixture.element('noticeAccept').addEventListener('click', () => { accepted += 1; fixture.element('noticeDialog').hidden = true; });
    expect(await preflight(fixture.page)).toMatchObject({ privacy: 'unavailable', blocked: true });
    expect(accepted).toBe(0);
    expect(fixture.element(key === 'domId' ? value : 'noticeReview').checked).toBe(false);
  });

  it('does not auto-accept a standalone notice with no owned application control', async () => {
    const fixture = fakePage([NOTICE_LINK + NOTICE_DIALOG]);
    let opened = 0;
    fixture.element('notice').addEventListener('click', () => { opened += 1; fixture.element('noticeDialog').hidden = false; });
    expect(await acceptPrivacyStatement(fixture.page, await extractFields(fixture.page, NAVIGATION))).toBe('unavailable');
    expect(opened).toBe(0);
  });
});
