import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { extractFieldsInPage } from '../scripts/assisted-application/lib/portal/fields.mjs';
import { holdsValue, isShownDate } from '../scripts/assisted-application/lib/portal/plan.mjs';
import { requiredEmptyDetail } from '../scripts/assisted-application/lib/portal/portal.mjs';

// Damiani, SuccessFactors career55 (2026-11-28): the runner reported portal_required_fields_unfilled on a form that was
// complete. «Date of Birth» is a text box showing MM/DD/YYYY; «01/13/1968» is no DD/MM date, so it counted as empty for ever.
function extract(html: string) {
  const { window } = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: 'https://career55.sapsf.eu/portalcareer' });
  Object.defineProperty(window.HTMLElement.prototype, 'innerText', { configurable: true, get() { return this.textContent || ''; } });
  window.Element.prototype.getBoundingClientRect = function rect() {
    return { width: 20, height: 20, top: 0, left: 0, right: 20, bottom: 20, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('location', window.location);
  vi.stubGlobal('CSS', { escape: (value: string) => String(value).replace(/["\\\]]/g, '\\$&') });
  return extractFieldsInPage({});
}
afterEach(() => { vi.unstubAllGlobals(); });

const page = (birth: string) => `<form aria-label="Job Application Form"><div role="region" aria-labelledby="p"><button id="p" type="button">Profile Information</button>
  <label for="first">* First Name</label><input id="first" type="text" aria-required="true" value="Ada">
  <label for="birth">* Date of Birth</label><input id="birth" type="text" aria-required="true" placeholder="MM/DD/YYYY" value="${birth}">
  <label for="start">Start Date</label><input id="start" type="text" placeholder="MM/DD/YYYY" value="">
</div></form>`;

describe('a required date shown in the portal\'s own format is held', () => {
  it('reads «01/13/1968» (MM/DD, day above 12) as a filled date', () => {
    const snapshot = extract(page('01/13/1968'));
    const birth = snapshot.fields.find((field: any) => field.label === '* Date of Birth');
    expect(birth.required).toBe(true);
    expect(holdsValue(birth)).toBe(true);
    expect(holdsValue(snapshot.fields.find((field: any) => field.label === '* First Name'))).toBe(true);
  });

  it('keeps an empty or placeholder date, an incomplete one and an impossible one as unfilled', () => {
    for (const value of ['', 'MM/DD/YYYY', '01/13', '13/13/1968', '02/30/1968', '00/10/1968']) {
      const snapshot = extract(page(value));
      const birth = snapshot.fields.find((field: any) => field.label === '* Date of Birth');
      expect(holdsValue(birth)).toBe(false);
    }
  });

  it('reads a shown date as a date in either order, and only a whole one', () => {
    for (const shown of ['01/13/1968', '13/01/1968', '12.31.1990', '31.12.1990', '2-3-2001']) expect(isShownDate(shown)).toBe(true);
    for (const shown of ['', 'MM/DD/YYYY', '1968', '01/13', '31/04/2020', '13/13/2000']) expect(isShownDate(shown)).toBe(false);
  });

  it('names an unfilled required field by its caption and reason, never by its value', () => {
    expect(requiredEmptyDetail({ label: '* Major', kind: 'combobox', value: '' })).toEqual({ label: '* Major', kind: 'combobox', reason: 'empty' });
    expect(requiredEmptyDetail({ label: '* Date of Birth', kind: 'text', value: '99/99/9999' }))
      .toEqual({ label: '* Date of Birth', kind: 'text', reason: 'value_not_recognised' });
    expect(requiredEmptyDetail({ label: 'CV', kind: 'file', inputType: 'file' }).reason).toBe('file_not_attached');
    expect(JSON.stringify(requiredEmptyDetail({ label: 'Name', kind: 'text', value: 'private-value' }))).not.toContain('private-value');
  });
});
