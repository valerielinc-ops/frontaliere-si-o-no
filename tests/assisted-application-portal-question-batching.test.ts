import { afterEach, describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { handleAuth, portalRequirementsFromMissingRequired, submitViaPortal } from '../scripts/assisted-application/lib/portal/portal.mjs';
import { extractFields } from '../scripts/assisted-application/lib/portal/fields.mjs';
import { guardPlan } from '../scripts/assisted-application/lib/portal/plan.mjs';

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

function fakePage({ multiStep = false, conditional = true, registration = false, privacyRevealsUnknown = false, privacyRevealsRequiredFile = false, privacyRevealsKnownAnswer = false, uploadRevealsUnknown = false, workdayUploadUnconfirmed = false, passwordRevealsUnknown = false, asyncRevealsUnknown = false, asyncDescriptionChanges = false, asyncValueChanges = false } = {}) {
  const privacyReveals = privacyRevealsUnknown || privacyRevealsRequiredFile || privacyRevealsKnownAnswer;
  const url = workdayUploadUnconfirmed ? 'https://acme.wd1.myworkdayjobs.com/apply' : 'https://careers.example.test/apply';
  const uploadedReceipts = new Set<string>();
  let uploadQuestionRevealed = false;
  const credentials = registration
    ? '<label for="password">Password *</label><input id="password" type="password" name="password" required><label for="password-confirm">Confirm password *</label><input id="password-confirm" type="password" name="password-confirm" required>'
    : '';
  const form = multiStep
    ? `<form action="/apply" aria-label="Personal information" data-page="1">
        <label for="country">Country of residence *</label>
        <select id="country" name="country" required><option value="">Choose one</option><option value="IT">Italy</option><option value="CH">Switzerland</option></select>
        <button id="next" type="button">Next</button>
      </form>`
    : `<form action="/apply" aria-label="Personal information">${credentials}
        ${uploadRevealsUnknown ? '<label for="resume">Upload your CV *</label><input id="resume" type="file" name="resume" required>' : ''}
        <label for="country">Country of residence *</label>
        <select id="country" name="country" required><option value="">Choose one</option><option value="IT">Italy</option><option value="CH">Switzerland</option></select>
        <label for="motivation">Why are you interested in this role? *</label><textarea id="motivation" name="motivation" required></textarea>
        ${privacyReveals ? '<a id="privacy" href="#">Read and accept the privacy policy</a>' : ''}
        ${registration ? `<button id="create" type="button">Create account</button>${privacyReveals ? '<button id="submit" type="button">Submit application</button>' : ''}` : '<button id="next" type="button">Next</button>'}
      </form>`;
  const dom = new JSDOM(`<!doctype html><html><body>${form}</body></html>`, { url, runScripts: 'outside-only' });
  const { window } = dom;
  if (privacyReveals && !(window as any).CSS?.escape) {
    Object.defineProperty(window, 'CSS', { configurable: true, value: { escape: (value: string) => value } });
  }
  const extractionTrace: any[] = [];
  const ctaClicks: string[] = [];
  let currentUrl = url;
  let frameReadFailures = 0;
  Object.defineProperty(window.HTMLElement.prototype, 'innerText', { configurable: true, get() { return this.textContent || ''; } });
  window.Element.prototype.getBoundingClientRect = function box(this: any) {
    const size = this.closest('[hidden]') ? 0 : 60;
    return { width: size, height: size } as DOMRect;
  };

  let skew = 0;
  const timers: Array<{ at: number; run: () => void }> = [];
  const element = (selector: string) => window.document.querySelector(selector) as any;
  if (privacyReveals) {
    element('#country').value = 'IT';
    element('#motivation').value = 'Synthetic interest';
  }
  const locator = (selector: string) => {
    const target = () => {
      const found = element(selector);
      if (!found) throw new Error(`locator: ${selector} is gone`);
      return found;
    };
    const handle: any = {
      first: () => handle,
      count: async () => window.document.querySelectorAll(selector).length,
      click: async () => target().click(),
      fill: async (value: string) => {
        target().value = value;
        target().dispatchEvent(new window.Event('input', { bubbles: true }));
        target().dispatchEvent(new window.Event('change', { bubbles: true }));
      },
      inputValue: async () => target().value,
      selectOption: async ({ label, value }: { label?: string; value?: string }) => {
        const select = target();
        const option = [...select.options].find((item: any) => (label && item.label === label) || (value && item.value === value));
        if (!option) throw new Error('option not found');
        select.value = option.value;
        select.dispatchEvent(new window.Event('change', { bubbles: true }));
        return [option.value];
      },
      setChecked: async (wanted: boolean) => { const box = target(); if (box.checked !== wanted) box.click(); },
      isChecked: async () => target().checked,
      setInputFiles: async (files: string | string[]) => {
        const names = (Array.isArray(files) ? files : [files]).map((file) => file.split('/').at(-1) || file);
        for (const name of names) uploadedReceipts.add(name);
        if (uploadRevealsUnknown && !uploadQuestionRevealed) {
          uploadQuestionRevealed = true;
          element('form')?.insertAdjacentHTML('beforeend', '<label for="certification">Which professional certification do you hold? *</label><input id="certification" name="certification" required>');
        }
      },
      evaluate: async (run: any, argument: any) => inWindow(window, () => run(target(), argument)),
      allInnerTexts: async () => [...window.document.querySelectorAll(selector)].map((item: any) => item.textContent || ''),
    };
    return handle;
  };
  const frame: any = {
    url: () => currentUrl,
    evaluate: async (run: any, argument: any) => inWindow(window, () => {
      const result = run(argument);
      if (result && Array.isArray(result.fields) && Array.isArray(result.buttons)) {
        const snapshot = {
          fields: result.fields.map(({ id, kind, label, required, value, options, context }: any) => ({
            id, kind, label, required, value, context,
            options: Array.isArray(options) ? options.map((option: any) => typeof option === 'string' ? option : option.label) : undefined,
          })),
          buttons: result.buttons.map(({ id, text }: any) => ({ id, text })),
        };
        if (JSON.stringify(extractionTrace.at(-1)) !== JSON.stringify(snapshot)) extractionTrace.push(snapshot);
      }
      return result;
    }),
    locator,
  };
  const page: any = {
    frames: () => {
      if (frameReadFailures > 0) {
        frameReadFailures -= 1;
        throw new Error('synthetic frame read failure');
      }
      return [frame];
    },
    mainFrame: () => frame,
    url: () => currentUrl,
    evaluate: frame.evaluate,
    locator,
    waitForLoadState: async () => {},
    waitForTimeout: async (ms: number) => {
      skew += ms;
      while (true) {
        const index = timers.findIndex((timer) => timer.at <= skew);
        if (index < 0) break;
        timers.splice(index, 1)[0].run();
      }
    },
    getByRole: () => {
      const handle: any = { first: () => handle, filter: () => handle, waitFor: async () => { throw new Error('not found'); }, isVisible: async () => false };
      return handle;
    },
    getByText: (text: string) => ({ first: () => ({ isVisible: async () => uploadedReceipts.has(String(text)), waitFor: async () => { throw new Error('not found'); } }) }),
    after: (ms: number, run: () => void) => timers.push({ at: skew + ms, run }),
    goto: async (target: string) => { currentUrl = target; return { status: () => 200 }; },
    setUrl: (target: string) => { currentUrl = target; },
    failFrameReads: (count: number) => { frameReadFailures = count; },
    title: async () => '',
    on: () => {},
    off: () => {},
    screenshot: async () => Buffer.from(''),
  };

  if (multiStep) {
    let pageNumber = 1;
    let cityAdded = false;
    let postalAdded = false;
    let availabilityAdded = false;
    const formElement = element('form');
    formElement.addEventListener('change', (event: any) => {
      if (event.target.id !== 'country' || event.target.value !== 'IT') return;
      if (pageNumber === 1 && !cityAdded) {
        cityAdded = true;
        formElement.insertAdjacentHTML('beforeend', '<label for="city">City of residence *</label><input id="city" name="city" required>');
      } else if (pageNumber === 2 && !availabilityAdded) {
        availabilityAdded = true;
        formElement.insertAdjacentHTML('beforeend', '<label for="availability">When could you start? *</label><input id="availability" name="availability" required>');
      }
    });
    formElement.addEventListener('input', (event: any) => {
      if (pageNumber !== 1 || event.target.id !== 'city' || postalAdded) return;
      postalAdded = true;
      formElement.insertAdjacentHTML('beforeend', '<label for="postal">Postal code *</label><input id="postal" name="postal" required>');
    });
    formElement.addEventListener('click', (event: any) => {
      if (event.target.id !== 'next' || pageNumber !== 1) return;
      pageNumber = 2;
      formElement.dataset.page = '2';
      formElement.innerHTML = `<label for="country">Country of residence *</label>
        <select id="country" name="country" required><option value="">Choose one</option><option value="IT">Italy</option><option value="CH">Switzerland</option></select>
        <button id="next" type="button">Next</button>`;
    });
  } else {
    if (registration) {
      element('#create').addEventListener('click', () => { element('#create').dataset.clicked = 'true'; ctaClicks.push('create'); });
      element('#submit')?.addEventListener('click', () => { element('#submit').dataset.clicked = 'true'; ctaClicks.push('submit'); });
      if (passwordRevealsUnknown) {
        element('#password-confirm').addEventListener('change', () => {
          if (!element('#password-question')) {
            element('form')?.insertAdjacentHTML('beforeend', '<label for="password-question">Which security clearance do you hold? *</label><input id="password-question" name="password-question" required>');
          }
        });
      }
    }
    else element('#next').addEventListener('click', () => { element('#next').dataset.clicked = 'true'; });
    if (privacyReveals) {
      element('#privacy').addEventListener('click', (event: any) => {
        event.preventDefault();
        const formElement = element('form');
        formElement.insertAdjacentHTML('beforeend', `<div id="privacy-dialog" role="dialog" aria-modal="true" aria-label="Privacy Policy">
          <h2>Privacy Policy</h2>
          <label for="privacy-reviewed">I have read and accept the privacy policy</label>
          <input id="privacy-reviewed" name="privacy-reviewed" type="checkbox" required>
          <button id="privacy-accept" type="button" disabled>Accept</button>
        </div>`);
        const review = element('#privacy-reviewed');
        const accept = element('#privacy-accept');
        review.addEventListener('change', () => { accept.disabled = !review.checked; });
        accept.addEventListener('click', () => {
          element('#privacy-dialog').remove();
          element('#privacy')?.remove();
          formElement.insertAdjacentHTML('beforeend', privacyRevealsRequiredFile
            ? '<label for="required-cv">Curriculum Vitae *</label><input id="required-cv" name="required-cv" type="file" required>'
            : privacyRevealsKnownAnswer
              ? '<label for="origin-region">Region of origin *</label><select id="origin-region" name="origin-region" required><option value="">Choose one</option><option value="TI">Ticino</option><option value="LO">Lombardy</option></select>'
              : '<label for="unknown-requirement">Which professional certification do you hold? *</label><input id="unknown-requirement" name="unknown-requirement" required>');
          if (privacyRevealsKnownAnswer) {
            element('#origin-region').addEventListener('change', () => {
              if (element('#origin-region').value === 'LO' && !element('#origin-question')) {
                formElement.insertAdjacentHTML('beforeend', '<label for="origin-question">Which certification is recognized in Lombardy? *</label><input id="origin-question" name="origin-question" required>');
              }
            });
          }
        });
      });
    }
    if (conditional) {
      let revealedAuthorization = false;
      let scheduledAvailability = false;
      element('#country').addEventListener('change', () => {
        if (element('#country').value !== 'IT' || revealedAuthorization) return;
        revealedAuthorization = true;
        const formElement = element('form');
        formElement.insertAdjacentHTML('beforeend', '<label for="authorization">Which work authorization do you hold? *</label><input id="authorization" name="authorization" required>');
        if (!scheduledAvailability) {
          scheduledAvailability = true;
          page.after(4500, () => formElement.insertAdjacentHTML('beforeend', '<label for="availability">When could you start? *</label><input id="availability" name="availability" required>'));
        }
      });
    }
  }
  if (asyncRevealsUnknown) {
    page.after(3500, () => element('form')?.insertAdjacentHTML('beforeend', '<label for="late-question">Which professional certification do you hold? *</label><input id="late-question" name="late-question" required>'));
  }
  if (asyncDescriptionChanges) {
    // Use the generated machine label so the question must come from the
    // updated live description, not from planner-authored replacement text.
    element('label[for="motivation"]').textContent = 'textarea_123';
    page.after(3500, () => element('#motivation')?.setAttribute('aria-description', 'Describe your experience leading regional teams.'));
  }
  if (asyncValueChanges) {
    page.after(3500, () => {
      const field = element('#motivation');
      if (!field) return;
      field.value = 'Autofilled by the application';
      field.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  }
  return { page, window, extractionTrace, ctaClicks };
}

it('gives a replaced file input a new control identity even when its data-aa-id is reused', async () => {
  const fixture = fakePage({ conditional: false });
  const { page, window } = fixture;
  const form = window.document.querySelector('form')!;
  form.insertAdjacentHTML('beforeend', '<label for="cv">CV *</label><input id="cv" data-aa-id="reused-cv" type="file" required>');

  const first = await extractFields(page, { listboxOptions: false });
  const firstFile = first.fields.find((field: any) => field.inputType === 'file')!;
  const replacement = window.document.createElement('input');
  replacement.id = 'cv';
  replacement.setAttribute('data-aa-id', 'reused-cv');
  replacement.type = 'file';
  replacement.required = true;
  window.document.getElementById('cv')!.replaceWith(replacement);

  const second = await extractFields(page, { listboxOptions: false });
  const secondFile = second.fields.find((field: any) => field.inputType === 'file')!;
  expect(secondFile.id).toBe(firstFile.id);
  expect(secondFile.controlInstance).not.toBe(firstFile.controlInstance);
});

function portalRunSummary(result: any, plannerTrace: any[] = [], extractionTrace: any[] = []) {
  const steps = result.evidence.steps.map(({ step, fields, actions, redrawn, url, errors }: any) => ({
    step, fields, actions, redrawn, url, errors,
  }));
  const report = result.evidence.stopReport;
  const stopReport = report ? {
    reason: report.reason,
    step: report.step,
    buttons: report.buttons,
    fields: report.fields?.map(({ label, kind, required }: any) => ({ label, kind, required })),
    errors: report.errors,
    agent: report.agent,
  } : undefined;
  return JSON.stringify({ event: result.event, steps, stopReport, plannerTrace, extractionTrace });
}

describe('assisted portal question batching', () => {
  it('replans after privacy acceptance and does not create an account when it reveals an unknown required answer', async () => {
    const fixture = fakePage({ registration: true, privacyRevealsUnknown: true });
    const { page, window, ctaClicks } = fixture;
    const candidate = { identity: { email: 'candidate@example.test' }, profile: {} };
    const fieldId = (id: string) => window.document.getElementById(id)?.getAttribute('data-aa-id') || '';
    let plannerCalls = 0;
    const codex = async ({ prompt }: any) => {
      if (JSON.stringify(prompt).includes('You localize questions from an online job application')) return { questions: [] };
      plannerCalls += 1;
      return {
        actions: [],
        missingRequired: plannerCalls > 1
          ? [{ fieldId: fieldId('unknown-requirement'), question: 'Which professional certification do you hold?', why: '', type: 'text', options: [] }]
          : [],
      };
    };
    const accountEvents: string[] = [];
    const result = await handleAuth({
      page,
      snapshot: await extractFields(page, { listboxOptions: false }),
      ctx: {
        candidate,
        candidateLocale: 'en',
        language: 'en',
        files: {},
        codex,
        accounts: {
          load: async () => null,
          save: async () => { accountEvents.push('save'); },
          mark: async () => { accountEvents.push('mark'); },
          discard: async () => { accountEvents.push('discard'); },
        },
      },
    });

    expect(plannerCalls).toBe(2);
    expect(result.questions.map((question: any) => question.applicationQuestion)).toEqual([
      'Which professional certification do you hold? *',
    ]);
    expect(window.document.getElementById('privacy-dialog')).toBeNull();
    expect(window.document.getElementById('unknown-requirement')).not.toBeNull();
    expect(window.document.getElementById('create')?.getAttribute('data-clicked')).not.toBe('true');
    expect(window.document.getElementById('submit')?.getAttribute('data-clicked')).not.toBe('true');
    expect(ctaClicks).toEqual([]);
    // A candidate-question handoff happens before credentials are persisted.
    expect(accountEvents).toEqual([]);
  });

  it('batches already visible hard questions with hard questions revealed by privacy acceptance', async () => {
    const fixture = fakePage({ registration: true, privacyRevealsUnknown: true });
    const { page, window } = fixture;
    const candidate = { identity: { email: 'candidate@example.test' }, profile: {} };
    const form = window.document.querySelector('form')!;
    form.insertAdjacentHTML('beforeend', '<label for="initial-requirement">When could you start?</label><input id="initial-requirement" name="initial-requirement" required>');
    const fieldId = (id: string) => window.document.getElementById(id)?.getAttribute('data-aa-id') || '';
    let plannerCalls = 0;
    const codex = async ({ prompt }: any) => {
      if (JSON.stringify(prompt).includes('You localize questions from an online job application')) return { questions: [] };
      plannerCalls += 1;
      const missingRequired = [
        { fieldId: fieldId('initial-requirement'), question: 'When could you start?', why: '', type: 'text', options: [] },
      ];
      if (plannerCalls > 1) missingRequired.push({
        fieldId: fieldId('unknown-requirement'), question: 'Which professional certification do you hold?', why: '', type: 'text', options: [],
      });
      return { actions: [], missingRequired };
    };
    const accountEvents: string[] = [];
    const result = await handleAuth({
      page,
      snapshot: await extractFields(page, { listboxOptions: false }),
      ctx: {
        candidate,
        candidateLocale: 'en',
        language: 'en',
        files: {},
        codex,
        accounts: {
          load: async () => null,
          save: async () => { accountEvents.push('save'); },
          mark: async () => { accountEvents.push('mark'); },
          discard: async () => { accountEvents.push('discard'); },
        },
      },
    });

    expect(plannerCalls).toBe(2);
    expect(result.questions.map((question: any) => question.applicationQuestion)).toEqual([
      'When could you start?',
      'Which professional certification do you hold? *',
    ]);
    expect(window.document.getElementById('privacy-dialog')).toBeNull();
    expect(window.document.getElementById('unknown-requirement')).not.toBeNull();
    expect(window.document.getElementById('create')?.getAttribute('data-clicked')).not.toBe('true');
    expect(window.document.getElementById('submit')?.getAttribute('data-clicked')).not.toBe('true');
    expect(accountEvents).toEqual([]);
  });

  it('hands off a required CV revealed by privacy when no verified upload is available', async () => {
    const fixture = fakePage({ registration: true, privacyRevealsRequiredFile: true });
    const { page, window, ctaClicks } = fixture;
    const candidate = { identity: { email: 'candidate@example.test' }, profile: {} };
    const fieldId = (id: string) => window.document.getElementById(id)?.getAttribute('data-aa-id') || '';
    let plannerCalls = 0;
    const codex = async ({ prompt }: any) => {
      if (JSON.stringify(prompt).includes('You localize questions from an online job application')) return { questions: [] };
      plannerCalls += 1;
      return {
        actions: [],
        missingRequired: plannerCalls > 1
          ? [{ fieldId: fieldId('required-cv'), question: 'Curriculum Vitae', why: '', type: 'text', options: [] }]
          : [],
      };
    };
    const accountEvents: string[] = [];
    const result = await handleAuth({
      page,
      snapshot: await extractFields(page, { listboxOptions: false }),
      ctx: {
        candidate,
        candidateLocale: 'en',
        language: 'en',
        files: {},
        codex,
        accounts: {
          load: async () => null,
          save: async () => { accountEvents.push('save'); },
          mark: async () => { accountEvents.push('mark'); },
          discard: async () => { accountEvents.push('discard'); },
        },
      },
    });

    expect(plannerCalls).toBe(2);
    expect(result.handoff).toBe('portal_required_file_unhandled');
    expect(window.document.getElementById('create')?.getAttribute('data-clicked')).not.toBe('true');
    expect(window.document.getElementById('submit')?.getAttribute('data-clicked')).not.toBe('true');
    expect(ctaClicks).toEqual([]);
    expect(accountEvents).toEqual([]);
  });

  it('replans a registration after known answers reveal conditional questions before asking the candidate', async () => {
    const fixture = fakePage({ registration: true });
    const { page, window } = fixture;
    const candidate = { identity: { email: 'candidate@example.test', address: { country: 'Italia' } }, profile: {} };
    const fieldId = (id: string) => window.document.getElementById(id)?.getAttribute('data-aa-id') || '';
    let plannerCalls = 0;
    const codex = async ({ prompt }: any) => {
      if (JSON.stringify(prompt).includes('You localize questions from an online job application')) return { questions: [] };
      plannerCalls += 1;
      const missingRequired = [
        { fieldId: fieldId('motivation'), question: 'Why are you interested in this role?', why: '', type: 'text', options: [] },
      ];
      if (plannerCalls > 1) {
        missingRequired.push(
          { fieldId: fieldId('authorization'), question: 'Which work authorization do you hold?', why: '', type: 'text', options: [] },
          { fieldId: fieldId('availability'), question: 'When could you start?', why: '', type: 'text', options: [] },
        );
      }
      return {
        actions: plannerCalls === 1
          ? [{ fieldId: fieldId('country'), action: 'select', value: 'Italia', document: 'none', source: 'identity', evidence: '' }]
          : [],
        missingRequired,
      };
    };
    const accountEvents: string[] = [];
    const snapshot = await extractFields(page, { listboxOptions: false });
    const result = await handleAuth({
      page,
      snapshot,
      ctx: {
        candidate,
        candidateLocale: 'en',
        language: 'en',
        files: {},
        codex,
        accounts: {
          load: async () => null,
          save: async () => { accountEvents.push('save'); },
          mark: async () => { accountEvents.push('mark'); },
          discard: async () => { accountEvents.push('discard'); },
        },
      },
    });

    expect(plannerCalls).toBe(3);
    expect(elementValue(window, '#country')).toBe('IT');
    expect(result.questions.map((question: any) => question.applicationQuestion)).toEqual([
      'Why are you interested in this role? *',
      'Which work authorization do you hold? *',
      'When could you start? *',
    ]);
    expect(window.document.getElementById('create')?.getAttribute('data-clicked')).not.toBe('true');
    expect(accountEvents).toEqual([]);
  });

  it('replans after a successful CV upload reveals a hard required question', async () => {
    const fixture = fakePage({ registration: true, uploadRevealsUnknown: true });
    const { page, window } = fixture;
    (window.document.getElementById('country') as HTMLSelectElement).value = 'IT';
    (window.document.getElementById('motivation') as HTMLTextAreaElement).value = 'I want this role.';
    const fieldId = (id: string) => window.document.getElementById(id)?.getAttribute('data-aa-id') || '';
    let plannerCalls = 0;
    const codex = async ({ prompt }: any) => {
      if (JSON.stringify(prompt).includes('You localize questions from an online job application')) return { questions: [] };
      plannerCalls += 1;
      return {
        actions: plannerCalls === 1
          ? [{ fieldId: fieldId('resume'), action: 'upload', document: 'cv', source: 'candidate_document', evidence: '' }]
          : [],
        missingRequired: plannerCalls > 1
          ? [{ fieldId: fieldId('certification'), question: 'Which professional certification do you hold?', why: '', type: 'text', options: [] }]
          : [],
      };
    };
    const result = await handleAuth({
      page,
      snapshot: await extractFields(page, { listboxOptions: false }),
      ctx: {
        candidate: { identity: { email: 'candidate@example.test' }, profile: {} },
        candidateLocale: 'en',
        language: 'en',
        files: { cv: '/tmp/cv.pdf' },
        codex,
        accounts: {
          load: async () => null,
          save: async () => {},
          mark: async () => {},
          discard: async () => {},
        },
      },
    });

    expect(plannerCalls).toBe(2);
    expect(result.questions.map((question: any) => question.applicationQuestion)).toEqual([
      'Which professional certification do you hold? *',
    ]);
    expect(window.document.getElementById('create')?.getAttribute('data-clicked')).not.toBe('true');
  });

  it('does not treat a Workday file selection without an upload receipt as complete', async () => {
    const fixture = fakePage({ registration: true, uploadRevealsUnknown: true, workdayUploadUnconfirmed: true });
    const { page, window, ctaClicks } = fixture;
    let clock = realNow();
    Date.now = () => clock;
    const waitForTimeout = page.waitForTimeout;
    page.waitForTimeout = async (ms: number) => {
      clock += ms;
      await waitForTimeout(ms);
    };
    const fieldId = (id: string) => window.document.getElementById(id)?.getAttribute('data-aa-id') || '';
    const codex = async ({ prompt }: any) => {
      if (JSON.stringify(prompt).includes('You localize questions from an online job application')) return { questions: [] };
      return {
        actions: [{ fieldId: fieldId('resume'), action: 'upload', document: 'cv', source: 'candidate_document', evidence: '' }],
        missingRequired: [],
      };
    };
    const accountEvents: string[] = [];
    const result = await handleAuth({
      page,
      snapshot: await extractFields(page, { listboxOptions: false }),
      ctx: {
        candidate: { identity: { email: 'candidate@example.test' }, profile: {} },
        candidateLocale: 'en',
        language: 'en',
        files: { cv: '/tmp/cv.pdf' },
        codex,
        accounts: {
          load: async () => null,
          save: async () => { accountEvents.push('save'); },
          mark: async () => { accountEvents.push('mark'); },
          discard: async () => { accountEvents.push('discard'); },
        },
      },
    });

    expect(result.handoff).toBe('portal_required_file_unhandled');
    expect(ctaClicks).toEqual([]);
    expect(window.document.getElementById('create')?.getAttribute('data-clicked')).not.toBe('true');
    expect(accountEvents).toEqual([]);
  });

  it('replans after a privacy-revealed known answer exposes another hard question', async () => {
    const fixture = fakePage({ registration: true, privacyRevealsKnownAnswer: true });
    const { page, window } = fixture;
    const fieldId = (id: string) => window.document.getElementById(id)?.getAttribute('data-aa-id') || '';
    let plannerCalls = 0;
    const codex = async ({ prompt }: any) => {
      if (JSON.stringify(prompt).includes('You localize questions from an online job application')) return { questions: [] };
      plannerCalls += 1;
      return {
        actions: plannerCalls === 2
          ? [{ fieldId: fieldId('origin-region'), action: 'select', value: 'Lombardy', source: 'candidate_profile', evidence: 'profile region' }]
          : [],
        missingRequired: plannerCalls > 2
          ? [{ fieldId: fieldId('origin-question'), question: 'Which certification is recognized in Lombardy?', why: '', type: 'text', options: [] }]
          : [],
      };
    };
    const result = await handleAuth({
      page,
      snapshot: await extractFields(page, { listboxOptions: false }),
      ctx: {
        candidate: { identity: { email: 'candidate@example.test' }, profile: { region: 'Lombardy' } },
        candidateLocale: 'en',
        language: 'en',
        files: {},
        codex,
        accounts: {
          load: async () => null,
          save: async () => {},
          mark: async () => {},
          discard: async () => {},
        },
      },
    });

    expect(plannerCalls).toBe(3);
    expect(result.questions.map((question: any) => question.applicationQuestion)).toEqual([
      'Which certification is recognized in Lombardy? *',
    ]);
    expect(window.document.getElementById('create')?.getAttribute('data-clicked')).not.toBe('true');
  });

  it('replans after password entry reveals a hard required question', async () => {
    const fixture = fakePage({ registration: true, passwordRevealsUnknown: true });
    const { page, window } = fixture;
    const fieldId = (id: string) => window.document.getElementById(id)?.getAttribute('data-aa-id') || '';
    let plannerCalls = 0;
    const codex = async ({ prompt }: any) => {
      if (JSON.stringify(prompt).includes('You localize questions from an online job application')) return { questions: [] };
      plannerCalls += 1;
      return {
        actions: [],
        missingRequired: plannerCalls > 1
          ? [{ fieldId: fieldId('password-question'), question: 'Which security clearance do you hold?', why: '', type: 'text', options: [] }]
          : [],
      };
    };
    const result = await handleAuth({
      page,
      snapshot: await extractFields(page, { listboxOptions: false }),
      ctx: {
        candidate: { identity: { email: 'candidate@example.test' }, profile: {} },
        candidateLocale: 'en',
        language: 'en',
        files: {},
        codex,
        accounts: {
          load: async () => null,
          save: async () => {},
          mark: async () => {},
          discard: async () => {},
        },
      },
    });

    expect(plannerCalls).toBe(2);
    expect(result.questions.map((question: any) => question.applicationQuestion)).toEqual([
      'Which security clearance do you hold? *',
      'Country of residence *',
      'Why are you interested in this role? *',
    ]);
    expect(window.document.getElementById('create')?.getAttribute('data-clicked')).not.toBe('true');
  });

  it('replans when a hard question appears asynchronously without a planned answer action', async () => {
    const fixture = fakePage({ registration: true, asyncRevealsUnknown: true });
    const { page, window } = fixture;
    const fieldId = (id: string) => window.document.getElementById(id)?.getAttribute('data-aa-id') || '';
    let plannerCalls = 0;
    const codex = async ({ prompt }: any) => {
      if (JSON.stringify(prompt).includes('You localize questions from an online job application')) return { questions: [] };
      plannerCalls += 1;
      return {
        actions: [],
        missingRequired: plannerCalls > 1
          ? [{ fieldId: fieldId('late-question'), question: 'Which professional certification do you hold?', why: '', type: 'text', options: [] }]
          : [],
      };
    };
    const result = await handleAuth({
      page,
      snapshot: await extractFields(page, { listboxOptions: false }),
      ctx: {
        candidate: { identity: { email: 'candidate@example.test' }, profile: {} },
        candidateLocale: 'en',
        language: 'en',
        files: {},
        codex,
        accounts: {
          load: async () => null,
          save: async () => {},
          mark: async () => {},
          discard: async () => {},
        },
      },
    });

    expect(plannerCalls).toBe(2);
    expect(result.questions.map((question: any) => question.applicationQuestion)).toEqual([
      'Which professional certification do you hold? *',
      'Country of residence *',
      'Why are you interested in this role? *',
    ]);
    expect(window.document.getElementById('create')?.getAttribute('data-clicked')).not.toBe('true');
  });

  it('replans when a field description changes without adding a control', async () => {
    const fixture = fakePage({ registration: true, asyncDescriptionChanges: true });
    const { page, window } = fixture;
    const fieldId = (id: string) => window.document.getElementById(id)?.getAttribute('data-aa-id') || '';
    let plannerCalls = 0;
    const plannerInputs: string[] = [];
    const codex = async ({ prompt }: any) => {
      const serializedPrompt = JSON.stringify(prompt);
      if (serializedPrompt.includes('You localize questions from an online job application')) return { questions: [] };
      plannerCalls += 1;
      plannerInputs.push(serializedPrompt);
      return {
        actions: [],
        missingRequired: plannerCalls > 1
          ? [{ fieldId: fieldId('motivation'), question: 'Describe your experience leading regional teams.', why: '', type: 'text', options: [] }]
          : [],
      };
    };
    const result = await handleAuth({
      page,
      snapshot: await extractFields(page, { listboxOptions: false }),
      ctx: {
        candidate: { identity: { email: 'candidate@example.test' }, profile: {} },
        candidateLocale: 'en',
        language: 'en',
        files: {},
        codex,
        accounts: {
          load: async () => null,
          save: async () => {},
          mark: async () => {},
          discard: async () => {},
        },
      },
    });

    expect(plannerCalls).toBe(2);
    expect(result.questions.map((question: any) => question.applicationQuestion)).toEqual([
      'Describe your experience leading regional teams.',
      'Country of residence *',
    ]);
    expect(plannerInputs.some((input) => input.includes('Describe your experience leading regional teams.'))).toBe(true);
    expect(plannerInputs.some((input) => input.includes('textarea_123'))).toBe(true);
    expect(window.document.getElementById('create')?.getAttribute('data-clicked')).not.toBe('true');
  });

  it('replans when autofill changes only a field value without adding markup', async () => {
    const fixture = fakePage({ registration: true, asyncValueChanges: true });
    const { page, window } = fixture;
    const fieldId = (id: string) => window.document.getElementById(id)?.getAttribute('data-aa-id') || '';
    const initialControlCount = window.document.querySelectorAll('input, textarea, select').length;
    let plannerCalls = 0;
    const plannerInputs: string[] = [];
    const codex = async ({ prompt }: any) => {
      if (JSON.stringify(prompt).includes('You localize questions from an online job application')) return { questions: [] };
      plannerCalls += 1;
      plannerInputs.push(JSON.stringify(prompt));
      return {
        actions: [],
        missingRequired: plannerCalls > 1
          ? [{ fieldId: fieldId('motivation'), question: 'Describe the autofilled answer before applying.', why: '', type: 'text', options: [] }]
          : [],
      };
    };
    const result = await handleAuth({
      page,
      snapshot: await extractFields(page, { listboxOptions: false }),
      ctx: {
        candidate: { identity: { email: 'candidate@example.test' }, profile: {} },
        candidateLocale: 'en',
        language: 'en',
        files: {},
        codex,
        accounts: {
          load: async () => null,
          save: async () => {},
          mark: async () => {},
          discard: async () => {},
        },
      },
    });

    expect(plannerCalls).toBe(2);
    expect(window.document.querySelectorAll('input, textarea, select')).toHaveLength(initialControlCount);
    expect(elementValue(window, '#motivation')).toBe('Autofilled by the application');
    expect(result.questions.map((question: any) => question.applicationQuestion)).toEqual([
      'Why are you interested in this role? *',
      'Country of residence *',
    ]);
    expect(plannerInputs.some((input) => input.includes('Autofilled by the application'))).toBe(true);
    expect(window.document.getElementById('create')?.getAttribute('data-clicked')).not.toBe('true');
  });

  it('applies known answers, waits for conditional fields, and sends one stable question batch', async () => {
    const fixture = fakePage();
    const { page, window, extractionTrace } = fixture;
    const context: any = {
      on: () => {}, off: () => {}, pages: () => [page], newPage: async () => page,
      close: async () => {}, waitForEvent: async () => null,
    };
    page.context = () => context;
    const browser = { newContext: async () => context, close: async () => {}, version: () => '130.0.0.0' };
    const plannerCalls: string[][] = [];
    const plannerTrace: any[] = [];
    const candidate = { identity: { email: 'candidate@example.test', address: { country: 'Italia' } }, profile: {} };
    const fieldId = (id: string) => window.document.getElementById(id)?.getAttribute('data-aa-id') || '';
    const codex = async () => {
      plannerCalls.push([...window.document.querySelectorAll('input,textarea,select')].map((field: any) => field.id));
      const missingRequired = [
        { fieldId: fieldId('motivation'), question: 'Why are you interested in this role?', why: '', type: 'text', options: [] },
      ];
      if (window.document.getElementById('authorization')) {
        missingRequired.push({ fieldId: fieldId('authorization'), question: 'Which work authorization do you hold?', why: '', type: 'text', options: [] });
      }
      if (window.document.getElementById('availability')) {
        missingRequired.push({ fieldId: fieldId('availability'), question: 'When could you start?', why: '', type: 'text', options: [] });
      }
      const actions = plannerCalls.length === 1
        ? [{ fieldId: fieldId('country'), action: 'select', value: 'Italia', document: 'none', source: 'identity', evidence: '' }]
        : [];
      const extracted = await extractFields(page, { listboxOptions: false });
      const guarded = guardPlan({ actions, missingRequired }, extracted.fields, candidate);
      const mapped = portalRequirementsFromMissingRequired(extracted.fields, guarded.missingRequired);
      plannerTrace.push({
        visibleFields: [...window.document.querySelectorAll('input,textarea,select')].map((field: any) => ({
          id: field.id, aaId: field.getAttribute('data-aa-id'),
        })),
        actions: actions.map(({ fieldId, action }) => ({ fieldId, action })),
        missingRequired: missingRequired.map((item: any) => ({
          fieldId: item.fieldId, question: item.question,
          applicationQuestion: item.applicationQuestion, portalQuestion: item.portalQuestion,
        })),
        guardedActions: guarded.actions.map(({ fieldId, action, value }: any) => ({ fieldId, action, value })),
        guardedMissingRequired: guarded.missingRequired.map(({ fieldId, question, portalQuestion }: any) => ({ fieldId, question, portalQuestion })),
        mapped: { unreadableFields: mapped.unreadableFields || [], questions: mapped.questions.map(({ applicationQuestion, question }: any) => ({ applicationQuestion, question })) },
      });
      return { actions, missingRequired };
    };

    const result = await submitViaPortal({
      applyUrl: page.url(),
      job: { title: 'Synthetic role', company: 'Example AG' },
      language: 'en', candidateLocale: 'en',
      candidate,
      files: {}, skipPostingCheck: true, maxSteps: 5,
      codex, launch: async () => browser,
      accounts: { load: async () => null, save: async () => {}, mark: async () => {}, discard: async () => {} },
    });

    expect(result.event.type, portalRunSummary(result, plannerTrace, extractionTrace)).toBe('submit_needs_candidate');
    expect(elementValue(window, '#country')).toBe('IT');
    expect(result.event.questions.map((question: any) => question.question)).toEqual([
      'Why are you interested in this role? *',
      'Which work authorization do you hold? *',
      'When could you start? *',
    ]);
    expect(plannerCalls.some((fields) => fields.includes('availability'))).toBe(true);
    expect(window.document.getElementById('next')?.getAttribute('data-clicked')).not.toBe('true');
  });

  it('resets the bounded redraw budget after a new SPA step that reuses the same URL', async () => {
    const fixture = fakePage({ multiStep: true });
    const { page, window, extractionTrace } = fixture;
    const context: any = {
      on: () => {}, off: () => {}, pages: () => [page], newPage: async () => page,
      close: async () => {}, waitForEvent: async () => null,
    };
    page.context = () => context;
    const browser = { newContext: async () => context, close: async () => {}, version: () => '130.0.0.0' };
    const fieldId = (id: string) => window.document.getElementById(id)?.getAttribute('data-aa-id') || '';
    const plannerTrace: any[] = [];
    const candidate = { identity: { email: 'candidate@example.test', address: { country: 'Italia', city: 'Como', postalCode: '22100' } }, profile: {} };
    const codex = async () => {
      const pageNumber = Number(window.document.querySelector('form')?.getAttribute('data-page') || '1');
      const fields = new Set([...window.document.querySelectorAll('input,textarea,select')].map((field: any) => field.id));
      if (pageNumber === 1 && !fields.has('city')) {
        const plan = { actions: [{ fieldId: fieldId('country'), action: 'select', value: 'Italia', document: 'none', source: 'identity', evidence: '' }], missingRequired: [] };
        const extracted = await extractFields(page, { listboxOptions: false });
        const guarded = guardPlan(plan, extracted.fields, candidate);
        plannerTrace.push({ pageNumber, fields: [...fields], actions: plan.actions.map(({ fieldId, action }) => ({ fieldId, action })), guardedActions: guarded.actions, guardedMissingRequired: guarded.missingRequired, missingRequired: [] });
        return plan;
      }
      if (pageNumber === 1 && !fields.has('postal')) {
        const plan = { actions: [{ fieldId: fieldId('city'), action: 'fill', value: 'Como', document: 'none', source: 'identity', evidence: '' }], missingRequired: [] };
        const extracted = await extractFields(page, { listboxOptions: false });
        const guarded = guardPlan(plan, extracted.fields, candidate);
        plannerTrace.push({ pageNumber, fields: [...fields], actions: plan.actions.map(({ fieldId, action }) => ({ fieldId, action })), guardedActions: guarded.actions, guardedMissingRequired: guarded.missingRequired, missingRequired: [] });
        return plan;
      }
      if (pageNumber === 1) {
        const plan = { actions: [{ fieldId: fieldId('postal'), action: 'fill', value: '22100', document: 'none', source: 'identity', evidence: '' }], missingRequired: [] };
        const extracted = await extractFields(page, { listboxOptions: false });
        const guarded = guardPlan(plan, extracted.fields, candidate);
        plannerTrace.push({ pageNumber, fields: [...fields], actions: plan.actions.map(({ fieldId, action }) => ({ fieldId, action })), guardedActions: guarded.actions, guardedMissingRequired: guarded.missingRequired, missingRequired: [] });
        return plan;
      }
      if (!fields.has('availability')) {
        const plan = { actions: [{ fieldId: fieldId('country'), action: 'select', value: 'Italia', document: 'none', source: 'identity', evidence: '' }], missingRequired: [] };
        plannerTrace.push({ pageNumber, fields: [...fields], actions: plan.actions.map(({ fieldId, action }) => ({ fieldId, action })), missingRequired: [] });
        return plan;
      }
      const plan = {
        actions: [],
        missingRequired: [{ fieldId: fieldId('availability'), question: 'When could you start?', why: '', type: 'text', options: [] }],
      };
      const extracted = await extractFields(page, { listboxOptions: false });
      const guarded = guardPlan(plan, extracted.fields, candidate);
      const mapped = portalRequirementsFromMissingRequired(extracted.fields, guarded.missingRequired);
      plannerTrace.push({ pageNumber, fields: [...fields], actions: [], guardedActions: guarded.actions, guardedMissingRequired: guarded.missingRequired, mapped: { unreadableFields: mapped.unreadableFields || [], questions: mapped.questions }, missingRequired: plan.missingRequired.map(({ fieldId, question }) => ({ fieldId, question })) });
      return plan;
    };

    const result = await submitViaPortal({
      applyUrl: page.url(), job: { title: 'Synthetic role', company: 'Example AG' },
      language: 'en', candidateLocale: 'en',
      candidate,
      files: {}, skipPostingCheck: true, maxSteps: 8, codex, launch: async () => browser,
      accounts: { load: async () => null, save: async () => {}, mark: async () => {}, discard: async () => {} },
    });

    expect(window.document.querySelector('form')?.getAttribute('data-page'), portalRunSummary(result, plannerTrace, extractionTrace)).toBe('2');
    expect(result.event.type).toBe('submit_needs_candidate');
    expect(result.event.questions.map((question: any) => question.question)).toEqual(['When could you start? *']);
  });

  it('does not ask stale questions when the page moves while its DOM cannot be read', async () => {
    const fixture = fakePage();
    const { page, window } = fixture;
    const context: any = {
      on: () => {}, off: () => {}, pages: () => [page], newPage: async () => page,
      close: async () => {}, waitForEvent: async () => null,
    };
    page.context = () => context;
    const browser = { newContext: async () => context, close: async () => {}, version: () => '130.0.0.0' };
    const fieldId = (id: string) => window.document.getElementById(id)?.getAttribute('data-aa-id') || '';
    let plans = 0;
    page.after(1000, () => {
      page.setUrl(`${page.url()}/step-2`);
      page.failFrameReads(10);
    });

    const result = await submitViaPortal({
      applyUrl: page.url(), job: { title: 'Synthetic role', company: 'Example AG' },
      language: 'en', candidateLocale: 'en', candidate: { identity: { email: 'candidate@example.test', address: { country: 'Italia' } }, profile: {} },
      files: {}, skipPostingCheck: true, maxSteps: 5,
      codex: async () => {
        plans += 1;
        return {
          actions: plans === 1
            ? [{ fieldId: fieldId('country'), action: 'select', value: 'Italia', document: 'none', source: 'identity', evidence: '' }]
            : [],
          missingRequired: [{
            fieldId: fieldId('motivation'), question: 'Why are you interested in this role?', why: '', type: 'text', options: [],
          }],
        };
      },
      launch: async () => browser,
      accounts: { load: async () => null, save: async () => {}, mark: async () => {}, discard: async () => {} },
    });

    expect(page.url()).toContain('/step-2');
    expect(result.event.type).not.toBe('submit_needs_candidate');
  });

  it('does not send a partial batch when the required-field surface never settles', async () => {
    const fixture = fakePage({ conditional: false });
    const { page } = fixture;
    const context: any = {
      on: () => {}, off: () => {}, pages: () => [page], newPage: async () => page,
      close: async () => {}, waitForEvent: async () => null,
    };
    page.context = () => context;
    const browser = { newContext: async () => context, close: async () => {}, version: () => '130.0.0.0' };
    const fieldId = (id: string) => fixture.window.document.getElementById(id)?.getAttribute('data-aa-id') || '';
    for (let index = 1; index <= 48; index += 1) {
      page.after(index * 250, () => {
        const form = fixture.window.document.querySelector('form');
        form?.insertAdjacentHTML('beforeend', `<label for="volatile-${index}">Additional required field ${index} *</label><input id="volatile-${index}" required>`);
      });
    }

    const result = await submitViaPortal({
      applyUrl: page.url(), job: { title: 'Synthetic role', company: 'Example AG' },
      language: 'en', candidateLocale: 'en', candidate: { identity: { email: 'candidate@example.test' }, profile: {} },
      files: {}, skipPostingCheck: true, maxSteps: 3,
      codex: async () => ({
        actions: [],
        missingRequired: [{
          fieldId: fieldId('motivation'),
          question: 'Why are you interested in this role?', why: '', type: 'text', options: [],
        }],
      }),
      launch: async () => browser,
      accounts: { load: async () => null, save: async () => {}, mark: async () => {}, discard: async () => {} },
    });

    expect(result.event.type).not.toBe('submit_needs_candidate');
  });
});

function elementValue(window: any, selector: string) {
  return window.document.querySelector(selector)?.value;
}
