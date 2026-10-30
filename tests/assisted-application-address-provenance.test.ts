import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { extractFieldsInPage } from '../scripts/assisted-application/lib/portal/fields.mjs';
import { candidateForForm, portalQuestionId, portalQuestionKey, portalRequirementsFromMissingRequired } from '../scripts/assisted-application/lib/portal/portal.mjs';
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

  it('retains an explicitly named personal group on a form-less page', () => {
    const field = nativeField('<fieldset aria-label="Personal information"><label for="city">City</label><input id="city" name="city" autocomplete="address-level2"></fieldset>', reader);
    expect(candidateAnswerForField(candidate, field)).toEqual({ value: 'Como', source: 'identity' });
  });

  it('does not confuse a birth-date sibling with the residence owner', () => {
    const field = nativeField('<form><fieldset><legend>Informazioni personali</legend><label for="dob">Data di nascita</label><input id="dob" name="dob"><label for="city">Città</label><input id="city" name="city" autocomplete="address-level2"></fieldset></form>', reader);
    expect(field.context).toContain('nascita');
    expect(candidateAnswerForField(candidate, field)).toEqual({ value: 'Como', source: 'identity' });
  });

  it.each(['Place of birth', 'Comune di nascita', 'Luogo di nascita', 'Geburtsort', 'Lieu de naissance', 'Country of birth', 'Paese di nascita', 'Commune de naissance', 'Ort der Geburt', 'Nato a', 'Birth country', 'Provincia di nascita', 'Nationality / Country of birth', 'Nazionalità / Paese di nascita'])('does not answer %s with a known date of birth or nationality', (label) => {
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
