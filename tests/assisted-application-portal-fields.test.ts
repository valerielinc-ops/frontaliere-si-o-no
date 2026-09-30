import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { extractFieldsInPage } from '../scripts/assisted-application/lib/portal/fields.mjs';
import { guardPlan } from '../scripts/assisted-application/lib/portal/plan.mjs';

/** Runs the in-page extractor on `html` as Playwright would, with every element laid out. */
function extract(html: string) {
  const { window } = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: 'https://jobs.example/apply' });
  window.Element.prototype.getBoundingClientRect = () => ({ width: 20, height: 20, top: 0, left: 0, right: 20, bottom: 20, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('location', window.location);
  vi.stubGlobal('CSS', { escape: (value: string) => String(value).replace(/["\\\]]/g, '\\$&') });
  return extractFieldsInPage();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('portal field extraction', () => {
  it('reads a radio group required only by its label as required, and asks the candidate for it', () => {
    const page = extract(`
      <fieldset>
        <legend>Geschlecht* (erforderlich)</legend>
        <label><input type="radio" name="gender" value="f"> Weiblich</label>
        <label><input type="radio" name="gender" value="m"> Männlich</label>
      </fieldset>
      <fieldset>
        <legend>Newsletter</legend>
        <label><input type="radio" name="news" value="y"> Ja</label>
        <label><input type="radio" name="news" value="n"> Nein</label>
      </fieldset>`);
    const gender = page.fields.find((field: any) => field.name === 'gender');
    const news = page.fields.find((field: any) => field.name === 'news');
    expect(gender).toMatchObject({ kind: 'radio', label: 'Geschlecht* (erforderlich)', required: true });
    expect(gender.options.map((option: any) => option.label)).toEqual(['Weiblich', 'Männlich']);
    expect(news).toMatchObject({ kind: 'radio', required: false });

    // No gender in the candidate's data: an invented answer is dropped and the question goes to the candidate.
    const candidate = { answers: {}, profile: {}, portalQuestionsAnswered: [] };
    const guarded = guardPlan({ actions: [{ fieldId: gender.id, action: 'select', source: 'rule', value: 'Weiblich' }], missingRequired: [] }, page.fields, candidate);
    expect(guarded.actions).toEqual([]);
    expect(guarded.missingRequired).toEqual([expect.objectContaining({ fieldId: gender.id, question: 'Geschlecht', type: 'choice', options: ['Weiblich', 'Männlich'] })]);
  });
});
