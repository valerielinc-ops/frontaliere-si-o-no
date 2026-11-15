import { afterEach, describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import * as portal from '../scripts/assisted-application/lib/portal/portal.mjs';
import { AGENT_SCHEMA, refusal, runAction } from '../scripts/assisted-application/lib/portal/agent.mjs';

const { submitViaPortal, isAgentRecoverableAuthStop } = portal as any;

// The account page's agentic fallback, through the public entry and the real
// handleAuth: a bounded JSDOM stand-in for the browser (as in the privacy
// preflight tests), with an accessibility snapshot whose refs the agent acts on.
// Time only moves through waitForTimeout. No model, no network.
const realNow = Date.now;
afterEach(() => { Date.now = realNow; });

const URL = 'https://career74.sapsf.eu/career?career_ns=job_application';

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

function fakePage(markup: string) {
  const dom = new JSDOM(`<!doctype html><html><head><title>Bewerbungskonto</title></head><body>${markup}</body></html>`, { url: URL, runScripts: 'outside-only' });
  const { window } = dom;
  Object.defineProperty(window.HTMLElement.prototype, 'innerText', { configurable: true, get() { return this.textContent || ''; } });
  window.Element.prototype.getBoundingClientRect = function box(this: any) {
    const size = this.closest('[hidden]') ? 0 : 60;
    return { width: size, height: size } as DOMRect;
  };
  let skew = 0;
  Date.now = () => realNow() + skew;
  const visible = (element: any) => Boolean(element) && !element.closest('[hidden]');
  // `aria-ref=eN` resolves to the element the last snapshot named eN.
  const resolve = (selector: string) => {
    const ref = /^aria-ref=(e\d+)$/.exec(selector)?.[1];
    return ref ? `[data-test-ref="${ref}"]` : selector;
  };
  const locator = (selector: string, index = 0): any => {
    const css = resolve(selector);
    const all = () => [...window.document.querySelectorAll(css)];
    const element = () => {
      const found = all()[index];
      if (!found) throw new Error(`locator.click: ${selector} is gone`);
      return found;
    };
    const input = (target: any, value: string) => {
      target.value = value;
      target.dispatchEvent(new window.Event('input', { bubbles: true }));
      target.dispatchEvent(new window.Event('change', { bubbles: true }));
    };
    const handle: any = {
      first: () => locator(selector, 0),
      last: () => locator(selector, Math.max(0, all().length - 1)),
      nth: (at: number) => locator(selector, at),
      locator: (inner: string) => locator(`${css} ${inner}`),
      filter: () => handle,
      count: async () => all().length,
      waitFor: async ({ state = 'visible' } = {}) => {
        if (state === 'visible' && !visible(all()[index])) throw new Error('locator.waitFor: not visible');
        if (state === 'attached' && !all()[index]) throw new Error('locator.waitFor: not attached');
      },
      isVisible: async () => visible(all()[index]),
      click: async () => {
        const target = element();
        if (target.disabled) throw new Error('locator.click: element is disabled');
        target.click();
      },
      fill: async (value: string) => {
        const target = element();
        if (target.readOnly) throw new Error('locator.fill: element is readonly');
        input(target, value);
      },
      pressSequentially: async (value: string) => {
        const target = element();
        if (target.readOnly) return;
        input(target, `${target.value || ''}${value}`);
      },
      press: async () => {},
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
        if (box.checked !== wanted) box.click();
      },
      isChecked: async () => element().checked,
      evaluate: async (run: any, argument: any) => inWindow(window, () => run(element(), argument)),
      allInnerTexts: async () => all().map((item: any) => item.textContent || ''),
      // Only what is inside this element and visible: a closed list has no option to click.
      getByRole: (role: string, { name = '' }: { name?: string } = {}) => {
        const marker = `data-test-in-${role}`;
        const scope = all()[index];
        for (const item of window.document.querySelectorAll(`[role="${role}"]`)) {
          if (scope?.contains(item) && visible(item) && (!name || item.textContent?.trim() === name)) item.setAttribute(marker, '1');
          else item.removeAttribute(marker);
        }
        return locator(`[${marker}]`);
      },
      getByText: () => locator('[data-test-none]'),
    };
    return handle;
  };
  // Playwright's AI snapshot, reduced to what the agent needs: role, name, value, ref.
  const ariaSnapshot = async () => {
    let ref = 0;
    const lines: string[] = [];
    for (const element of window.document.querySelectorAll('input, select, button, [role="option"], a')) {
      if (!visible(element) || (element as any).type === 'hidden') continue;
      const id = `e${++ref}`;
      element.setAttribute('data-test-ref', id);
      const label = element.id ? window.document.querySelector(`label[for="${element.id}"]`)?.textContent?.trim() : '';
      const name = label || element.getAttribute('aria-label') || element.textContent?.trim() || '';
      const role = element.getAttribute('role') || (element.tagName === 'BUTTON' ? 'button' : element.tagName === 'SELECT' ? 'combobox' : element.tagName === 'A' ? 'link' : 'textbox');
      const value = 'value' in element && (element as any).value ? `: ${(element as any).value}` : '';
      lines.push(`- ${role} "${name}" [ref=${id}]${value}`);
    }
    return lines.join('\n');
  };
  // getByRole('option', { name, exact }): the visible options of that exact name.
  const byRole = (role: string, { name = '' }: { name?: string } = {}) => {
    const marker = `data-test-role-${role}`;
    for (const element of window.document.querySelectorAll(`[role="${role}"]`)) {
      if (visible(element) && (!name || element.textContent?.trim() === name)) element.setAttribute(marker, '1');
      else element.removeAttribute(marker);
    }
    return locator(`[${marker}]`);
  };
  const frame = {
    url: () => window.location.href,
    evaluate: async (run: any, argument: any) => inWindow(window, () => run(argument)),
    locator: (selector: string) => locator(selector),
    getByRole: byRole,
    page: () => page,
  };
  const page: any = {
    keyboard: { press: async () => {} },
    frames: () => [frame],
    mainFrame: () => frame,
    url: () => window.location.href,
    evaluate: (run: any, argument: any) => frame.evaluate(run, argument),
    locator: (selector: string) => locator(selector),
    ariaSnapshot,
    waitForLoadState: async () => {},
    waitForTimeout: async (ms: number) => { skew += ms; },
    getByRole: byRole,
    goto: async () => ({ status: () => 200 }),
    title: async () => 'Bewerbungskonto',
    on: () => {},
    off: () => {},
    screenshot: async () => Buffer.from(''),
  };
  const element = (id: string) => window.document.getElementById(id) as any;
  return { page, window, element };
}

// SuccessFactors' registration, as #17094/#17181 met it: its residence country
// is a custom picklist whose list opens only from its own trigger, and whose
// box drops typed text that is not a committed choice. The deterministic filler
// types and finds no option to click; the agent can open the list and pick.
const SUCCESSFACTORS_REGISTRATION = `<form id="registration" action="/career">
  <label for="email">E-Mail: *</label><input id="email" name="email" type="email" required>
  <label for="emailRepeat">E-Mail wiederholen: *</label><input id="emailRepeat" name="emailRepeat" type="email" required>
  <label for="p1">Passwort: *</label><input id="p1" name="p1" type="password" required>
  <label for="p2">Passwort wiederholen: *</label><input id="p2" name="p2" type="password" required>
  <label for="first">Vorname: *</label><input id="first" name="first" required>
  <label for="last">Nachname: *</label><input id="last" name="last" required>
  <label for="country">Land des Wohnorts: *</label><input id="country" name="country" role="combobox" aria-haspopup="listbox" aria-controls="countryList" autocomplete="off" required>
  <button type="button" id="countryOpen" aria-label="Auswahl öffnen">▾</button>
  <ul role="listbox" id="countryList" hidden><li role="option" id="optCH">Schweiz</li><li role="option" id="optIT">Italien</li></ul>
  <input type="hidden" id="consent" value="">
  <button type="button" id="notice">Lesen und akzeptieren Sie die Datenschutzerklärung</button>
  <button type="button" id="create" disabled>Bewerbungskonto erstellen</button>
</form>
<div role="dialog" id="noticeDialog" hidden><h2>Einverständniserklärung zur Datenschutzrichtlinie</h2><p>Ein synthetischer Text.</p>
  <button type="button" id="noticeAccept">Akzeptieren</button><button type="button" id="noticeRefuse">Ablehnen</button></div>`;

const SIGNED_UP = '<h1>Willkommen</h1><form><label for="motivation">Motivation</label><input id="motivation" name="motivation"><button type="button">Weiter</button></form>';

/** The portal's side: the trigger opens the list, an option commits; privacy frees the CTA; the CTA creates the account. */
function wireSuccessFactors(fixture: ReturnType<typeof fakePage>, { createAnswers = true } = {}) {
  const { element, window } = fixture;
  const seen = { ctaClicks: 0, requests: 0, noticeClicks: 0 };
  element('countryOpen').addEventListener('click', () => { element('countryList').hidden = false; });
  // Typed text is no choice: the picklist drops it.
  element('country').addEventListener('input', () => { element('country').value = ''; });
  for (const option of ['optCH', 'optIT']) {
    element(option).addEventListener('click', () => {
      element('country').value = element(option).textContent;
      element('countryList').hidden = true;
    });
  }
  element('notice').addEventListener('click', () => { seen.noticeClicks += 1; element('noticeDialog').hidden = false; });
  element('noticeAccept').addEventListener('click', () => {
    element('consent').value = '1';
    element('noticeDialog').hidden = true;
    element('create').disabled = false;
  });
  element('create').addEventListener('click', () => {
    seen.ctaClicks += 1;
    const complete = element('consent').value === '1' && element('country').value && element('emailRepeat').value === element('email').value
      && element('p1').value && element('p1').value === element('p2').value;
    if (!complete || !createAnswers) return;
    seen.requests += 1;
    window.document.body.innerHTML = SIGNED_UP;
  });
  return seen;
}

const CANDIDATE = {
  identity: { email: 'candidate@example.test', firstName: 'Test', lastName: 'Kandidat', address: { country: 'CH' } },
  profile: { address: { country: 'Svizzera' } },
};

async function run(fixture: ReturnType<typeof fakePage>, agentTurns: any[], { account = null as any } = {}) {
  const { page } = fixture;
  const accounts: string[] = [];
  const prompts: string[] = [];
  const agentCalls: string[] = [];
  const context: any = { on: () => {}, off: () => {}, pages: () => [page], newPage: async () => page, close: async () => {}, waitForEvent: async () => null, addInitScript: async () => {} };
  page.context = () => context;
  const browser = { newContext: async () => context, close: async () => {}, version: () => '130.0.0.0' };
  const codex = async ({ prompt, schema }: { prompt: string; schema: any }) => {
    prompts.push(prompt);
    if (schema === AGENT_SCHEMA) {
      agentCalls.push(prompt);
      const turn = agentTurns.shift() || { status: 'PARKED', reason: 'PARKED: no more turns', actions: [], advanceRef: '', submitRef: '', questions: [] };
      return typeof turn === 'function' ? turn(prompt) : turn;
    }
    // Question localization: the form is German, as is the candidate's language here.
    if (prompt.includes('You localize questions')) {
      const ids = [...prompt.matchAll(/\\?"id\\?":\\?"([^"\\]+)/g)].map((match) => match[1]);
      return { questions: ids.map((id) => ({ id, sourceLocale: 'de', question: '', why: '', options: [], optionMap: [], validationMessage: '' })) };
    }
    return { actions: [], missingRequired: [] };
  };
  const result = await submitViaPortal({
    applyUrl: page.url(), job: { title: 'Synthetische Rolle', company: 'Beispiel AG' }, language: 'de', candidateLocale: 'de',
    candidate: CANDIDATE, files: {}, skipPostingCheck: true, maxSteps: 1,
    codex, launch: async () => browser,
    accounts: {
      load: async () => account,
      save: async () => { accounts.push('save'); },
      mark: async (_host: string, patch: any) => { accounts.push(`mark:${patch.status || Object.keys(patch)}`); },
      discard: async (_host: string, reason: string) => { accounts.push(`discard:${reason}`); },
    },
  });
  return { result, step: result.evidence.steps[0], accounts, prompts, agentCalls };
}

const refOf = (prompt: string, name: string) => {
  const line = prompt.split('\n').find((item) => item.includes(`"${name}"`));
  const ref = /\[ref=(e\d+)\]/.exec(line || '')?.[1];
  if (!ref) throw new Error(`no ref for ${name}`);
  return ref;
};
const turn = (status: string, actions: any[] = []) => ({ status, reason: '', actions, advanceRef: '', submitRef: '', questions: [] });
const action = (ref: string, kind: string, extra: any = {}) => ({
  ref, action: kind, value: '', document: 'none', question: '', context: '', answer: '', source: 'widget', evidence: '', ...extra,
});

describe('the agentic fallback on the account page', { timeout: 120_000 }, () => {
  it('completes a SuccessFactors registration the deterministic path cannot converge on, and the runner creates the account', async () => {
    const fixture = fakePage(SUCCESSFACTORS_REGISTRATION);
    const seen = wireSuccessFactors(fixture);
    const { step, accounts, prompts, agentCalls } = await run(fixture, [
      // The agent opens the picklist from its trigger and picks the candidate's country, nothing else.
      (prompt: string) => turn('ACT', [action(refOf(prompt, 'Auswahl öffnen'), 'click')]),
      (prompt: string) => turn('ACT', [
        action(refOf(prompt, 'Land des Wohnorts: *'), 'select', { value: 'Schweiz', question: 'Land des Wohnorts', answer: 'Schweiz', source: 'profile' }),
      ]),
      turn('REACHED_FORM'),
    ]);

    expect(agentCalls).toHaveLength(4);
    expect(step.auth).toMatchObject({
      outcome: 'ok',
      privacy: 'accepted',
      agentRecovery: { stop: 'registration_answer_unconfirmed', status: 'REACHED_FORM', outcome: 'ok' },
    });
    expect(step.agent).toEqual([expect.objectContaining({ hint: 'registration_incomplete', status: 'REACHED_FORM' })]);
    // One create click, by the runner, after the credential was saved; the agent pressed none.
    expect(seen).toMatchObject({ ctaClicks: 1, requests: 1 });
    expect(accounts).toEqual(['save', 'mark:created']);
    expect(fixture.window.document.body.innerHTML).toContain('Willkommen');
  });

  it('never shows the agent a password the runner typed', async () => {
    const fixture = fakePage(SUCCESSFACTORS_REGISTRATION);
    wireSuccessFactors(fixture, { createAnswers: false });
    const typed: string[] = [];
    fixture.element('p1').addEventListener('input', () => typed.push(fixture.element('p1').value));
    const { agentCalls } = await run(fixture, [
      (prompt: string) => turn('ACT', [action(refOf(prompt, 'Auswahl öffnen'), 'click')]),
      (prompt: string) => turn('ACT', [
        action(refOf(prompt, 'Land des Wohnorts: *'), 'select', { value: 'Schweiz', question: 'Land des Wohnorts', answer: 'Schweiz', source: 'profile' }),
      ]),
      turn('REACHED_FORM'),
    ]);
    expect(agentCalls.length).toBeGreaterThan(0);
    expect(typed.filter(Boolean).length).toBeGreaterThan(0);
    for (const password of typed.filter(Boolean)) {
      for (const prompt of agentCalls) expect(prompt).not.toContain(password);
    }
  });

  it('refuses the agent the account buttons and the privacy statement: only the runner presses them', async () => {
    const fixture = fakePage(SUCCESSFACTORS_REGISTRATION);
    const seen = wireSuccessFactors(fixture);
    const { step } = await run(fixture, [
      (prompt: string) => turn('ACT', [action(refOf(prompt, 'Bewerbungskonto erstellen'), 'click')]),
      (prompt: string) => turn('ACT', [action(refOf(prompt, 'Lesen und akzeptieren Sie die Datenschutzerklärung'), 'click')]),
    ]);
    const refusals = step.agent.flatMap((agent: any) => agent.rounds.flatMap((round: any) =>
      round.actions.map((result: any) => result.error).filter(Boolean)));
    expect(refusals).toEqual(['final_submit_reserved', 'account_action_reserved']);
    expect(seen).toMatchObject({ ctaClicks: 0, noticeClicks: 0 });
    // Nothing converged: the owner gets the original handoff, with the agent's evidence.
    expect(step.auth).toMatchObject({ outcome: 'portal_needs_candidate', stop: 'registration_answer_unconfirmed', agentRecovery: { status: 'ACCOUNT_STEP' } });
    expect(step.agent).toEqual([expect.objectContaining({ hint: 'registration_incomplete', status: 'ACCOUNT_STEP' })]);
  });

  it('refuses the agent a reserved privacy checkbox or label as it refuses the button', () => {
    expect(refusal({ action: 'click' }, { button: false, inputType: 'checkbox', name: 'I accept' }, { reservedButtons: [/accept/i] })).toBe('account_action_reserved');
    expect(refusal({ action: 'click' }, { button: false, inputType: 'checkbox', name: 'Datenschutzerklärung gelesen' }, { reservedButtons: [/datenschutz/i] })).toBe('account_action_reserved');
    expect(refusal({ action: 'fill', value: 'Rossi' }, { button: false, inputType: 'text', name: 'Nachname', editable: true }, { reservedButtons: [/accept/i] })).toBe('');
    // check/uncheck change the control too; «I accept» is read as «accept».
    expect(refusal({ action: 'check' }, { name: '', labelName: 'I accept', button: false, inputType: 'checkbox' }, { reservedButtons: [/^accept/i] })).toBe('account_action_reserved');
    expect(refusal({ action: 'uncheck' }, { name: '', labelName: 'Ich akzeptiere die Datenschutzerklärung', button: false, inputType: 'checkbox' }, { reservedButtons: [/^akzeptiere/i] })).toBe('account_action_reserved');
  });

  it('refuses a checkbox named only by an external label, through runAction', async () => {
    const { window } = new JSDOM('<label for="privacy">I accept</label><input type="checkbox" id="privacy">');
    const element = window.document.getElementById('privacy')!;
    let clicks = 0;
    const page = { locator: () => ({ evaluate: async (fn: (el: Element) => unknown) => fn(element), click: async () => { clicks += 1; } }) };
    const result = await runAction(page as any, { action: 'click', ref: 'e1' }, {}, { reservedButtons: [/accept/i] });
    expect(result).toEqual({ ok: false, error: 'account_action_reserved' });
    expect(clicks).toBe(0);
  });

  it('turns what the candidate data does not say into a candidate question, never into an answer', async () => {
    // The portal also asks a phone number the candidate data does not hold.
    const fixture = fakePage(SUCCESSFACTORS_REGISTRATION.replace(
      '<input type="hidden" id="consent" value="">',
      '<label for="phone">Telefonnummer</label><input id="phone" name="phone" type="tel" required><input type="hidden" id="consent" value="">',
    ));
    const seen = wireSuccessFactors(fixture);
    const { result, step, accounts } = await run(fixture, [{
      ...turn('NEEDS_CANDIDATE'),
      questions: [{
        question: 'Qual è il tuo numero di telefono?', applicationQuestion: 'Telefonnummer', context: '', why: 'Il portale lo richiede per creare l’account.', type: 'text',
        options: [], applicationOptions: [], optionMap: [],
        validation: { pattern: '', minLength: 0, maxLength: 0, min: null, max: null, minDate: '', example: '', message: '' },
      }],
    }]);
    expect(result.event.type).toBe('submit_needs_candidate');
    expect(result.event.questions.map((item: any) => item.applicationQuestion)).toEqual(['Telefonnummer']);
    expect(step.auth).toMatchObject({ outcome: 'questions', agentRecovery: { stop: 'registration_answer_unconfirmed', status: 'NEEDS_CANDIDATE' } });
    // Nothing was answered for the candidate and nothing pressed: no account, no credential residue.
    expect(fixture.element('phone').value).toBe('');
    expect(seen).toMatchObject({ ctaClicks: 0 });
    expect(accounts).toEqual([]);
  });

  it('is never tried on a stop after the account click: an unanswered creation goes to the owner as it is', async () => {
    const fixture = fakePage(SUCCESSFACTORS_REGISTRATION.replace(
      '<input id="country" name="country" role="combobox" aria-haspopup="listbox" aria-controls="countryList" autocomplete="off" required>',
      '<select id="country" name="country" required><option value="">Bitte wählen</option><option value="CH">Schweiz</option></select>',
    ));
    const seen = wireSuccessFactors(fixture, { createAnswers: false });
    const { step, agentCalls, accounts } = await run(fixture, []);
    expect(seen.ctaClicks).toBe(1);
    expect(step.auth).toMatchObject({ outcome: 'account_create_unanswered' });
    expect(step.auth.agentRecovery).toBeUndefined();
    expect(agentCalls).toHaveLength(0);
    expect(accounts).toEqual(['save', 'mark:unanswered']);
  });

  it('completes a sign-in whose typed values the portal dropped while its notice was open', async () => {
    // A maintenance notice sits over the sign-in form: until it is acknowledged, the form drops what is typed.
    const fixture = fakePage(`<form id="login" action="/career">
      <label for="user">E-Mail: *</label><input id="user" name="user" type="email" required>
      <label for="pass">Passwort: *</label><input id="pass" name="pass" type="password" required>
      <button type="button" id="signIn">Anmelden</button>
    </form>
    <div role="dialog" id="notice"><p>Wartungshinweis: das Portal ist heute Abend kurz nicht erreichbar.</p><button type="button" id="ack">Verstanden</button></div>`);
    const { element, window } = fixture;
    for (const id of ['user', 'pass']) element(id).addEventListener('input', () => { if (!element('notice').hidden) element(id).value = ''; });
    element('ack').addEventListener('click', () => { element('notice').hidden = true; });
    let signIns = 0;
    element('signIn').addEventListener('click', () => {
      signIns += 1;
      if (element('user').value && element('pass').value) window.document.body.innerHTML = SIGNED_UP;
    });
    const account = { email: 'candidate@example.test', password: 'synthetic-secret-1', status: 'created', verifiedAt: 1 };
    const { step, accounts, agentCalls } = await run(fixture, [
      (prompt: string) => turn('ACT', [action(refOf(prompt, 'Verstanden'), 'click')]),
      turn('REACHED_FORM'),
    ], { account });

    expect(step.auth).toMatchObject({ kind: 'sign_in', outcome: 'ok', agentRecovery: { stop: 'sign_in_typing_unconfirmed', status: 'REACHED_FORM', outcome: 'ok' } });
    expect(step.agent).toEqual([expect.objectContaining({ hint: 'sign_in_incomplete', status: 'REACHED_FORM' })]);
    expect(signIns).toBe(1);
    expect(accounts).toEqual(['mark:created']);
    for (const prompt of agentCalls) expect(prompt).not.toContain(account.password);
  });
});

describe('which account stops the fallback may try', () => {
  it.each([
    'registration_replans_exhausted',
    'registration_answer_unconfirmed',
    'registration_surface_unstable',
    'privacy_question_surface_unstable',
    'privacy_question_answer_unconfirmed',
  ])('tries the technical registration stop %s', (authStop) => {
    expect(isAgentRecoverableAuthStop({ handoff: 'portal_needs_candidate', authStop })).toBe(true);
  });

  it('tries a sign-in whose typed values did not stay', () => {
    expect(isAgentRecoverableAuthStop({ handoff: 'account', authStop: 'sign_in_typing_unconfirmed' })).toBe(true);
  });

  it.each([
    [{ handoff: 'portal_ambiguous' }],
    // Even mislabelled as a technical stop, an ambiguous send is never retried.
    [{ handoff: 'portal_ambiguous', authStop: 'registration_answer_unconfirmed' }],
    [{ handoff: 'portal_needs_candidate', authStop: 'registration_surface_moved' }],
    [{ handoff: 'portal_needs_candidate', authStop: 'privacy_question_surface_moved' }],
    [{ handoff: 'portal_needs_candidate' }],
    [{ handoff: 'privacy_not_accepted' }],
    [{ handoff: 'posting_closed' }],
    [{ handoff: 'account_verification' }],
    [{ handoff: 'account_create_unanswered' }],
    [{ handoff: 'account_create_refused' }],
    [{ snapshot: {} }],
  ])('never tries %j', (result) => {
    expect(isAgentRecoverableAuthStop(result)).toBe(false);
  });
});
