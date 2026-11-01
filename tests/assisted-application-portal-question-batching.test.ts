import { afterEach, describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { submitViaPortal } from '../scripts/assisted-application/lib/portal/portal.mjs';

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

function fakePage({ multiStep = false, conditional = true } = {}) {
  const url = 'https://careers.example.test/apply';
  const form = multiStep
    ? `<form action="/apply" data-page="1">
        <label for="country">Country of residence *</label>
        <select id="country" name="country" required><option value="">Choose one</option><option value="IT">Italy</option><option value="CH">Switzerland</option></select>
        <button id="next" type="button">Next</button>
      </form>`
    : `<form action="/apply">
        <label for="country">Country of residence *</label>
        <select id="country" name="country" required><option value="">Choose one</option><option value="IT">Italy</option><option value="CH">Switzerland</option></select>
        <label for="motivation">Why are you interested in this role? *</label><textarea id="motivation" name="motivation" required></textarea>
        <button id="next" type="button">Next</button>
      </form>`;
  const dom = new JSDOM(`<!doctype html><html><body>${form}</body></html>`, { url, runScripts: 'outside-only' });
  const { window } = dom;
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
      evaluate: async (run: any, argument: any) => inWindow(window, () => run(target(), argument)),
      allInnerTexts: async () => [...window.document.querySelectorAll(selector)].map((item: any) => item.textContent || ''),
    };
    return handle;
  };
  const frame: any = {
    url: () => currentUrl,
    evaluate: async (run: any, argument: any) => inWindow(window, () => run(argument)),
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
    getByText: () => ({ first: () => ({ isVisible: async () => false, waitFor: async () => { throw new Error('not found'); } }) }),
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
    element('#next').addEventListener('click', () => { element('#next').dataset.clicked = 'true'; });
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
  return { page, window };
}

describe('assisted portal question batching', () => {
  it('applies known answers, waits for conditional fields, and sends one stable question batch', async () => {
    const fixture = fakePage();
    const { page, window } = fixture;
    const context: any = {
      on: () => {}, off: () => {}, pages: () => [page], newPage: async () => page,
      close: async () => {}, waitForEvent: async () => null,
    };
    page.context = () => context;
    const browser = { newContext: async () => context, close: async () => {}, version: () => '130.0.0.0' };
    const plannerCalls: string[][] = [];
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
      return {
        actions: plannerCalls.length === 1
          ? [{ fieldId: fieldId('country'), action: 'select', value: 'Italia', document: 'none', source: 'identity', evidence: '' }]
          : [],
        missingRequired,
      };
    };

    const result = await submitViaPortal({
      applyUrl: page.url(),
      job: { title: 'Synthetic role', company: 'Example AG' },
      language: 'en', candidateLocale: 'en',
      candidate: { identity: { email: 'candidate@example.test', address: { country: 'Italia' } }, profile: {} },
      files: {}, skipPostingCheck: true, maxSteps: 5,
      codex, launch: async () => browser,
      accounts: { load: async () => null, save: async () => {}, mark: async () => {}, discard: async () => {} },
    });

    expect(result.event.type).toBe('submit_needs_candidate');
    expect(elementValue(window, '#country')).toBe('IT');
    expect(result.event.questions.map((question: any) => question.question)).toEqual([
      'Why are you interested in this role?',
      'Which work authorization do you hold?',
      'When could you start?',
    ]);
    expect(plannerCalls.some((fields) => fields.includes('availability'))).toBe(true);
    expect(window.document.getElementById('next')?.getAttribute('data-clicked')).not.toBe('true');
  });

  it('resets the bounded redraw budget after a new SPA step that reuses the same URL', async () => {
    const fixture = fakePage({ multiStep: true });
    const { page, window } = fixture;
    const context: any = {
      on: () => {}, off: () => {}, pages: () => [page], newPage: async () => page,
      close: async () => {}, waitForEvent: async () => null,
    };
    page.context = () => context;
    const browser = { newContext: async () => context, close: async () => {}, version: () => '130.0.0.0' };
    const fieldId = (id: string) => window.document.getElementById(id)?.getAttribute('data-aa-id') || '';
    const codex = async () => {
      const pageNumber = Number(window.document.querySelector('form')?.getAttribute('data-page') || '1');
      const fields = new Set([...window.document.querySelectorAll('input,textarea,select')].map((field: any) => field.id));
      if (pageNumber === 1 && !fields.has('city')) {
        return { actions: [{ fieldId: fieldId('country'), action: 'select', value: 'Italia', document: 'none', source: 'identity', evidence: '' }], missingRequired: [] };
      }
      if (pageNumber === 1 && !fields.has('postal')) {
        return { actions: [{ fieldId: fieldId('city'), action: 'fill', value: 'Lugano', document: 'none', source: 'identity', evidence: '' }], missingRequired: [] };
      }
      if (pageNumber === 1) {
        return { actions: [{ fieldId: fieldId('postal'), action: 'fill', value: '6900', document: 'none', source: 'identity', evidence: '' }], missingRequired: [] };
      }
      if (!fields.has('availability')) {
        return { actions: [{ fieldId: fieldId('country'), action: 'select', value: 'Italia', document: 'none', source: 'identity', evidence: '' }], missingRequired: [] };
      }
      return {
        actions: [],
        missingRequired: [{ fieldId: fieldId('availability'), question: 'When could you start?', why: '', type: 'text', options: [] }],
      };
    };

    const result = await submitViaPortal({
      applyUrl: page.url(), job: { title: 'Synthetic role', company: 'Example AG' },
      language: 'en', candidateLocale: 'en',
      candidate: { identity: { email: 'candidate@example.test', address: { country: 'Italia', city: 'Lugano', postalCode: '6900' } }, profile: {} },
      files: {}, skipPostingCheck: true, maxSteps: 8, codex, launch: async () => browser,
      accounts: { load: async () => null, save: async () => {}, mark: async () => {}, discard: async () => {} },
    });

    expect(window.document.querySelector('form')?.getAttribute('data-page')).toBe('2');
    expect(result.event.type).toBe('submit_needs_candidate');
    expect(result.event.questions.map((question: any) => question.question)).toEqual(['When could you start?']);
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
