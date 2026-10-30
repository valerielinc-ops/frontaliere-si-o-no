import { afterEach, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { EventEmitter } from 'node:events';
import { markOptionalAutofillDeclineInPage } from '../scripts/assisted-application/lib/portal/optional-autofill.mjs';
import { chooseFiles } from '../scripts/assisted-application/lib/portal/fill.mjs';

function documentWithDialog(text: string, buttons = '<button type="button">Rifiutare</button>') {
  const dom = new JSDOM(`<div role="dialog">${text}${buttons}</div><button type="submit">Rifiutare</button>`);
  Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', { get() { return this.textContent || ''; } });
  dom.window.Element.prototype.getBoundingClientRect = () => ({ width: 20, height: 20 } as DOMRect);
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
