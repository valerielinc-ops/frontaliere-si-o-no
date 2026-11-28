import { afterEach, describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { applyActions, pickSuggestionLabel } from '../scripts/assisted-application/lib/portal/fill.mjs';
import { emptyRequiredAsQuestions, portalRequirementsFromMissingRequired, suggestionKey } from '../scripts/assisted-application/lib/portal/portal.mjs';
import { platformCandidateFacts, platformDefaultAnswer, studyFieldSearchKeys } from '../functions/src/assistedApplicationPlatformDefaults.js';

// A SuccessFactors-like autocomplete (synthetic): an input with role=combobox that lists the catalogue entries holding the
// typed text, accepts only a clicked option, and lists the whole catalogue when it is empty and opened.
const open: JSDOM[] = [];
afterEach(() => { for (const dom of open) dom.window.close(); open.length = 0; });

function autocomplete(catalogue: string[]) {
  const dom = new JSDOM('<form><input id="major" role="combobox" data-aa-id="f1" value=""></form>', { runScripts: 'outside-only' });
  open.push(dom);
  const doc = dom.window.document;
  const input = doc.querySelector('input') as HTMLInputElement;
  const render = (text: string, all = false) => {
    doc.querySelector('[role="listbox"]')?.remove();
    const matches = catalogue.filter((label) => all || (text && label.toLowerCase().includes(text.toLowerCase())));
    if (!matches.length) return;
    const list = doc.createElement('div');
    list.setAttribute('role', 'listbox');
    for (const label of matches) { const item = doc.createElement('div'); item.setAttribute('role', 'option'); item.textContent = label; list.appendChild(item); }
    doc.body.appendChild(list);
  };
  const query = (selector: string) => () => {
    const clean = selector.replace(':visible', '');
    return [...doc.querySelectorAll(clean)];
  };
  class Locator {
    constructor(readonly q: () => Element[], readonly index = 0) {}
    el() { const node = this.q()[this.index]; if (!node) throw new Error('missing'); return node as HTMLElement; }
    first() { return new Locator(this.q, 0); }
    nth(index: number) { return new Locator(this.q, index); }
    waitFor = async () => { if (!this.q()[this.index]) throw new Error('timeout'); };
    count = async () => this.q().length;
    allInnerTexts = async () => this.q().map((node) => node.textContent || '');
    inputValue = async () => (this.el() as HTMLInputElement).value;
    fill = async (value: string) => { input.value = value; };
    getAttribute = async (name: string) => this.el().getAttribute(name);
    click = async () => {
      const node = this.el();
      if (node.getAttribute('role') === 'option') { input.value = node.textContent || ''; doc.querySelector('[role="listbox"]')?.remove(); }
    };
    press = async (key: string) => {
      if (key === 'Backspace') { input.value = ''; render(''); }
      if (key === 'ArrowDown' && !input.value) render('', true);
      if (key === 'Escape') doc.querySelector('[role="listbox"]')?.remove();
    };
    pressSequentially = async (text: string) => { input.value += text; render(input.value); };
    evaluate = async (fn: any, arg?: any) => dom.window.eval(`(${fn.toString()})`)(this.el(), arg);
  }
  const frame = {
    locator: (selector: string) => new Locator(query(selector)),
    getByRole: (_role: string, { name }: { name: string }) => new Locator(() => [...doc.querySelectorAll('[role="option"]')].filter((node) => node.textContent === name)),
  };
  const page = { frames: () => [frame], mainFrame: () => frame, waitForTimeout: async () => {} };
  const field = { id: 'f1', kind: 'combobox', inputType: 'text', selectLike: false, label: '* Major', required: true, options: [] as any[] };
  const run = (value: string) => applyActions(page as any, [field], [{ fieldId: 'f1', action: 'fill', value }], {}, { pause: async () => {} });
  return { input, run, field };
}

describe('a SuccessFactors autocomplete takes only a listed option (Damiani «Major», 2026-11-28)', () => {
  it('chooses the portal-style name of the field of study the CV writes in its own words', async () => {
    const f = autocomplete(['Biology', 'Accounting', 'Computer Science']);
    expect(await f.run('analista contabile finanziario')).toEqual([{ fieldId: 'f1', ok: true }]);
    expect(f.input.value).toBe('Accounting');
  });

  it('tries the keys in order and takes the first one the list really holds', async () => {
    const f = autocomplete(['Business Administration', 'Economics']);
    expect(await f.run('analista contabile finanziario')).toEqual([{ fieldId: 'f1', ok: true }]);
    expect(f.input.value).toBe('Business Administration');
  });

  it('takes the literal answer when the list has it', async () => {
    const f = autocomplete(['Accounting', 'Analista contabile finanziario']);
    expect(await f.run('analista contabile finanziario')).toEqual([{ fieldId: 'f1', ok: true }]);
    expect(f.input.value).toBe('Analista contabile finanziario');
  });

  it('prefers the exact name to a longer one that holds it', async () => {
    const f = autocomplete(['Accounting and Finance', 'Accounting']);
    expect((await f.run('contabilita'))[0].ok).toBe(true);
    expect(f.input.value).toBe('Accounting');
  });

  it('chooses nothing when no key is listed, and hands back what the portal lists', async () => {
    const f = autocomplete(['Biology', 'Chemistry', 'Physics']);
    const [result] = await f.run('analista contabile finanziario');
    expect(result).toMatchObject({ fieldId: 'f1', ok: false, error: 'option_not_found' });
    expect((result as any).optionDiagnostics.suggestions).toEqual(['Biology', 'Chemistry', 'Physics']);
    expect(f.input.value).not.toBe('Biology');
  });

  it('never picks by position or by a key shared by two options', () => {
    expect(pickSuggestionLabel(['Accounting Technology', 'Accounting Services'], 'Accounting', { literal: false })).toBe(-1);
    expect(pickSuggestionLabel(['Accounting', 'Accounting Services'], 'accounting', { literal: false })).toBe(0);
    expect(pickSuggestionLabel(['Accounting Services'], 'Accounting', { literal: false })).toBe(0);
    expect(pickSuggestionLabel(['Accounting Services'], 'Accounting', { literal: true })).toBe(-1);
    expect(pickSuggestionLabel(['Accountancy'], 'Accounting', { literal: false })).toBe(-1);
  });
});

describe('search keys, default and question for a field of study', () => {
  it('lists the CV words first, then the portal-style names', () => {
    expect(studyFieldSearchKeys('analista contabile finanziario').slice(0, 3)).toEqual(['analista contabile finanziario', 'Accounting', 'Finance']);
    expect(studyFieldSearchKeys('Informatica')).toEqual(['Informatica', 'Computer Science', 'Information Technology', 'Information Systems']);
    expect(studyFieldSearchKeys('')).toEqual([]);
  });

  it('answers an editable autocomplete «Major» from the diploma', () => {
    const facts = platformCandidateFacts({ profile: { education: [{ degree: 'Diploma di Maturita’ analista contabile finanziario' }] }, identity: {}, locale: 'it', seed: 's' });
    const major = { label: '* Major', kind: 'combobox', inputType: 'text', selectLike: false, options: [] };
    expect(platformDefaultAnswer(major, facts)?.value).toBe('analista contabile finanziario');
    // A closed picklist of the portal is another control: never answered with free text.
    expect(platformDefaultAnswer({ ...major, selectLike: true, options: [{ label: 'Accounting' }] }, facts)).toBeNull();
  });

  it('asks the candidate with the options the portal suggested, never as free text', () => {
    const field: any = { id: 'f1', kind: 'combobox', inputType: 'text', selectLike: false, label: '* Major', required: true, value: '' };
    const offered = new Map([[suggestionKey(field), ['Biology', 'Chemistry']]]);
    const items = emptyRequiredAsQuestions([field], offered);
    expect(items[0]).toMatchObject({ type: 'choice', applicationOptions: ['Biology', 'Chemistry'] });
    const requirements: any = portalRequirementsFromMissingRequired([field], items, { candidate: { identity: {}, profile: {}, answers: {} } });
    const [question] = requirements.questions;
    expect(question).toMatchObject({ applicationQuestion: '* Major', type: 'choice', applicationOptions: ['Biology', 'Chemistry'] });
    // Without suggestions it stays the free-text question of the earlier recovery.
    const plain = portalRequirementsFromMissingRequired([field], emptyRequiredAsQuestions([field]), { candidate: { identity: {}, profile: {}, answers: {} } }) as any;
    expect(plain.questions[0].type).toBe('text');
  });
});
