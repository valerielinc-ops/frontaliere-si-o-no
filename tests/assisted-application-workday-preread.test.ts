import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { extractFields, readListboxOptions, readOwnedListOptions } from '../scripts/assisted-application/lib/portal/fields.mjs';
import {
  candidateForForm,
  mergePortalChoiceOptions,
  needsPortalOptionRead,
  portalRequirementsFromMissingRequired,
  profileDateQuestionsCanUseProfile,
  profileEntriesForSection,
  profileEntryAnswer,
  submitViaPortal,
} from '../scripts/assisted-application/lib/portal/portal.mjs';
import { guardPlan, normalizeDateAnswer } from '../scripts/assisted-application/lib/portal/plan.mjs';

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

describe('Workday and ATS question readability & profile completeness', () => {
  it('reads Workday promptOption items when a listbox renders promptOption instead of role="option"', async () => {
    const emptyRoleOptions = { first: () => ({ waitFor: async () => { throw new Error('timeout'); } }) };
    const promptOptions = {
      first: () => ({ waitFor: async () => {} }),
      allInnerTexts: async () => ['Select One', 'Mobile', 'Home'],
    };
    const trigger = { click: vi.fn(async () => {}), press: vi.fn(async () => {}) };
    const list = {
      waitFor: async () => {},
      locator: (selector: string) => selector.includes('promptOption') ? promptOptions : emptyRoleOptions,
    };
    const frame = {
      locator: (selector: string) => selector.startsWith('[data-aa-id=')
        ? { first: () => trigger }
        : selector === '[role="listbox"]:visible'
          ? { last: () => list }
          : emptyRoleOptions,
    };

    const options = await readListboxOptions(frame as never, { id: 'phone-device-type' });
    expect(options).toEqual([
      { value: 'Mobile', label: 'Mobile' },
      { value: 'Home', label: 'Home' },
    ]);
    expect(trigger.press).toHaveBeenCalledWith('Escape');
  });

  it('marks a Workday searchable popup (searchBox without static options) as searchablePrompt instead of question_label_unreadable', async () => {
    const html = `<!doctype html><html><body><form><fieldset><legend>Phone</legend>
      <label id="lbl-code" for="phone-code">Country Phone Code *</label>
      <button id="phone-code" aria-haspopup="listbox" aria-labelledby="lbl-code" aria-required="true">Select One</button>
    </fieldset></form></body></html>`;
    const dom = new JSDOM(html, { url: 'https://rituals.wd3.myworkdayjobs.com/en-US/Rituals/job/Shop_R1/apply/applyManually' });
    const { window } = dom;
    Object.defineProperty(window.HTMLElement.prototype, 'innerText', { configurable: true, get() { return this.textContent || ''; } });
    window.Element.prototype.getBoundingClientRect = () => ({ width: 80, height: 24 } as DOMRect);

    const noOptions = { first: () => ({ waitFor: async () => { throw new Error('timeout'); } }) };
    const searchVisible = { first: () => ({ isVisible: async () => true }) };
    const trigger = { click: vi.fn(async () => {}), press: vi.fn(async () => {}) };
    const frame = {
      url: () => window.location.href,
      evaluate: async (fn: any, arg: any) => inWindow(window, () => fn(arg)),
      locator: (selector: string) => {
        if (selector.startsWith('[data-aa-id=')) return { first: () => trigger };
        if (selector === '[role="listbox"]:visible') return { last: () => ({ waitFor: async () => { throw new Error('no listbox'); } }) };
        if (selector.includes('searchBox')) return searchVisible;
        return noOptions;
      },
    };
    const page = { url: () => window.location.href, frames: () => [frame], mainFrame: () => frame };

    const fullSnapshot = await extractFields(page as never);
    const codeField = fullSnapshot.fields.find((field: any) => field.label.includes('Country Phone Code'));
    expect(codeField).toMatchObject({ kind: 'listbox', options: [], searchablePrompt: true });

    const navSnapshot = await extractFields(page as never, { listboxOptions: false });
    const navField = navSnapshot.fields.find((field: any) => field.label.includes('Country Phone Code'));
    expect(navField?.searchablePrompt).toBeUndefined();

    const merged = mergePortalChoiceOptions(navSnapshot, fullSnapshot);
    expect(needsPortalOptionRead(merged)).toBe(false);

    const requirements = portalRequirementsFromMissingRequired(merged.fields, [{
      fieldId: navField.id,
      question: 'Prefisso telefonico internazionale *',
      type: 'choice',
      why: 'Campo obbligatorio',
    }]);
    expect(requirements.unreadableFields || []).toEqual([]);
    expect(requirements.questions).toEqual([
      expect.objectContaining({
        id: expect.any(String),
        type: 'text',
        applicationQuestion: 'Country Phone Code *',
      }),
    ]);
  });

  it('defaults year-only experience dates to month 01 and empty employer to the full role across helpers and planner', () => {
    const candidate = candidateForForm({
      identity: { name: 'Mario Rossi', email: 'c-test@candidature.frontaliereticino.ch', phone: '+39 320 0000000' },
      profile: {
        experience: [
          { role: 'Boutique Owner', employer: '', start: '2017', end: '07/2024' },
          { role: 'Shop Manager', employer: '', start: '2008', end: '2010' },
          { role: 'Ongoing Role', employer: 'Acme', start: '2025', end: '' },
        ],
      },
      language: 'it',
    });

    expect(candidate.profile.experience[0]).toMatchObject({
      role: 'Boutique Owner',
      employer: 'Boutique Owner',
      start: '2017-01',
      end: '07/2024',
    });
    expect(candidate.profile.experience[1]).toMatchObject({
      role: 'Shop Manager',
      employer: 'Shop Manager',
      start: '2008-01',
      end: '2010-01',
    });

    const entries = profileEntriesForSection(candidate, 'experience');
    expect(entries.map((entry: any) => entry.role)).toEqual(['Boutique Owner', 'Shop Manager']);
    expect(profileEntryAnswer({ role: 'Boutique Owner', employer: '', start: '2017', end: '07/2024' }, 'experience', { label: 'Company*' }))
      .toEqual({ value: 'Boutique Owner', source: 'profile' });
    expect(profileEntryAnswer({ role: 'Boutique Owner', employer: '', start: '2017', end: '07/2024' }, 'experience', { label: 'From*' }))
      .toEqual({ value: '2017-01', source: 'profile' });

    expect(profileDateQuestionsCanUseProfile({
      profile: { experience: [{ role: 'Boutique Owner', employer: '', start: '2017', end: '07/2024' }] },
    }, [{
      type: 'date', applicationQuestion: 'From*', section: 'Work Experience 1', context: 'Boutique Owner · From*',
    }])).toBe(true);

    const workdayField = { id: 'from-1', kind: 'text', inputType: 'date', widget: 'workday-date', label: 'From*', required: true };
    expect(normalizeDateAnswer(workdayField, '2017')).toBe('2017-01');
    expect(normalizeDateAnswer(workdayField, '07/2024')).toBe('2024-07');
    expect(normalizeDateAnswer(workdayField, 'ad oggi')).toBe('');

    const plan = guardPlan({
      actions: [{ fieldId: 'from-1', action: 'fill', value: '2017-01', source: 'profile', document: 'none', evidence: '' }],
      missingRequired: [],
    }, [workdayField], candidate);
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0].value).toBe('2017-01');
  });

  it('keeps ownedList return type empty array when ownedList container never appears', async () => {
    const trigger = { click: vi.fn(async () => {}), press: vi.fn(async () => {}) };
    const list = { waitFor: async () => { throw new Error('hidden'); } };
    const frame = {
      locator: (selector: string) => selector.startsWith('[data-aa-id=') ? { first: () => trigger } : { first: () => list },
    };
    await expect(readOwnedListOptions(frame as never, { id: 'f1', ownedList: 'menu-1' })).resolves.toEqual([]);
  });

  it('walks multi-step Workday form through My Information and My Experience to extract Step 3 Application Questions in preReadOnly mode', async () => {
    const applyUrl = 'https://rituals.wd3.myworkdayjobs.com/en-US/Rituals/job/Lugano/Sales-Assistant_R999/apply/applyManually';
    const step1Html = `<form aria-label="My Information">
      <h1>My Information</h1>
      <fieldset><legend>Phone</legend>
        <label id="lbl-dev" for="phone-dev">Phone Device Type *</label>
        <button id="phone-dev" aria-haspopup="listbox" aria-labelledby="lbl-dev" aria-required="true">Select One</button>
      </fieldset>
      <button id="next-1" type="button">Save and Continue</button>
    </form>`;
    const step2Html = `<form aria-label="My Experience">
      <h1>My Experience</h1>
      <section aria-label="Work Experience">
        <h2>Work Experience</h2>
        <div data-section="Work Experience 1">
          <h3>Work Experience 1</h3>
          <label for="exp-title">Job Title *</label><input id="exp-title" type="text" required value="">
          <label for="exp-company">Company *</label><input id="exp-company" type="text" required value="">
          <div data-automation-id="dateInputWrapper" id="from-wrap">
            <label>From *</label>
            <input role="spinbutton" data-automation-id="dateSectionMonth-input" aria-label="Month" required value="">
            <input role="spinbutton" data-automation-id="dateSectionYear-input" aria-label="Year" required value="">
          </div>
          <div data-automation-id="dateInputWrapper" id="to-wrap">
            <label>To *</label>
            <input role="spinbutton" data-automation-id="dateSectionMonth-input" aria-label="Month" required value="">
            <input role="spinbutton" data-automation-id="dateSectionYear-input" aria-label="Year" required value="">
          </div>
          <button id="del-exp-1" type="button">Delete</button>
        </div>
        <button id="add-exp" type="button">Add Another</button>
      </section>
      <button id="next-2" type="button">Save and Continue</button>
    </form>`;
    const step3Html = `<form aria-label="Application Questions">
      <h1>Application Questions</h1>
      <label id="lbl-marital" for="marital-status">What is your Marital Status? *</label>
      <button id="marital-status" aria-haspopup="listbox" aria-labelledby="lbl-marital" aria-required="true">Select One</button>
      <button id="next-3" type="button">Save and Continue</button>
    </form>`;

    const dom = new JSDOM(`<!doctype html><html><body>${step1Html}</body></html>`, { url: applyUrl, runScripts: 'outside-only' });
    const { window } = dom;
    Object.defineProperty(window.HTMLElement.prototype, 'innerText', { configurable: true, get() { return this.textContent || ''; } });
    window.Element.prototype.getBoundingClientRect = () => ({ width: 80, height: 24 } as DOMRect);

    let step = 1;
    let openPopupFor = '';
    const attachHandlers = () => {
      window.document.getElementById('next-1')?.addEventListener('click', () => {
        step = 2;
        window.document.body.innerHTML = step2Html;
        attachHandlers();
      });
      window.document.getElementById('next-2')?.addEventListener('click', () => {
        step = 3;
        window.document.body.innerHTML = step3Html;
        attachHandlers();
      });
    };
    attachHandlers();

    const makeLocator = (selector: string): any => {
      if (selector === '[role="listbox"]:visible') {
        return {
          last: () => ({
            waitFor: async () => {},
            locator: (nested: string) => {
              const items = openPopupFor === 'phone-dev'
                ? ['Select One', 'Mobile', 'Home']
                : openPopupFor === 'marital-status'
                  ? ['Select One', 'Single', 'Married']
                  : [];
              if (nested.includes('promptOption')) {
                return {
                  first: () => ({ waitFor: async () => { if (!items.length) throw new Error('none'); } }),
                  allInnerTexts: async () => items,
                };
              }
              return { first: () => ({ waitFor: async () => { throw new Error('use promptOption'); } }) };
            },
          }),
        };
      }
      if (selector.includes('[role="option"]') || selector.includes('promptOption') || selector.includes('searchBox')) {
        return {
          first: () => ({ waitFor: async () => { throw new Error('none'); }, isVisible: async () => false }),
          allInnerTexts: async () => [],
        };
      }
      const element = () => {
        if (selector.startsWith('[data-aa-id="')) {
          const id = /data-aa-id="([^"]+)"/.exec(selector)?.[1] || '';
          return window.document.querySelector(`[data-aa-id="${id}"]`) as any;
        }
        return window.document.querySelector(selector) as any;
      };
      const handle: any = {
        first: () => handle,
        count: async () => {
          const found = element();
          return found ? 1 : 0;
        },
        click: async () => {
          const el = element();
          if (!el) throw new Error(`missing ${selector}`);
          if (el.id === 'phone-dev' || el.id === 'marital-status') {
            openPopupFor = el.id;
          } else {
            el.click();
          }
        },
        press: async (key: string) => {
          if (key === 'Escape') openPopupFor = '';
        },
        fill: async (value: string) => {
          const el = element();
          if (!el) throw new Error(`missing ${selector}`);
          el.value = value;
          el.dispatchEvent(new window.Event('input', { bubbles: true }));
          el.dispatchEvent(new window.Event('change', { bubbles: true }));
        },
        inputValue: async () => element()?.value || '',
        evaluate: async (fn: any, arg: any) => inWindow(window, () => fn(element(), arg)),
        locator: (nested: string) => {
          const el = element();
          if (el?.id === 'from-wrap' || el?.id === 'to-wrap') {
            if (nested === '[role="spinbutton"]') {
              return { count: async () => 2, nth: (idx: number) => makeSpinHandle(el, idx) };
            }
            if (nested.includes('Month')) return { first: () => makeSpinHandle(el, 0), count: async () => 1 };
            if (nested.includes('Year')) return { first: () => makeSpinHandle(el, 1), count: async () => 1 };
          }
          return makeLocator(nested);
        },
      };
      return handle;
    };
    const makeSpinHandle = (wrapper: any, idx: number) => {
      const inputs = [...wrapper.querySelectorAll('[role="spinbutton"]')];
      const spin = inputs[idx];
      return {
        count: async () => (spin ? 1 : 0),
        evaluate: async (fn: any, arg: any) => inWindow(window, () => fn(spin, arg)),
        fill: async (value: string) => { spin.value = value; },
        press: async () => {},
      };
    };

    const frame: any = {
      url: () => applyUrl,
      evaluate: async (fn: any, arg: any) => inWindow(window, () => fn(arg)),
      locator: makeLocator,
    };
    const page: any = {
      frames: () => [frame],
      mainFrame: () => frame,
      url: () => applyUrl,
      title: async () => 'Apply - Rituals',
      evaluate: frame.evaluate,
      locator: makeLocator,
      waitForLoadState: async () => {},
      waitForTimeout: async () => {},
      goto: async () => ({ status: () => 200 }),
      getByRole: (_role: string, query: { name?: string }) => ({
        first: () => ({
          click: async () => {
            if (openPopupFor && query?.name) {
              const btn = window.document.getElementById(openPopupFor);
              if (btn) btn.textContent = query.name;
              openPopupFor = '';
            }
          },
        }),
      }),
      getByText: () => ({ first: () => ({ isVisible: async () => false, waitFor: async () => { throw new Error('none'); } }) }),
      keyboard: { press: async () => { openPopupFor = ''; } },
      on: () => {},
      off: () => {},
      screenshot: async () => Buffer.from(''),
    };
    const context: any = { on: () => {}, off: () => {}, pages: () => [page], newPage: async () => page, close: async () => {}, waitForEvent: async () => null };
    page.context = () => context;
    const browser = { newContext: async () => context, close: async () => {}, version: () => '130.0.0.0' };

    const seenStepOptions: string[][] = [];
    const codex = async ({ prompt }: any) => {
      const text = String(prompt);
      if (text.includes('You localize questions from an online job application')) {
        const start = text.lastIndexOf('\n\n{');
        const end = text.indexOf('\n\nReturn exactly one JSON object', start);
        const input = JSON.parse(text.slice(start + 2, end)) as { questions?: Array<Record<string, any>> };
        return {
          questions: (input.questions || []).map((q) => ({
            id: q.id,
            sourceLocale: 'en',
            question: q.applicationQuestion,
            why: 'Required by portal',
            options: q.applicationOptions || [],
            optionMap: (q.applicationOptions || []).map((opt: string) => ({ candidate: opt, application: opt })),
            validationMessage: '',
          })),
        };
      }
      if (step === 1) {
        const devId = window.document.getElementById('phone-dev')?.getAttribute('data-aa-id') || '';
        const match = /"options":\s*(\[[^\]]+\])/.exec(text);
        if (match) seenStepOptions.push(JSON.parse(match[1]).map((o: any) => (typeof o === 'string' ? o : o.label)));
        return {
          actions: [{ fieldId: devId, action: 'select', value: 'Mobile', document: 'none', source: 'identity', evidence: '' }],
          missingRequired: [],
        };
      }
      if (step === 2) {
        return { actions: [], missingRequired: [] };
      }
      const maritalId = window.document.getElementById('marital-status')?.getAttribute('data-aa-id') || '';
      return {
        actions: [],
        missingRequired: [{
          fieldId: maritalId,
          question: 'What is your Marital Status? *',
          type: 'choice',
          why: 'Required on Step 3',
        }],
      };
    };

    const result = await submitViaPortal({
      applyUrl,
      preReadOnly: true,
      dryRun: true,
      job: { title: 'Sales Assistant', company: 'Rituals' },
      language: 'en',
      candidateLocale: 'en',
      candidate: candidateForForm({
        identity: { name: 'Mario Rossi', email: 'c-test@candidature.frontaliereticino.ch', phone: '+39 320 0000000' },
        profile: {
          experience: [{ role: 'Boutique Owner', employer: '', start: '2017', end: '07/2024' }],
          education: [],
        },
        language: 'en',
      }),
      files: {},
      skipPostingCheck: true,
      maxSteps: 6,
      codex,
      launch: async () => browser,
      accounts: { load: async () => null, save: async () => {}, mark: async () => {}, discard: async () => {} },
    });

    expect(seenStepOptions[0]).toEqual(['Mobile', 'Home']);
    expect(result.event.type).toBe('submit_needs_candidate');
    expect(result.event.questions.map((q: any) => q.applicationQuestion)).toEqual(['What is your Marital Status? *']);
    expect(result.event.questions[0].applicationOptions).toEqual(['Single', 'Married']);
  });

  it('detects searchablePrompt when a hidden duplicate searchBox precedes a visible searchBox', async () => {
    const html = `<!doctype html><html><body><form><fieldset><legend>Phone</legend>
      <label id="lbl-code" for="phone-code">Country Phone Code *</label>
      <button id="phone-code" aria-haspopup="listbox" aria-labelledby="lbl-code" aria-required="true">Select One</button>
    </fieldset></form></body></html>`;
    const dom = new JSDOM(html, { url: 'https://rituals.wd3.myworkdayjobs.com/en-US/Rituals/job/Shop_R1/apply/applyManually' });
    const { window } = dom;
    Object.defineProperty(window.HTMLElement.prototype, 'innerText', { configurable: true, get() { return this.textContent || ''; } });
    window.Element.prototype.getBoundingClientRect = () => ({ width: 80, height: 24 } as DOMRect);

    const noOptions = { first: () => ({ waitFor: async () => { throw new Error('timeout'); } }) };
    const trigger = { click: vi.fn(async () => {}), press: vi.fn(async () => {}) };
    const searchLocator = {
      count: async () => 2,
      nth: (index: number) => ({ isVisible: async () => index === 1 }),
      first: () => ({ isVisible: async () => false }),
    };
    const frame = {
      url: () => window.location.href,
      evaluate: async (fn: any, arg: any) => inWindow(window, () => fn(arg)),
      locator: (selector: string) => {
        if (selector.startsWith('[data-aa-id=')) return { first: () => trigger };
        if (selector === '[role="listbox"]:visible') return { last: () => ({ waitFor: async () => { throw new Error('no listbox'); } }) };
        if (selector.includes('searchBox')) return searchLocator;
        return noOptions;
      },
    };
    const page = { url: () => window.location.href, frames: () => [frame], mainFrame: () => frame };
    const snapshot = await extractFields(page as never);
    expect(snapshot.fields[0]).toMatchObject({ kind: 'listbox', options: [], searchablePrompt: true });
  });

  it('clears open-ended end markers ("present", "ad oggi") in profileEntryAnswer and date guards while preserving ongoing status on candidateForForm', () => {
    const dateField = { id: 'to-1', kind: 'text', inputType: 'date', widget: 'workday-date', label: 'To*', required: true };
    for (const marker of ['present', 'ad oggi']) {
      const candidate = candidateForForm({
        identity: { name: 'Mario Rossi', email: 'c-test@candidature.frontaliereticino.ch' },
        profile: { experience: [{ role: 'Boutique Owner', employer: '', start: '2017', end: marker }] },
        language: 'it',
      });
      expect(candidate.profile.experience[0].end).toBe(marker);
      expect(profileEntryAnswer(candidate.profile.experience[0], 'experience', { label: 'To*' })).toBeNull();
      expect(profileEntryAnswer({ role: 'Boutique Owner', employer: '', start: '2017', end: marker }, 'experience', { label: 'To*' })).toBeNull();
      expect(normalizeDateAnswer(dateField, marker)).toBe('');
    }
  });
});
