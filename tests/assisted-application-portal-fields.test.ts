import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { extractFieldsInPage } from '../scripts/assisted-application/lib/portal/fields.mjs';
import { guardPlan } from '../scripts/assisted-application/lib/portal/plan.mjs';

/** Runs the in-page extractor on `html` as Playwright would, with every element laid out (data-size: its side in px, default 20). */
function extract(html: string) {
  const { window } = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: 'https://jobs.example/apply' });
  window.Element.prototype.getBoundingClientRect = function rect(this: Element) {
    const size = Number(this.getAttribute('data-size') || 20);
    return { width: size, height: size, top: 0, left: 0, right: size, bottom: size, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
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
  it.each([
    ['https://www.google.com/recaptcha/api2/anchor?size=normal', 'g-recaptcha-response'],
    ['https://newassets.hcaptcha.com/captcha/v1/test?frame=checkbox', 'h-captcha-response'],
    ['https://challenges.cloudflare.com/turnstile/test', 'cf-turnstile-response'],
  ])('recognizes an answered %s challenge while keeping unresolved widgets pending', (src, name) => {
    const iframe = `<iframe src="${src}" data-size="200"></iframe>`;
    expect(extract(`${iframe}<textarea name="${name}"></textarea>`).captcha).toBe(true);
    expect(extract(`${iframe}<textarea name="${name}">solved-token</textarea>`).captcha).toBe(false);
    expect(extract(`${iframe}<textarea name="${name}">solved-token</textarea><textarea name="${name}"></textarea>`).captcha).toBe(true);
  });

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
    // The heading names the step; the zone adds the text nearest before the input.
    expect(file.label).toBe('Carica il tuo CV · Fare clic per sfogliare o trascinare qui un file.');
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
    // Second round: another section's heading, and a sibling field's question, name nothing here.
    expect(extract('<section><h2>Inactive step</h2></section><section><div><input id="input-7"></div></section>').fields[0].label).not.toContain('Inactive step');
    const pair = extract('<div><span>First question</span><input id="input-7"><span>Second question</span><input id="input-8"></div>');
    expect(pair.fields.map((field: any) => field.label)).toEqual(['First question', 'Second question']);
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

  // Giro di prova 2026-10-01 on JOIN: every step reported the page title as a form error.
  it('reads the form’s own messages, not a route announcer only screen readers get', () => {
    const page = extract(`
      <p id="__next-route-announcer__" role="alert" aria-live="assertive" data-size="1">Frontaliere Ticino (Stabio): Infermiere/a</p>
      <label for="mail">E-Mail</label><input id="mail" type="email">
      <div role="alert">Inserisci un indirizzo e-mail valido</div>`);
    expect(page.errors).toEqual(['Inserisci un indirizzo e-mail valido']);
    // Review of #10707: a visually hidden validation message is still the form's own.
    const hidden = extract('<label for="m">E-Mail</label><input id="m" type="email"><div role="alert" data-size="1">Invalid email</div>');
    expect(hidden.errors).toEqual(['Invalid email']);
    // Second review: no size at all (0 px) is still a message; a hidden template is not.
    const zero = extract('<input id="m" type="email"><div role="alert" data-size="0">Invalid email</div><div class="error" style="display:none">Old message</div>');
    expect(zero.errors).toEqual(['Invalid email']);
  });

  // career-ops counts the final answer: a limit stated in words or by a counter is a limit too.
  it('reads a length limit the form states only in words or with a counter', () => {
    const page = extract(`
      <div><label for="a">Motivazione</label><div><textarea id="a" aria-describedby="a-help"></textarea><small id="a-help">Massimo 500 caratteri</small></div></div>
      <div><label for="b">Anschreiben</label><div><textarea id="b" aria-describedby="b-count"></textarea><span id="b-count">0 / 1000</span></div></div>
      <div><p>Schritt 1 / 12</p><label for="c">Bemerkungen</label><div><textarea id="c"></textarea></div></div>
      <div><label for="d">Telefono</label><input id="d" maxlength="20"></div>`);
    const limit = (id: string) => page.fields.find((field: any) => field.name === '' && field.label && field.id && document.querySelector(`[data-aa-id="${field.id}"]`)?.id === id)?.maxLength;
    expect(limit('a')).toBe(500);
    expect(limit('b')).toBe(1000);
    expect(limit('c')).toBeNull();
    expect(limit('d')).toBe(20);
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
