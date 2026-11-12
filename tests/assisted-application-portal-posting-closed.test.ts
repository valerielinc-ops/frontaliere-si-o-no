import { afterEach, describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import * as portal from '../scripts/assisted-application/lib/portal/portal.mjs';
import { checkPostingLiveness, classifyLiveness, isHardClosed } from '../scripts/assisted-application/lib/liveness.mjs';

// SuccessFactors, Stadt Zürich (career2.successfactors.eu, run 42818412495, 2026-11-10): the account was
// created and the privacy statement accepted, then /portalcareer said the posting could no longer be applied
// for, and the run stopped as `posting_mismatch` instead of the closed posting it was.
const { initialPortalHandoffReason, submitViaPortal } = portal as any;


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

function fakePage(markups: string[], {
  boxRegisters = true,
  url = undefined as string | undefined,
  onWait = undefined as ((context: { ms: number; skew: number; window: any }) => void) | undefined,
} = {}) {
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
      selectOption: async ({ label, value }: { label?: string; value?: string }) => {
        const select = element();
        const option = [...select.options].find((item: any) => (label && item.label === label) || (value && item.value === value));
        if (!option) throw new Error('option not found');
        select.value = option.value;
        select.dispatchEvent(new window.Event('change', { bubbles: true }));
        return [option.value];
      },
      setChecked: async (wanted: boolean) => {
        const box = element();
        if (boxRegisters && box.checked !== wanted) box.click();
      },
      isChecked: async () => element().checked,
      evaluate: async (run: any, argument: any) => inWindow(window, () => run(element(), argument)),
      allInnerTexts: async () => [...window.document.querySelectorAll(selector)].map((item: any) => item.textContent || ''),
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
      onWait?.({ ms, skew, window: windows[0] });
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

// The tenant's text, as the stop showed it; no candidate data.
const STZH_CLOSED = `<main><p>Diese Stelle kann zurzeit nicht angezeigt werden. Sie wurde entweder gelöscht, oder man kann sich nicht länger darauf bewerben. Weitere Stellenangebote finden Sie, wenn Sie hier klicken.</p>
<button type="button" id="home">Zurück zur Startseite</button></main>`;
const OPEN_POSTING = `<main><h1>Sachbearbeiterin / Sachbearbeiter Synthetisch 80-100%</h1>
<p>Ihre Aufgaben: Sie betreuen ein synthetisches Dossier und arbeiten im Team. Bitte bewerben Sie sich ausschliesslich online; Bewerbungen per Post können wir leider nicht berücksichtigen.</p>
<p>Ihr Profil: abgeschlossene Ausbildung, gute Deutschkenntnisse, Freude an Kontakten.</p>
<button type="button" id="apply">Jetzt bewerben</button></main>`;
const REGISTRATION = `<h1>Konto anlegen</h1>
<form id="registration" action="/career">
  <label for="email">E-Mail-Adresse: *</label><input id="email" name="email" type="text">
  <label for="email2">E-Mail-Adresse wiederholen: *</label><input id="email2" name="email2" type="text">
  <label for="p1">Wähle ein Kennwort: *</label><input id="p1" type="password" name="p1">
  <label for="p2">Kennwort erneut eingeben: *</label><input id="p2" type="password" name="p2">
  <label for="first">Vorname: *</label><input id="first" name="first" type="text">
  <label for="last">Nachname: *</label><input id="last" name="last" type="text">
  <label for="country">Land/Region des Wohnorts:*</label><select id="country" name="country"><option value="">Bitte wählen</option><option value="CH" selected>Schweiz</option></select>
  <button type="button" id="create">Konto anlegen</button>
</form>`;

/** The portal: the account is created, then the browser lands on what the portal shows for the posting. */
function afterRegistration(fixture: ReturnType<typeof fakePage>, landing: string) {
  const { element, window } = fixture;
  const seen = { created: 0 };
  element('create').addEventListener('click', () => {
    seen.created += 1;
    window.history.pushState({}, '', '/portalcareer?company=STZH&career_job_req_id=1');
    window.document.body.innerHTML = landing;
  });
  return seen;
}

async function run(landing: string, { ownerRetry = false } = {}) {
  const fixture = fakePage([REGISTRATION], { url: 'https://career2.successfactors.eu/career?company=STZH&career_job_req_id=1' });
  const seen = afterRegistration(fixture, landing);
  const { page } = fixture;
  const context: any = { on: () => {}, off: () => {}, pages: () => [page], newPage: async () => page, close: async () => {}, waitForEvent: async () => null, addInitScript: async () => {} };
  page.context = () => context;
  const browser = { newContext: async () => context, close: async () => {}, version: () => '130.0.0.0' };
  const result = await submitViaPortal({
    applyUrl: page.url(), job: { title: 'Sachbearbeiter Synthetisch', company: 'Stadt Zürich' }, language: 'de', candidateLocale: 'de',
    candidate: { identity: { email: 'alias@example.test', firstName: 'Test', lastName: 'Kandidat', address: { country: 'CH' } }, profile: {} },
    files: {}, skipPostingCheck: ownerRetry, maxSteps: 2, codex: async () => ({ actions: [], missingRequired: [] }), launch: async () => browser,
    accounts: { load: async () => null, save: async () => {}, mark: async () => {}, discard: async () => {} },
  });
  return { result, seen };
}

describe('a posting that closes behind the registration', () => {
  it('reads the portal\'s own page for a posting it no longer shows as a certain closure', () => {
    const text = 'Diese Stelle kann zurzeit nicht angezeigt werden. Sie wurde entweder gelöscht, oder man kann sich nicht länger darauf bewerben. Weitere Stellenangebote finden Sie, wenn Sie hier klicken';
    const page = classifyLiveness({ status: 200, bodyText: text, applyControls: ['Zurück zur Startseite'] });
    expect(page).toMatchObject({ result: 'expired', code: 'expired_body' });
    expect(isHardClosed(page)).toBe(true);
  });

  it('does not close on «kann nicht angezeigt werden» alone, which may be a passing display failure', () => {
    for (const text of ['Diese Stelle kann zurzeit nicht angezeigt werden.', `Diese Stelle kann derzeit nicht angezeigt werden. ${'z '.repeat(200)}`]) {
      const page = classifyLiveness({ status: 200, bodyText: text });
      expect(page.code).not.toBe('expired_body');
      expect(isHardClosed(page)).toBe(false);
    }
  });

  it.each([
    'We retain application information, including after a specific job has been filled, as required by law.',
    'Once a specific job has been filled, application information remains in our records.',
    'When a specific job has been filled, application information remains in our records.',
    'If a specific job has been filled, application information remains in our records.',
    'Application information is retained until a specific job has been filled.',
    'Nachdem die Stelle bereits besetzt wurde, bewahren wir die Unterlagen auf.',
    'Sobald die Stelle bereits besetzt wurde, bewahren wir die Unterlagen auf.',
    'Wenn die Stelle bereits besetzt wurde, bewahren wir die Unterlagen auf.',
    'Dopo che la posizione è stata coperta, conserviamo i dati.',
    'Una volta che la posizione è stata coperta, conserviamo i dati.',
    'Quando la posizione è stata coperta, conserviamo i dati.',
    "Une fois que l'offre a été supprimée, les données sont conservées.",
    "Lorsque l'offre a été supprimée, les données sont conservées.",
    "Après que l'annonce a été supprimée, les données sont conservées.",
  ])('does not treat a conditional or temporal privacy statement as a current closure: «%s»', (text) => {
    const page = classifyLiveness({ status: 200, bodyText: `${text} ${'x '.repeat(200)}`, applyControls: ['Apply'] });
    expect(page).toMatchObject({ result: 'active', code: 'apply_control_visible' });
    expect(isHardClosed(page)).toBe(false);
  });

  it('routes body-confirmed runner IP blocks to egress without misrouting HTTP outages', () => {
    const ipBlocked = classifyLiveness({ status: 200, bodyText: 'Your IP address is blocked' });
    expect(ipBlocked).toMatchObject({ result: 'uncertain', code: 'runner_ip_blocked' });
    expect(initialPortalHandoffReason({ liveness: ipBlocked })).toBe('application_region_unsupported');

    for (const status of [403, 429, 503]) {
      const unavailable = classifyLiveness({ status, bodyText: '' });
      expect(unavailable).toMatchObject({ result: 'uncertain', code: 'access_blocked' });
      expect(initialPortalHandoffReason({ liveness: unavailable })).toBeNull();
    }
    expect(initialPortalHandoffReason({ liveness: { code: 'bot_challenge' } })).toBe('captcha');
  });

  it.each([
    '<label for="application">Application details</label><input id="application" name="application" type="text">',
    '<label for="password">Password</label><input id="password" name="password" type="password">',
    '<label for="attachment">Curriculum Vitae</label><input id="attachment" name="attachment" type="file">',
  ])('does not reclassify a still-interactive form as closed (%s)', async (field) => {
    const landing = `<main><p>Die Stelle wurde leider bereits besetzt.</p><form>${field}<button type="submit">Weiter</button></form></main>`;
    const { result } = await run(landing);
    expect(result.event.type).not.toBe('posting_closed');
  }, 45_000);

  it.each([
    '<label for="query">Search jobs</label><input id="query" name="query" type="search"><button type="submit">Search</button>',
    '<label for="query">Search applications</label><input id="query" name="query" type="search"><button type="submit">Search</button>',
    '<section><h2>Sign in</h2><form><label for="email">Email</label><input id="email" name="email" type="email"></form></section>',
    '<section><h2>Application portal</h2><label for="username">Username</label><input id="username" name="username" type="text"></section>',
  ])('still recognizes a closure when only a non-application field is present (%s)', async (field) => {
    const landing = `<main><p>This job is no longer available.</p><form>${field}</form></main>`;
    const { result } = await run(landing);
    expect(result.event).toMatchObject({ type: 'posting_closed', reason: 'expired_body' });
  }, 45_000);

  it('uses an explicit fetched page language and caller page language for Italian «se»', async () => {
    const url = 'https://jobs.example.test/posting/42';
    const html = `<!doctype html><html lang="fr-CH"><body><p>Cette offre se trouve ici et cette offre n'est plus disponible.</p></body></html>`;
    const result = await checkPostingLiveness({
      order: { jobUrl: url },
      posting: { postingUrl: url },
      fetchImpl: async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
      resolve: async () => [{ address: '93.184.216.34' }],
    });
    expect(result.page).toMatchObject({ result: 'expired', code: 'expired_body' });

    expect(classifyLiveness({
      status: 200,
      locale: 'it-CH',
      bodyText: 'Se la posizione è stata coperta, conserviamo i dati.',
      applyControls: ['Apply'],
    })).toMatchObject({ result: 'active', code: 'apply_control_visible' });
  });

  it('does not let the Italian conditional token suppress a French hard closure', () => {
    expect(classifyLiveness({
      status: 200,
      bodyText: "Cette offre se trouve ici et cette offre n'est plus disponible.",
    })).toMatchObject({ result: 'expired', code: 'expired_body' });
  });

  it.each([
    ['BitNinja Security challenge. Please verify that you are human.', 'bot_challenge'],
    ['Verify you are human to continue.', 'bot_challenge'],
    ['Verifica di essere umano per continuare.', 'bot_challenge'],
    ['Sicherheitsüberprüfung: Bitte bestätigen Sie, dass Sie kein Roboter sind.', 'bot_challenge'],
    ['Complete the CAPTCHA to continue.', 'bot_challenge'],
    ['CAPTCHA verification is required to continue.', 'bot_challenge'],
    ['Il tuo indirizzo IP è stato bloccato da BitNinja.', 'runner_ip_blocked'],
  ])('classifies access challenges without calling the posting closed: «%s»', (text, code) => {
    expect(classifyLiveness({ status: 200, bodyText: text })).toMatchObject({ result: 'uncertain', code });
  });

  it.each([
    'We use CAPTCHA to protect candidate accounts and keep application forms safe.',
    'BitNinja provides security services to our careers website.',
    'If your IP address is blocked, contact support for help.',
    'Candidates may be asked to verify their identity at an interview.',
    'Sicherheitsüberprüfung gehört zu unserem üblichen Einstellungsverfahren.',
  ])('does not mistake ordinary prose for an access challenge: «%s»', (text) => {
    expect(classifyLiveness({ status: 200, bodyText: `${text} ${'x '.repeat(80)}`, applyControls: ['Apply'] }))
      .toMatchObject({ result: 'active', code: 'apply_control_visible' });
  });

  it.each([
    'Diese Stelle kann derzeit nicht angezeigt werden. Sie wurde gelöscht.',
    'Sie können sich nicht mehr auf diese Stelle bewerben.',
    'Die Stelle wurde gelöscht.',
    'Non è più possibile candidarsi per questa posizione.',
    "L'annuncio è stato rimosso.",
    "Il n'est plus possible de postuler à cette offre.",
    "L'annonce a été supprimée.",
    'This position has been closed.',
    'The posting was removed by the employer.',
    'You can no longer apply to this job.',
    'We are no longer accepting applications for this role.',
    'This position has been filled.',
    'Die Stelle wurde bereits besetzt.',
  ])('closes on «%s»', (text) => {
    const page = classifyLiveness({ status: 200, bodyText: `${text} ${'x '.repeat(200)}` });
    expect(page).toMatchObject({ result: 'expired', code: 'expired_body' });
    expect(isHardClosed(page)).toBe(true);
  });

  it.each([
    'Bitte bewerben Sie sich ausschliesslich online; Bewerbungen per Post können wir leider nicht berücksichtigen.',
    'Sie können sich auch ohne Konto bewerben. Die Seite kann auf älteren Browsern nicht korrekt angezeigt werden.',
    'Non è possibile candidarsi via e-mail: usa il modulo online.',
    "Il n'est pas possible de postuler par courrier.",
    'Applications are reviewed on a rolling basis; the position was created in 2025.',
    'You can apply once per role.',
  ])('leaves an open posting open: «%s»', (text) => {
    const page = classifyLiveness({ status: 200, bodyText: `${text} ${'y '.repeat(200)}`, applyControls: ['Jetzt bewerben'] });
    expect(page.result).toBe('active');
    expect(isHardClosed(page)).toBe(false);
  });

  it('ends a run whose registration lands on that page as a closed posting, not as a mismatch', async () => {
    const { result, seen } = await run(STZH_CLOSED);
    expect(seen.created).toBe(1);
    expect(result.evidence.steps[0]?.auth).toMatchObject({ kind: 'create', outcome: 'ok' });
    // The page names no posting: as on the real run, the check after the account reads it as a mismatch.
    expect(result.evidence.postingMatch).toBe('mismatch');
    expect(result.event).toEqual({ type: 'posting_closed', reason: 'expired_body' });
    expect(result.evidence.livenessAtStop).toEqual({ result: 'expired', code: 'expired_body', stop: 'posting_mismatch' });
  }, 45_000);

  it('reads the same page as closed on an owner retry, which skips the posting check (no form left for the candidate)', async () => {
    // submit.mjs: `skipPostingCheck` on a dispatch with reason `owner_retry`.
    const { result } = await run(STZH_CLOSED, { ownerRetry: true });
    expect(result.event).toEqual({ type: 'posting_closed', reason: 'expired_body' });
    expect(result.evidence.livenessAtStop).toEqual({ result: 'expired', code: 'expired_body', stop: 'portal_needs_candidate' });
  }, 45_000);

  it('never calls an open posting behind the registration closed', async () => {
    const { result, seen } = await run(OPEN_POSTING);
    expect(seen.created).toBe(1);
    expect(result.event.type).not.toBe('posting_closed');
    expect(result.evidence.livenessAtStop).toBeUndefined();
  }, 45_000);
});
