import { afterEach, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { markOptionalAutofillDeclineInPage } from '../scripts/assisted-application/lib/portal/optional-autofill.mjs';
import { chooseFiles } from '../scripts/assisted-application/lib/portal/fill.mjs';

function documentWithDialog(text: string, buttons = '<button type="button">Rifiutare</button>') {
  const dom = new JSDOM(`<div role="dialog">${text}${buttons}</div><button type="submit">Rifiutare</button>`, { runScripts: 'outside-only' });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', { get() { return this.textContent || ''; } });
  dom.window.Element.prototype.getBoundingClientRect = function () {
    for (let node: Element | null = this; node; node = node.parentElement) {
      if (dom.window.getComputedStyle(node).display === 'none') return { width: 0, height: 0 } as DOMRect;
    }
    return { width: 20, height: 20 } as DOMRect;
  };
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('getComputedStyle', dom.window.getComputedStyle);
  return dom;
}
afterEach(() => vi.unstubAllGlobals());
const notice = "Per un riempimento automatico più preciso dei campi del modulo, i contenuti possono essere valutati da un'intelligenza artificiale (IA). La decisione di procedere senza IA non ha alcun effetto sul prosieguo del processo di candidatura.";

it.each([
  [notice, 'Rifiutare'],
  ['Artificial intelligence may analyse this document for automatic form filling. Proceeding without AI has no effect on this application.', 'Decline'],
  ['Künstliche Intelligenz kann die Daten auswerten. Die Ablehnung hat keinen Einfluss auf die Bewerbung.', 'Ablehnen'],
  ["L’intelligence artificielle peut analyser le document pour le remplissage. Le refus n’a aucune incidence sur la candidature.", 'Refuser'],
])('finds only the decline control of an explicitly optional parser disclosure', (text, label) => {
  const dom = documentWithDialog(text, `<button type="button">${label}</button>`);
  expect(markOptionalAutofillDeclineInPage()).toBe(true);
  expect(dom.window.document.querySelector('[data-aa-autofill-decline]')?.textContent).toBe(label);
  expect(dom.window.document.querySelector('button[type="submit"]')?.hasAttribute('data-aa-autofill-decline')).toBe(false);
  dom.window.close();
});

it.each([
  'Rifiutare questa candidatura non ha alcun effetto sulle altre candidature.',
  'Intelligenza artificiale per valutare il documento necessario alla candidatura.',
  'Artificial intelligence may analyse your application. Acceptance is mandatory.',
])('does not invent permission to dismiss a different or mandatory dialog: %s', text => {
  const dom = documentWithDialog(text);
  expect(markOptionalAutofillDeclineInPage()).toBe(false);
  dom.window.close();
});

it('does not choose between duplicate decline controls', () => {
  const dom = documentWithDialog(notice, '<button type="button">Rifiutare</button><button type="button">Rifiutare</button>');
  expect(markOptionalAutofillDeclineInPage()).toBe(false);
  dom.window.close();
});

it.each(['No, grazie', 'Nein, danke', 'Non, merci'])('the extension waits for an asynchronous dialog and declines %s once', async label => {
  const dom = documentWithDialog(notice, `<button type="button">${label}</button><button type="button">Accettare</button>`);
  const { document } = dom.window;
  const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
  dialog.style.display = 'none';
  document.body.insertAdjacentHTML('afterbegin', '<form><label for="cv">Curriculum vitae *</label><input id="cv" type="file" required></form>');
  (dom.window as any).CSS = { escape: (value: string) => value };
  for (const file of ['runner-fields.js', 'apply-control.js', 'filler.js']) dom.window.eval(readFileSync(new URL(`../scripts/assisted-application/extension/${file}`, import.meta.url), 'utf8'));
  const extension = (dom.window as any).CompilaCandidatura;
  extension.config.waitMs = 250; extension.config.stepMs = 5;
  const input = document.getElementById('cv') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: null, writable: true });
  (dom.window as any).DataTransfer = class { files: File[] = []; items = { add: (file: File) => { this.files.push(file); } }; };
  input.addEventListener('change', () => dom.window.setTimeout(() => { dialog.style.display = 'block'; }, 30));
  const upload = vi.fn(() => dialog.remove());
  const accept = vi.fn(); const submit = vi.fn();
  dialog.querySelectorAll('button')[0].addEventListener('click', upload);
  dialog.querySelectorAll('button')[1].addEventListener('click', accept);
  document.querySelector('button[type="submit"]')!.addEventListener('click', submit);
  const cv = new dom.window.File(['%PDF-1.4'], 'CV.pdf', { type: 'application/pdf' });
  const entry = extension.collect(document).find((item: any) => item.element === input);
  expect(await extension.fillEntry(entry, { document: 'cv' }, { getFile: async () => cv })).toBe(true);
  expect(upload).toHaveBeenCalledTimes(1);
  expect(accept).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled();
  expect(document.querySelector('[data-aa-autofill-decline]')).toBeNull();
  dom.window.close();
});

it('keeps observing the actual upload that starts only after declining the optional parser', async () => {
  const dom = documentWithDialog(notice);
  const page: any = new EventEmitter();
  let now = 0;
  const request = { method: () => 'POST', headers: () => ({ 'content-type': 'multipart/form-data; boundary=test' }) };
  const decline = dom.window.document.querySelector('button[type="button"]')!;
  const click = vi.fn(() => {
    page.emit('request', request);
    page.emit('response', { request: () => request, status: () => 200 });
    page.emit('requestfinished', request);
    decline.closest('[role="dialog"]')!.remove();
  });
  const frame = {
    evaluate: async (fn: () => unknown) => fn(),
    locator: () => ({ count: async () => dom.window.document.querySelectorAll('[data-aa-autofill-decline="1"]').length, click }),
  };
  page.frames = () => [frame];
  page.waitForTimeout = async (ms: number) => { now += ms; };
  const input = { setInputFiles: vi.fn(async () => {}) };
  const receipt = await chooseFiles(page, input, 'synthetic-cv.pdf', { now: () => now, settleMs: 1000, quietMs: 200 });
  expect(receipt.accepted).toBe(true);
  expect(click).toHaveBeenCalledTimes(1);
  expect(input.setInputFiles).toHaveBeenCalledTimes(1);
  expect(page.listenerCount('request')).toBe(0);
  dom.window.close();
});
