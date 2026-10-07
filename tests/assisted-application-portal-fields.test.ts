import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { LIST_PROMPT_RE, extractFieldsInPage } from '../scripts/assisted-application/lib/portal/fields.mjs';
import { findButton } from '../scripts/assisted-application/lib/portal/fill.mjs';
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

  // JOIN's date question is one widget: the two generated comboboxes choose
  // year/month and the day buttons choose the value.
  it('reads a JOIN date picker as one required date field', () => {
    const page = extract(`
      <h2>Quando sei nato?</h2>
      <div data-scope="date-picker" data-part="root" data-empty="">
        <button type="button" data-part="prev-trigger" aria-label="Switch to previous month"></button>
        <input role="combobox" id="select-input-_r_n_" value="">
        <input role="combobox" id="select-input-_r_o_" value="">
        <button type="button" data-part="next-trigger" aria-label="Switch to next month"></button>
        <table data-part="table"><tbody><tr>
          <td role="gridcell"><div data-part="table-cell-trigger" role="button" data-value="1990-05-11">11</div></td>
          <td role="gridcell"><div data-part="table-cell-trigger" role="button" data-value="1990-05-12">12</div></td>
        </tr></tbody></table>
      </div>`);
    expect(page.fields).toHaveLength(1);
    expect(page.fields[0]).toMatchObject({ kind: 'date', inputType: 'date', label: 'Quando sei nato?', required: true, value: '' });
    // JSDOM does not expose innerText for the role=button day cells, but the
    // month controls are reported exactly as they are by the browser.
    expect(page.buttons.map((button: any) => button.text)).toEqual(expect.arrayContaining(['Switch to previous month', 'Switch to next month']));

    const selected = extract(`
      <h2>Quando sei nato?</h2>
      <div data-scope="date-picker" data-part="root">
        <table data-part="table"><tbody><tr><td><div data-part="table-cell-trigger" role="button" data-value="1990-05-12" data-selected="">12</div></td></tr></tbody></table>
      </div>`);
    expect(selected.fields[0]).toMatchObject({ kind: 'date', value: '1990-05-12' });
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

  it('says which <form> a control is sent with', () => {
    const page = extract('<form><label for="p">Password</label><input id="p" type="password"><label for="cv">Resume</label><input id="cv" type="file"></form>'
      + '<form><label for="q">Suche</label><input id="q"></form><label for="alone">Notiz</label><input id="alone">');
    expect(page.fields.map((field: any) => [field.label, field.form])).toEqual([['Password', 0], ['Resume', 0], ['Suche', 1], ['Notiz', -1]]);
  });

  // Coop's SuccessFactors form, mapped on 2026-10-03.
  it('reads SuccessFactors’ picklists as selects and its UI5 birth date as a date field', () => {
    const page = extract(`
      <input aria-label="Anrede" type="text" placeholder="Bitte auswählen" role="combobox" aria-owns="63:_listSelect" aria-required="true" class="rcmpaginatedselectinput">
      <input aria-label="Nationalité" type="text" placeholder="Aucune sélection" role="combobox" aria-owns="64:_listSelect" aria-required="true">
      <input aria-label="Suche" type="text" role="combobox" aria-controls="results">
      <div id="97:_datepicker" class="datePicker"><ui5-date-picker-xweb-calendar-widget ui5-date-picker="" title="Geburtsdatum" accessible-name="Geburtsdatum" format-pattern="dd.MM.yyyy" required="" placeholder="TT.MM.JJJJ"></ui5-date-picker-xweb-calendar-widget></div>`);
    const anrede = page.fields.find((field: any) => field.label === 'Anrede');
    expect(anrede).toMatchObject({ kind: 'combobox', required: true, selectLike: true, ownedList: '63:_listSelect' });
    expect(page.fields.find((field: any) => field.label === 'Nationalité')).toMatchObject({ selectLike: true, ownedList: '64:_listSelect' });
    // A search box is no select, even with a list of its own.
    expect(page.fields.find((field: any) => field.label === 'Suche')).toMatchObject({ kind: 'combobox', selectLike: false });
    expect(page.fields.find((field: any) => field.label === 'Geburtsdatum')).toMatchObject({ kind: 'text', inputType: 'date', widget: 'ui5-date', datePattern: 'dd.MM.yyyy', required: true });
  });

  it('answers «Vermittlungsbüro?» with its No, whatever the plan said, and never asks the candidate', () => {
    const agency = { id: 'f27', kind: 'combobox', selectLike: true, label: '* Stammt diese Bewerbung von einem Vermittlungsbüro? (Falls ja: Mit Einreichen des Dossiers werden die AGB der Coop Genossenschaft für die Personalvermittlung auf Erfolgsbasis akzeptiert.)', required: true, value: '', options: [{ value: 'Ja', label: 'Ja' }, { value: 'Nein', label: 'Nein' }] };
    const yes = guardPlan({ actions: [{ fieldId: 'f27', action: 'select', value: 'Ja', document: 'none', source: 'rule', evidence: '' }], missingRequired: [] }, [agency]);
    expect(yes.actions).toEqual([{ fieldId: 'f27', action: 'select', value: 'Nein', document: 'none', source: 'rule', evidence: '' }]);
    expect(yes.missingRequired).toEqual([]);
    const asked = guardPlan({ actions: [], missingRequired: [{ fieldId: 'f27', question: 'Agenzia?', why: '', type: 'choice', options: ['Ja', 'Nein'] }] }, [agency]);
    expect(asked.actions.map((action: any) => action.value)).toEqual(['Nein']);
    expect(asked.missingRequired).toEqual([]);
    // Review of #11036: options not read, no "No" to choose: the plan's "Ja" is dropped, the field stays open.
    const unread = guardPlan({ actions: [{ fieldId: 'a', action: 'select', value: 'Ja', document: 'none', source: 'rule', evidence: '' }], missingRequired: [] }, [{ id: 'a', kind: 'combobox', label: 'Vermittlungsbüro', required: true, value: '', options: [] }]);
    expect(unread.actions.some((action: any) => action.fieldId === 'a')).toBe(false);
    expect(unread.missingRequired.map((item: any) => item.fieldId)).toEqual(['a']);
    // Any other Ja/Nein question is left to the plan.
    const employee = { ...agency, id: 'f26', label: '* Ich bin bereits Mitarbeiter/in bei der Coop Gruppe' };
    expect(guardPlan({ actions: [{ fieldId: 'f26', action: 'select', value: 'Nein', document: 'none', source: 'rule', evidence: '' }], missingRequired: [] }, [employee]).actions.map((action: any) => action.value)).toEqual(['Nein']);
  });

  // A real order of 2026-10-07 (Workday): the «Create Account» page as its own code draws it.
  it('never reads a honeypot as a field of the form, nor the submit Workday hides under its click filter as one to press', () => {
    const account = extract(`
      <form>
        <label for="e">Email Address*</label><input id="e" type="text" autocomplete="email" required>
        <label for="p1">Password*</label><input id="p1" type="password" required>
        <label for="p2">Verify New Password*</label><input id="p2" type="password" required>
        <div><label for="hp">Enter website. This input is for robots only, do not enter if you're human.</label>
          <input id="hp" name="website" type="text" data-automation-id="beecatcher" data-size="1"></div>
        <div><div role="button" tabindex="0" aria-label="Create Account" data-automation-id="click_filter"></div>
          <button type="submit" tabindex="-2" aria-hidden="true" aria-label="Create Account">Create Account</button></div>
        <button type="button" aria-label="Sign In">Sign In</button>
      </form>`);
    expect(account.fields.map((field: any) => field.label)).toEqual(['Email Address*', 'Password*', 'Verify New Password*']);
    // The overlay people click is the one «Create Account»; the real submit next to it is hidden from them
    // and out of the tab order. (jsdom has no innerText: the buttons of this file are read by their aria-label.)
    expect(account.buttons.map((button: any) => button.text)).toEqual(['Create Account', 'Sign In']);
    // A trap is one by what its label says or by its size alone, whichever it shows.
    const traps = extract(`
      <label for="a">Leave this field for robots only</label><input id="a" name="trap_a">
      <label for="b">Company</label><input id="b" name="company_fax" data-size="1">
      <label for="c">Only fill this in if you are human? No: if you're human, skip it</label><input id="c" name="trap_c">
      <label for="d">Website</label><input id="d" name="website">
      <label for="t">Notes</label><textarea id="t" name="notes" data-size="1"></textarea>`);
    expect(traps.fields.map((field: any) => field.name)).toEqual(['website']);
    // What is hidden on purpose behind a widget of its own keeps the rule it had: a native checkbox with a
    // visible label, a file input behind its button.
    const widgets = extract(`
      <label for="k"><input id="k" type="checkbox" name="privacy" data-size="1"> I accept</label>
      <label for="f">CV</label><input id="f" type="file" name="cv" data-size="1">`);
    expect(widgets.fields.map((field: any) => field.name)).toEqual(['privacy', 'cv']);
  });

  // Review of #12255: aria-hidden is a flag of the accessibility tree, not a sign that nothing is drawn.
  it('keeps a drawn button that is only aria-hidden, and leaves out what lies under an open modal dialog', () => {
    // A submit some portal marks aria-hidden with no overlay next to it is still the one to press: alone, out
    // of the tab order or not, and next to a control of another name.
    const drawn = extract(`
      <form>
        <button type="submit" aria-hidden="true" aria-label="Send application">Send application</button>
        <div><button type="button" tabindex="-1" aria-hidden="true" aria-label="Next">Next</button><div role="button" tabindex="0" aria-label="Back">Back</div></div>
        <div aria-hidden="true"><button type="button" aria-label="Save draft">Save draft</button></div>
      </form>`);
    expect(drawn.buttons.map((button: any) => button.text)).toEqual(['Send application', 'Next', 'Back', 'Save draft']);
    // Workday's pair: the same name on a visible overlay next to the hidden, unfocusable submit.
    const filtered = extract(`
      <div><div role="button" tabindex="0" aria-label="Sign In" data-automation-id="click_filter"></div>
        <button type="submit" tabindex="-2" aria-hidden="true" aria-label="Sign In">Sign In</button></div>`);
    expect(filtered.buttons).toHaveLength(1);
    expect(filtered.buttons[0].text).toBe('Sign In');
    // What a page hides while its modal dialog is open is under that dialog; the dialog's own buttons count.
    const modal = extract(`
      <div aria-hidden="true"><header><button type="button" aria-label="Sign In">Sign In</button></header>
        <main><button type="button" aria-label="Create Account">Create Account</button></main></div>
      <div role="dialog" aria-modal="true"><button type="button" aria-label="Close">Close</button><button type="button" aria-label="Sign In">Sign In</button></div>`);
    expect(modal.buttons.map((button: any) => `${button.text}${button.dialog ? ' (dialog)' : ''}`)).toEqual(['Close (dialog)', 'Sign In (dialog)']);
  });

  // Dry run of 2026-10-07 (Workday): two «Sign In» on the account page, the site header's first in the
  // document (it opens a dialog over the page) and the form's own link.
  it('tells a control of the site’s header, navigation or footer from one of the page', () => {
    const page = extract(`
      <header><div><button type="button" aria-label="Sign In">Sign In</button></div></header>
      <nav><a role="button" aria-label="Jobs">Jobs</a></nav>
      <main>
        <form>
          <label for="e">Email Address*</label><input id="e" type="text" required>
          <label for="p1">Password*</label><input id="p1" type="password" required>
          <button type="button" aria-label="Sign In">Sign In</button>
          <footer><button type="submit" aria-label="Create Account">Create Account</button></footer>
        </form>
        <section><header><button type="button" aria-label="Edit">Edit</button></header></section>
      </main>
      <div role="dialog"><footer><button type="button" aria-label="Accept">Accept</button></footer></div>
      <footer><button type="button" aria-label="Cookie settings">Cookie settings</button></footer>
      <div role="contentinfo"><button type="button" aria-label="Imprint">Imprint</button></div>`);
    // A <footer> or a <header> inside the form, a section or a dialog belongs to the page, not to the site.
    expect(page.buttons.map((button: any) => `${button.text}${button.chrome ? ' (site)' : ''}`)).toEqual([
      'Sign In (site)', 'Jobs (site)', 'Sign In', 'Create Account', 'Edit', 'Accept', 'Cookie settings (site)', 'Imprint (site)',
    ]);
    // Of the two «Sign In» the form's is the one to press; the header's only where it is the only one.
    expect(findButton(page.buttons, /^sign in$/i).chrome).toBeUndefined();
    expect(findButton(page.buttons, /^jobs$/i).text).toBe('Jobs');
  });

  // Workday's «settingsSelectorButton» (the language of the site, in its header) was read as a field of
  // every page of the form (2026-10-07): a menu of the site is no question of the application.
  it('leaves the menus of the site’s header out of the fields, and keeps the form’s own', () => {
    const page = extract(`
      <header><button type="button" aria-haspopup="listbox" aria-label="settingsSelectorButton">English</button></header>
      <main><form>
        <label id="c">Country*</label><button type="button" aria-haspopup="listbox" aria-labelledby="c" aria-label="Country*">Switzerland</button>
      </form></main>`);
    expect(page.fields.map((field: any) => `${field.label} (${field.kind})`)).toEqual(['Country* (listbox)']);
  });

  // «Select One» was offered to the candidate as a marital status (dry run of 2026-10-07).
  it('knows a list’s prompt from its options', () => {
    for (const prompt of ['Select One', 'Select one', 'Please select', 'Bitte auswählen', 'Bitte wählen', 'Seleziona', 'Sélectionnez', 'Choisir']) expect(LIST_PROMPT_RE.test(prompt)).toBe(true);
    for (const option of ['Single (Switzerland)', 'Married (Switzerland)', 'Switzerland', 'Mobile', 'Selbständig']) expect(LIST_PROMPT_RE.test(option)).toBe(false);
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
