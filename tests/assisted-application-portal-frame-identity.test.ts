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
  it('changes the document identity when a repeated file control belongs to a new document', async () => {
    const html = '<form><label for="cv">CV *</label><input id="cv" name="cv" type="file" required></form>';
    const first = extract(html, 'https://forms.example.test/application');
    const second = extract(html, 'https://forms.example.test/application');
    const firstFile = first.fields.find((field: any) => field.inputType === 'file');
    const secondFile = second.fields.find((field: any) => field.inputType === 'file');

    expect(firstFile).toEqual(expect.objectContaining({ controlInstance: expect.any(String), documentInstance: expect.any(String) }));
    expect(secondFile).toEqual(expect.objectContaining({ controlInstance: expect.any(String), documentInstance: expect.any(String) }));
    // A fresh document may restart its node counter, so the document token is
    // the identity that must invalidate a prior upload receipt.
    expect(secondFile.documentInstance).not.toBe(firstFile.documentInstance);
  });

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
