import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { extractFieldsInPage } from '../scripts/assisted-application/lib/portal/fields.mjs';

const opened: JSDOM[] = [];
const native = (attributes = '') => `<label for="wie_gefunden">How did you hear about this vacancy?</label>
  <select id="wie_gefunden" style="display:none" ${attributes}><option value="">Choose</option><option value="web">Website</option></select>`;
const proxy = `<span id="wie_gefunden-button" class="ui-selectmenu-button" role="combobox" aria-owns="wie_gefunden-menu">Website</span>`;
const menu = '<ul id="wie_gefunden-menu" style="display:none"><li>Website</li></ul>';

function snapshot(html: string) {
  const dom = new JSDOM(html + menu, { url: 'https://careers.example/application' });
  opened.push(dom);
  Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', { get() { return this.textContent || ''; } });
  dom.window.Element.prototype.getBoundingClientRect = () => ({ width: 20, height: 20 } as DOMRect);
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('location', dom.window.location);
  vi.stubGlobal('CSS', { escape: (value: string) => value });
  const result = extractFieldsInPage();
  const proxyNode = dom.window.document.getElementById('wie_gefunden-button')!;
  return { dom, field: result.fields.find((field: any) => field.id === proxyNode.getAttribute('data-aa-id')) };
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dom of opened.splice(0)) dom.window.close();
});

describe('native submitted control form ownership', () => {
  it.each([
    ['native inside its form', `<form id="native-owner">${native()}<button>Continue</button></form><form id="proxy-owner">${proxy}<button>Apply</button></form>`],
    ['native external form attribute', `<form id="native-owner"><button>Continue</button></form><form id="proxy-owner">${native('form="native-owner"')}${proxy}<button>Apply</button></form>`],
    ['anonymous native form', `<form>${native()}<button>Continue</button></form><form id="proxy-owner">${proxy}<button>Apply</button></form>`],
    ['duplicate HTML form ids', `<form id="same-form">${native()}<button>Continue</button></form><form id="same-form">${proxy}<button>Apply</button></form>`],
  ])('uses the real SELECT owner rather than the proxy wrapper: %s', (_case, html) => {
    const { dom, field } = snapshot(html);
    const nativeOwner = (dom.window.document.getElementById('wie_gefunden') as HTMLSelectElement).form!;
    const proxyOwner = dom.window.document.getElementById('wie_gefunden-button')!.closest('form')!;
    expect(nativeOwner).not.toBe(proxyOwner);
    expect(nativeOwner.getAttribute('data-aa-id')).toMatch(/^f\d+$/);
    expect(field).toMatchObject({ widget: 'jquery-selectmenu', nativeSelectId: 'wie_gefunden', formId: nativeOwner.getAttribute('data-aa-id') });
    expect(field.formId).not.toBe(proxyOwner.getAttribute('data-aa-id'));
  });

  it('keeps an ownerless native SELECT unknown even when its proxy is inside a form', () => {
    const { field } = snapshot(`${native()}<form id="proxy-owner">${proxy}<button>Apply</button></form>`);
    expect(field).toMatchObject({ widget: 'jquery-selectmenu', nativeSelectId: 'wie_gefunden', formId: '' });
  });

  it('does not pick the first native id when another element carries the same id', () => {
    const { dom, field } = snapshot(`<form id="native-owner">${native()}<button>Continue</button></form>
      <div id="wie_gefunden"></div><form id="proxy-owner">${proxy}<button>Apply</button></form>`);
    expect(field).toBeDefined();
    expect(field.formId).not.toBe(dom.window.document.getElementById('native-owner')!.getAttribute('data-aa-id'));
    // A stricter producer may reject the widget relationship earlier. If it
    // still exposes a native source id, the owner must remain unknown.
    if (field.nativeSelectId) expect(field.formId).toBe('');
  });
});
