import { afterEach, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { extractFieldsInPage, readListboxOptions, readOwnedListOptions } from '../scripts/assisted-application/lib/portal/fields.mjs';
import { preferredCvFields } from '../scripts/assisted-application/lib/portal/portal.mjs';
import { applyActions } from '../scripts/assisted-application/lib/portal/fill.mjs';
import { candidateAnswerForField } from '../scripts/assisted-application/lib/portal/plan.mjs';

const html = `<form><label id="workload-label">Grado di occupazione desiderato *</label>
<select id="workload" aria-labelledby="workload-label" multiple aria-required="true" style="display:none">
<option value="full">100%</option><option value="part">80%</option><option disabled value="disabled">60%</option></select>
<button class="ui-multiselect" type="button" aria-haspopup="listbox" aria-labelledby="workload-label">Seleziona</button>
<a class="button button--primary" href="/ApplicationMethods?jobId=42">Create profile</a>
<a href="/company">Company profile</a></form>`;
function extract(markup = html) {
  const { window } = new JSDOM(markup, { url: 'https://careers.example.test/Login' });
  Object.defineProperty(window.HTMLElement.prototype, 'innerText', { configurable: true, get() { return this.textContent || ''; } });
  window.Element.prototype.getBoundingClientRect = () => ({ width: 20, height: 20 } as DOMRect);
  vi.stubGlobal('window', window); vi.stubGlobal('document', window.document); vi.stubGlobal('location', window.location);
  vi.stubGlobal('CSS', { escape: (value: string) => value });
  return extractFieldsInPage();
}
afterEach(() => vi.unstubAllGlobals());

it('reads the option catalogue of an explicitly owned checkbox-backed listbox', () => {
  const choice = extract().fields.find((field: any) => field.widget === 'jquery-multiselect');
  expect(choice).toMatchObject({ required: true, nativeSelectId: 'workload', options: [{ value: 'full', label: '100%' }, { value: 'part', label: '80%' }] });
  expect(candidateAnswerForField({ answers: [{ question: 'Grado di occupazione desiderato *', answer: '100', source: 'policy_default' }] }, choice)?.value).toBe('100%');
});

it('does not borrow the option catalogue from an unrelated neighboring select', () => {
  expect(extract(html.replace('aria-labelledby="workload-label" multiple', 'aria-labelledby="other-label" multiple')).fields.some((field: any) => field.widget === 'jquery-multiselect')).toBe(false);
});

it('discovers styled registration links while leaving ordinary profile links as content', () => {
  expect(extract().buttons.map((button: any) => button.text)).toEqual(['Create profile']);
});

it('prefers mandatory CV attachments and preserves other required document families', () => {
  const parser = { id: 'parser', kind: 'file', label: 'CV-Upload', required: false };
  const cv = { id: 'cv', kind: 'file', label: 'Curriculum vitae', required: true };
  const otherCv = { ...cv, id: 'other-cv', label: 'Resume' };
  const letter = { id: 'letter', kind: 'file', label: 'Cover letter', required: true };
  expect(preferredCvFields([parser, cv, otherCv, letter]).map((field: any) => field.id)).toEqual(['cv', 'other-cv']);
  expect(preferredCvFields([parser, letter]).map((field: any) => field.id)).toEqual(['parser']);
  expect(preferredCvFields([letter])).toEqual([]);
});

it.each([true, false])('requires native selection proof after the checkbox is pressed (%s)', async committed => {
  const choice = extract().fields.find((field: any) => field.widget === 'jquery-multiselect');
  let selected = false;
  const button = { click: vi.fn(async () => {}), press: vi.fn(async () => {}) };
  const checkbox = { count: async () => 1, setChecked: vi.fn(async () => { selected = true; }) };
  const native = { evaluate: async () => selected && committed };
  const frame = { locator: vi.fn((selector: string) => selector.startsWith('input[name="multiselect_workload"]') ? checkbox : selector.startsWith('select[') ? native : { first: () => button }) };
  const page = { frames: () => [frame], mainFrame: () => frame };
  const result = await applyActions(page, [choice], [{ fieldId: choice.id, action: 'select', value: '100%' }], {}, { pause: async () => {} });
  expect(checkbox.setChecked).toHaveBeenCalledWith(true, { timeout: 6000 });
  expect(result).toEqual([committed ? { fieldId: choice.id, ok: true } : { fieldId: choice.id, ok: false, error: 'choice_not_registered' }]);
});


it.each(['native', 'jquery'])('keeps the full option domain beyond 300 entries: %s', widget => {
  const options = Array.from({ length: 301 }, (_, i) => `<option value="v${i + 1}">Option ${i + 1}</option>`).join('');
  const markup = `<label id="choice-label">Required choice *</label><select id="choice" aria-labelledby="choice-label" ${widget === 'jquery' ? 'style="display:none" multiple' : ''}>${options}</select>`
    + (widget === 'jquery' ? '<button type="button" class="ui-multiselect" aria-haspopup="listbox" aria-labelledby="choice-label">Select</button>' : '');
  const fields = extract(markup).fields;
  const field = fields.find((field: any) => widget === 'jquery' ? field.widget === 'jquery-multiselect' : field.kind === 'select');
  expect(field.options).toHaveLength(301);
  expect(field.options[300]).toEqual({ value: 'v301', label: 'Option 301' });
});

it('selects option 301 of a checkbox-backed listbox with native confirmation', async () => {
  const field = { id: 'choice', kind: 'listbox', widget: 'jquery-multiselect', nativeSelectId: 'choice', options: Array.from({ length: 301 }, (_, i) => ({ value: `v${i + 1}`, label: `Option ${i + 1}` })) };
  let selected = false;
  const button = { click: vi.fn(async () => {}), press: vi.fn(async () => {}) };
  const checkbox = { count: async () => 1, setChecked: vi.fn(async () => { selected = true; }) };
  const frame = { locator: vi.fn((selector: string) => selector.startsWith('input[') ? (expect(selector).toContain('[value="v301"]'), checkbox) : selector.startsWith('select[') ? { evaluate: async (_fn: any, value: string) => selected && value === 'v301' } : { first: () => button }) };
  expect(await applyActions({ frames: () => [frame], mainFrame: () => frame }, [field], [{ fieldId: 'choice', action: 'select', value: 'Option 301' }], {}, { pause: async () => {} })).toEqual([{ fieldId: 'choice', ok: true }]);
});

it.each(['listbox', 'owned'])('keeps complete ARIA option catalogues as well: %s', kind => {
  const labels = Array.from({ length: 301 }, (_, i) => `Option ${i + 1}`);
  const button = { click: async () => {}, press: async () => {} };
  const options = { first: () => ({ waitFor: async () => {} }), allInnerTexts: async () => labels };
  const list = { waitFor: async () => {}, locator: () => options };
  const frame = { locator: (selector: string) => selector.startsWith('[data-aa-id=') ? { first: () => button } : selector === '[role="listbox"]:visible' ? { last: () => list } : list };
  const result = kind === 'owned' ? readOwnedListOptions(frame, { id: 'choice', ownedList: 'choices' }) : readListboxOptions(frame, 'choice');
  return expect(result).resolves.toHaveLength(301);
});
