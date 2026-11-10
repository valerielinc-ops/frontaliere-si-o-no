import { afterEach, describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import * as portal from '../scripts/assisted-application/lib/portal/portal.mjs';
import { candidateAnswerForField, guardPlan } from '../scripts/assisted-application/lib/portal/plan.mjs';
import { isIdentityEmailConfirmation } from '../functions/src/lib/identityEmail.js';
import { platformCandidateFacts, uploadResidenceCountry } from '../functions/src/assistedApplicationPlatformDefaults.js';

// SuccessFactors «Career Opportunities: Create an Account» (Damiani Group,
// career55.sapsf.eu, run 42798249754, 2026-11-10): «Retype Email Address» stayed
// empty, «Country/Region of Residence» on «Select -», and the privacy statement,
// which the tenant opens only for a chosen country, was never accepted.
const { candidateForForm, submitViaPortal } = portal as any;
const { residenceFieldRole, isIdentityEmailCaption } = (globalThis as any).AssistedApplyControls;


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

// The page as the stop report and the screenshot show it; values are synthetic.
const SF_REGISTRATION = `<h1>Career Opportunities: Create an Account</h1>
<form id="registration" action="/career">
  <div><label for="email">Email Address: *</label><input id="email" name="email" type="text"></div>
  <div><label for="email2">Retype Email Address: *</label><input id="email2" name="email2" type="text"></div>
  <div><label for="p1">Choose Password: *</label><input id="p1" type="password" name="p1"></div>
  <div><label for="p2">Retype Password: *</label><input id="p2" type="password" name="p2"></div>
  <div><label for="first">First Name: *</label><input id="first" name="first" type="text"></div>
  <div><label for="last">Last Name: *</label><input id="last" name="last" type="text"></div>
  <div><label for="country">Country/Region of Residence:*</label><select id="country" name="country"><option value="">Select -</option><option value="CH">Switzerland</option><option value="IT">Italy</option><option value="DE">Germany</option></select></div>
  <div><label for="notify">Notification:</label><input type="checkbox" id="notify" name="notify"> Receive new job posting notifications</div>
  <input type="hidden" id="consent" value="">
  <div><label for="notice">Terms of Use:*</label><a id="notice" role="button" tabindex="0" aria-haspopup="dialog">Read and accept the data privacy statement.</a></div>
  <button type="button" id="create">Create Account</button>
</form>
<div role="dialog" id="noticeDialog" hidden><h2>Data Privacy Statement</h2><p>Synthetic text.</p>
  <button type="button" id="noticeAccept">Accept</button><button type="button" id="noticeRefuse">Decline</button></div>`;

/** The tenant's side: no statement without a country; the account only with every required field. */
function wireSuccessFactors(fixture: ReturnType<typeof fakePage>) {
  const { element, window } = fixture;
  const seen = { noticeClicks: 0, opened: 0, accepted: 0, ctaClicks: 0, created: 0, sent: {} as Record<string, string | boolean> };
  element('notice').addEventListener('click', () => {
    seen.noticeClicks += 1;
    if (!element('country').value) return;
    seen.opened += 1;
    element('noticeDialog').hidden = false;
  });
  element('noticeAccept').addEventListener('click', () => {
    seen.accepted += 1;
    element('consent').value = '1';
    element('noticeDialog').hidden = true;
  });
  element('create').addEventListener('click', () => {
    seen.ctaClicks += 1;
    seen.sent = {
      email: element('email').value,
      email2: element('email2').value,
      country: element('country').value,
      notify: element('notify').checked,
      consent: element('consent').value,
    };
    if (element('consent').value !== '1' || !element('country').value || !element('email2').value
      || element('email2').value !== element('email').value) return;
    seen.created += 1;
    window.document.body.innerHTML = '<h1>Welcome</h1><form><label>First <input name="first"></label><button type="button">Next</button></form>';
  });
  return seen;
}

const EMAIL = 'alias.synthetic@example.test';

// The order's data in the shape the runner receives: the CV states its town, and the platform
// deduces the country from it (platformCandidateFacts).
function sfCandidate() {
  const profile = { address: { city: 'Como', country: '' }, location: 'Como' };
  const facts = platformCandidateFacts({ profile, identity: { firstName: 'Ada' }, locale: 'it', seed: 'synthetic' });
  return candidateForForm({
    identity: { name: 'Ada Esempio', firstName: 'Ada', lastName: 'Esempio', email: EMAIL, phone: '' },
    profile, platformFacts: facts, language: 'en',
  });
}

/** A planner that proposes the obvious values, as the model did on the real run; or one that proposes nothing. */
const plannerProposing = async ({ prompt }: any) => {
  const ids = [...String(prompt).matchAll(/"id":"([^"]+)"[^{}]*?"label":"([^"]+)"/g)].map((match) => [match[1], match[2]]);
  const id = (pattern: RegExp) => ids.find(([, label]) => pattern.test(label))?.[0];
  return {
    actions: [
      { fieldId: id(/^Email Address/), action: 'fill', value: EMAIL, document: 'none', source: 'identity', evidence: '' },
      { fieldId: id(/^Retype Email Address/), action: 'fill', value: EMAIL, document: 'none', source: 'identity', evidence: '' },
      { fieldId: id(/^First Name/), action: 'fill', value: 'Ada', document: 'none', source: 'identity', evidence: '' },
      { fieldId: id(/^Last Name/), action: 'fill', value: 'Esempio', document: 'none', source: 'identity', evidence: '' },
      { fieldId: id(/^Country\/Region of Residence/), action: 'select', value: 'Italy', document: 'none', source: 'profile', evidence: '' },
    ].filter((action) => action.fieldId),
    missingRequired: [],
  };
};
const plannerSilent = async () => ({ actions: [], missingRequired: [] });

async function register(codex: (input: any) => Promise<any>) {
  const fixture = fakePage([SF_REGISTRATION], { url: 'https://career55.sapsf.eu/career' });
  const seen = wireSuccessFactors(fixture);
  const { page } = fixture;
  const context: any = { on: () => {}, off: () => {}, pages: () => [page], newPage: async () => page, close: async () => {}, waitForEvent: async () => null, addInitScript: async () => {} };
  page.context = () => context;
  const browser = { newContext: async () => context, close: async () => {}, version: () => '130.0.0.0' };
  const accounts: string[] = [];
  const result = await submitViaPortal({
    applyUrl: page.url(), job: { title: 'Synthetic role', company: 'Example SpA' }, language: 'en', candidateLocale: 'en',
    candidate: sfCandidate(), files: {}, skipPostingCheck: true, maxSteps: 1, codex, launch: async () => browser,
    accounts: {
      load: async () => null,
      save: async () => { accounts.push('save'); },
      mark: async (_host: string, patch: any) => { accounts.push(`mark:${patch.status || Object.keys(patch)}`); },
      discard: async (_host: string, reason: string) => { accounts.push(`discard:${reason}`); },
    },
  });
  return { auth: result.evidence.steps[0]?.auth, reason: result.event.reason, seen, accounts };
}

describe('SuccessFactors registration: country, retyped e-mail, then the privacy statement', () => {
  it.each([['the planner proposes the values', plannerProposing], ['the planner proposes nothing', plannerSilent]])(
    'chooses the country before the notice, accepts it and retypes the e-mail when %s', async (_name, codex) => {
      const { auth, reason, seen, accounts } = await register(codex as (input: any) => Promise<any>);
      expect(reason).not.toBe('privacy_not_accepted');
      expect(auth).toMatchObject({ kind: 'create', outcome: 'ok', privacy: 'accepted' });
      // The statement opened at the first click: the country was already chosen.
      expect(seen).toMatchObject({ noticeClicks: 1, opened: 1, accepted: 1, ctaClicks: 1, created: 1 });
      expect(seen.sent).toEqual({ email: EMAIL, email2: EMAIL, country: 'IT', notify: false, consent: '1' });
      expect(accounts).toEqual(['save', 'mark:created']);
    });
});

describe('the labels of the page', () => {
  it.each([
    'Country/Region of Residence:*', 'Country / Region of Residence', 'Country or region of residence', 'Country of domicile',
    'Paese/Regione di residenza:*', 'Pays/Région de résidence :*', 'Land/Region des Wohnorts:*',
  ])('reads %s as the residence country', (caption) => {
    expect(residenceFieldRole(caption)).toBe('country');
  });

  it.each([
    'Retype Email Address: *', 'Re-type email address', 'Re-enter your email address', 'Type your email again',
    'Verify email', 'Confirm e-mail', 'E-Mail-Adresse wiederholen', 'E-Mail-Adresse erneut eingeben', 'E-Mail-Bestätigung',
    'Conferma indirizzo e-mail', 'Ripetere l\'indirizzo e-mail', 'Reinserisci e-mail', 'Ridigita indirizzo e-mail', 'Inserisci di nuovo l\'e-mail',
    'Confirmez votre adresse e-mail', 'Ressaisissez l\'adresse e-mail', 'Saisissez à nouveau votre courriel', 'Répétez votre e-mail',
  ])('reads %s as the applicant\'s e-mail asked again', (label) => {
    expect(isIdentityEmailConfirmation({ label, context: 'Email Address: *' })).toBe(true);
  });

  it.each([
    ['the first e-mail field', 'Email Address: *'],
    ['a code sent to the e-mail', 'Email verification code'],
    ['a German code', 'E-Mail-Bestätigungscode'],
    ['a referee', 'Confirm referee email'],
    ['a retyped password', 'Retype Password: *'],
  ])('does not read %s as the e-mail asked again', (_name, label) => {
    expect(isIdentityEmailConfirmation({ label, context: 'Email Address: * · Retype Email Address: *' })).toBe(false);
  });

  it('keeps «Retype Email Address» out of the postal address and gives it the e-mail', () => {
    expect(isIdentityEmailCaption('Retype Email Address: *')).toBe(true);
    const candidate = sfCandidate();
    const field = { id: 'email2', kind: 'text', inputType: 'text', label: 'Retype Email Address: *', required: true, context: 'Career Opportunities: Create an Account', addressContext: { section: '', owners: [], unknown: false } };
    expect(candidateAnswerForField(candidate, field)).toEqual({ value: EMAIL, source: 'identity' });
    // The planner's own proposal for the field survives the guard: it is not an address to prove.
    const guarded = guardPlan({ actions: [{ fieldId: 'email2', action: 'fill', value: EMAIL, document: 'none', source: 'identity', evidence: '' }], missingRequired: [] }, [field], candidate);
    expect(guarded.actions).toEqual([expect.objectContaining({ fieldId: 'email2', action: 'fill', value: EMAIL })]);
    expect(guarded.missingRequired).toEqual([]);
  });
});

describe('the residence country without a town in the CV (owner decision 2026-11-10)', () => {
  const facts = (candidateFacts: any, profile: any = {}) => platformCandidateFacts({ order: { candidateFacts }, profile, locale: 'en', seed: 'synthetic' });

  it('keeps the town\'s country first, then the country the CV states', () => {
    expect(facts({ workPermit: 'permit_b', passport: 'eu_efta', nationality: 'italiana' }, { location: 'Lugano' }).address.country).toBe('CH');
    expect(facts({ workPermit: 'permit_g', passport: 'eu_efta', nationality: 'tedesca' }, { address: { city: 'Como' } }).address.country).toBe('IT');
    expect(facts({ workPermit: 'permit_b', passport: 'eu_efta', nationality: 'italiana' }, { address: { country: 'Italia' } }).address.country).toBe('IT');
  });

  it('takes a Swiss residence permit as Switzerland, any other answer as the nationality\'s country', () => {
    expect(uploadResidenceCountry({ workPermit: 'permit_c', nationality: 'italiana' })).toBe('CH');
    expect(uploadResidenceCountry({ workPermit: 'permit_l', nationality: 'italiana' })).toBe('CH');
    expect(uploadResidenceCountry({ workPermit: 'permit_g', nationality: 'italiana' })).toBe('IT');
    expect(uploadResidenceCountry({ workPermit: 'none', nationality: 'Deutsch' })).toBe('DE');
    expect(uploadResidenceCountry({ workPermit: 'swiss', nationality: 'svizzera' })).toBe('CH');
    // A country the platform cannot name on a form stays the candidate's question.
    expect(uploadResidenceCountry({ workPermit: 'permit_g', nationality: 'spagnola' })).toBe('');
    expect(uploadResidenceCountry({})).toBe('');
    const deduced = facts({ workPermit: 'permit_g', passport: 'eu_efta', nationality: 'italiana' });
    expect(deduced.address).toMatchObject({ country: 'IT', countryName: 'Italy', city: '' });
  });

  it('brings that country to the form even without a town', () => {
    const platformFacts = facts({ workPermit: 'permit_g', passport: 'eu_efta', nationality: 'italiana' });
    const candidate = candidateForForm({ identity: { name: 'Ada Esempio', email: EMAIL }, profile: {}, platformFacts, language: 'en' });
    expect(candidate.identity.address.country).toBe('Italy');
    const field = { id: 'country', kind: 'select', label: 'Country/Region of Residence:*', required: true, addressContext: { section: 'Personal information', owners: ['Personal information'], unknown: false },
      options: [{ value: '', label: 'Select -' }, { value: 'CH', label: 'Switzerland' }, { value: 'IT', label: 'Italy' }] };
    expect(candidateAnswerForField(candidate, field)?.value).toBe('Italy');
  });
});
