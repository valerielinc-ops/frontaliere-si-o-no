import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { extractFieldsInPage } from '../scripts/assisted-application/lib/portal/fields.mjs';
import { guardPlan } from '../scripts/assisted-application/lib/portal/plan.mjs';
import { localizePortalQuestions, portalRequirementsForCandidate, portalRequirementsFromMissingRequired, readPortalRequirements, readPortalQuestions } from '../scripts/assisted-application/lib/portal/portal.mjs';
import { PORTAL_QUESTION_PLACEHOLDERS } from '../functions/src/lib/portalQuestionText.js';
import { questionsForCandidate } from '../functions/src/assistedApplicationCandidateEdits.js';
import { transition } from '../functions/src/assistedApplicationFlow.js';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { reconcileOperationalAnswers } from '../scripts/assisted-application/reconcile-operational-answers.mjs';

// Anonymous registration markup: an intentionally empty styled label and the
// actual consent in the owned fieldset legend, as on the public Avature form.
const form = `<form><fieldset><legend>I have read and accept the Privacy Policy. *</legend>
  <div><label for="consent"></label><input id="consent" name="consent" type="checkbox" required data-required="true"><input type="hidden" name="unselected" value="0"></div>
</fieldset></form>`;
function extract(html: string) {
  const dom = new JSDOM(html, { url: 'https://jobs.example/register/', runScripts: 'outside-only' });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', { get() { return this.textContent || ''; } });
  dom.window.Element.prototype.getBoundingClientRect = () => ({ width: 20, height: 20, top: 0, left: 0, right: 20, bottom: 20, x: 0, y: 0, toJSON() {} });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document); vi.stubGlobal('location', dom.window.location);
  vi.stubGlobal('CSS', { escape: (value: string) => value });
  return { dom, snapshot: extractFieldsInPage() };
}
afterEach(() => vi.unstubAllGlobals());

const mirrorPrompt = 'I accept the Candidates Privacy Notice. *';
const mirrorQuestion = `<label for="resumator-questionnaire-q722664">${mirrorPrompt}</label><input type="hidden" id="resumator-questionnaire-q722664" name="resumator-questionnaire[722664]" value="I agree">`;
const mirrorChoice = '<label><input type="checkbox" id="resumator-checkbox-722664-1" name="resumator-checkbox-722664-1" value="I agree">I agree</label>';
const mirrorMarketing = '<label><input type="checkbox" id="marketing">Send me the newsletter</label>';
const radioCards = (options = ['Yes', 'No']) => `<div>${options.map(option => `<div><div role="radio" aria-checked="false"><p>${option}</p></div></div>`).join('')}</div>`;
function allQuestionReaders(html: string) {
  const { dom, snapshot } = extract(html);
  (dom.window as any).CSS = { escape: (value: string) => value };
  for (const file of ['runner-fields.js', 'apply-control.js', 'filler.js']) dom.window.eval(readFileSync(new URL(`../scripts/assisted-application/extension/${file}`, import.meta.url), 'utf8'));
  const F = (dom.window as any).CompilaCandidatura;
  return { dom, F, source: snapshot.fields, bundle: (dom.window as any).CompilaRunnerFields().fields, filler: F.collect(dom.window.document) };
}
it('associates JazzHR hidden questionnaire metadata only with its unique keyed checkbox, never marketing', () => {
  const { dom, F, source, bundle, filler } = allQuestionReaders(`<form><div class="form-group">${mirrorQuestion}${mirrorChoice}${mirrorMarketing}</div></form>`);
  for (const fields of [source, bundle, filler]) {
    expect(fields[0]).toMatchObject({ label: mirrorPrompt, required: true });
    expect(fields[1]).toMatchObject({ label: 'Send me the newsletter', required: false });
  }
  expect(F.answerFor(filler[0], { identity: {}, documents: {} })).toEqual({ check: true });
  expect(F.answerFor(filler[1], { identity: {}, documents: {} })).toBeNull();
  expect(filler[0].element.checked).toBe(false); // A hidden value never proves a recorded check.
  dom.window.close();
});
it('does not invent a hidden owner from an empty for and empty tracking ID', () => {
  const { dom, F, source, bundle, filler } = allQuestionReaders(`<form><fieldset><legend>${mirrorPrompt}</legend><label for="">Tracking metadata</label><input type="hidden" id=""><input id="consent" type="checkbox" required></fieldset></form>`);
  for (const fields of [source, bundle, filler]) expect(fields[0]).toMatchObject({ label: mirrorPrompt, required: true });
  expect(F.answerFor(filler[0], { identity: {}, documents: {} })).toEqual({ check: true });
  dom.window.close();
});
it.each([
  ['aria-describedby="description" aria-label="I agree"', '<span id="description">Newsletter</span>'],
  ['aria-describedby="description"', '<span id="description">I do not agree</span>'],
  ['aria-describedby="missing-description"', ''],
  ['aria-details="description"', '<span id="description">I do not agree</span>'],
  ['title="Newsletter"', ''],
  ['placeholder="Newsletter"', ''],
  ['aria-description="Newsletter"', ''],
])('keeps contrary or unresolved own descriptive metadata distinct from the hidden privacy question: %s', (attributes, description) => {
  const choice = mirrorChoice.replace('type="checkbox"', `type="checkbox" ${attributes}`);
  const { dom, F, source, bundle, filler } = allQuestionReaders(`<form><div class="form-group">${mirrorQuestion}${description}${choice}</div></form>`);
  for (const fields of [source, bundle, filler]) expect(fields[0].label).not.toMatch(/privacy/i);
  expect(F.answerFor(filler[0], { identity: {}, documents: {} })).not.toEqual({ check: true });
  const plan = guardPlan({ actions: [{ fieldId: source[0].id, action: 'check', source: 'consent' }], missingRequired: [] }, source);
  expect(plan.actions).not.toContainEqual(expect.objectContaining({ fieldId: source[0].id, action: 'check' }));
  dom.window.close();
});
it('preserves a verified mirror when the own ARIA description is also an affirmative acceptance', () => {
  const choice = mirrorChoice.replace('type="checkbox"', 'type="checkbox" aria-describedby="description"');
  const { dom, F, source, bundle, filler } = allQuestionReaders(`<form><div class="form-group">${mirrorQuestion}<span id="description">I agree</span>${choice}</div></form>`);
  for (const fields of [source, bundle, filler]) expect(fields[0]).toMatchObject({ label: mirrorPrompt, required: true });
  expect(F.answerFor(filler[0], { identity: {}, documents: {} })).toEqual({ check: true });
  dom.window.close();
});
it.each([
  mirrorQuestion.replace('name="resumator-questionnaire[722664]"', 'name="resumator-questionnaire[9]"') + mirrorChoice,
  mirrorQuestion + mirrorChoice.replace('name="resumator-checkbox-722664-1"', 'name="resumator-checkbox-9-1"'),
  mirrorQuestion + mirrorChoice.replaceAll('resumator-checkbox-722664-1', 'resumator-checkbox-9-1'),
  mirrorQuestion + mirrorQuestion + mirrorChoice,
  mirrorQuestion + mirrorChoice + mirrorChoice,
  mirrorQuestion + mirrorChoice + mirrorChoice.replaceAll('resumator-checkbox-722664-1', 'resumator-checkbox-722664-2'),
  mirrorQuestion.replace(mirrorPrompt, '') + mirrorChoice,
  mirrorQuestion + mirrorChoice.replace('>I agree</label>', '>Send me the newsletter</label>'),
  mirrorQuestion + mirrorChoice.replace('>I agree</label>', '>I do not agree</label>'),
  mirrorQuestion + mirrorChoice.replace('type="checkbox"', 'type="checkbox" aria-label="Send me the newsletter"'),
  mirrorQuestion + '<span id="own-option">I do not agree</span>' + mirrorChoice.replace('type="checkbox"', 'type="checkbox" aria-labelledby="own-option"'),
  mirrorQuestion.replace('type="hidden"', 'type="hidden" form="other-form"') + mirrorChoice,
  `<div class="field">${mirrorQuestion}</div><div class="field">${mirrorChoice}</div>`,
  `<div class="field">${mirrorQuestion}${mirrorChoice.replaceAll('722664', '9')}</div>${mirrorChoice}`,
])('rejects mismatched, duplicate or foreign hidden-question ownership: %s', markup => {
  const { dom, F, source, bundle, filler } = allQuestionReaders(`<form><div class="form-group">${markup}${mirrorMarketing}</div></form>`);
  for (const fields of [source, bundle, filler]) expect(fields.every((field: any) => !/privacy/i.test(field.label))).toBe(true);
  for (const field of filler) expect(F.answerFor(field, { identity: {}, documents: {} })).not.toEqual({ check: true });
  dom.window.close();
});
it('rejects a hidden questionnaire in another form even when its key matches', () => {
  const { dom, F, source, bundle, filler } = allQuestionReaders(`<form>${mirrorQuestion}</form><form>${mirrorChoice}${mirrorMarketing}</form>`);
  for (const fields of [source, bundle, filler]) expect(fields.every((field: any) => !/privacy/i.test(field.label))).toBe(true);
  expect(F.answerFor(filler[0], { identity: {}, documents: {} })).not.toEqual({ check: true });
  dom.window.close();
});
it.each([
  mirrorQuestion.replaceAll('722664', '9') + mirrorChoice,
  mirrorQuestion + mirrorChoice.replace('name="resumator-checkbox-722664-1"', 'name="other"'),
  mirrorQuestion + mirrorChoice.replace('>I agree</label>', '>I do not agree</label>'),
  mirrorQuestion + '<input type="checkbox" id="preference" name="preference" required>',
  mirrorQuestion + mirrorQuestion + mirrorChoice,
])('preserves an unassociated hidden prompt as a distinct owner even without another visible question: %s', markup => {
  const { dom, F, source, bundle, filler } = allQuestionReaders(`<form><div class="form-group">${markup}</div></form>`);
  for (const fields of [source, bundle, filler]) expect(fields.every((field: any) => !/privacy/i.test(field.label))).toBe(true);
  for (const field of filler) expect(F.answerFor(field, { identity: {}, documents: {} })).not.toEqual({ check: true });
  dom.window.close();
});
it('reads a pure unnamed ARIA option list as one logical question in all three runtimes', () => {
  const { dom, F, source, bundle, filler } = allQuestionReaders(`<form><h2>Hai la patente?</h2>${radioCards()}<button type="button">Continue</button></form>`);
  for (const fields of [source, bundle, filler]) {
    expect(fields).toHaveLength(1);
    expect(fields[0].label).toBe('Hai la patente?');
    expect(fields[0].options).toHaveLength(2);
  }
  expect(F.answerFor(filler[0], { identity: {}, documents: {}, answers: [] })).toBeNull();
  expect([...dom.window.document.querySelectorAll('[role="radio"]')].every(node => node.getAttribute('aria-checked') === 'false')).toBe(true);
  dom.window.close();
});
it.each([
  '<input id="other">',
  '<input id="other" type="checkbox">',
  '<button type="button" aria-haspopup="listbox">Please select</button>',
  '<div ui5-date-picker></div>',
  `<h2>Another question?</h2>${radioCards(['Other yes', 'Other no'])}`,
])('keeps an unnamed radio list and a sibling question distinct: %s', sibling => {
  const { dom, F, source, bundle, filler } = allQuestionReaders(`<form><h2>I accept the Privacy Policy. *</h2>${radioCards()}${sibling}</form>`);
  for (const fields of [source, bundle, filler]) expect(fields.every((field: any) => !/privacy/i.test(field.label))).toBe(true);
  for (const field of filler) expect(F.answerFor(field, { identity: {}, documents: {} })).not.toEqual({ check: true });
  dom.window.close();
});
it('does not merge ARIA choices across distinct semantic groups', () => {
  const { dom, source, bundle, filler } = allQuestionReaders(`<form><h2>I accept the Privacy Policy. *</h2><div class="field"><div role="radio">Yes</div></div><div class="field"><div role="radio">No</div></div></form>`);
  for (const fields of [source, bundle, filler]) {
    expect(fields).toHaveLength(2);
    expect(fields.every((field: any) => !/privacy/i.test(field.label))).toBe(true);
  }
  dom.window.close();
});
it('does not merge unnamed ARIA options across question headings in the same wrapper', () => {
  const { dom, source, bundle, filler } = allQuestionReaders('<form><div><h2>First question?</h2><div role="radio">Yes</div><h2>Second question?</h2><div role="radio">No</div></div></form>');
  for (const fields of [source, bundle, filler]) {
    expect(fields).toHaveLength(2);
    expect(fields.every((field: any) => !/question/i.test(field.label))).toBe(true);
  }
  dom.window.close();
});
it.each([
  '<div aria-label="Newsletter"><div role="radio">Yes</div></div><div aria-label="Privacy acceptance"><div role="radio">No</div></div>',
  '<span id="news">Newsletter</span><span id="privacy">Privacy acceptance</span><div aria-labelledby="news"><div role="radio">Yes</div></div><div aria-labelledby="privacy"><div role="radio">No</div></div>',
])('does not merge ARIA options owned by separately named ancestors: %s', options => {
  const { dom, F, source, bundle, filler } = allQuestionReaders(`<form><h2>I accept the Privacy Policy. *</h2><div>${options}</div></form>`);
  for (const fields of [source, bundle, filler]) {
    expect(fields).toHaveLength(2);
    expect(fields.every((field: any) => !/privacy/i.test(field.label))).toBe(true);
  }
  for (const field of filler) expect(F.answerFor(field, { identity: {}, documents: {}, answers: [] })).toBeNull();
  dom.window.close();
});
it.each(['form', 'div role="form"'])('never groups unnamed radio options across separate %s owners under a shared named section', tag => {
  const close = tag.split(' ')[0];
  const { dom, source, bundle, filler } = allQuestionReaders(`<section aria-label="I accept the Privacy Policy. *"><${tag}><div role="radio">Yes</div></${close}><${tag}><div role="radio">No</div></${close}></section>`);
  for (const fields of [source, bundle, filler]) {
    expect(fields).toHaveLength(2);
    expect(fields.every((field: any) => !/privacy/i.test(field.label))).toBe(true);
  }
  dom.window.close();
});

it('reads the owned consent legend past an empty label and resolves it without a candidate question', () => {
  const { dom, snapshot } = extract(form);
  const field = snapshot.fields.find((item: any) => item.kind === 'checkbox');
  expect(field.label).toBe('I have read and accept the Privacy Policy. *');
  const plan = guardPlan({ actions: [{ fieldId: field.id, action: 'check', source: 'consent' }], missingRequired: [] }, [field], { identity: {}, profile: {}, answers: {} });
  expect(plan.actions).toContainEqual(expect.objectContaining({ fieldId: field.id, action: 'check', source: 'consent' }));
  expect(plan.missingRequired).toEqual([]);
  for (const file of ['apply-control.js', 'filler.js']) dom.window.eval(readFileSync(new URL(`../scripts/assisted-application/extension/${file}`, import.meta.url), 'utf8'));
  const extension = (dom.window as any).CompilaCandidatura;
  expect(extension.answerFor(extension.collect(dom.window.document)[0], { identity: {}, documents: {} })).toEqual({ check: true });
  dom.window.close();
});

it('keeps an optional marketing notice distinct from the required application consent', () => {
  const { dom, snapshot } = extract(form.replace('Privacy Policy.', 'Privacy Policy and marketing newsletter.'));
  const field = snapshot.fields.find((item: any) => item.kind === 'checkbox');
  expect(guardPlan({ actions: [{ fieldId: field.id, action: 'check', source: 'consent' }], missingRequired: [] }, [field]).actions).not.toContainEqual(expect.objectContaining({ action: 'check' }));
  dom.window.close();
});

it.each([
  '<span class="label"></span><span class="question">Work permit?</span><input id="x">',
  '<div class="question">Unrelated container text<input id="x"></div><span class="question">Work permit?</span>',
])('reads the first nonempty group label that does not contain the control in both runners: %s', markup => {
  const { dom, snapshot } = extract(`<form><fieldset>${markup}</fieldset></form>`);
  expect(snapshot.fields[0].label).toBe('Work permit?');
  (dom.window as any).CSS = { escape: (value: string) => value };
  dom.window.eval(readFileSync(new URL('../scripts/assisted-application/extension/runner-fields.js', import.meta.url), 'utf8'));
  expect((dom.window as any).CompilaRunnerFields().fields[0].label).toBe('Work permit?');
  dom.window.close();
});

it.each(['text', 'radio'])('preserves the readable question and its required marker past an empty label for %s fields', type => {
  const { dom, snapshot } = extract(`<form><fieldset><label></label><legend>Work permit?</legend><span>*</span><input type="${type}" name="permit" id="x"></fieldset></form>`);
  expect(snapshot.fields[0]).toMatchObject({ label: 'Work permit?', required: true });
  (dom.window as any).CSS = { escape: (value: string) => value };
  for (const file of ['runner-fields.js', 'apply-control.js', 'filler.js']) dom.window.eval(readFileSync(new URL(`../scripts/assisted-application/extension/${file}`, import.meta.url), 'utf8'));
  expect((dom.window as any).CompilaRunnerFields().fields[0]).toMatchObject({ label: 'Work permit?', required: true });
  expect((dom.window as any).CompilaCandidatura.collect(dom.window.document)[0]).toMatchObject({ label: 'Work permit?', required: true });
  dom.window.close();
});

it.each([
  '<label for="y">I accept the Privacy Policy. *</label><input id="y" type="checkbox" required>',
  '<label>I accept the Privacy Policy. *<input id="y" type="checkbox" required></label>',
  '<label for="y"><span class="label">I accept the Privacy Policy. *</span></label><input id="y" type="checkbox" required>',
  '<label><span class="question">I accept the Privacy Policy. *</span><input id="y" type="checkbox" required></label>',
  '<div class="field"><span class="label">I accept the Privacy Policy. *</span><input id="y" type="checkbox" required></div>',
  '<div class="label"><label for="y">I accept the Privacy Policy. *</label></div><input id="y" type="checkbox" required>',
  '<div class="question"><label for="y">I accept the Privacy Policy. *</label></div><input id="y" type="checkbox" required>',
])('never gives an unlabeled checkbox another control\'s consent: %s', neighbor => {
  const { dom, snapshot } = extract(`<form><fieldset><label for="x"></label><input id="x" name="newsletter" type="checkbox" required>${neighbor}</fieldset></form>`);
  expect(snapshot.fields[0].label).not.toMatch(/privacy/i);
  expect(snapshot.fields[1].label).toBe('I accept the Privacy Policy. *');
  const plan = guardPlan({ actions: [{ fieldId: snapshot.fields[0].id, action: 'check', source: 'consent' }], missingRequired: [] }, snapshot.fields);
  expect(plan.actions).not.toContainEqual(expect.objectContaining({ fieldId: snapshot.fields[0].id, action: 'check' }));
  (dom.window as any).CSS = { escape: (value: string) => value };
  for (const file of ['runner-fields.js', 'apply-control.js', 'filler.js']) dom.window.eval(readFileSync(new URL(`../scripts/assisted-application/extension/${file}`, import.meta.url), 'utf8'));
  expect((dom.window as any).CompilaRunnerFields().fields[0].label).not.toMatch(/privacy/i);
  const entries = (dom.window as any).CompilaCandidatura.collect(dom.window.document);
  expect(entries[0].label).not.toMatch(/privacy/i);
  expect((dom.window as any).CompilaCandidatura.answerFor(entries[0], { identity: {}, documents: {} })).not.toEqual({ check: true });
  expect(entries[1].label).toBe('I accept the Privacy Policy. *');
  dom.window.close();
});

it('does not name a radio group after any individual option', () => {
  const { dom, snapshot } = extract('<form><fieldset><div class="label"><label class="label" for="x"><span class="question">Yes</span></label></div><input id="x" name="permit" type="radio"><label><span class="question">No</span><input id="y" name="permit" type="radio"></label><legend>Work permit?</legend></fieldset></form>');
  expect(snapshot.fields[0].label).toBe('Work permit?');
  (dom.window as any).CSS = { escape: (value: string) => value };
  for (const file of ['runner-fields.js', 'apply-control.js', 'filler.js']) dom.window.eval(readFileSync(new URL(`../scripts/assisted-application/extension/${file}`, import.meta.url), 'utf8'));
  expect((dom.window as any).CompilaRunnerFields().fields[0].label).toBe('Work permit?');
  expect((dom.window as any).CompilaCandidatura.collect(dom.window.document)[0].label).toBe('Work permit?');
  dom.window.close();
});

it.each([
  ['<span class="label">I accept the Privacy Policy. *</span>', ''],
  ['<legend>I accept the Privacy Policy. *</legend>', ''],
  ['<span class="label">I accept the Privacy Policy. *</span>', 'aria-label="[Default] Preference"'],
  ['<legend>I accept the Privacy Policy. *</legend>', 'aria-label="[Default] Preference"'],
].flatMap(([heading, aria]) => ['fieldset', 'div'].map(wrapper => [heading, aria, wrapper])))('keeps a shared heading ambiguous across distinct checkbox questions: %s %s %s', (heading, aria, wrapper) => {
  const { dom, snapshot } = extract(`<form><${wrapper}>${heading}<input id="x" name="preference" ${aria} type="checkbox" required><input id="y" name="updates" type="checkbox" required></${wrapper}></form>`);
  expect(snapshot.fields[0].label).not.toMatch(/privacy/i);
  (dom.window as any).CSS = { escape: (value: string) => value };
  for (const file of ['runner-fields.js', 'apply-control.js', 'filler.js']) dom.window.eval(readFileSync(new URL(`../scripts/assisted-application/extension/${file}`, import.meta.url), 'utf8'));
  expect((dom.window as any).CompilaRunnerFields().fields[0].label).not.toMatch(/privacy/i);
  const entry = (dom.window as any).CompilaCandidatura.collect(dom.window.document)[0];
  expect(entry.label).not.toMatch(/privacy/i);
  expect((dom.window as any).CompilaCandidatura.answerFor(entry, { identity: {}, documents: {} })).not.toEqual({ check: true });
  dom.window.close();
});

it.each(['', 'submit', 'button', 'reset', 'image'].flatMap(type => ['fieldset', 'div'].map(wrapper => [type, wrapper])))('keeps one question readable past bookkeeping and action inputs: %s %s', (type, wrapper) => {
  const label = 'I accept the Privacy Policy. *';
  const { dom, snapshot } = extract(`<form><${wrapper}><h3>${label}</h3><input id="input-1" type="checkbox" required><input type="hidden" name="unselected" value="0">${type ? `<input type="${type.toUpperCase()}" value="Continue">` : ''}</${wrapper}></form>`);
  expect(snapshot.fields[0].label).toBe(label);
  (dom.window as any).CSS = { escape: (value: string) => value };
  for (const file of ['runner-fields.js', 'apply-control.js', 'filler.js']) dom.window.eval(readFileSync(new URL(`../scripts/assisted-application/extension/${file}`, import.meta.url), 'utf8'));
  expect((dom.window as any).CompilaRunnerFields().fields[0].label).toBe(label);
  const entry = (dom.window as any).CompilaCandidatura.collect(dom.window.document)[0];
  expect(entry.label).toBe(label);
  expect((dom.window as any).CompilaCandidatura.answerFor(entry, { identity: {}, documents: {} })).toEqual({ check: true });
  dom.window.close();
});

it.each([
  ['Country', '<button type="button" aria-haspopup="listbox">Please select</button>'],
  ['Country', '<div role="button" aria-haspopup="listbox">Please select</div>'],
  ['Country', '<div role="radiogroup"><div role="radio">Italy</div><div role="radio">Switzerland</div></div>'],
  ['Birth date', '<div ui5-date-picker required></div>'],
  ['Birth date', '<div data-scope="date-picker" data-part="root"><input role="combobox"><input role="combobox"></div>'],
  ['Country', '<select id="country" style="display:none"><option value="">---</option><option value="IT">Italy</option></select><span id="country-button" class="ui-selectmenu-button" role="combobox" aria-owns="country-menu"></span>'],
])('keeps a supported virtual widget as one question: %s %s', (label, control) => {
  const { dom, snapshot } = extract(`<form><div class="field"><h3>${label}</h3>${control}<input type="submit" value="Continue"></div></form>`);
  expect(snapshot.fields[0].label).toBe(label);
  (dom.window as any).CSS = { escape: (value: string) => value };
  for (const file of ['runner-fields.js', 'apply-control.js', 'filler.js']) dom.window.eval(readFileSync(new URL(`../scripts/assisted-application/extension/${file}`, import.meta.url), 'utf8'));
  expect((dom.window as any).CompilaRunnerFields().fields[0].label).toBe(label);
  expect((dom.window as any).CompilaCandidatura.collect(dom.window.document)[0].label).toBe(label);
  dom.window.close();
});

it.each([
  '<button type="button" aria-haspopup="listbox">Please select</button>',
  '<div role="button" aria-haspopup="listbox">Please select</div>',
  '<div ui5-date-picker></div>',
  '<div data-scope="date-picker" data-part="root"><input role="combobox"><input role="combobox"></div>',
  '<div role="radiogroup"><div role="radio">Yes</div><div role="radio">No</div></div>',
])('does not borrow a shared consent heading when another question is a virtual widget: %s', control => {
  const { dom, snapshot } = extract(`<form><div class="field"><h3>I accept the Privacy Policy. *</h3><input id="x" name="preference" type="checkbox" required>${control}</div></form>`);
  expect(snapshot.fields.find((field: any) => field.kind === 'checkbox').label).not.toMatch(/privacy/i);
  expect(snapshot.fields.every((field: any) => !/privacy/i.test(field.label))).toBe(true);
  (dom.window as any).CSS = { escape: (value: string) => value };
  for (const file of ['runner-fields.js', 'apply-control.js', 'filler.js']) dom.window.eval(readFileSync(new URL(`../scripts/assisted-application/extension/${file}`, import.meta.url), 'utf8'));
  expect((dom.window as any).CompilaRunnerFields().fields.find((field: any) => field.kind === 'checkbox').label).not.toMatch(/privacy/i);
  const entry = (dom.window as any).CompilaCandidatura.collect(dom.window.document).find((field: any) => field.kind === 'checkbox');
  expect(entry.label).not.toMatch(/privacy/i);
  expect((dom.window as any).CompilaCandidatura.answerFor(entry, { identity: {}, documents: {} })).not.toEqual({ check: true });
  dom.window.close();
});

it.each([
  '<h3>I accept the Privacy Policy. *</h3><div class="field"><input id="x" name="preference" type="checkbox" required></div><div class="field"><input id="y" name="updates" type="checkbox" required></div>',
  '<div class="field"><label for="y">I accept the Privacy Policy. *</label><input id="x" name="preference" type="checkbox" required></div><input id="y" type="checkbox" required>',
])('does not let unstructured context escape the question owner: %s', markup => {
  const { dom, snapshot } = extract(`<form>${markup}</form>`);
  expect(snapshot.fields.find((field: any) => field.name === 'preference').label).not.toMatch(/privacy/i);
  (dom.window as any).CSS = { escape: (value: string) => value };
  for (const file of ['runner-fields.js', 'apply-control.js', 'filler.js']) dom.window.eval(readFileSync(new URL(`../scripts/assisted-application/extension/${file}`, import.meta.url), 'utf8'));
  expect((dom.window as any).CompilaRunnerFields().fields.find((field: any) => field.name === 'preference').label).not.toMatch(/privacy/i);
  const entry = (dom.window as any).CompilaCandidatura.collect(dom.window.document).find((field: any) => field.element.id === 'x');
  expect(entry.label).not.toMatch(/privacy/i);
  expect((dom.window as any).CompilaCandidatura.answerFor(entry, { identity: {}, documents: {} })).not.toEqual({ check: true });
  dom.window.close();
});

it.each(['h3', 'div role="heading"'].flatMap(heading => ['fieldset', 'div class="field"'].map(wrapper => [heading, wrapper])))('keeps a radio heading owned by its field when a different question shares the form: %s %s', (heading, wrapper) => {
  const { dom, snapshot } = extract(`<form><${wrapper}><${heading}>Work permit?</${heading.split(' ')[0]}><label for="yes">Yes</label><input id="yes" name="permit" type="radio" required><label for="no">No</label><input id="no" name="permit" type="radio"></${wrapper.split(' ')[0]}><div class="field"><label for="email">Email</label><input id="email" type="email"></div></form>`);
  expect(snapshot.fields.find((field: any) => field.kind === 'radio').label).toBe('Work permit?');
  (dom.window as any).CSS = { escape: (value: string) => value };
  for (const file of ['runner-fields.js', 'apply-control.js', 'filler.js']) dom.window.eval(readFileSync(new URL(`../scripts/assisted-application/extension/${file}`, import.meta.url), 'utf8'));
  expect((dom.window as any).CompilaRunnerFields().fields.find((field: any) => field.kind === 'radio').label).toBe('Work permit?');
  expect((dom.window as any).CompilaCandidatura.collect(dom.window.document).find((field: any) => field.kind === 'radio').label).toBe('Work permit?');
  dom.window.close();
});

it('routes unreadable source labels to a technical hold instead of manufacturing a required question', () => {
  const result = portalRequirementsFromMissingRequired([{ id: 'f1', kind: 'checkbox', label: '', required: true }], [{ fieldId: 'f1', question: '' }]);
  expect(result.questions).toEqual([]);
  expect(result.unreadableFields).toEqual(['f1']);
  expect(portalRequirementsFromMissingRequired([{ id: 'f1', kind: 'text', label: '', required: true }],
    [{ fieldId: 'f1', question: 'A plausible but invented question?' }])).toMatchObject({ questions: [], unreadableFields: ['f1'] });
});

it('does not create a candidate request when the real reduction contains no questions or documents', async () => {
  const requirements = portalRequirementsFromMissingRequired([{ id: 'cv', kind: 'file', label: 'Resume / CV', required: true }], [{ fieldId: 'cv', type: 'text', question: 'Upload your CV' }]);
  expect(requirements).toMatchObject({ questions: [], documents: [] });
  const codex = vi.fn();
  expect(await portalRequirementsForCandidate(requirements, { candidateLocale: 'it', applicationLocale: 'en', codex })).toBeNull();
  expect(codex).not.toHaveBeenCalled();
});

it.each([false, true])('preserves a real document request and hard question without manufacturing answers: %s', async withQuestion => {
  const question = { id: 'permit', source: 'portal', type: 'choice', question: 'Do you hold a Swiss work permit?', applicationQuestion: 'Do you hold a Swiss work permit?', options: ['Yes', 'No'], required: true };
  const requirements = { questions: withQuestion ? [question] : [], documents: [{ id: 'diploma', label: 'Diploma', required: true }] };
  const codex = vi.fn();
  const request = await portalRequirementsForCandidate(requirements, { candidateLocale: 'en', applicationLocale: 'en', codex });
  expect(request).toEqual(requirements);
  expect(request).not.toHaveProperty('answers');
  expect(codex).not.toHaveBeenCalled();
});

it('never treats an unreadable required field as an empty resolved reduction', async () => {
  await expect(portalRequirementsForCandidate({ questions: [], documents: [], unreadableFields: ['unknown'] })).rejects.toThrow('portal_question_unreadable');
});

it.each([
  ['required', '<option value="">Choose</option><option value="yes">Yes</option>', true],
  ['aria-required="true"', '<option value="">No preference</option><option value="yes">Yes</option>', false],
  ['required multiple', '<option value="">No preference</option><option value="yes">Yes</option>', false],
  ['required size="2"', '<option value="">No preference</option><option value="yes">Yes</option>', false],
  ['required', '<optgroup label="Answers"><option value="">No preference</option></optgroup><option value="yes">Yes</option>', false],
  ['required', '<option value="yes">Yes</option><option value="">No preference</option>', false],
  ['required', '<option disabled value="">Choose</option><option value="">No preference</option>', false],
])('marks only the native placeholder label option: %s %s', (attributes, options, placeholder) => {
  const { dom, snapshot } = extract(`<form><label for="choice">Choice</label><select id="choice" ${attributes}>${options}</select></form>`);
  expect(Boolean(snapshot.fields[0].options.find((option: any) => option.placeholder))).toBe(placeholder);
  (dom.window as any).CSS = { escape: (value: string) => value };
  dom.window.eval(readFileSync(new URL('../scripts/assisted-application/extension/runner-fields.js', import.meta.url), 'utf8'));
  expect(Boolean((dom.window as any).CompilaRunnerFields().fields[0].options.find((option: any) => option.placeholder))).toBe(placeholder);
  dom.window.close();
});

it('hands off an unreadable required field during the real pre-read before translating other questions', async () => {
  const url = 'https://jobs.lever.co/example/1/apply';
  const snapshot = {
    url, buttons: [], captcha: false, passwordVisible: false, errors: [], text: '',
    fields: [
      { id: 'cv', kind: 'file', label: 'CV', required: true },
      { id: 'x', kind: 'text', label: '', required: true },
      { id: 'other', kind: 'text', label: 'What is your current employer?', required: true },
    ],
  };
  const frame = { evaluate: vi.fn(async () => snapshot) };
  const page = { frames: () => [frame], url: () => url, goto: vi.fn(async () => {}),
    evaluate: vi.fn(async () => false), waitForLoadState: vi.fn(async () => {}) };
  const browser = { newContext: vi.fn(async () => ({ newPage: async () => page })), close: vi.fn(async () => {}) };
  const codex = vi.fn(async () => ({ actions: [], missingRequired: [{ fieldId: 'x' }, { fieldId: 'other', question: 'What is your current employer?' }] }));
  const ctx = { channelType: 'lever', applyUrl: url, language: 'en', candidateLocale: 'it',
    candidate: { identity: {}, profile: {}, answers: {} }, codex, launch: async () => browser };
  const result = await readPortalRequirements(ctx);
  expect(result).toMatchObject({ handoff: 'question_label_unreadable', unreadableFields: ['x'], questions: [] });
  expect(codex).toHaveBeenCalledTimes(1); // Planner only; no localization of an incomplete form.
  expect(frame.evaluate).toHaveBeenCalled();
  expect(browser.close).toHaveBeenCalledOnce();
  expect(await readPortalQuestions(ctx)).toEqual([]); // The legacy question-only caller stays safe.
});

it('uses the actual source question if localization returns only a generic placeholder', async () => {
  const result = await localizePortalQuestions([{ id: 'q', question: 'Your current employer?', applicationQuestion: 'Your current employer?', options: [] }], {
    candidateLocale: 'it', applicationLocale: 'en', codex: async () => ({ questions: [{ id: 'q', question: PORTAL_QUESTION_PLACEHOLDERS.it, why: '', options: [], optionMap: [], validationMessage: '' }] }),
  });
  expect(result[0].question).toBe('Your current employer?');
});

const placeholder = { id: 'unreadable', source: 'portal', question: PORTAL_QUESTION_PLACEHOLDERS.it, applicationQuestion: '', required: true, type: 'text' };
const hard = { id: 'experience', source: 'match', question: 'Describe your international shipping experience', required: true, type: 'text' };
const draft = { status: 'ready', round: 1, job: { source: 'job_detail' }, channel: { type: 'portal' }, questions: [placeholder] };
const approved = { state: 'needs_candidate_action', round: 1, heldBy: ['question:unreadable'], dispatch: { mode: 'submit', round: 1, attempts: 1 } };

describe('legacy unreadable portal waits', () => {
  it.each(Object.values(PORTAL_QUESTION_PLACEHOLDERS))('rejects decorative placeholder variants: %s', question => {
    expect(questionsForCandidate([{ ...placeholder, question: `• ${question.toUpperCase()} *` }], {})).toEqual([]);
  });
  it('requeues a paid legacy wait once through the deployment reconciler without changing answers or approval', async () => {
    const base = 'assisted_applications/unreadable_test';
    const store = createMemoryFirestore({
      [base]: { paymentStatus: 'paid', automationState: 'needs_candidate_action' },
      [`${base}/automation/flow`]: approved,
      [`${base}/ai_drafts/current`]: draft,
    });
    const context = { db: store.db, apply: true, nowMs: 2000 };
    expect(await reconcileOperationalAnswers(context)).toMatchObject({ eligible: 1, queued: 1 });
    expect(store.read(base).automationDueAt).toBe(2000);
    expect(store.read(`${base}/automation/flow`)).toEqual(approved);
    expect(await reconcileOperationalAnswers(context)).toMatchObject({ eligible: 0, alreadyQueued: 1 });
  });
  it('does not expose placeholders or record a fictional answer, and resumes only the approved submission on its normal tick', () => {
    expect(questionsForCandidate([placeholder], {})).toEqual([]);
    const result = transition(approved, { type: 'tick' }, { draft });
    expect(result.flow.state).toBe('submitting');
    expect(result.effects).toContainEqual({ type: 'dispatch', mode: 'submit', reason: 'resolved_candidate_answers' });
    expect(result.flow.answers || {}).toEqual({});
  });
  it('keeps real unanswered hard facts as candidate holds', () => {
    expect(questionsForCandidate([placeholder, hard], {})).toEqual([hard]);
    const result = transition({ ...approved, heldBy: ['question:unreadable', 'question:experience'] }, { type: 'tick' }, { draft: { ...draft, questions: [placeholder, hard] } });
    expect(result.flow.state).toBe('needs_candidate_action');
    expect(result.effects).not.toContainEqual(expect.objectContaining({ type: 'dispatch' }));
  });
  it('never turns an unapproved candidate review into a submission', () => {
    const result = transition({ ...approved, state: 'candidate_review', dispatch: undefined }, { type: 'tick' }, { draft });
    expect(result.flow.state).toBe('candidate_review');
    expect(result.effects).not.toContainEqual(expect.objectContaining({ type: 'dispatch' }));
  });
  it('repairs a stored generic translation when its original question is available', () => {
    expect(questionsForCandidate([{ ...placeholder, applicationQuestion: 'What is your notice period?' }], {})[0].question).toBe('What is your notice period?');
  });
});
