import { afterEach, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { extractFieldsInPage } from '../scripts/assisted-application/lib/portal/fields.mjs';
import { applyActions } from '../scripts/assisted-application/lib/portal/fill.mjs';

function extract(owns = 'notice-menu') {
  const dom = new JSDOM(`<form><label for="notice">Attuale periodo di preavviso *</label>
    <select id="notice" style="display:none" aria-required="true"><option value="">---</option><option value="month3">3 mesi</option><option value="month1">1 mese</option><optgroup disabled label="Unavailable"><option value="blocked">6 mesi</option></optgroup></select>
    <span id="notice-button" class="ui-selectmenu-button" role="combobox" aria-owns="${owns}"></span>
    <ul id="notice-menu" style="display:none"><li><div class="ui-menu-item-wrapper">3 mesi</div></li><li><div class="ui-menu-item-wrapper">1 mese</div></li><li><div class="ui-menu-item-wrapper">6 mesi</div></li></ul></form>`, { url: 'https://careers.example/register/', runScripts: 'outside-only' });
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

it('the extension uses the owned selectmenu and excludes a disabled optgroup choice', async () => {
  const { dom } = extract();
  const { document } = dom.window;
  for (const file of ['runner-fields.js', 'apply-control.js', 'filler.js']) dom.window.eval(readFileSync(new URL(`../scripts/assisted-application/extension/${file}`, import.meta.url), 'utf8'));
  const native = document.getElementById('notice') as HTMLSelectElement;
  const menu = document.getElementById('notice-menu') as HTMLElement;
  document.getElementById('notice-button')!.addEventListener('click', () => { menu.style.display = 'block'; });
  menu.querySelectorAll('div')[0].addEventListener('click', () => { native.value = 'month3'; menu.style.display = 'none'; });
  const extension = (dom.window as any).CompilaCandidatura;
  const entry = extension.collect(document).find((item: any) => item.widget === 'jquery-selectmenu');
  expect(await extension.fillEntry(entry, { value: '3 mesi' }, {})).toBe(true);
  expect(native.value).toBe('month3');
  expect(await extension.fillEntry(entry, { value: '6 mesi' }, {})).toBe(false);
  expect(native.value).toBe('month3');
  // The ordinary native-select reader follows the same disabled-group rule.
  native.style.display = 'block';
  const snapshot = extractFieldsInPage();
  expect(snapshot.fields.find((field: any) => field.kind === 'select')?.options.some((option: any) => option.value === 'blocked')).toBe(false);
  dom.window.close();
});
