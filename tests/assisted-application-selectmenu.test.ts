import { afterEach, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { extractFieldsInPage } from '../scripts/assisted-application/lib/portal/fields.mjs';
import { applyActions } from '../scripts/assisted-application/lib/portal/fill.mjs';

function extract(owns = 'notice-menu') {
  const dom = new JSDOM(`<form><label for="notice">Attuale periodo di preavviso *</label>
    <select id="notice" style="display:none" aria-required="true"><option value="">---</option><option value="month3">3 mesi</option><option value="month1">1 mese</option></select>
    <span id="notice-button" class="ui-selectmenu-button" role="combobox" aria-owns="${owns}"></span>
    <ul id="notice-menu"><li><div>3 mesi</div></li><li><div>1 mese</div></li></ul></form>`, { url: 'https://careers.example/register/' });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', { get() { return this.textContent || ''; } });
  dom.window.Element.prototype.getBoundingClientRect = () => ({ width: 20, height: 20 } as DOMRect);
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document); vi.stubGlobal('location', dom.window.location);
  vi.stubGlobal('CSS', { escape: (value: string) => value });
  return { dom, fields: extractFieldsInPage().fields };
}
afterEach(() => vi.unstubAllGlobals());

it('uses the complete catalogue of the native select only when menu ownership agrees', () => {
  const { dom, fields } = extract();
  expect(fields.find((field: any) => field.widget === 'jquery-selectmenu')).toMatchObject({
    nativeSelectId: 'notice', ownedList: 'notice-menu', label: 'Attuale periodo di preavviso *', required: true,
    options: [{ value: '', label: '---' }, { value: 'month3', label: '3 mesi' }, { value: 'month1', label: '1 mese' }],
  });
  dom.window.close();
  const neighbor = extract('some-other-menu');
  expect(neighbor.fields.some((field: any) => field.widget === 'jquery-selectmenu')).toBe(false);
  neighbor.dom.window.close();
});

it.each([true, false])('requires the exact choice in the submitted native control (%s)', async committed => {
  const { dom, fields } = extract();
  const field = fields.find((item: any) => item.widget === 'jquery-selectmenu');
  const choose = vi.fn(async () => {});
  const getByText = vi.fn(() => ({ count: async () => 1, click: choose }));
  const frame = { locator: (selector: string) => selector.startsWith('[id=') ? { getByText }
    : selector.startsWith('select[') ? { evaluate: async () => committed } : { first: () => ({ click: async () => {} }) } };
  const result = await applyActions({ frames: () => [frame], mainFrame: () => frame }, [field], [{ fieldId: field.id, action: 'select', value: '3 mesi' }], {}, { pause: async () => {} });
  expect(getByText).toHaveBeenCalledWith('3 mesi', { exact: true });
  expect(choose).toHaveBeenCalledTimes(1);
  expect(result[0]).toMatchObject(committed ? { ok: true } : { ok: false, error: 'choice_not_registered' });
  dom.window.close();
});
