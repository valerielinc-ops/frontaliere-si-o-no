import { JSDOM } from 'jsdom';
import { extractFieldsInPage } from '../../scripts/assisted-application/lib/portal/fields.mjs';

/** Real native producer metadata for planner-only tests; no fabricated authority. */
export function nativeConsentField(label: string, overrides: Record<string, unknown> = {}) {
  const dom = new JSDOM('<form><label for="consent"></label><input id="consent" type="checkbox"></form>', { url: 'https://jobs.example/apply', runScripts: 'outside-only' });
  const win = dom.window;
  win.document.querySelector('label')!.textContent = label;
  (win.document.querySelector('input') as HTMLInputElement).required = overrides.required !== false;
  if (overrides.name) win.document.querySelector('input')!.setAttribute('name', String(overrides.name));
  Object.defineProperty(win.HTMLElement.prototype, 'innerText', { get() { return this.textContent || ''; } });
  win.Element.prototype.getBoundingClientRect = () => ({ width: 20, height: 20, top: 0, left: 0, right: 20, bottom: 20, x: 0, y: 0, toJSON() {} });
  (win as any).CSS = { escape: (value: string) => value };
  const field = win.eval(`(${extractFieldsInPage.toString()})()`).fields[0];
  win.close();
  return { ...field, ...overrides, label };
}
