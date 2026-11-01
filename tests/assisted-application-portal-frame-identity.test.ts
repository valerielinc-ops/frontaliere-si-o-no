import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { extractFields, extractFieldsInPage } from '../scripts/assisted-application/lib/portal/fields.mjs';

function extract(html: string, url: string) {
  const { window } = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url });
  Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
    configurable: true,
    get() { return this.textContent || ''; },
  });
  window.Element.prototype.getBoundingClientRect = function rect(this: Element) {
    return { width: 20, height: 20, top: 0, left: 0, right: 20, bottom: 20, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('location', window.location);
  vi.stubGlobal('CSS', { escape: (value: string) => String(value).replace(/["\\\]]/g, '\\$&') });
  return extractFieldsInPage();
}

afterEach(() => vi.unstubAllGlobals());

describe('assisted portal iframe identity', () => {
  it('includes embedded step markers when parent URL and field labels and ids repeat', async () => {
    const mainUrl = 'https://careers.example.test/apply';
    const formUrl = 'https://forms.example.test/application';
    let step = 1;
    const main = {
      url: () => mainUrl,
      evaluate: vi.fn(async () => extract('<main id="career-shell"></main>', mainUrl)),
    };
    const form = {
      url: () => formUrl,
      evaluate: vi.fn(async () => extract(`<form id="application" data-step="${step}">
        <label for="name">Name *</label><input id="name" name="name" required>
      </form>`, formUrl)),
    };
    const page = { url: () => mainUrl, frames: () => [main, form] };

    const first = await extractFields(page as any);
    step = 2;
    const second = await extractFields(page as any);

    expect(first.fields.map((field: any) => ({ frame: field.frame, id: field.id, label: field.label })))
      .toEqual(second.fields.map((field: any) => ({ frame: field.frame, id: field.id, label: field.label })));
    expect(JSON.parse(first.pageMarker)).toContainEqual(expect.objectContaining({
      frame: 1, url: formUrl, marker: expect.stringContaining('data-step=1'),
    }));
    expect(JSON.parse(second.pageMarker)).toContainEqual(expect.objectContaining({
      frame: 1, url: formUrl, marker: expect.stringContaining('data-step=2'),
    }));
    expect(second.pageMarker).not.toBe(first.pageMarker);
  });
});
