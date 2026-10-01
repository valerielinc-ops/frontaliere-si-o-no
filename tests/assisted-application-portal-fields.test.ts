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
  // Giro di prova 2026-10-01 on JOIN: the CV drop zone had no label, only "file:_r_3_:input",
  // so the planner skipped it and the run handed the application over.
  it('names an unlabelled drop zone by its heading and zone text, not by a generated id', () => {
    const page = extract(`
      <h1>Carica il tuo CV</h1>
      <div class="dropzone"><div><span>Carica file</span><p>Fare clic per sfogliare o trascinare qui un file.</p>
        <input type="file" id="file:_r_3_:input" accept=".pdf"></div></div>
      <label for="city">Località</label><input id="city" name="city">
      <input name="nickname">`);
    const file = page.fields.find((field: any) => field.kind === 'file');
    expect(file.label).toBe('Carica il tuo CV · Carica file');
    // A real label or a meaningful name is kept as before.
    expect(page.fields.find((field: any) => field.name === 'city').label).toBe('Località');
    expect(page.fields.find((field: any) => field.name === 'nickname').label).toBe('nickname');
  });

  // Giro di prova 2026-10-01 on JOIN: option cards are ARIA radios with no native input.
  it('reads an ARIA radio group as one question with its options, and the chosen one', () => {
    const card = (letter: string, title: string, text: string, checked = false) => `
      <div><div role="radio" aria-checked="${checked}" tabindex="0"><div><p>${letter}</p></div>
        <div><p>${title}</p><p>${text}</p></div></div></div>`;
    const page = extract(`
      <div><h2>Qual è il suo stato di autorizzazione al lavoro per Svizzera?</h2><div><div>
        ${card('a', 'Posso lavorare qui senza alcuna restrizione', 'Ho la cittadinanza.')}
        ${card('b', 'Posso lavorare qui, ma solo per un periodo limitato', 'Fino alla scadenza.', true)}
        ${card('d', 'Non posso ancora lavorare qui', 'Serve un permesso.')}
      </div></div></div>`);
    expect(page.fields).toHaveLength(1);
    const [field] = page.fields;
    expect(field).toMatchObject({ kind: 'radio', label: 'Qual è il suo stato di autorizzazione al lavoro per Svizzera?' });
    expect(field.options.map((option: any) => option.label)).toEqual([
      'Posso lavorare qui senza alcuna restrizione — Ho la cittadinanza.',
      'Posso lavorare qui, ma solo per un periodo limitato — Fino alla scadenza.',
      'Non posso ancora lavorare qui — Serve un permesso.',
    ]);
    expect(field.value).toBe('Posso lavorare qui, ma solo per un periodo limitato — Fino alla scadenza.');
    expect(field.options.every((option: any) => /^f\d+$/.test(option.aaId))).toBe(true);
  });

  // Review of #10698.
  it('prefers a meaningful id to a generated name, skips hidden headings and never reads a label from inside a control', () => {
    expect(extract('<input name="input-7" id="email-address">').fields[0].label).toBe('email-address');
    const steps = extract('<h2>Current step</h2><h2 hidden>Inactive step</h2><div><input id="input-7"></div>');
    expect(steps.fields[0].label).toContain('Current step');
    expect(steps.fields[0].label).not.toContain('Inactive step');
    const country = extract('<h2>Paese</h2><div><select id="input-7"><option>Italia</option><option>Svizzera</option></select></div>');
    expect(country.fields[0].label).toBe('Paese');
  });

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

  it('keeps Workday’s select-input search boxes and leaves the site’s own search out', () => {
    const page = extract(`
      <form role="search"><input type="search" name="q" aria-label="Jobs durchsuchen"></form>
      <div class="field">
        <label for="country">Land*</label>
        <input id="country" type="search" data-uxi-widget-type="selectinput" data-uxi-multiselect-id="country">
      </div>`);
    const searchFields = page.fields.filter((field: any) => field.inputType === 'search');
    expect(searchFields).toHaveLength(1);
    expect(searchFields[0]).toMatchObject({ label: 'Land*', search: true, required: true });
  });
});
