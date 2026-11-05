import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { extractFieldsInPage } from '../scripts/assisted-application/lib/portal/fields.mjs';
import { markOptionalAutofillDeclineInPage } from '../scripts/assisted-application/lib/portal/optional-autofill.mjs';
import { authPageKind } from '../scripts/assisted-application/lib/portal/account.mjs';

let dom: JSDOM;
function extract(html: string) {
  dom = new JSDOM(html, { url: 'https://portal.example/career/' });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', { get() { return this.textContent || ''; } });
  // Inert elements retain layout boxes in browsers.
  dom.window.Element.prototype.getBoundingClientRect = () => ({ width: 20, height: 20 } as DOMRect);
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('getComputedStyle', dom.window.getComputedStyle);
  vi.stubGlobal('location', dom.window.location);
  vi.stubGlobal('CSS', { escape: (value: string) => value });
  return extractFieldsInPage();
}
afterEach(() => { vi.unstubAllGlobals(); dom?.window.close(); });

// Labels come from #17182/#17094; containment and state are synthetic.
// These fixtures do not assert which DOM was present in either live run.
const registration = (create: string, privacy: string) => `<form>
  <label>E-Mail-Adresse: *<input required></label>
  <label>E-Mail-Adresse wiederholen: *<input required></label>
  <label>Passwort *<input type="password" required></label>
  <label>Passwort wiederholen: *<input type="password" required></label>
  <label>Vorname: *<input required></label><label>Nachname: *<input required></label>
  <label>Land des Wohnorts:*<select required><option value="">Choose</option></select></label>
  <label>Unknown required answer<input required></label>
  <label>Mehr über Karrierechancen erfahren<input type="checkbox"></label>
  <button type="button">Cookie-Einstellungen</button>
  <button type="button">${privacy}</button><button>${create}</button>
</form>`;

describe('portal inactive surface boundary', () => {
  it.each(['inert', 'hidden', 'style="display:none"', 'style="visibility:hidden"'])('excludes mounted inactive controls (%s)', state => {
    const snapshot = extract(`<section ${state}>${registration('Konto anlegen', 'Lese und akzeptiere die Datenschutzerklärung.')}</section>
      <form><label>E-Mail<input type="email"></label><label>Password<input type="password"></label><button>Login</button></form>`);
    expect(snapshot.fields.map((field: any) => field.label)).toEqual(['E-Mail', 'Password']);
    expect(snapshot.buttons.map((button: any) => button.text)).toEqual(['Login']);
    expect(authPageKind(snapshot)).toBe('sign_in');
  });

  it.each([
    ['Konto anlegen', 'Lese und akzeptiere die Datenschutzerklärung.'],
    ['Bewerbungskonto erstellen', 'Lesen und akzeptieren Sie die Datenschutzerklärung'],
  ])('preserves active registration and unresolved candidate controls: %s', (create, privacy) => {
    const snapshot = extract(`<section aria-hidden="false">${registration(create, privacy)}</section>
      <section inert><button>Accept All Cookies</button><input type="file" required></section>`);
    expect(authPageKind(snapshot)).toBe('create');
    expect(snapshot.buttons.map((button: any) => button.text)).toEqual(['Cookie-Einstellungen', privacy, create]);
    expect(snapshot.fields).toHaveLength(9);
    expect(snapshot.fields.find((field: any) => field.label === 'Unknown required answer')).toMatchObject({ required: true, value: '' });
    expect(snapshot.fields.find((field: any) => field.kind === 'checkbox')).toMatchObject({ checked: false });
    expect(snapshot.fields.find((field: any) => field.kind === 'select')).toMatchObject({ value: '' });
    expect(snapshot.fields.some((field: any) => field.kind === 'file')).toBe(false);
  });

  it.each(['inert', 'hidden', 'style="display:none"', 'style="visibility:hidden"'])('does not mark an inactive optional-parser decline (%s)', state => {
    extract(`<section ${state}><div role="dialog">Artificial intelligence may analyse this document for automatic form filling. Proceeding without AI has no effect on this application.<button type="button">Decline</button></div></section>`);
    expect(markOptionalAutofillDeclineInPage()).toBe(false);
    expect(document.querySelector('[data-aa-autofill-decline]')).toBeNull();
  });

  it('excludes controls explicitly marked inactive without an inactive ancestor', () => {
    const snapshot = extract('<button inert>Accept All Cookies</button><input inert type="password"><label><input inert type="checkbox">Unknown approval</label>');
    expect(snapshot.fields).toEqual([]);
    expect(snapshot.buttons).toEqual([]);
    expect(snapshot.passwordVisible).toBe(false);
    expect(authPageKind(snapshot)).toBe('none');
  });
});
