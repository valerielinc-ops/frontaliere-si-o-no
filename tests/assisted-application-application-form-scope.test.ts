import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { extractFieldsInPage } from '../scripts/assisted-application/lib/portal/fields.mjs';
import { guardPlan, ownConsent } from '../scripts/assisted-application/lib/portal/plan.mjs';
import { portalRequirementsFromMissingRequired } from '../scripts/assisted-application/lib/portal/portal.mjs';

// Synthetic page modelled on an employer's public «lavora con noi»: the application form (CV upload, own submit) and
// a footer NEWSLETTER form carry the same required privacy sentence. No candidate data.
const PRIVACY = 'Dichiaro di aver letto l’informativa sulla privacy e acconsento al trattamento dei miei dati. *';
const PAGE = `
  <main>
    <form id="candidatura" action="/candidatura">
      <label for="candidature_name">Nome *</label><input id="candidature_name" name="candidature_name" required>
      <label for="candidature_file">Carica il tuo CV *</label><input id="candidature_file" name="candidature_file" type="file" required>
      <div class="custom-control custom-checkbox">
        <input class="custom-control-input" type="checkbox" id="candidature_privacy" name="candidature_privacy" required>
        <label class="custom-control-label" for="candidature_privacy">${PRIVACY}</label>
      </div>
      <div class="send-candidatura-submit">Invia candidatura</div>
    </form>
  </main>
  <footer>
    <form id="newsletter" action="/newsletter">
      <label for="newsletter_email">E-mail</label><input id="newsletter_email" name="post_title" type="email" required>
      <div class="custom-control custom-checkbox">
        <input class="custom-control-input" type="checkbox" id="newsletter_privacy" name="newsletter_privacy" required>
        <label class="custom-control-label" for="newsletter_privacy">${PRIVACY}</label>
      </div>
      <button type="button" id="newsletter-invia">Iscriviti</button>
    </form>
  </footer>`;

function extract(html: string) {
  const { window } = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: 'https://employer.example/it/lavora-con-noi/' });
  Object.defineProperty(window.HTMLElement.prototype, 'innerText', { configurable: true, get() { return this.textContent || ''; } });
  window.Element.prototype.getBoundingClientRect = function rect() {
    return { width: 20, height: 20, top: 0, left: 0, right: 20, bottom: 20, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('location', window.location);
  vi.stubGlobal('CSS', { escape: (value: string) => String(value).replace(/["\\\]]/g, '\\$&') });
  return extractFieldsInPage({});
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('only the application form is read when a page has several forms', () => {
  it('leaves the newsletter form out, fields and buttons', () => {
    const page = extract(PAGE);
    const names = page.fields.map((field: any) => field.name);
    expect(names).toEqual(['candidature_name', 'candidature_file', 'candidature_privacy']);
    expect(page.buttons.map((button: any) => button.text)).not.toContain('Iscriviti');
  });

  it('never asks the candidate the newsletter consent and covers the application one by the mandate', () => {
    const page = extract(PAGE);
    const consent = page.fields.find((field: any) => field.name === 'candidature_privacy');
    expect(consent).toMatchObject({ kind: 'checkbox', required: true });
    expect(ownConsent(consent)).toBe(true);
    const candidate = { profile: {}, answers: { candidature_name: 'x' }, identity: {}, portalQuestionsAnswered: [] };
    const asked = portalRequirementsFromMissingRequired(page.fields, [], { candidate }).questions.map((q: any) => q.id);
    expect(asked).not.toContain('portal_privacy_consent');
    const plan = guardPlan({ actions: [], missingRequired: [] }, page.fields, candidate);
    const checked = plan.actions.filter((action: any) => action.action === 'check');
    expect(checked).toHaveLength(1);
    expect(checked[0].fieldId).toBe(consent.id);
  });

  it('gives the box the label click its hidden Bootstrap input needs, bound to the application input', () => {
    const { window } = new JSDOM(`<body>${PAGE}</body>`);
    const label = window.document.querySelector('label[for="candidature_privacy"]');
    expect(label?.textContent).toContain('privacy');
    expect(window.document.getElementById('candidature_privacy')?.closest('form')?.id).toBe('candidatura');
  });
});

describe('fail-closed without proof of the application form', () => {
  it('keeps every form when none holds the CV upload', () => {
    const page = extract(PAGE.replace(/<label for="candidature_file">.*?required>/s, ''));
    expect(page.fields.map((field: any) => field.name)).toContain('newsletter_privacy');
  });

  it('keeps a single form, and a form nested in the application one', () => {
    expect(extract(PAGE.replace(/<footer>[\s\S]*<\/footer>/, '')).fields.map((f: any) => f.name)).not.toContain('newsletter_privacy');
    const nested = extract(`<form id="outer"><input type="file" name="cv"><div><form id="inner"><input name="inner_field" required></form></div></form><form id="other"><input name="other_field"></form>`);
    expect(nested.fields.map((f: any) => f.name)).toEqual(expect.arrayContaining(['cv', 'inner_field']));
    expect(nested.fields.map((f: any) => f.name)).not.toContain('other_field');
  });
});
