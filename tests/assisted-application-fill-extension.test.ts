import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { CONFIRM_RE, NEXT_RE, REFUSED_RE, SUBMIT_RE } from '../scripts/assisted-application/lib/portal/fill.mjs';
import { APPLY_LATER_RE, APPLY_RE, COOKIE_REJECT_RE } from '../scripts/assisted-application/lib/portal/portal.mjs';
import { NOT_ADVANCE_RE } from '../scripts/assisted-application/lib/portal/agent.mjs';

const extension = resolve(fileURLToPath(new URL('..', import.meta.url)), 'scripts/assisted-application/extension');
const fillerSource = readFileSync(resolve(extension, 'filler.js'), 'utf8');
const runnerFieldsSource = readFileSync(resolve(extension, 'runner-fields.js'), 'utf8');

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
    for (const [name, pattern] of Object.entries({ NEXT_RE, SUBMIT_RE, CONFIRM_RE, REFUSED_RE, APPLY_RE, APPLY_LATER_RE, NOT_ADVANCE_RE, COOKIE_REJECT_RE })) {
      expect(`${name}: ${F[name].source}/${F[name].flags}`).toBe(`${name}: ${pattern.source}/${pattern.flags}`);
    }
  });

  it('declares only what it needs and opens the queue bridge on the owner page alone', () => {
    const manifest = JSON.parse(readFileSync(resolve(extension, 'manifest.json'), 'utf8'));
    expect(manifest.manifest_version).toBe(3);
    // alarms: the once-a-minute look at its own files on disk (it reloads itself after an update).
    expect(manifest.permissions.sort()).toEqual(['alarms', 'scripting', 'storage', 'tabs']);
    expect(manifest.content_scripts).toEqual([{ matches: ['https://frontaliereticino.ch/*gestione-contenuti-xk9mp2q/*'], js: ['bridge.js'], run_at: 'document_start' }]);
    for (const file of ['background.js', 'bridge.js', 'content.js', 'filler.js']) {
      // The one thing kept across a reload is when the last reload happened (no candidate data).
      const source = readFileSync(resolve(extension, file), 'utf8')
        .replace(/chrome\.storage\.local\.(?:get\('lastReloadAt'\)|set\(\{ lastReloadAt: nowMs \}\))/g, '');
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

  it('starts Coop’s application with «Jetzt bewerben», never «Später bewerben»', () => {
    // jobs.coopjobs.ch (Prospective.ch), 2026-10-02: the bookmark comes first in the page.
    const coop = page('<header><a role="button" aria-label="Später bewerben">Später bewerben</a></header><main><h1>Bäcker:in</h1><a class="main-btn apply" target="_blank" href="https://ohws.prospective.ch/public/v1/redirect/20d53107-db26-4a35-8f4c-b4d15bb4bb31/ats/">Jetzt bewerben</a></main>', 'https://jobs.coopjobs.ch/offene-stellen/baecker/20d53107-db26-4a35-8f4c-b4d15bb4bb31');
    const state = coop.F.pageState(coop.document);
    expect(state.kind).toBe('posting');
    expect(coop.F.textOf(state.start)).toBe('Jetzt bewerben');
  });

  it('highlights SuccessFactors’ bare «Bewerben» as the send button', () => {
    const form = page('<form><label for="v">Vorname *</label><input id="v" required value="Luigi"><button type="button">Entwurf speichern</button><button type="submit">Bewerben</button></form>', 'https://career2.successfactors.eu/career?company=Coop');
    const state = form.F.pageState(form.document, { sawForm: true });
    expect(state.kind).toBe('final');
    expect(form.F.textOf(state.final)).toBe('Bewerben');
  });

  // Coop's SuccessFactors form, mapped on 2026-10-03.
  it('chooses in SuccessFactors’ picklists once their options load, and types its UI5 birth date', async () => {
    const sf = page(`<label for="a">* Anrede</label><input id="a" aria-label="Anrede" type="text" role="combobox" placeholder="Bitte auswählen" aria-owns="an:_listSelect" aria-required="true" class="rcmpaginatedselectinput"><ul id="an:_listSelect" role="listbox"></ul>
      <div class="datePicker"><ui5-date-picker-xweb-calendar-widget ui5-date-picker="" accessible-name="Geburtsdatum" format-pattern="dd.MM.yyyy" required=""></ui5-date-picker-xweb-calendar-widget></div>`, 'https://career2.successfactors.eu/portalcareer');
    sf.window.eval(`
      const input = document.getElementById('a');
      const list = document.getElementById('an:_listSelect');
      input.addEventListener('click', () => setTimeout(() => {
        list.innerHTML = '<li role="option">Bitte auswählen</li><li role="option">Frau</li><li role="option">Herr</li>';
        for (const item of list.querySelectorAll('li')) item.addEventListener('click', () => { input.value = item.textContent; list.innerHTML = ''; });
      }, 30));
      customElements.define('ui5-date-picker-xweb-calendar-widget', class extends HTMLElement {
        constructor() {
          super();
          this._value = '';
          const root = this.attachShadow({ mode: 'open' });
          root.innerHTML = '<input type="text">';
          const inner = root.querySelector('input');
          inner.addEventListener('keydown', (event) => { if (event.key === 'Enter') this._value = inner.value; });
        }
        get value() { return this._value; }
      });`);
    const sfKit = { ...kit, profile: { dateOfBirth: '1990-05-12' }, answers: [{ question: '* Anrede', answer: 'Herr', source: 'answers' }] };
    const result = await sf.F.fillPage(sf.document, sfKit, { getFile: async () => null, attempts: new WeakMap(), uploaded: new Set() });
    expect(result.missing).toEqual([]);
    expect((sf.document.getElementById('a') as HTMLInputElement).value).toBe('Herr');
    expect((sf.document.querySelector('[ui5-date-picker]') as any).value).toBe('12.05.1990');
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

  it('knows JOIN’s «verify your e-mail» page after the send, never the e-mail step of the form', () => {
    const waiting = page('<main><p>Completare la domanda</p><h1>Verificare l\'indirizzo e-mail</h1><button type="button">Reinvio della mail di verifica</button></main>');
    expect(waiting.F.pageState(waiting.document, { sawForm: true }).kind).toBe('verify');
    // German puts the verb first (review of #10771).
    const german = page('<main><h1>Fast geschafft</h1><p>Bitte verifizieren Sie Ihre E-Mail-Adresse.</p></main>');
    expect(german.F.pageState(german.document, { sawForm: true }).kind).toBe('verify');
    const form = page(`<form><h2>Verificare l'indirizzo e-mail</h2><div role="group"><label for="email">Email</label><input id="email" type="email" required></div>${continueButtons}</form>`);
    expect(form.F.pageState(form.document, { sawForm: true }).kind).toBe('step');
  });

  it('reads JOIN’s refusal and a confirmation', () => {
    expect(page('<div role="status">Non siamo riusciti a inviare la tua candidatura. Riprova.</div>').F.pageState(page('<div>Non siamo riusciti a inviare la tua candidatura. Riprova.</div>').document).kind).toBe('refused');
    const done = page('<h1>Grazie per la tua candidatura!</h1>');
    expect(done.F.pageState(done.document).kind).toBe('confirmed');
    for (const text of ['Du hast dich erfolgreich auf diese Stelle beworben.', 'Sie haben sich erfolgreich beworben.', 'Deine Bewerbung wurde erfolgreich übermittelt.', 'You have successfully applied for this job.', 'Vous avez postulé avec succès.', 'Ti sei candidato con successo.']) {
      const shown = page(`<p>${text}</p>`);
      expect(shown.F.pageState(shown.document).kind, text).toBe('confirmed');
    }
    // Review of #10980: a page's prose about other applicants is no confirmation.
    const prose = 'Es haben sich erfolgreich auf diese Stelle beworben: 12 Personen.';
    expect(CONFIRM_RE.test(prose)).toBe(false);
    const posting = page(`<main><h1>Bäcker:in</h1><p>${prose}</p><a href="https://ohws.prospective.ch/public/v1/redirect/x/ats/">Jetzt bewerben</a></main>`);
    expect(posting.F.pageState(posting.document).kind).toBe('posting');
  });
});

// Coop, 2026-10-02: «Jetzt bewerben» opens SuccessFactors in a new tab (target=_blank).
describe('fill extension: the tab the start link opens', () => {
  const backgroundSource = readFileSync(resolve(extension, 'background.js'), 'utf8');
  const START = 'https://ohws.prospective.ch/public/v1/redirect/20d53107-db26-4a35-8f4c-b4d15bb4bb31/ats/';

  /** background.js on a fake `chrome`: session storage and the listeners it registers. */
  function worker(store = new Map<string, any>([['loadedFingerprint', 'loaded']])) {
    const listeners: Record<string, Array<(...args: any[]) => any>> = { created: [], message: [] };
    const on = (name: string) => ({ addListener: (listener: any) => (listeners[name] ||= []).push(listener) });
    const chrome = {
      storage: {
        session: {
          async get(key: string | null) {
            if (key === null) return Object.fromEntries(store);
            return store.has(key) ? { [key]: store.get(key) } : {};
          },
          async set(values: Record<string, any>) { for (const [key, value] of Object.entries(values)) store.set(key, value); },
          async remove(keys: string | string[]) { for (const key of [keys].flat()) store.delete(key); },
        },
        local: { async get() { return {}; }, async set() {} },
      },
      tabs: { onCreated: on('created'), onUpdated: on('updated'), onRemoved: on('removed'), async query() { return []; }, async get() { return null; }, async create() { return { id: 99 }; }, async update() {}, async sendMessage() {} },
      runtime: { onMessage: on('message'), onStartup: on('startup'), onInstalled: on('installed'), getURL: (file: string) => file, getManifest: () => ({ content_scripts: [{ matches: [], js: [] }] }), reload() {} },
      alarms: { async get() { return {}; }, create() {}, onAlarm: on('alarm') },
      scripting: { async executeScript() { return []; } },
    };
    vm.runInNewContext(backgroundSource, { chrome, URL, Date, Number, String, Promise, setTimeout, console, crypto, TextEncoder, btoa, fetch: async () => ({ ok: false }) });
    const message = (msg: any, tabId: number) => new Promise((done) => listeners.message[0](msg, { tab: { id: tabId } }, done));
    const created = (tab: any) => listeners.created[0](tab);
    const updated = (tabId: number, info: any) => listeners.updated[0](tabId, info, { id: tabId, url: info.url || '' });
    return { store, message, created, updated };
  }

  it('gives the order’s kit to the apply tab only, once per start click', async () => {
    const { store, message, created } = worker();
    store.set('tab:1', { kit: { orderId: 'o', applyUrl: 'https://jobs.coopjobs.ch/offene-stellen/x/20d53107-db26-4a35-8f4c-b4d15bb4bb31' }, state: 'filling', openedAt: Date.now() });
    // A popup before any start click: nothing.
    await created({ id: 2, openerTabId: 1, pendingUrl: START });
    expect(store.has('tab:2')).toBe(false);
    await message({ type: 'mark', startedAt: Date.now(), startUrl: START }, 1);
    // Another link of the posting first (a social page), then the apply tab, then a second popup.
    await created({ id: 3, openerTabId: 1, pendingUrl: 'https://www.instagram.com/coop.jobs/' });
    await created({ id: 4, openerTabId: 1, pendingUrl: START });
    await created({ id: 5, openerTabId: 1, pendingUrl: START });
    expect(store.has('tab:3')).toBe(false);
    expect(store.get('tab:4')).toMatchObject({ kit: { orderId: 'o' }, openedFrom: 1 });
    expect(store.has('tab:5')).toBe(false);
    // Not even a popup whose address Chrome does not know yet, once the start is used up.
    await created({ id: 6, openerTabId: 1, pendingUrl: '' });
    expect(store.has('tab:6')).toBe(false);
  });

  it('waits for the address of a tab Chrome does not know yet, and adopts only the one that is the link', async () => {
    // Review of #10980: an apply tab created with no address, then an unrelated popup.
    const { store, message, created, updated } = worker();
    store.set('tab:1', { kit: { orderId: 'o', applyUrl: 'https://jobs.coopjobs.ch/x' }, state: 'filling' });
    await message({ type: 'mark', startedAt: Date.now(), startUrl: START }, 1);
    await created({ id: 4, openerTabId: 1, pendingUrl: '' });
    await created({ id: 5, openerTabId: 1, pendingUrl: '' });
    expect(store.has('tab:4') || store.has('tab:5')).toBe(false);
    await updated(5, { url: 'https://www.pastahr.com/privacy', status: 'loading' });
    expect(store.has('tab:5')).toBe(false);
    expect(store.get('tab:1').startUrl).toBe(START);
    await updated(4, { url: START, status: 'loading' });
    expect(store.get('tab:4')).toMatchObject({ kit: { orderId: 'o' }, openedFrom: 1 });
    expect(store.has('tab:5')).toBe(false);
    // A start control with no link: no tab is ever adopted.
    const button = worker();
    button.store.set('tab:1', { kit: { orderId: 'o', applyUrl: 'https://jobs.coopjobs.ch/x' }, state: 'filling' });
    await button.message({ type: 'mark', startedAt: Date.now(), startUrl: '' }, 1);
    await button.created({ id: 2, openerTabId: 1, pendingUrl: START });
    expect(button.store.has('tab:2')).toBe(false);
  });

  it('remembers a waiting tab across a service worker restart', async () => {
    // Review of #10980: the opener of a tab with no address yet is not only in memory.
    const first = worker();
    first.store.set('tab:1', { kit: { orderId: 'o', applyUrl: 'https://jobs.coopjobs.ch/x' }, state: 'filling' });
    await first.message({ type: 'mark', startedAt: Date.now(), startUrl: START }, 1);
    await first.created({ id: 4, openerTabId: 1, pendingUrl: '' });
    expect(first.store.has('tab:4')).toBe(false);
    // The worker restarts: a new background.js on the same session storage.
    const restarted = worker(first.store);
    await restarted.updated(4, { url: START, status: 'loading' });
    expect(restarted.store.get('tab:4')).toMatchObject({ kit: { orderId: 'o' }, openedFrom: 1 });
    expect(restarted.store.get('tab:1')).toMatchObject({ kit: { orderId: 'o' }, state: 'filling' });
    expect(restarted.store.has('awaiting:4')).toBe(false);
  });

  it('never takes a start that is not a time', async () => {
    const { store, message, created } = worker();
    store.set('tab:1', { kit: { orderId: 'o', applyUrl: 'https://jobs.coopjobs.ch/x' }, state: 'filling' });
    await message({ type: 'mark', startedAt: 'soon', startUrl: START }, 1);
    await created({ id: 2, openerTabId: 1, pendingUrl: START });
    expect(store.has('tab:2')).toBe(false);
  });
});

// Owner request 2026-10-01: generic, not per site. The extension reads the
// fields with the runner's own reading (runner-fields.js, generated from
// lib/portal/fields.mjs), so the questions the runner recorded match on any portal.
describe('fill extension: the runner’s reading on any portal', () => {
  it('ships the runner’s field reading as generated from fields.mjs', () => {
    // Plain Node renders it: a test bundler may print the function differently.
    const check = spawnSync(process.execPath, [resolve(extension, 'build-runner-fields.mjs'), '--check'], { encoding: 'utf8' });
    expect(`${check.status} ${check.stdout}${check.stderr}`.trim()).toBe('0 runner-fields.js up to date');
  });

  /** A page with the runner's reading and the engine, every element laid out as in a browser. */
  function runnerPage(html: string, url: string) {
    const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url, runScripts: 'outside-only' });
    dom.window.Element.prototype.getBoundingClientRect = function rect() {
      return { width: 20, height: 20, top: 0, left: 0, right: 20, bottom: 20, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    };
    (dom.window as any).CSS = { escape: (value: string) => String(value).replace(/["\\\]]/g, (match) => `\\${match}`) };
    dom.window.eval(runnerFieldsSource);
    dom.window.eval(fillerSource);
    return { window: dom.window, document: dom.window.document, F: (dom.window as any).CompilaCandidatura, read: (dom.window as any).CompilaRunnerFields };
  }

  const portals: Array<[string, string, string]> = [
    ['Greenhouse', 'https://boards.greenhouse.io/acme/jobs/1', `<form>
      <div class="field"><label for="first_name">First Name <span class="asterisk">*</span></label><input id="first_name" name="job_application[first_name]" type="text" aria-required="true"></div>
      <div class="field"><label for="last_name">Last Name <span class="asterisk">*</span></label><input id="last_name" name="job_application[last_name]" type="text" aria-required="true"></div>
      <div class="field"><label>Are you legally authorized to work in Switzerland? *
        <select id="q_permit" name="job_application[answers_attributes][0][boolean_value]"><option value="">--</option><option value="1">Yes</option><option value="0">No</option></select></label></div>
      <div class="field"><label for="q_notice">What is your notice period? *</label><textarea id="q_notice" name="job_application[answers_attributes][1][text_value]"></textarea></div>
      <input type="submit" value="Submit Application"></form>`],
    ['Workday', 'https://acme.wd3.myworkdayjobs.com/en-US/careers/job/1/apply', `<div data-automation-id="applyFlowPage">
      <div data-automation-id="formField-legalNameSection_firstName"><label id="lbl-fn" for="input-fn">Given Name(s)<abbr title="required">*</abbr></label><input id="input-fn" data-automation-id="legalNameSection_firstName" aria-required="true"></div>
      <div data-automation-id="formField-legalNameSection_lastName"><label id="lbl-ln" for="input-ln">Family Name<abbr title="required">*</abbr></label><input id="input-ln" data-automation-id="legalNameSection_lastName" aria-required="true"></div>
      <div><span id="q-salary">Desired salary (CHF per year)</span><input id="input-salary" aria-labelledby="q-salary"></div>
      <button data-automation-id="bottom-navigation-next-button">Save and Continue</button></div>`],
    ['Personio', 'https://acme.jobs.personio.de/job/1', `<form>
      <div><span>Gehaltsvorstellung*</span><div><input name="salary_expectations" type="text"></div></div>
      <fieldset><legend>Haben Sie einen Führerschein?*</legend>
        <label><input type="radio" name="driving" value="ja"> Ja</label><label><input type="radio" name="driving" value="nein"> Nein</label></fieldset>
      <button type="submit">Bewerbung absenden</button></form>`],
    ['Lever', 'https://jobs.lever.co/acme/1/apply', `<form><ul>
      <li class="application-question custom-question"><div class="application-label full-width text">Please, add a brief comment on your experience and qualifications<span class="required">✱</span></div>
        <div class="application-field full-width"><textarea name="cards[a][field0]" aria-label="[Default] Comment" required></textarea></div></li>
      <li class="application-question custom-question"><label><div class="application-label full-width">Expected pay rate per session<span class="required">✱</span></div>
        <div class="application-field full-width"><select name="cards[b][field0]" aria-label="[General] Salary" required><option value="">Select...</option><option value="CHF 50">CHF 50</option><option value="CHF 80">CHF 80</option></select></div></label></li>
      </ul><button type="button">Submit application</button></form>`],
  ];

  // Review of #10785: the runner also reads Workday's listbox buttons and «selectinput» search boxes.
  it('fills Workday’s listbox buttons and search-select boxes as the runner reads them', async () => {
    const { F, document, read } = runnerPage(`<div data-automation-id="applyFlowPage">
      <div data-automation-id="formField-source"><label id="lbl-src" for="src">How did you hear about us?<abbr title="required">*</abbr></label>
        <button id="src" type="button" aria-haspopup="listbox" aria-required="true" aria-labelledby="lbl-src">Select One</button></div>
      <div data-automation-id="formField-country"><label for="country">Country of residence<abbr title="required">*</abbr></label>
        <input id="country" type="search" data-uxi-widget-type="selectinput" data-uxi-multiselect-id="ms1" aria-required="true"></div>
      <div id="pills"></div><div id="popup"></div>
      <input type="search" id="site-search" placeholder="Search jobs">
      <button type="button" data-automation-id="bottom-navigation-next-button">Save and Continue</button></div>`, 'https://acme.wd3.myworkdayjobs.com/en-US/careers/job/1/apply');
    const popup = document.getElementById('popup')!;
    const button = document.getElementById('src')!;
    const country = document.getElementById('country') as HTMLInputElement;
    const open = (labels: string[], choose: (label: string) => void) => {
      popup.innerHTML = '<div role="listbox">' + labels.map((label) => '<div role="option">' + label + '</div>').join('') + '</div>';
      popup.querySelectorAll('[role="option"]').forEach((option) => option.addEventListener('click', () => { choose(option.textContent || ''); popup.innerHTML = ''; }));
    };
    button.addEventListener('click', () => open(['Job board', 'LinkedIn', 'Referral'], (label) => { button.textContent = label; }));
    country.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key !== 'Enter') return;
      open(['Switzerland', 'Swaziland'].filter((name) => name.toLowerCase().startsWith(country.value.toLowerCase().slice(0, 3))), (label) => {
        document.getElementById('pills')!.innerHTML = '<div data-uxi-widget-type="selectinputlistitem" data-uxi-multiselect-id="ms1">' + label + '</div>';
        country.value = '';
      });
    });
    // The runner's pass: its labels for the two required fields.
    const fields = read().fields.filter((field: any) => field.required);
    expect(fields.map((field: any) => field.kind).sort()).toEqual(['listbox', 'text']);
    const answers = fields.map((field: any) => ({ question: field.label, answer: field.kind === 'listbox' ? 'LinkedIn' : 'Switzerland', source: 'answers' }));
    const entries = F.collect(document);
    // The site's own job search is no question.
    expect(entries.some((entry: any) => entry.element.id === 'site-search')).toBe(false);
    const result = await F.fillPage(document, { ...kit, answers }, { getFile: async () => null, attempts: new WeakMap() });
    expect(button.textContent).toBe('LinkedIn');
    expect(document.getElementById('pills')!.textContent).toBe('Switzerland');
    expect(result.missing).toEqual([]);
  });

  for (const [portal, url, html] of portals) {
    it(`answers every field the runner answered, on a ${portal}-style form`, async () => {
      const { F, document, read } = runnerPage(html, url);
      const runnerFields = read().fields.filter((field: any) => field.kind !== 'file');
      expect(runnerFields.length).toBeGreaterThan(1);
      // The runner's pass: an answer per field, recorded under the runner's label.
      const sample = (field: any) => {
        const options = (field.options || []).map((option: any) => option.label).filter((label: string) => label && !/^(--|select)/i.test(label));
        return options.length ? options[options.length - 1] : `Antwort ${field.id}`;
      };
      const answers = runnerFields.map((field: any) => ({ question: field.label, answer: sample(field), source: 'answers' }));
      const portalKit = { ...kit, identity: { ...kit.identity, firstName: '', lastName: '', fullName: '' }, answers };
      await F.fillPage(document, portalKit, { getFile: async () => null, attempts: new WeakMap() });
      for (const field of runnerFields) {
        const wanted = sample(field);
        const element = document.querySelector(`[data-aa-id="${field.id}"]`) as HTMLInputElement;
        const value = field.kind === 'radio'
          ? (document.querySelector(`input[name="${element.name}"]:checked`) as HTMLInputElement | null)?.value
          : element.tagName === 'SELECT' ? (element as unknown as HTMLSelectElement).selectedOptions[0]?.text : element.value;
        expect({ field: field.label, value }).toEqual({ field: field.label, value: field.kind === 'radio' ? wanted.toLowerCase() : wanted });
      }
    });
  }
});

describe('fill extension: other portals', () => {
  // TSMG on Lever (ordine reale 2026-10-01): custom questions carry Lever's own names
  // («[Default] Comment»), the runner records the question the candidate reads.
  it('answers Lever’s custom questions by the visible question, not Lever’s internal names', async () => {
    const { F, document } = page(`<form><ul>
      <li class="application-question"><label><div class="application-label">Full name<span class="required">✱</span></div>
        <div class="application-field"><input type="text" name="name" id="name" required></div></label></li>
      <li class="application-question custom-question"><div class="application-label full-width text">Please, add a brief comment on your experience and qualifications<span class="required">✱</span></div>
        <div class="application-field full-width"><textarea id="comment" name="cards[a][field0]" aria-label="[Default] Comment" required></textarea></div></li>
      <li class="application-question custom-question"><label><div class="application-label full-width">By clicking 'I agree,' you are confirming that you have read the Privacy Policy<span class="required">✱</span></div>
        <div class="application-field full-width"><select id="consent" name="cards[b][field0]" aria-label="[Default] Data Processing Consent" required><option value="">Select...</option><option value="I agree">I agree</option></select></div></label></li>
      <li class="application-question custom-question"><label><div class="application-label full-width">I would like to receive information about TSMG Academy<span class="required">✱</span></div>
        <div class="application-field full-width"><select id="academy" name="cards[c][field0]" aria-label="[Default] TSMG Academy" required><option value="">Select...</option><option value="Yes">Yes</option><option value="No">No</option></select></div></label></li>
      </ul><button type="button" id="btn-submit">Submit application</button></form>`, 'https://jobs.lever.co/tsmg/1/apply');
    const leverKit = { ...kit, answers: [
      { question: 'Full name✱', answer: 'Luigi Prova', source: 'identity' },
      { question: 'Please, add a brief comment on your experience and qualifications✱', answer: 'Madrelingua italiana, disponibile per la sessione.', source: 'answers' },
      { question: "By clicking 'I agree,' you are confirming that you have read the Privacy Policy", answer: 'I agree', source: 'consent' },
      { question: 'I would like to receive information about TSMG Academy', answer: 'No', source: 'rule' },
    ] };
    const comment = F.collect(document).find((entry: any) => entry.element.id === 'comment');
    expect(comment.label).toMatch(/^Please, add a brief comment on your experience and qualifications/);
    // A label wrapped around a select is its question, never its options.
    expect(F.collect(document).find((entry: any) => entry.element.id === 'academy').label).toMatch(/^I would like to receive information about TSMG Academy ?✱?$/);
    const result = await F.fillPage(document, leverKit, { getFile: async () => null, attempts: new WeakMap() });
    const value = (id: string) => (document.getElementById(id) as HTMLInputElement).value;
    expect(['name', 'comment', 'consent', 'academy'].map(value)).toEqual(['Luigi Prova', 'Madrelingua italiana, disponibile per la sessione.', 'I agree', 'No']);
    expect(result.missing).toEqual([]);
    expect(F.textOf(F.pageState(document, { sawForm: true }).final)).toBe('Submit application');
  });


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

  // Rolex 2026-10-02: the posting asks for school reports and aptitude test results besides the CV.
  it('attaches the requested documents to their own fields, and all of them to a generic attachments field', async () => {
    const { F, document, window } = page(`<form>
      <label for="cv">Curriculum vitae *</label><input type="file" id="cv" required>
      <label for="reports">Bulletins scolaires des 3 dernières années *</label><input type="file" id="reports" multiple required>
      <label for="eva">Résultats du test EVA</label><input type="file" id="eva">
      <label for="other">Autres documents</label><input type="file" id="other" multiple>
      <label for="photo">Photo</label><input type="file" id="photo">
      <button type="button">Suivant</button></form>`, 'https://jobs.example.ch/apply');
    const docsKit = {
      ...kit,
      documents: {
        cv: { url: 'https://signed/cv', fileName: 'CV.pdf' },
        extra: [
          { slot: 'extra_1', label: 'Bulletins des trois dernières années scolaires', kind: 'school_report', keywords: ['bulletin', 'bulletins'], files: [{ url: 'u1', fileName: 'B1.pdf' }, { url: 'u2', fileName: 'B2.pdf' }] },
          { slot: 'extra_2', label: 'Résultats du test EVA', kind: 'aptitude_test', keywords: ['EVA', 'evatech'], files: [{ url: 'u3', fileName: 'EVA.pdf' }] },
        ],
      },
    };
    const [cv, reports, eva, other, photo] = ['cv', 'reports', 'eva', 'other', 'photo'].map((id) => F.collect(document).find((entry: any) => entry.element.id === id));
    expect(F.answerFor(cv, docsKit)).toEqual({ document: 'cv' });
    expect(F.answerFor(reports, docsKit)).toEqual({ document: 'extra_1' });
    expect(F.answerFor(eva, docsKit)).toEqual({ document: 'extra_2' });
    expect(F.answerFor(other, docsKit)).toEqual({ document: 'extra_all' });
    expect(F.answerFor(photo, docsKit)).toBeNull();
    // Without requested documents nothing changes.
    expect(F.answerFor(reports, kit)).toBeNull();
    // Every file of the document in an input that takes several; the first one otherwise.
    // jsdom has no DataTransfer, and its inputs take only a real FileList: a minimal stand-in for Chrome's.
    (window as any).DataTransfer = class { files: File[] = []; items = { add: (file: File) => { this.files.push(file); } }; };
    for (const id of ['reports', 'eva']) Object.defineProperty(document.getElementById(id), 'files', { value: null, writable: true });
    const files = (names: string[]) => names.map((name) => new window.File(['%PDF-1.4'], name, { type: 'application/pdf' }));
    const getFiles = async (which: string) => (which === 'extra_1' ? files(['B1.pdf', 'B2.pdf']) : which === 'extra_2' ? files(['EVA.pdf']) : []);
    expect(await F.fillEntry(reports, { document: 'extra_1' }, { getFiles })).toBe(true);
    expect([...(document.getElementById('reports') as HTMLInputElement).files!].map((file) => file.name)).toEqual(['B1.pdf', 'B2.pdf']);
    expect(await F.fillEntry(eva, { document: 'extra_1' }, { getFiles })).toBe(true);
    expect([...(document.getElementById('eva') as HTMLInputElement).files!].map((file) => file.name)).toEqual(['B1.pdf']);
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
