import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { nativeQuestionText } from '../functions/src/lib/nativeQuestionText.js';
import { extractFieldsInPage } from '../scripts/assisted-application/lib/portal/fields.mjs';
import { autoAnswersForPortalQuestions, candidateForForm, portalQuestionId, portalQuestionKey, portalRequirementsFromMissingRequired } from '../scripts/assisted-application/lib/portal/portal.mjs';
import { candidateAnswerForField, guardPlan } from '../scripts/assisted-application/lib/portal/plan.mjs';

const bundle = readFileSync(new URL('../scripts/assisted-application/extension/runner-fields.js', import.meta.url), 'utf8');
const candidate = { identity: { address: { city: 'Como', country: 'Italia' } }, profile: { dateOfBirth: '1990-01-02', nationality: 'Italia' }, answers: [] };

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
  it.each(['City', 'City of residence'])('does not treat an empty native ownership shape as evidence for %s', (label) => {
    const field = nativeField(`<form><label for="city">${label}</label><input id="city" name="city" required autocomplete="address-level2"></form>`, reader);
    expect(field.addressContext).toEqual({ section: '', owners: [], unknown: false });
    const stated = { ...candidate, portalQuestionsAnswered: [{ question: field.label, context: field.context, section: field.section, autocomplete: field.autocomplete, addressContext: field.addressContext, answer: 'Lugano', source: 'answers', current: true }] };
    expect(candidateAnswerForField(stated, field)).toBeNull();
    expect(candidateAnswerForField(candidate, field)).toBeNull();
    const requirements = portalRequirementsFromMissingRequired([field], [{ fieldId: field.id, question: label, type: 'text' }]);
    expect(requirements.questions).toEqual([]);
    expect(requirements.unreadableFields).toEqual([field.id]);
  });

  it.each([
    ['City', 'Personal information'], ['Town', 'Personal information'], ['Città', 'Informazioni personali'],
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
    `<section aria-labelledby="owner"><span id="owner">Personal information ${'x'.repeat(310)} Employer</span>`,
    '<fieldset aria-labelledby="owner"><span id="owner">Personal information</span><span id="owner">Employer</span>',
  ])('never substitutes residence or DOB for another named owner', (open) => {
    const close = open.startsWith('<fieldset') ? '</fieldset>' : open.startsWith('<section') ? '</section>' : '</div>';
    const field = nativeField(`<form><h2>Personal information</h2>${open}<div role="group"><label for="city">City</label><input id="city" name="city" autocomplete="address-level2"></div>${close}</form>`, reader);
    expect(candidateAnswerForField(candidate, field)).toBeNull();
  });

  it('does not borrow a personal heading from a different form', () => {
    const field = nativeField('<form><h2>Personal information</h2><input name="first"></form><form><label for="city">City</label><input id="city" name="city" autocomplete="address-level2"></form>', reader);
    expect(candidateAnswerForField(candidate, field)).toBeNull();
  });

  it('keeps a trusted personal heading immediately before the sole form', () => {
    const field = nativeField('<h2>Personal details</h2><form><label for="city">City</label><input id="city" name="city" autocomplete="address-level2"></form>', reader);
    expect(field.addressContext.section).toBe('Personal details');
    expect(candidateAnswerForField(candidate, field)).toEqual({ value: 'Como', source: 'identity' });
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

  it.each(['Place of birth', 'Comune di nascita', 'Luogo di nascita', 'Geburtsort', 'Lieu de naissance', 'Country of birth', 'Paese di nascita', 'Nazione di nascita', 'Commune de naissance', 'Ort der Geburt', 'Nato a', 'Birth country', 'Provincia di nascita', 'Nationality / Country of birth', 'Nazionalità / Paese di nascita', 'Nazionalità / Nazione di nascita', 'Nationalität bei Geburt', 'Nationality at birth'])('does not answer %s with a known date of birth or nationality', (label) => {
    const field = nativeField(`<form><h2>Personal information</h2><label for="city">${label}</label><input id="city" name="city"></form>`, reader);
    expect(candidateAnswerForField(candidate, field)).toBeNull();
  });

  it.each(['Date of birth', 'DOB', 'Data di nascita', 'Quando sei nato?', 'Geburtsdatum', 'Date de naissance'])('still answers the actual %s date question', (label) => {
    const field = nativeField(`<form><h2>Personal information</h2><label for="dob">${label}</label><input id="dob" name="dob" type="date"></form>`, reader, 'dob');
    expect(candidateAnswerForField(candidate, field)).toEqual({ value: '1990-01-02', source: 'profile' });
  });

  it('uses native date semantics for a bare birth caption but not arbitrary text', () => {
    const input = nativeField('<form><h2>Personal information</h2><label for="dob">Birth</label><input id="dob" name="dob" type="date"></form>', reader, 'dob');
    expect(candidateAnswerForField(candidate, input)).toEqual({ value: '1990-01-02', source: 'profile' });
    expect(candidateAnswerForField(candidate, { ...input, inputType: 'text', kind: 'text' })).toBeNull();
  });

  it('retains an explicit exact answer without substituting another birth fact', () => {
    const field = nativeField('<form><h2>Personal information</h2><label for="city">Place of birth</label><input id="city" name="city"></form>', reader);
    const stated = { ...candidate, portalQuestionsAnswered: [{ question: field.label, context: field.context, section: field.section, autocomplete: field.autocomplete, addressContext: field.addressContext, answer: 'Lugano', source: 'candidate' }] };
    expect(candidateAnswerForField(stated, field)).toEqual({ value: 'Lugano', source: 'answers' });
    expect(candidateAnswerForField(stated, { ...field, label: 'Country of birth' })).toBeNull();
  });

  it.each(['identity', 'profile', 'answers'])('rejects an unbound saved %s answer after the native owner veto', (source) => {
    const field = nativeField('<form><h2>Personal information</h2><fieldset aria-label="Employer"><div role="group"><label for="city">City</label><input id="city" name="city" autocomplete="address-level2" required></div></fieldset></form>', reader);
    const previous = { question: field.label, context: field.context, section: field.section, autocomplete: field.autocomplete, answer: 'Como', source };
    const remembered = { ...candidate, portalQuestionsAnswered: [previous] };
    expect(candidateAnswerForField(remembered, field)).toBeNull();
    const guarded = guardPlan({ actions: [{ fieldId: field.id, action: 'fill', value: 'Como', source: 'profile' }], missingRequired: [] }, [field], remembered);
    expect(guarded.actions).toEqual([]);
    expect(guarded.missingRequired.some((item: any) => item.fieldId === field.id)).toBe(true);
  });

  it('requires the same valid owner for a saved candidate statement', () => {
    const field = nativeField('<form><h2>Personal information</h2><fieldset aria-label="Employer"><label for="city">City</label><input id="city" name="city" autocomplete="address-level2" required></fieldset></form>', reader);
    const statement = { question: field.label, context: field.context, section: field.section, autocomplete: field.autocomplete, addressContext: field.addressContext, answer: 'Lugano', source: 'answers' };
    const remembered = { ...candidate, portalQuestionsAnswered: [statement] };
    expect(candidateAnswerForField(remembered, field)).toEqual({ value: 'Lugano', source: 'answers' });
    expect(candidateAnswerForField({ ...remembered, portalQuestionsAnswered: [{ ...statement, source: 'identity' }] }, field)).toBeNull();
    expect(candidateAnswerForField({ ...remembered, portalQuestionsAnswered: [{ ...statement, addressContext: { section: 'Personal information', owners: [], unknown: false } }] }, field)).toBeNull();
    expect(candidateAnswerForField(remembered, { ...field, addressContext: { ...field.addressContext, unknown: true } })).toBeNull();
    const guarded = guardPlan({ actions: [{ fieldId: field.id, action: 'fill', value: 'Lugano', source: 'answers' }], missingRequired: [] }, [field], remembered);
    expect(guarded.actions[0]?.value).toBe('Lugano');
  });

  it('uses the current residence above a stale bound profile projection', () => {
    const field = nativeField('<form><h2>Personal information</h2><label for="city">City</label><input id="city" name="city" autocomplete="address-level2"></form>', reader);
    const remembered = { ...candidate, portalQuestionsAnswered: [{ question: field.label, context: field.context, section: field.section, autocomplete: field.autocomplete, addressContext: field.addressContext, answer: 'Zurich', source: 'identity' }] };
    expect(candidateAnswerForField(remembered, field)).toEqual({ value: 'Como', source: 'identity' });
  });

  it.each(['Via', 'Wohnort', 'Località', 'Postleitzahl', 'Place of birth', 'Birthplace', 'Luogo di nascita', 'Geburtsort', 'Lieu de naissance', 'Nato a', 'Ort der Geburt'])('never projects saved identity, profile or unbound user data onto %s', (label) => {
    const field = nativeField(`<form><h2>Personal information</h2><fieldset aria-label="Employer"><label for="city">${label}</label><input id="city" name="city" required></fieldset></form>`, reader);
    for (const source of ['identity', 'profile', 'answers']) {
      const previous = { question: field.label, context: field.context, section: field.section, autocomplete: field.autocomplete, answer: 'Como', source };
      expect(candidateAnswerForField({ ...candidate, portalQuestionsAnswered: [previous] }, field)).toBeNull();
    }
  });

  it('keeps an unreadable native owner technical instead of asking an unanswerable candidate question', () => {
    const field = nativeField('<form><h2>Personal information</h2><fieldset aria-labelledby="missing"><label for="city">City</label><input id="city" name="city" required autocomplete="address-level2"></fieldset></form>', reader);
    const requirements = portalRequirementsFromMissingRequired([field], [{ fieldId: field.id, question: 'City', type: 'text' }]);
    expect(requirements.questions).toEqual([]);
    expect(requirements.unreadableFields).toEqual([field.id]);
    const birthplace = nativeField('<form><h2>Personal information</h2><label for="city">Place of birth</label><input id="city" name="city" required></form>', reader);
    const hard = portalRequirementsFromMissingRequired([birthplace], [{ fieldId: birthplace.id, question: 'Place of birth', type: 'text' }]);
    expect(hard.questions).toHaveLength(1);
    expect(hard.unreadableFields).toBeUndefined();
  });

  it('honors the current explicit residence correction above CV extraction', () => {
    const field = nativeField('<form><h2>Personal information</h2><label for="city">City</label><input id="city" name="city" autocomplete="address-level2"></form>', reader);
    const question = { ...field, question: field.label, source: 'portal', type: 'text' };
    const form = candidateForForm({ identity: { name: 'Test User', email: 'test@example.test' }, profile: { address: { city: 'Como', country: 'Italia' } }, portalQuestions: [question], answers: { [field.id]: 'Lugano' }, currentAnswerIds: [field.id] });
    expect(candidateAnswerForField(form, field)).toEqual({ value: 'Lugano', source: 'answers' });
    const cleared = candidateForForm({ identity: { name: 'Test User', email: 'test@example.test' }, portalQuestions: [{ ...question, addressContext: { ...field.addressContext, owners: ['Employer'] } }], answers: { [field.id]: '' }, draft: { portalAnswers: { answers: [{ question: field.label, context: field.context, section: field.section, autocomplete: field.autocomplete, addressContext: { ...field.addressContext, owners: ['Employer'] }, answer: 'Como', source: 'answers' }] } } });
    expect(cleared.portalQuestionsAnswered).toEqual([]);
  });

  it('preserves ownership during automatic answer projection and never attests an inferred answer as current', () => {
    const field = nativeField('<form><h2>Personal information</h2><fieldset aria-label="Employer"><label for="city">City</label><input id="city" name="city" required autocomplete="address-level2"></fieldset></form>', reader);
    const question = { ...field, question: field.label, source: 'portal', type: 'text' };
    expect(autoAnswersForPortalQuestions({ questions: [question], candidate, answers: {} })).toEqual({});
    const personal = { ...question, addressContext: { section: 'Personal information', owners: [], unknown: false } };
    const sources: Record<string, string> = {};
    const projected = autoAnswersForPortalQuestions({ questions: [personal], candidate, answers: {}, sources });
    expect(projected[field.id]).toBe('Como');
    const inferred = candidateForForm({ identity: { name: 'Test User', email: 'test@example.test' }, portalQuestions: [personal], answers: projected, answerSources: sources });
    expect(inferred.portalQuestionsAnswered[0].current).toBeUndefined();
    expect(inferred.portalQuestionsAnswered[0].source).toBe('identity');
  });

  it('keeps an unreadable native checkbox owner technical without dropping legacy checkboxes', () => {
    const field = { id: 'consent', label: 'I agree to the required privacy terms', kind: 'checkbox', required: true };
    const missing = [{ fieldId: field.id, question: field.label, type: 'yes_no' }];
    expect(portalRequirementsFromMissingRequired([{ ...field, consentOwnershipUnknown: true }], missing).unreadableFields).toEqual([field.id]);
    expect(portalRequirementsFromMissingRequired([field], missing).questions).toHaveLength(1);
    expect(portalRequirementsFromMissingRequired([{ ...field, consentOwnershipUnknown: false }], missing).questions).toHaveLength(1);
  });

  it.each([
    ['Where would you like to work (City)?', 'address-level2'],
    ['In quale città vorresti lavorare?', 'address-level2'],
    ['In welcher Stadt möchten Sie arbeiten?', 'address-level2'],
    ['Dans quelle ville souhaitez-vous travailler?', 'address-level2'],
    ['Which country would you relocate to?', 'country-name'],
    ['In quale paese vorresti trasferirti?', 'country-name'],
    ['In welchem Land möchten Sie arbeiten?', 'country-name'],
    ['Dans quel pays voulez-vous travailler?', 'country-name'],
    ['Which postal code would you like to work in?', 'postal-code'],
  ])('does not turn candidate ownership into residence intent for %s', (label, autocomplete) => {
    const field = nativeField(`<form><h2>Personal information</h2><label for="city">${label}</label><input id="city" name="city" autocomplete="${autocomplete}" required></form>`, reader);
    expect(candidateAnswerForField(candidate, field)).toBeNull();
    const answer = autocomplete === 'country-name' ? 'France' : autocomplete === 'postal-code' ? '8000' : 'Lugano';
    const stated = candidateForForm({ identity: { name: 'Test User', email: 'test@example.test' }, profile: { address: { city: 'Como', country: 'Italia' } }, portalQuestions: [{ ...field, question: field.label, source: 'portal', type: 'text' }], answers: { [field.id]: answer }, currentAnswerIds: [field.id] });
    expect(candidateAnswerForField(stated, field)).toEqual({ value: answer, source: 'answers' });
  });

  it('keeps a positive street caption distinct from an unrelated date alias', () => {
    const field = nativeField('<form><h2>Personal information</h2><label for="city">Straße</label><input id="city" name="city" placeholder="Date of birth"></form>', reader);
    expect(candidateAnswerForField({ ...candidate, identity: { address: { street: 'Via Roma 1' } } }, field)).toEqual({ value: 'Via Roma 1', source: 'identity' });
  });

  it.each([['Email address', 'text'], ['Email address', 'email'], ['Adresse e-mail', 'text'], ['Adresse e-mail', 'email']])('does not treat the contact caption %s/%s as a postal address', (label, type) => {
    const field = nativeField(`<form><h2>Personal information</h2><label for="city">${label}</label><input id="city" name="city" type="${type}" autocomplete="email" required></form>`, reader);
    const person = { ...candidate, identity: { ...candidate.identity, email: 'alias@example.test' } };
    expect(candidateAnswerForField(person, field)).toEqual({ value: 'alias@example.test', source: 'identity' });
    const guarded = guardPlan({ actions: [{ fieldId: field.id, action: 'fill', value: 'alias@example.test', source: 'identity' }], missingRequired: [] }, [field], person);
    expect(guarded.actions[0]?.value).toBe('alias@example.test');
  });

  it.each([
    '<section aria-label="Work preferences">',
    '<section><h3>Work preferences</h3>',
    '<section aria-label="Additional questions">',
  ])('keeps the closest unknown purpose ahead of a distant personal scope', open => {
    const field = nativeField(`<form><section aria-label="Personal details">${open}<label for="city">City</label><input id="city" name="city"></section></section></form>`, reader);
    expect(candidateAnswerForField(candidate, field)).toBeNull();
    const statement = { question: field.label, context: field.context, section: field.section, autocomplete: field.autocomplete, addressContext: field.addressContext, source: 'answers', answer: 'Lugano', current: true };
    expect(candidateAnswerForField({ ...candidate, portalQuestionsAnswered: [statement] }, field)).toEqual({ value: 'Lugano', source: 'answers' });
  });

  it.each([['', 'Italy'], ['<fieldset><legend>Telephone</legend>', 'Switzerland']])('uses named telephone ownership, not a phone sibling, for a country prefix', (phoneScope, expected) => {
    const field = nativeField(`<form><fieldset><legend>Personal information</legend>${phoneScope}<label for="phone">Phone</label><input id="phone" type="tel"><label for="city">Country</label><select id="city" name="city"><option value="">Select</option><option value="it">Italy</option><option value="ch">Switzerland</option></select>${phoneScope ? '</fieldset>' : ''}</fieldset></form>`, reader);
    expect(candidateAnswerForField({ ...candidate, identity: { ...candidate.identity, phone: '+41 79 1234567' } }, field)?.value).toBe(expected);
  });

  it.each([
    '<form aria-label="Work preferences"><h2>Personal information</h2>',
    '<form><section aria-label="Work preferences"><h2>Personal details</h2>',
  ])('keeps discordant names on one physical scope together', open => {
    const field = nativeField(`${open}<label for="city">City</label><input id="city" name="city"></section></form>`, reader);
    expect(field.addressContext.unknown).toBe(false);
    expect(field.addressContext.owners[0]).toContain(' · ');
    expect(candidateAnswerForField(candidate, field)).toBeNull();
    const statement = { question: field.label, context: field.context, section: field.section, addressContext: field.addressContext, source: 'answers', answer: 'Lugano', current: true };
    expect(candidateAnswerForField({ ...candidate, portalQuestionsAnswered: [statement] }, field)?.value).toBe('Lugano');
  });

  it.each([
    ['Telephone', 'Residence', 'Italy'], ['Residence', 'Telephone', 'Switzerland'],
    ['Telephone', 'Work preferences', null],
  ])('uses the closest %s/%s scope for country purpose', (outer, inner, expected) => {
    const field = nativeField(`<form><fieldset aria-label="${outer}"><section aria-label="${inner}"><label for="city">Country</label><select id="city" name="city"><option value="">Select</option><option value="it">Italy</option><option value="ch">Switzerland</option></select></section></fieldset></form>`, reader);
    expect(candidateAnswerForField({ ...candidate, identity: { ...candidate.identity, phone: '+41 79 1234567' } }, field)?.value || null).toBe(expected);
  });

  it.each(['Email address', 'Adresse e-mail', 'Indirizzo e-mail', 'E-Mail-Adresse'])('keeps the canonical counter on contact %s out of postal ownership', label => {
    for (const type of ['email', 'text']) {
      const field = nativeField(`<form><h2>Personal information</h2><label for="city">${label} <span>0 / 200 chars</span></label><input id="city" name="city" type="${type}" autocomplete="email" maxlength="200"></form>`, reader);
      expect(field.label).toBe(`${label} max 200 chars`);
      expect(candidateAnswerForField({ ...candidate, identity: { email: 'alias@example.test' } }, field)?.value).toBe('alias@example.test');
    }
  });

  it.each([
    ['200', '0 / 200 Zeichen', 'Wohnort max 200 Zeichen'],
    ['200', '1 / 200 Zeichen', 'Wohnort 1 / 200 Zeichen'],
    ['', '0 / 200 Zeichen', 'Wohnort 0 / 200 Zeichen'],
  ])('normalizes only the observed owned counter with maxlength=%s', (maximum, counter, expected) => {
    expect(extractFieldsInPage.toString()).toContain(nativeQuestionText.toString());
    const field = nativeField(`<form><section aria-label="Personal information"><label for="city">Wohnort <span>${counter}</span></label><input id="city" name="city" ${maximum ? `maxlength="${maximum}"` : ''}></section></form>`, reader);
    expect(field.label).toBe(expected);
    const answered = nativeField('<form><section aria-label="Personal information"><label for="city">Wohnort <span>6 / 200 Zeichen</span></label><input id="city" name="city" maxlength="200" value="Lugano"></section></form>', reader);
    if (expected === 'Wohnort max 200 Zeichen') {
      expect(answered.label).toBe(field.label);
      expect(answered.context).toBe(field.context);
      expect(answered.addressContext).toEqual(field.addressContext);
      const current = { question: field.label, context: field.context, section: field.section, addressContext: field.addressContext, source: 'answers', current: true, answer: 'Lugano' };
      expect(candidateAnswerForField({ ...candidate, portalQuestionsAnswered: [current] }, answered)?.value).toBe('Lugano');
    }
  });

  it.each([
    '<label for="city">Minimum 500 / 1000 characters</label>',
    '<label for="city">Wohnort <span hidden>0 / 200 Zeichen</span></label>',
    '<label id="shared">Wohnort <span>0 / 200 Zeichen</span></label><input aria-labelledby="shared">',
  ])('preserves unproven numeric requirements or ambiguous counter ownership', label => {
    const field = nativeField(`<form>${label}<input id="city" name="city" aria-labelledby="shared" maxlength="200"></form>`, reader);
    expect(field.label).not.toContain('max 200');
  });

  it('recognizes the explicit German country and region of residence caption', () => {
    const field = nativeField('<form><h2>Personal information</h2><label for="city">Land/Region des Wohnorts</label><input id="city" name="city"></form>', reader);
    expect(candidateAnswerForField(candidate, field)?.value).toBe('Italia');
  });

  it.each<[string, boolean]>([
    ['<main><h2>My Information</h2><form>FIELD</form></main>', true],
    ['<section><h2>Personal information</h2><form>FIELD</form></section>', true],
    ['<main><h2>My Information</h2><form>FIELD</form><form></form></main>', false],
    ['<h2>My Information</h2><form>FIELD</form>', false],
    ['<main><section><h2>My Information</h2></section><form>FIELD</form></main>', false],
    ['<main aria-label="Work preferences"><h2>My Information</h2><form>FIELD</form></main>', false],
    ['<main><h2>My Information</h2><form><fieldset aria-label="Work preferences">FIELD</fieldset></form></main>', false],
    ['<main><h2>My Information</h2><form><fieldset aria-label="Employer">FIELD</fieldset></form></main>', false],
    ['<main><h2>My Information</h2><form><fieldset aria-label="Place of birth">FIELD</fieldset></form></main>', false],
    ['<main><h2>My Information</h2><form><fieldset aria-label="Telephone">FIELD</fieldset></form></main>', false],
  ])('uses a full candidate heading only in a semantic container with one actual form: %s', (html, allowed) => {
    const label = html.includes('Telephone') ? 'City' : 'Country*';
    const field = nativeField(html.replace('FIELD', `<label for="city">${label}</label><input id="city" name="city">`), reader);
    expect(candidateAnswerForField(candidate, field)?.value || '').toBe(allowed ? 'Italia' : '');
  });

  it.each<[string, boolean]>([['personal', true], ['employer', false]])('preserves the submitted form names for an external associated control: %s', (owner, allowed) => {
    const title = allowed ? 'Personal information' : 'Employer';
    const field = nativeField(`<main><h2>My Information</h2><form id="${owner}" aria-label="${title}"></form><label for="city">Country</label><input id="city" name="city" form="${owner}"></main>`, reader);
    expect(field.addressContext.owners).toContain(title);
    expect(candidateAnswerForField(candidate, field)?.value || '').toBe(allowed ? 'Italia' : '');
  });

  it('rejects an explicit association with another native form', () => {
    const field = nativeField('<main><h2>My Information</h2><form><label for="city">Country</label><input id="city" name="city" form="employer"></form></main><form id="employer"></form>', reader);
    expect(field.addressContext.unknown).toBe(true);
    expect(candidateAnswerForField(candidate, field)).toBeNull();
  });

  it.each(['Email address/login *', 'E-Mail-Adresse erneut eingeben: *', 'Verify Email Address', 'Please enter your email address', 'Adresse e-mail / identifiant'])('does not reinterpret the registration contact %s as postal evidence', label => {
    const field = nativeField(`<form><label for="city">${label}</label><input id="city" name="city" type="text" autocomplete="email"></form>`, reader);
    const guarded = guardPlan({ actions: [{ fieldId: field.id, action: 'fill', value: 'alias@example.test', source: 'identity' }], missingRequired: [] }, [field], { ...candidate, identity: { email: 'alias@example.test' } });
    expect(guarded.actions[0]?.value).toBe('alias@example.test');
  });

  it('does not invent DOB when the profile has no date of birth', () => {
    const field = nativeField('<form><label for="dob">DOB</label><input id="dob" name="dob" type="date" required></form>', reader, 'dob');
    const guarded = guardPlan({ actions: [{ fieldId: field.id, action: 'fill', value: '1990-01-02', source: 'inferred' }], missingRequired: [] }, [field], { ...candidate, profile: {} });
    expect(guarded.actions).toEqual([]);
    expect(guarded.missingRequired.some((item: any) => item.fieldId === field.id)).toBe(true);
  });
});

describe('owned native question round trip', () => {
  it('keeps two City statements separate through generated ids and portal projection', () => {
    const base = { question: 'City', context: 'City', section: 'Personal information', autocomplete: 'address-level2', source: 'portal', type: 'text' };
    const questions = [[], ['Employer']].map(owners => {
      const question = { ...base, addressContext: { section: base.section, owners, unknown: false } };
      return { ...question, id: portalQuestionId(question) };
    });
    expect(questions[0].id).not.toBe(questions[1].id);
    expect(portalQuestionKey(questions[0])).not.toBe(portalQuestionKey(questions[1]));
    const form = candidateForForm({ identity: { name: 'Test User', email: 'test@example.test' }, profile: {}, portalQuestions: questions, answers: { [questions[0].id]: 'Como', [questions[1].id]: 'Lugano' } });
    expect(form.portalQuestionsAnswered).toEqual(expect.arrayContaining(questions.map((question, index) => expect.objectContaining({ question: 'City', answer: ['Como', 'Lugano'][index], addressContext: question.addressContext }))));
    expect(form.portalQuestionsAnswered).toHaveLength(2);
    const prior = candidateForForm({ identity: { name: 'Test User', email: 'test@example.test' }, profile: {}, draft: { portalAnswers: { answers: form.portalQuestionsAnswered } } });
    expect(prior.portalQuestionsAnswered).toHaveLength(2);
    expect(candidateAnswerForField(prior, { ...questions[1], label: 'City', kind: 'text' })).toEqual({ value: 'Lugano', source: 'answers' });
  });
});
