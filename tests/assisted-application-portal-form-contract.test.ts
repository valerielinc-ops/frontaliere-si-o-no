import { afterEach, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { extractFieldsInPage } from '../scripts/assisted-application/lib/portal/fields.mjs';
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
