import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { CONFIRM_RE, NEXT_RE, REFUSED_RE, SUBMIT_RE } from '../scripts/assisted-application/lib/portal/fill.mjs';
import { APPLY_RE, COOKIE_REJECT_RE } from '../scripts/assisted-application/lib/portal/portal.mjs';
import { NOT_ADVANCE_RE } from '../scripts/assisted-application/lib/portal/agent.mjs';

const extension = resolve(fileURLToPath(new URL('..', import.meta.url)), 'scripts/assisted-application/extension');
const fillerSource = readFileSync(resolve(extension, 'filler.js'), 'utf8');

/** The page engine loaded into a page, as the extension injects it. */
function page(html: string, url = 'https://join.com/companies/acme/1/apply/step') {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url, runScripts: 'outside-only' });
  dom.window.eval(fillerSource);
  const F = (dom.window as any).CompilaCandidatura;
  F.config.waitMs = 200;
  F.config.stepMs = 5;
  return { window: dom.window, document: dom.window.document, F };
}

// The trial order's kit (JOIN, giro di prova 2026-10-01): the runner's own answers, worded as JOIN asks.
const kit = {
  orderId: 'trial',
  identity: { firstName: 'Luigi', lastName: 'Prova', fullName: 'Luigi Prova', email: 'alias@example.test', phone: '+39 333 1234567', location: 'Como, Italia', address: { street: '', postalCode: '', city: 'Como', country: 'Italia' } },
  profile: { dateOfBirth: '' },
  answers: [
    { question: 'Email', answer: 'alias@example.test', source: 'identity' },
    { question: 'Carica il tuo CV · Carica file', answer: '[CV]', source: 'documents' },
    { question: 'Nome *', answer: 'Luigi', source: 'identity' },
    { question: 'Cognome *', answer: 'Prova', source: 'identity' },
    { question: 'Qual è il suo stato di autorizzazione al lavoro per Svizzera?', answer: 'Posso lavorare qui, ma solo per un periodo limitato — Il mio permesso mi consente di lavorare per qualsiasi datore di lavoro, ma solo fino alla scadenza.', source: 'profile' },
    { question: 'Quando può iniziare?', answer: 'Oltre 3 mesi', source: 'answers' },
    { question: 'Quando sei nato?', answer: '1986-09-12', source: 'answers' },
    { question: 'Che sesso sei?', answer: 'N/A', source: 'rule' },
  ],
  texts: { coverLetter: 'Gentili signori' },
  documents: {},
};
const run = (F: any, document: Document) => F.fillPage(document, kit, { getFile: async () => null, attempts: new WeakMap(), uploaded: new Set() });

// JOIN's markup, as saved from the trial posting (classes and icons left out).
const continueButtons = '<button type="button"><span>Indietro</span></button><button type="button" disabled=""><span>Continua</span></button>';
const ariaChoices = (question: string, options: string[]) => `<form><h2>${question}</h2><div>${options
  .map((option, index) => `<div><div role="radio" aria-checked="false" tabindex="0"><div><p>${String.fromCharCode(97 + index)}</p></div><p>${option}</p></div></div>`).join('')}</div>${continueButtons}</form>`;

describe('fill extension: patterns', () => {
  it('uses the runner’s own patterns', () => {
    const { F } = page('');
    for (const [name, pattern] of Object.entries({ NEXT_RE, SUBMIT_RE, CONFIRM_RE, REFUSED_RE, APPLY_RE, NOT_ADVANCE_RE, COOKIE_REJECT_RE })) {
      expect(`${name}: ${F[name].source}/${F[name].flags}`).toBe(`${name}: ${pattern.source}/${pattern.flags}`);
    }
  });

  it('declares only what it needs and opens the queue bridge on the owner page alone', () => {
    const manifest = JSON.parse(readFileSync(resolve(extension, 'manifest.json'), 'utf8'));
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions.sort()).toEqual(['scripting', 'storage', 'tabs']);
    expect(manifest.content_scripts).toEqual([{ matches: ['https://frontaliereticino.ch/*gestione-contenuti-xk9mp2q/*'], js: ['bridge.js'], run_at: 'document_start' }]);
    for (const file of ['background.js', 'bridge.js', 'content.js', 'filler.js']) {
      const source = readFileSync(resolve(extension, file), 'utf8');
      // No remote code, no eval, no stored candidate data.
      expect(source).not.toMatch(/\beval\(|new Function|importScripts|localStorage|chrome\.storage\.local/);
    }
  });
});

describe('fill extension: JOIN steps', () => {
  it('starts from the posting, never from a send button, and only before any form', () => {
    const posting = page('<main><h1>Infermiere/a</h1><a href="/apply">Candidarsi</a></main>');
    expect(posting.F.pageState(posting.document).kind).toBe('posting');
    expect(posting.F.pageState(posting.document, { sawForm: true }).kind).not.toBe('posting');
    // A review page with no field: «Invia candidatura» is the send button, not a start.
    const review = page('<form><h2>Esamina la tua candidatura</h2><button type="button">Indietro</button><button type="submit">Invia candidatura</button></form>');
    const state = review.F.pageState(review.document);
    expect(state.kind).toBe('final');
    expect(review.F.textOf(state.final)).toBe('Invia candidatura');
  });

  it('types the alias and moves on with «Continua», never «Continua con Google»', async () => {
    const { F, document } = page(`<form><div role="group"><label for="email">Email</label><input id="email" type="email" aria-label="Email" name="email" value=""></div>
      <button type="button" data-testid="ContinueButton"><span>Continua</span></button>
      <button type="button" data-testid="GoogleIdentityButton"><span>Continua con Google</span></button></form>`);
    const result = await run(F, document);
    expect((document.getElementById('email') as HTMLInputElement).value).toBe('alias@example.test');
    expect(result.missing).toEqual([]);
    const state = F.pageState(document, { sawForm: true });
    expect(state.kind).toBe('step');
    expect(F.textOf(state.next)).toBe('Continua');
  });

  it('fills the names under their required star and leaves a country already chosen', async () => {
    const { F, document } = page(`<form><h2>Informazioni personali</h2>
      <div role="group"><label for="candidate.firstName" data-required="">Nome<span aria-hidden="true">*</span></label><input id="candidate.firstName" required maxlength="30" value=""></div>
      <div role="group"><label for="candidate.lastName" data-required="">Cognome<span aria-hidden="true">*</span></label><input id="candidate.lastName" required maxlength="30" value=""></div>
      <div role="group" id="position-candidate.countryId"><label for="candidate.countryId">Paese di residenza<span aria-hidden="true">*</span></label>
        <div id="candidate.countryId"><div data-testid="SelectControlContainer"><div><p>Italia</p></div><div><input role="combobox" aria-label="Paese di residenza" aria-required="true" type="text" value=""></div></div></div></div>
      ${continueButtons}</form>`);
    const result = await run(F, document);
    expect((document.getElementById('candidate.firstName') as HTMLInputElement).value).toBe('Luigi');
    expect((document.getElementById('candidate.lastName') as HTMLInputElement).value).toBe('Prova');
    expect(result.filled).toEqual(['Nome', 'Cognome']);
    expect(result.missing).toEqual([]);
  });

  it('picks JOIN’s lettered choices by their text, the long work-permit one included', async () => {
    for (const [question, options, wanted] of [
      ['Quando può iniziare?', ['Da subito', 'Entro 2 settimane', 'Entro 1 mese', 'Entro 2 mesi', 'Entro 3 mesi', 'Oltre 3 mesi'], 5],
      ['Che sesso sei?', ['Maschio', 'Femmina', 'N/A'], 2],
      ['Qual è il suo stato di autorizzazione al lavoro per Svizzera?', [
        'Posso lavorare qui senza alcuna restrizione</p><p>Ho la cittadinanza o il diritto permanente di lavorare qui.',
        'Posso lavorare qui, ma solo per un periodo limitato</p><p>Il mio permesso mi consente di lavorare per qualsiasi datore di lavoro, ma solo fino alla scadenza.',
        'Posso lavorare qui, ma solo per il mio datore di lavoro attuale</p><p>Cambiare datore di lavoro richiederebbe il trasferimento.',
        'Non posso ancora lavorare qui',
      ], 1],
    ] as const) {
      const { F, document } = page(ariaChoices(question, [...options]));
      const radios = [...document.querySelectorAll('[role="radio"]')];
      radios.forEach((radio) => radio.addEventListener('click', () => radio.setAttribute('aria-checked', 'true')));
      const result = await run(F, document);
      expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual(radios.map((_, index) => String(index === wanted)));
      expect(result.filled).toEqual([question]);
    }
  });

  it('lists a choice the kit cannot answer instead of guessing', async () => {
    const { F, document } = page(ariaChoices('Hai la patente?', ['Sì', 'No']));
    const result = await run(F, document);
    expect(result.filled).toEqual([]);
    expect(result.missing).toEqual([{ label: 'Hai la patente?', answer: '' }]);
    expect([...document.querySelectorAll('[role="radio"]')].every((radio) => radio.getAttribute('aria-checked') === 'false')).toBe(true);
  });

  it('chooses the birth day on JOIN’s calendar', async () => {
    const { F, document } = page(`<form><h2>Quando sei nato?</h2>
      <div data-scope="date-picker" data-part="root" data-empty="" data-testid="DatePickerInput"><table data-part="table"><tbody><tr>
        <td role="gridcell"><div data-part="table-cell-trigger" role="button" data-value="1986-09-11">11</div></td>
        <td role="gridcell"><div data-part="table-cell-trigger" role="button" data-value="1986-09-12">12</div></td>
      </tr></tbody></table></div>${continueButtons}</form>`);
    const picker = document.querySelector('[data-part="root"]')!;
    const day = document.querySelector('[data-value="1986-09-12"]')!;
    day.addEventListener('click', () => { picker.removeAttribute('data-empty'); day.setAttribute('data-selected', ''); });
    const result = await run(F, document);
    expect(result.filled).toEqual(['Quando sei nato?']);
    expect(picker.hasAttribute('data-empty')).toBe(false);
  });

  it('picks a searched city among the options the portal lists', async () => {
    const { F, document } = page(`<form><div role="group"><label for="_r_h_">Città</label><div data-testid="CityName"><div><div id="react-select-1-placeholder">Selezionare la città</div>
      <div><input id="city" role="combobox" type="text" value=""></div></div></div></div><div id="menu"></div>${continueButtons}</form>`);
    const input = document.getElementById('city') as HTMLInputElement;
    const box = document.querySelector('[data-testid="CityName"] > div')!;
    input.addEventListener('input', () => {
      document.getElementById('menu')!.innerHTML = ['Comano', 'Como', 'Comologno'].map((city, index) => `<div role="option" id="react-select-1-option-${index}">${city}</div>`).join('');
      document.querySelectorAll('[role="option"]').forEach((option) => option.addEventListener('click', () => { box.innerHTML = `<div><p>${option.textContent}</p></div>`; }));
    });
    const result = await run(F, document);
    expect(result.filled).toEqual(['Città']);
    expect(box.textContent).toBe('Como');
  });

  it('stops on the review page with «Conferma e applica» and never presses it', async () => {
    const { F, document } = page(`<form><h2>Esamina la tua candidatura</h2><p>Inviando la candidatura accetto il JOIN Termini.</p>
      <button type="button"><span>Indietro</span></button><button type="submit"><span>Conferma e applica</span></button></form>`);
    let pressed = 0;
    document.querySelector('button[type="submit"]')!.addEventListener('click', () => { pressed += 1; });
    await run(F, document);
    const state = F.pageState(document, { sawForm: true });
    expect(state.kind).toBe('final');
    expect(F.textOf(state.final)).toBe('Conferma e applica');
    expect(pressed).toBe(0);
  });

  it('reads JOIN’s refusal and a confirmation', () => {
    expect(page('<div role="status">Non siamo riusciti a inviare la tua candidatura. Riprova.</div>').F.pageState(page('<div>Non siamo riusciti a inviare la tua candidatura. Riprova.</div>').document).kind).toBe('refused');
    const done = page('<h1>Grazie per la tua candidatura!</h1>');
    expect(done.F.pageState(done.document).kind).toBe('confirmed');
  });
});

describe('fill extension: other portals', () => {
  it('accepts the required terms, never a newsletter, and attaches the CV, never to an avatar', async () => {
    const { F, document } = page(`<form>
      <label><input type="checkbox" id="privacy" required> Ich akzeptiere die Datenschutzerklärung *</label>
      <label><input type="checkbox" id="news"> Newsletter abonnieren</label>
      <label for="cv">Lebenslauf *</label><input type="file" id="cv" accept=".pdf" required>
      <label for="avatar">Foto</label><input type="file" id="avatar" accept="image/png,.png,image/jpeg">
      <button type="button">Weiter</button></form>`, 'https://jobs.example.ch/apply');
    const [privacy, news, cv, avatar] = ['privacy', 'news', 'cv', 'avatar'].map((id) => F.collect(document).find((entry: any) => entry.element.id === id));
    expect(F.answerFor(privacy, kit)).toEqual({ check: true });
    expect(F.answerFor(news, kit)).toBeNull();
    expect(F.answerFor(cv, kit)).toEqual({ document: 'cv' });
    expect(F.answerFor(avatar, kit)).toBeNull();
    await F.fillEntry(privacy, { check: true }, { getFile: async () => null });
    expect((document.getElementById('privacy') as HTMLInputElement).checked).toBe(true);
    expect((document.getElementById('news') as HTMLInputElement).checked).toBe(false);
  });

  it('types identity fields by their meaning, the number without a prefix the field shows apart', async () => {
    const { F, document } = page(`<form>
      <label for="fn">Vorname</label><input id="fn" required>
      <label for="ln">Nachname</label><input id="ln" required>
      <label for="last">Last name</label><input id="last">
      <label for="company">Name des Unternehmens</label><input id="company">
      <div><div><button type="button" aria-haspopup="dialog">+39</button></div><input id="tel" type="tel" data-value="+39"></div>
      <label for="dob">Geburtsdatum</label><input id="dob" placeholder="TT.MM.JJJJ">
      <label for="plz">Postleitzahl</label><input id="plz">
      <label for="birthplace">Luogo di nascita</label><input id="birthplace">
      <button type="button">Weiter</button></form>`, 'https://jobs.example.ch/apply');
    const identity = { ...kit.identity, address: { ...kit.identity.address, postalCode: '22100' } };
    await F.fillPage(document, { ...kit, identity, answers: [], profile: { dateOfBirth: '1986-09-12' } }, { getFile: async () => null, attempts: new WeakMap() });
    const value = (id: string) => (document.getElementById(id) as HTMLInputElement).value;
    // German compounds count; a place of birth is no date.
    expect(['fn', 'ln', 'last', 'company', 'tel', 'dob', 'plz', 'birthplace'].map(value)).toEqual(['Luigi', 'Prova', 'Prova', '', '3331234567', '12.09.1986', '22100', '']);
    expect(F.parseDate('12/09/1986')).toEqual({ year: 1986, month: 9, day: 12 });
  });
});
