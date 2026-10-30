import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { extractFieldsInPage } from '../scripts/assisted-application/lib/portal/fields.mjs';
import { candidateAnswerForField } from '../scripts/assisted-application/lib/portal/plan.mjs';

const bundle = readFileSync(new URL('../scripts/assisted-application/extension/runner-fields.js', import.meta.url), 'utf8');
const candidate = { identity: { address: { city: 'Como', country: 'Italia' } }, profile: { dateOfBirth: '1990-01-02' }, answers: [] };

function nativeField(html: string, reader: string, name = 'city') {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { url: 'https://jobs.example.test/apply/', runScripts: 'outside-only' });
  const w = dom.window;
  Object.defineProperty(w.HTMLElement.prototype, 'getBoundingClientRect', { value: () => ({ width: 100, height: 24 }) });
  Object.defineProperty(w, 'CSS', { value: { escape: (value: string) => value } });
  w.eval(reader === 'source' ? `window.readAddressFields = ${extractFieldsInPage.toString()};` : bundle);
  const snapshot = reader === 'source' ? (w as any).readAddressFields() : (w as any).CompilaRunnerFields();
  const field = snapshot.fields.find((entry: any) => entry.name === name);
  w.close();
  expect(field).toBeDefined();
  return field;
}

describe.each(['source', 'bundle'])('native address ownership: %s', (reader) => {
  it.each([
    ['City', 'Personal information'], ['Città', 'Informazioni personali'],
    ['Citta', 'Dati personali'], ['Ort', 'Persönliche Informationen'],
    ['Ville', 'Informations personnelles'],
  ])('answers the candidate’s %s under %s from identity', (label, heading) => {
    const field = nativeField(`<form><h2>${heading}</h2><label for="city">${label}</label><input id="city" name="city" autocomplete="address-level2"></form>`, reader);
    expect(candidateAnswerForField(candidate, field)).toEqual({ value: 'Como', source: 'identity' });
  });

  it.each([
    '<fieldset aria-label="Employer">', '<div class="field" aria-label="Company address">',
    '<section aria-labelledby="owner"><span id="owner" hidden>Employer</span>',
    '<fieldset aria-labelledby="missing-owner">', '<fieldset><legend>Place of birth</legend>',
  ])('never substitutes residence or DOB for another named owner', (open) => {
    const close = open.startsWith('<fieldset') ? '</fieldset>' : open.startsWith('<section') ? '</section>' : '</div>';
    const field = nativeField(`<form><h2>Personal information</h2>${open}<div role="group"><label for="city">City</label><input id="city" name="city" autocomplete="address-level2"></div>${close}</form>`, reader);
    expect(candidateAnswerForField(candidate, field)).toBeNull();
  });

  it('does not borrow a personal heading from a different form', () => {
    const field = nativeField('<form><h2>Personal information</h2><input name="first"></form><form><label for="city">City</label><input id="city" name="city" autocomplete="address-level2"></form>', reader);
    expect(candidateAnswerForField(candidate, field)).toBeNull();
  });

  it('retains an explicitly named personal group on a form-less page', () => {
    const field = nativeField('<fieldset aria-label="Personal information"><label for="city">City</label><input id="city" name="city" autocomplete="address-level2"></fieldset>', reader);
    expect(candidateAnswerForField(candidate, field)).toEqual({ value: 'Como', source: 'identity' });
  });

  it('does not confuse a birth-date sibling with the residence owner', () => {
    const field = nativeField('<form><fieldset><legend>Informazioni personali</legend><label for="dob">Data di nascita</label><input id="dob" name="dob"><label for="city">Città</label><input id="city" name="city" autocomplete="address-level2"></fieldset></form>', reader);
    expect(field.context).toContain('nascita');
    expect(candidateAnswerForField(candidate, field)).toEqual({ value: 'Como', source: 'identity' });
  });

  it.each(['Place of birth', 'Comune di nascita', 'Luogo di nascita', 'Geburtsort', 'Lieu de naissance'])('does not answer %s with a known date of birth', (label) => {
    const field = nativeField(`<form><h2>Personal information</h2><label for="city">${label}</label><input id="city" name="city"></form>`, reader);
    expect(candidateAnswerForField(candidate, field)).toBeNull();
  });

  it('still answers the actual date-of-birth question', () => {
    const field = nativeField('<form><h2>Personal information</h2><label for="dob">Date of birth</label><input id="dob" name="dob" type="date"></form>', reader, 'dob');
    expect(candidateAnswerForField(candidate, field)).toEqual({ value: '1990-01-02', source: 'profile' });
  });
});
