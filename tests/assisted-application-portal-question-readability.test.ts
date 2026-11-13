import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { extractFieldsInPage } from '../scripts/assisted-application/lib/portal/fields.mjs';
import { guardPlan } from '../scripts/assisted-application/lib/portal/plan.mjs';
import { applicationEntryControls, formPostingMatch, hasReadOnlyVacancyEvidence, hasVacancySpecificPostingEvidence, localizePortalQuestions, namesAnotherEmployer, portalReadAheadCapability, portalQuestionReductionHandoff, portalRequirementsForCandidate, portalReaderErrorClass, portalRequirementsFromMissingRequired, readPortalRequirements, readPortalQuestions } from '../scripts/assisted-application/lib/portal/portal.mjs';
import { PORTAL_QUESTION_PLACEHOLDERS } from '../functions/src/lib/portalQuestionText.js';
import { questionsForCandidate } from '../functions/src/assistedApplicationCandidateEdits.js';
import { transition } from '../functions/src/assistedApplicationFlow.js';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { reconcileOperationalAnswers } from '../scripts/assisted-application/reconcile-operational-answers.mjs';
import { permitOptions, permitStatusQuestion, permitStatusQuestionWhy } from '../functions/src/lib/permitStatus.js';

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
  const css = { escape: (value: string) => value };
  vi.stubGlobal('CSS', css);
  (dom.window as any).CSS = css;
  return { dom, snapshot: extractFieldsInPage() };
}
afterEach(() => vi.unstubAllGlobals());

it('keeps collapsed future fields out of read-ahead in the portal and extension readers', () => {
  const { dom } = extract(`<form>
    <label for="active-cv">Current CV *</label><input id="active-cv" type="file" required>
    <section style="visibility:collapse"><label for="collapsed-cv">Later CV *</label><input id="collapsed-cv" type="file" required></section>
  </form>`);
  const readAheadLabels = extractFieldsInPage({ includeHidden: true }).fields.map((field: any) => field.label);
  expect(readAheadLabels).toEqual(['Current CV *']);
  dom.window.eval(readFileSync(new URL('../scripts/assisted-application/extension/runner-fields.js', import.meta.url), 'utf8'));
  const extensionReadAheadLabels = (dom.window as any).CompilaRunnerFields({ includeHidden: true }).fields.map((field: any) => field.label);
  expect(extensionReadAheadLabels).toEqual(['Current CV *']);
  dom.window.close();
});

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
  ['aria-describedby', 'What is your preferred work schedule?', '<span id="question-copy">What is your preferred work schedule?</span>'],
  ['aria-description', 'Qual è la tua disponibilità oraria?', ''],
  ['aria-details', 'Welche Region ist dein Herkunftskanton?', '<div id="question-copy">Welche Region ist dein Herkunftskanton?</div>'],
])('uses the exact accessible question text for %s in every field reader', (attribute, question, description) => {
  const value = attribute === 'aria-description' ? `${attribute}="${question}"` : `${attribute}="question-copy"`;
  const { dom, source, bundle, filler } = allQuestionReaders(`<form>${description}<input id="q" name="q" required ${value}></form>`);
  for (const fields of [source, bundle, filler]) expect(fields[0]).toMatchObject({ label: question, required: true });
  const reduced = portalRequirementsFromMissingRequired(source, [{
    fieldId: source[0].id, question: PORTAL_QUESTION_PLACEHOLDERS.it, type: 'text', required: true,
  }]);
  expect(reduced).toMatchObject({ questions: [expect.objectContaining({ question, applicationQuestion: question })] });
  dom.window.close();
});

it('keeps an unresolved accessible question unknown instead of falling back to a nearby title or generated name', () => {
  const { dom, source, bundle, filler } = allQuestionReaders('<form><h2>Unrelated application section</h2><input id="q" name="q" required aria-describedby="missing-question"></form>');
  for (const fields of [source, bundle, filler]) expect(fields[0]).toMatchObject({ label: '', required: true });
  const result = portalRequirementsFromMissingRequired(source, [{
    fieldId: source[0].id, question: PORTAL_QUESTION_PLACEHOLDERS.it, type: 'text', required: true,
  }]);
  expect(result).toMatchObject({ questions: [], unreadableFields: [source[0].id] });
  dom.window.close();
});

it('keeps accessible questions bound to their own conditional field', () => {
  const { dom, snapshot } = extract('<form><span id="q1-copy">What is your current employer?</span><input id="q1" required aria-describedby="q1-copy">'
    + '<span id="q2-copy">Welche Region ist dein Herkunftskanton?</span><input id="q2" required aria-describedby="q2-copy"></form>');
  const source = snapshot.fields;
  const result = portalRequirementsFromMissingRequired(source, [{
    fieldId: source.find((field: any) => field.domId === 'q2').id,
    question: PORTAL_QUESTION_PLACEHOLDERS.it, type: 'text', required: true,
  }]);
  expect(result.questions).toMatchObject([expect.objectContaining({ applicationQuestion: 'Welche Region ist dein Herkunftskanton?' })]);
  dom.window.close();
});

it('prefers readable ATS evidence over a generated question label', () => {
  const result = portalRequirementsFromMissingRequired([
    { id: 'f', label: 'Do you have a Swiss work permit?', required: true, kind: 'text' },
  ], [{
    id: 'f', question: 'input-7', applicationQuestion: 'Do you have a Swiss work permit?', type: 'text', required: true,
  }]);
  expect(result.questions).toMatchObject([{
    question: 'Do you have a Swiss work permit?',
    applicationQuestion: 'Do you have a Swiss work permit?',
  }]);
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

it('asks for a separately required house number when the residence street has no number', () => {
  const result = portalRequirementsFromMissingRequired([
    { id: 'street', kind: 'text', label: 'Via', required: true },
    { id: 'house-number', kind: 'text', label: 'Numero civico', required: true },
  ], [], { candidate: { identity: { address: { street: 'Via Roma' } }, profile: { address: { street: 'Via Roma' } }, answers: {} } });

  expect(result.questions.map((question: any) => question.id)).toContain('portal_residence_house_number');
});

it('turns a required Umantis residence-status choice into the candidate permit question', async () => {
  const applicationOptions = permitOptions('it');
  const result = portalRequirementsFromMissingRequired([
    { id: 'residence-status', kind: 'radio', label: 'Statuto di soggiorno', required: true, options: applicationOptions },
  ], [], { candidate: { identity: {}, profile: {}, answers: {} }, candidateLocale: 'it' });

  expect(result.unreadableFields).toBeUndefined();
  expect(result.questions).toEqual([expect.objectContaining({
    id: 'work_permit',
    question: permitStatusQuestion('it'),
    candidatePrompt: permitStatusQuestion('it'),
    applicationQuestion: 'Statuto di soggiorno',
    type: 'choice',
    options: applicationOptions,
    required: true,
  })]);

  const [localized] = await localizePortalQuestions(result.questions, { candidateLocale: 'it', applicationLocale: 'it' });
  expect(localized).toMatchObject({
    id: 'work_permit',
    question: permitStatusQuestion('it'),
    applicationQuestion: 'Statuto di soggiorno',
  });
});

it('asks for current Swiss status when the CV alone names a permit', () => {
  const field = { id: 'residence-status', kind: 'radio', label: 'Statuto di soggiorno', required: true, options: permitOptions('it') };
  const fromCv = portalRequirementsFromMissingRequired([field], [], {
    candidate: { identity: {}, profile: { workPermit: 'Permesso G' }, answers: {} }, candidateLocale: 'it',
  });
  expect(fromCv.questions).toMatchObject([{
    id: 'work_permit', question: permitStatusQuestion('it'), applicationQuestion: 'Statuto di soggiorno', required: true,
  }]);

  for (const candidate of [
    { identity: {}, profile: { permitStatus: 'permit_b' }, answers: {} },
    { identity: {}, profile: {}, answers: {}, swissStatus: { code: 'permit_c' } },
  ]) {
    const result = portalRequirementsFromMissingRequired([field], [], { candidate, candidateLocale: 'it' });
    expect(result.questions).toEqual([]);
  }
});

it('asks for a missing Swiss status when stored status strings are not recognized and localizes the explanation', async () => {
  const field = { id: 'residence-status', kind: 'radio', label: 'Statuto di soggiorno', required: true, options: permitOptions('it') };
  for (const candidate of [
    { identity: {}, profile: { permitStatus: 'pending' }, answers: {} },
    { identity: {}, profile: {}, answers: {}, swissStatus: { code: 'pending' } },
  ]) {
    const result = portalRequirementsFromMissingRequired([field], [], { candidate, candidateLocale: 'de' });
    expect(result.questions).toEqual([expect.objectContaining({
      id: 'work_permit',
      question: permitStatusQuestion('de'),
      candidatePrompt: permitStatusQuestion('de'),
      why: permitStatusQuestionWhy('de'),
      applicationQuestion: 'Statuto di soggiorno',
      applicationOptions: field.options,
      required: true,
    })]);
    const [localized] = await localizePortalQuestions(result.questions, {
      candidateLocale: 'de', applicationLocale: 'it', codex: vi.fn().mockRejectedValue(new Error('translation unavailable')),
    });
    expect(localized).toMatchObject({ question: permitStatusQuestion('de'), why: permitStatusQuestionWhy('de') });
  }
});

it('asks for a missing residence country and reads it from a partial profile address', () => {
  const country = {
    id: 'residence-country', kind: 'select', label: 'Land/Region des Wohnorts:*', required: true,
    options: [{ value: 'CH', label: 'Schweiz' }, { value: 'IT', label: 'Italien' }],
  };
  const partialIdentity = { identity: { address: { street: 'Via Roma' } }, profile: { address: { country: 'Svizzera' } }, answers: {} };
  expect(portalRequirementsFromMissingRequired([country], [], { candidate: partialIdentity }).questions).toEqual([]);

  const missing = portalRequirementsFromMissingRequired([country], [], {
    candidate: { identity: { address: { street: 'Via Roma' } }, profile: { address: { street: 'Via Roma' } }, answers: {} },
  });
  expect(missing.questions).toEqual([expect.objectContaining({
    id: 'portal_residence_country',
    question: 'In quale Paese risiedi?',
    applicationQuestion: country.label,
    type: 'choice',
    required: true,
    applicationOptions: ['Schweiz', 'Italien'],
  })]);

  const contextualCountry = { ...country, label: 'Country', context: 'Residence address' };
  const contextual = portalRequirementsFromMissingRequired([contextualCountry], [], {
    candidate: { identity: { address: {} }, profile: { address: {} }, answers: {} },
  });
  expect(contextual.questions).toEqual([expect.objectContaining({
    id: 'portal_residence_country',
    applicationQuestion: 'Country',
    question: 'In quale Paese risiedi?',
  })]);

  const genericCountry = { ...country, id: 'generic-country', label: 'Country' };
  expect(portalRequirementsFromMissingRequired([genericCountry], [], {
    candidate: { identity: { address: {} }, profile: { address: {} }, answers: {} },
  }).questions).toEqual([]);
});

it('does not create a candidate request when the real reduction contains no questions or documents', async () => {
  const requirements = portalRequirementsFromMissingRequired([{ id: 'cv', kind: 'file', label: 'Resume / CV', required: true }], [{ fieldId: 'cv', type: 'text', question: 'Upload your CV' }]);
  expect(requirements).toMatchObject({ questions: [], documents: [] });
  const codex = vi.fn();
  expect(await portalRequirementsForCandidate(requirements, { candidateLocale: 'it', applicationLocale: 'en', codex })).toBeNull();
  expect(codex).not.toHaveBeenCalled();
});

it('hands off when a non-core required portal request is reduced to zero', async () => {
  const requirements = portalRequirementsFromMissingRequired([{ id: 'optional', kind: 'text', label: 'Optional field', required: false }], [{ fieldId: 'optional', question: 'Optional field' }]);
  expect(requirements).toMatchObject({ questions: [], documents: [], reduction: { kind: 'empty' } });
  expect(portalQuestionReductionHandoff(requirements)).toEqual({ handoff: 'portal_question_reduction' });
  await expect(portalRequirementsForCandidate(requirements)).resolves.toEqual({ handoff: 'portal_question_reduction' });
});

it.each([false, true])('preserves a real document request and hard question without manufacturing answers: %s', async withQuestion => {
  const question = { id: 'permit', source: 'portal', type: 'choice', question: 'Do you hold a Swiss work permit?', applicationQuestion: 'Do you hold a Swiss work permit?', options: ['Yes', 'No'], required: true };
  const requirements = { questions: withQuestion ? [question] : [], documents: [{ id: 'diploma', label: 'Diploma', required: true }] };
  const codex = vi.fn(async (_request: any) => ({ questions: [{
    id: 'permit', sourceLocale: 'en', question: 'Do you hold a Swiss work permit?', why: '',
    options: ['Yes', 'No'], optionMap: [{ candidate: 'Yes', application: 'Yes' }, { candidate: 'No', application: 'No' }], validationMessage: '',
  }] }));
  const request = await portalRequirementsForCandidate(requirements, { candidateLocale: 'en', applicationLocale: 'en', codex });
  expect(request.documents).toEqual(requirements.documents);
  expect(request.questions).toHaveLength(withQuestion ? 1 : 0);
  if (withQuestion) expect(request.questions[0]).toMatchObject({
    question: 'Do you hold a Swiss work permit?', applicationQuestionLocale: 'en', localizationStatus: 'same_language',
  });
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

it('defers a SuccessFactors account gate to the automatic submit runner', async () => {
  const url = 'https://career5.successfactors.eu/career?company=bundesamtf&career_ns=job_application&career_job_req_id=20604&lang=de_DE';
  const snapshot = {
    url, buttons: [], links: [], captcha: false, passwordVisible: true, errors: [],
    text: 'Bewerbungskonto: Login',
    fields: [
      { id: 'email', kind: 'text', inputType: 'email', label: 'E-Mail-Adresse/login', required: true, formId: 'login-form' },
      { id: 'password', kind: 'text', inputType: 'password', label: 'Passwort', required: true, formId: 'login-form' },
    ],
  };
  const frame = { evaluate: vi.fn(async () => snapshot) };
  const page = {
    frames: () => [frame], url: () => url, goto: vi.fn(async () => {}),
    evaluate: vi.fn(async () => false), waitForLoadState: vi.fn(async () => {}), waitForTimeout: vi.fn(async () => {}),
  };
  const browser = { newContext: vi.fn(async () => ({ newPage: async () => page })), close: vi.fn(async () => {}) };
  const codex = vi.fn(async () => ({ actions: [], missingRequired: [] }));

  const result = await readPortalRequirements({
    channelType: 'successfactors', applyUrl: url, postingUrl: url, language: 'de', candidateLocale: 'it',
    job: { title: 'Application Manager/-in', company: 'Swiss Armed Forces (VTG)' },
    candidate: { identity: {}, profile: {}, answers: {} }, codex, launch: async () => browser,
  });

  expect(result.questions).toEqual([]);
  expect(result.documents).toEqual([]);
  expect(result.handoff).toBeUndefined();
  expect(codex).not.toHaveBeenCalled();
  expect(browser.close).toHaveBeenCalledOnce();
});

it('keeps a verified Umantis form when its accessibility text starts with skip-link chrome', async () => {
  const postingUrl = 'https://recruitingapp-2761.umantis.com/Vacancies/1153/Description/4';
  const applicationUrl = 'https://recruitingapp-2761.umantis.com/Vacancies/1153/Application/New/4';
  const snapshot = {
    url: applicationUrl, buttons: [], captcha: false, passwordVisible: true, errors: [],
    text: 'Passa a Contenuto principale Impiegato/a amministrativo - Candidatura I campi contrassegnati con * sono obbligatori.',
    fields: [{ id: 'cv', kind: 'file', inputType: 'file', label: 'Curriculum', required: true }],
  };
  const frame = { evaluate: vi.fn(async () => snapshot) };
  const page = {
    frames: () => [frame], url: () => applicationUrl,
    title: vi.fn(async () => 'Impiegato/a amministrativo - Candidatura | EOC candiDati'),
    goto: vi.fn(async () => {}), evaluate: vi.fn(async () => false), waitForLoadState: vi.fn(async () => {}),
    waitForTimeout: vi.fn(async () => {}),
  };
  const browser = { newContext: vi.fn(async () => ({ newPage: async () => page })), close: vi.fn(async () => {}) };
  const codex = vi.fn(async () => ({ actions: [], missingRequired: [] }));

  const result = await readPortalRequirements({
    channelType: 'umantis', applyUrl: postingUrl, postingUrl, language: 'it', candidateLocale: 'it',
    job: { title: 'Impiegato a amministrativo', company: 'EOC – Ente Ospedaliero Cantonale' },
    candidate: { identity: {}, profile: {}, answers: {} }, codex, launch: async () => browser,
  });

  expect(result).toMatchObject({ questions: [], documents: [] });
  expect(result.handoff).toBeUndefined();
  expect(codex).toHaveBeenCalledOnce();
  expect(browser.close).toHaveBeenCalledOnce();
});

it('pre-reads a public employer route without a planner and keeps unsafe channels out', async () => {
  const url = 'https://apply.example.test/jobs/42';
  expect(portalReadAheadCapability({ channelType: 'employer_site', entryUrl: url, applyUrl: url }))
    .toEqual({ kind: 'mounted_read_only', source: 'public_application_route' });
  expect(portalReadAheadCapability({ channelType: 'employer_site', entryUrl: 'http://apply.example.test/jobs/42', applyUrl: url }))
    .toBeNull();
  expect(portalReadAheadCapability({ channelType: 'pastahr', entryUrl: 'https://coop.pastahr.com/jobs/42', applyUrl: 'https://coop.pastahr.com/jobs/42' }))
    .toBeNull();

  const snapshot = {
    url, buttons: [], links: [], captcha: false, passwordVisible: false, errors: [], text: 'Application form',
    fields: [{ id: 'cv', kind: 'file', inputType: 'file', label: 'CV', required: true }],
  };
  const frame = { evaluate: vi.fn(async () => snapshot) };
  const page = { frames: () => [frame], url: () => url, goto: vi.fn(async () => {}),
    evaluate: vi.fn(async () => false), waitForLoadState: vi.fn(async () => {}) };
  const context = { newPage: async () => page };
  const browser = { newContext: vi.fn(async () => context), close: vi.fn(async () => {}) };
  const launch = vi.fn(async () => browser);
  const result = await readPortalRequirements({
    channelType: 'employer_site', applyUrl: url, language: 'en', candidateLocale: 'it',
    candidate: { identity: {}, profile: {}, answers: {} },
    resolvePublicHost: vi.fn(async () => true), launch,
  });

  expect(result.handoff).toBe('planner_unavailable');
  expect(result.portalContract).toMatchObject({
    status: 'unavailable',
    form: { observed: true, requiredFieldCount: 1, requiredFileCount: 1 },
    background: { readOnly: true },
  });
  expect(launch).toHaveBeenCalledOnce();
  expect(browser.close).toHaveBeenCalledOnce();
});

it('lets a public employer page through its own request guard (ECAM / Bank Cler, 2026-11-10)', async () => {
  // The guard's DNS check was declared in another block: the call threw, the
  // guard read that as «not public» and aborted the page itself, so goto
  // failed with net::ERR_FAILED on every generic employer site.
  const url = 'https://careers.employer.example/jobs/42';
  const snapshot = {
    url, buttons: [], links: [], captcha: false, passwordVisible: false, errors: [], text: 'Application form',
    fields: [{ id: 'cv', kind: 'file', inputType: 'file', label: 'CV', required: true }],
  };
  const guards: Array<(route: any) => Promise<void>> = [];
  const routed: Record<string, string> = {};
  const dispatch = async (requestUrl: string) => {
    const route = {
      request: () => ({ url: () => requestUrl }),
      fallback: vi.fn(async () => { routed[requestUrl] = 'continued'; }),
      continue: vi.fn(async () => { routed[requestUrl] = 'continued'; }),
      abort: vi.fn(async () => { routed[requestUrl] = 'aborted'; }),
    };
    for (const guard of guards) await guard(route);
    return routed[requestUrl];
  };
  const frame = { evaluate: vi.fn(async () => snapshot) };
  const page = {
    frames: () => [frame], url: () => url,
    goto: vi.fn(async (target: string) => {
      if (await dispatch(target) === 'aborted') throw new Error(`page.goto: net::ERR_FAILED at ${target}`);
    }),
    evaluate: vi.fn(async () => false), waitForLoadState: vi.fn(async () => {}),
  };
  const context = {
    newPage: async () => page,
    route: vi.fn(async (pattern: string, handler: any) => { if (pattern === '**/*') guards.push(handler); }),
  };
  const browser = { newContext: vi.fn(async () => context), close: vi.fn(async () => {}) };
  const resolvePublicHost = vi.fn(async (value: string) => !String(value).includes('internal.employer.example'));
  const result = await readPortalRequirements({
    channelType: 'employer_site', applyUrl: url, language: 'it', candidateLocale: 'it',
    candidate: { identity: {}, profile: {}, answers: {} }, resolvePublicHost, launch: async () => browser,
  });

  expect(guards).toHaveLength(1);
  expect(routed[url]).toBe('continued');
  // Past the page load: the form was observed and only the missing planner stopped the pre-read.
  expect(result.handoff).toBe('planner_unavailable');
  expect(result.portalContract).toMatchObject({ form: { observed: true, requiredFileCount: 1 } });
  // The guard still does its job on a host that does not resolve publicly.
  expect(await dispatch('https://internal.employer.example/api')).toBe('aborted');
});

it('names the class of a failed pre-read without copying the browser message', () => {
  expect(portalReaderErrorClass(new Error('page.goto: net::ERR_FAILED at https://employer.example/x'))).toBe('net_failed');
  expect(portalReaderErrorClass(new Error('page.goto: net::ERR_NAME_NOT_RESOLVED at https://x.example'))).toBe('net_name_not_resolved');
  expect(portalReaderErrorClass(Object.assign(new Error('page.goto: Timeout 60000ms exceeded.'), { name: 'TimeoutError' }))).toBe('timeout');
  expect(portalReaderErrorClass(new Error('page.goto: Download is starting'))).toBe('download');
  expect(portalReaderErrorClass(new ReferenceError('resolvePublicHost is not defined'))).toBe('code_error');
  expect(portalReaderErrorClass(new Error('Target page, context or browser has been closed'))).toBe('browser_closed');
  expect(portalReaderErrorClass(new Error('Maria Rossi <maria@example.com>'))).toBe('other');
  expect(portalReaderErrorClass(null)).toBe('other');
});

it('accepts a generic ATS form only after a matched posting Apply control was followed', () => {
  const genericForm = 'Bewerbung\nVorname *\nE-Mail *\nhttps://ats.example/apply';
  const job = { title: 'Pflegefachperson 80%' };
  expect(formPostingMatch(genericForm, job, { postingMatched: true })).toBe('unknown');
  expect(formPostingMatch(genericForm, job, { postingMatched: true, applicationEntry: true })).toBe('unknown');
  expect(formPostingMatch('Other employer\nBewerbung', { ...job, company: 'Muster AG' }, {
    postingMatched: true, applicationEntry: true,
  })).toBe('mismatch');
});

it('requires vacancy evidence beyond a company match before trusting one external Apply control', () => {
  const job = { company: 'Muster AG', title: 'Application Manager' };
  const listingUrl = 'https://careers.example.ch/jobs';
  const postingUrl = 'https://careers.example.ch/jobs/application-manager-42';

  expect(hasVacancySpecificPostingEvidence('Muster AG Karriere', job, {
    pageUrl: listingUrl, postingUrl,
  })).toBe(false);
  expect(hasVacancySpecificPostingEvidence('Muster AG — Application Manager', job, {
    pageUrl: listingUrl, pageTitle: 'Muster AG Karriere', postingUrl,
  })).toBe(false);
  expect(hasVacancySpecificPostingEvidence('Muster AG Karriere', job, {
    pageUrl: listingUrl, pageTitle: 'Muster AG — Application Manager', postingUrl,
  })).toBe(true);
  // A generic document title must not hide a different role rendered in the
  // exact selected-posting route.
  expect(hasVacancySpecificPostingEvidence('Unrelated Role', {
    company: 'Coop Genossenschaft', title: 'Bäckerin',
  }, {
    pageUrl: 'https://ats.example/job/1',
    postingUrl: 'https://ats.example/job/1',
    pageTitle: 'Career Opportunities | Coop Genossenschaft',
  })).toBe(false);
  expect(hasVacancySpecificPostingEvidence('Muster AG Karriere — Apply', job, {
    pageUrl: listingUrl, pageTitle: 'Application Manager', postingUrl,
    vacancyIdentityContexts: ['Application Manager — Muster AG'],
  })).toBe(true);
  const relatedVacancyJob = { company: 'Acme', title: 'Data Engineer' };
  expect(hasVacancySpecificPostingEvidence('Related vacancies: Data Engineer — Acme', relatedVacancyJob, {
    pageUrl: 'https://careers.example.ch/careers',
    pageTitle: 'Data Engineer | Careers',
    postingUrl: 'https://careers.example.ch/jobs/data-engineer-current',
  })).toBe(false);
  expect(hasVacancySpecificPostingEvidence('Related vacancies: Data Engineer — Acme', relatedVacancyJob, {
    pageUrl: 'https://careers.example.ch/careers',
    pageTitle: 'Data Engineer | Careers',
    postingUrl: 'https://careers.example.ch/jobs/data-engineer-current',
    vacancyIdentityContexts: ['Data Engineer — Acme'],
  })).toBe(true);
  expect(applicationEntryControls({
    text: 'Muster AG Karriere — Apply',
    links: [{ text: 'Apply', href: 'https://ats.example.test/apply', vacancyContext: 'Application Manager — Andere GmbH' }],
  }, {
    job, postingUrl, allowSingleExternalApplicationEntry: true,
  })).toEqual([]);
  expect(hasReadOnlyVacancyEvidence('Muster AG Karriere', job, {
    pageUrl: listingUrl, pageTitle: 'Application Manager',
  })).toBe(false);
  expect(hasReadOnlyVacancyEvidence('Muster AG Karriere', job, {
    pageUrl: postingUrl, pageTitle: 'Application Manager',
  })).toBe(false);
  expect(hasReadOnlyVacancyEvidence('Application form', { title: 'Application Manager' }, {
    pageTitle: 'Application Manager',
  })).toBe(false);
  expect(hasReadOnlyVacancyEvidence('Application form', { company: 'AG', title: 'Application Manager' }, {
    pageTitle: 'Application Manager',
  })).toBe(false);
  expect(hasReadOnlyVacancyEvidence('', { company: 'Hotel', title: 'Concierge' }, {
    pageTitle: 'Concierge — Hotel',
  })).toBe(false);
  expect(hasReadOnlyVacancyEvidence('Application form', job, {
    pageUrl: postingUrl, pageTitle: 'Muster AG — Application Manager',
  })).toBe(true);
  const rhbJob = { company: 'Ferrovia Retica (RhB)', title: 'Application Manager' };
  expect(hasReadOnlyVacancyEvidence('Application form', rhbJob, {
    pageUrl: 'https://rhb-career.talent-soft.com/application',
    pageTitle: 'Application Manager',
  })).toBe(false);
  expect(hasVacancySpecificPostingEvidence('Application Manager', { ...job, organization: 'Muster AG' }, {
    pageUrl: listingUrl, pageTitle: 'Application Manager', postingUrl,
  })).toBe(false);
  expect(hasVacancySpecificPostingEvidence('Application Manager', { ...job, organization: 'Andere GmbH' }, {
    pageUrl: listingUrl, pageTitle: 'Application Manager', postingUrl,
  })).toBe(false);
  expect(hasVacancySpecificPostingEvidence('Andere GmbH — Application Manager', { ...job, organization: 'Muster AG' }, {
    pageUrl: listingUrl, postingUrl,
  })).toBe(false);
  expect(hasVacancySpecificPostingEvidence('Andere GmbH', { ...job, organization: 'Muster AG' }, {
    pageUrl: listingUrl, pageTitle: 'Application Manager', postingUrl,
  })).toBe(false);
  expect(hasVacancySpecificPostingEvidence('Muster AG Karriere', job, {
    pageUrl: postingUrl, postingUrl,
  })).toBe(false); // The exact route and company alone prove neither the role nor its Apply control.
  expect(hasVacancySpecificPostingEvidence('Andere GmbH — Bewerbung', job, {
    pageUrl: postingUrl, pageTitle: 'Andere GmbH — Bewerbung', postingUrl,
  })).toBe(false);
});

it('keeps proven posting location metadata out of the employer conflict guard', () => {
  const job = {
    company: 'Coop Genossenschaft',
    title: 'Bäcker:in - Konditor:in (Schwerpunkt Bäckerei)',
    location: 'Rickenbach',
  };
  const postingUrl = 'https://jobs.example.test/coop-job';
  const vacancyContext = `${job.title} Coop Genossenschaft Standort Rickenbach Jetzt bewerben`;
  const apply = {
    id: 'apply',
    text: 'Jetzt bewerben',
    href: 'https://ats.example.test/apply',
    vacancyContext,
  };

  expect(hasVacancySpecificPostingEvidence(vacancyContext, job, {
    pageUrl: postingUrl,
    pageTitle: `Coop: ${job.title}`,
    postingUrl,
    vacancyIdentityContexts: [vacancyContext],
    uniqueApplicationEntryProven: true,
  })).toBe(true);
  expect(hasVacancySpecificPostingEvidence(vacancyContext, job, {
    pageUrl: postingUrl,
    pageTitle: `Andere GmbH: ${job.title}`,
    postingUrl,
    vacancyIdentityContexts: [vacancyContext],
    uniqueApplicationEntryProven: true,
  })).toBe(false);
  expect(applicationEntryControls({ links: [apply] }, {
    postingUrl,
    job,
    allowSingleExternalApplicationEntry: true,
  })).toEqual([apply]);
  expect(applicationEntryControls({
    links: [{ ...apply, vacancyContext: `${job.title} Andere GmbH Standort Rickenbach Jetzt bewerben` }],
  }, {
    postingUrl,
    job,
    allowSingleExternalApplicationEntry: true,
  })).toEqual([]);
  expect(namesAnotherEmployer('Kassierer — Coop One Rickenbach', {
    company: 'Coop Genossenschaft',
    title: 'Kassierer',
    location: 'Rickenbach',
  }, { allowPostingLocation: true })).toBe(true);
});

it('binds an unproved external Apply link to its own vacancy card', () => {
  const postingUrl = 'https://careers.example.ch/jobs/application-manager-42';
  const apply = { id: 'apply', text: 'Apply', href: 'https://ats.example.test/apply', vacancyContext: 'Application Manager — Muster AG' };
  const context = {
    postingUrl,
    job: { title: 'Application Manager', company: 'Muster AG' },
    allowSingleExternalApplicationEntry: true,
  };

  expect(applicationEntryControls({ links: [apply] }, context)).toEqual([apply]);
  expect(applicationEntryControls({ links: [{ ...apply, vacancyContext: 'Application Manager — Andere GmbH' }] }, context)).toEqual([]);
  expect(applicationEntryControls({ links: [{ ...apply, vacancyContext: '' }] }, context)).toEqual([]);
  // A company match elsewhere in the page cannot lend its identity to this
  // CTA; the control must carry the role and employer in its own card.
  expect(applicationEntryControls({
    text: 'Application Manager · Andere GmbH Apply · Footer Muster AG',
    links: [{ ...apply, vacancyContext: 'Application Manager — Andere GmbH' }],
  }, context)).toEqual([]);
});

it('does not launch a generic preflight when the public route cannot be resolved safely', async () => {
  const launch = vi.fn();
  const result = await readPortalRequirements({
    channelType: 'employer_site', applyUrl: 'https://apply.example.test/jobs/42',
    resolvePublicHost: vi.fn(async () => false), launch,
  });
  expect(result).toMatchObject({
    handoff: 'public_route_unavailable',
    portalContract: { status: 'unavailable', handoff: 'public_route_unavailable' },
  });
  expect(launch).not.toHaveBeenCalled();
});

it('binds the native Umantis applicant address when applyUrl is the direct posting URL', async () => {
  const postingUrl = 'https://recruitingapp-2761.umantis.com/Vacancies/1153/Description/4';
  const applicationUrl = 'https://recruitingapp-2761.umantis.com/Vacancies/1153/Application/New/4';
  const snapshot = {
    url: applicationUrl, buttons: [], captcha: false, passwordVisible: false, errors: [],
    text: 'Passa a Contenuto principale Impiegato/a amministrativo - Candidatura',
    fields: [
      { id: 'f5', kind: 'text', inputType: 'text', label: 'Nome', form: 0, required: false },
      { id: 'f6', kind: 'text', inputType: 'text', label: 'Cognome', form: 0, required: false },
      { id: 'f8', kind: 'text', inputType: 'email', label: 'Indirizzo e-mail/login', form: 0, required: false },
      { id: 'f10', kind: 'textarea', inputType: 'textarea', label: 'Via', form: 0, required: true,
        addressContext: { section: '', owners: [], unknown: false } },
      { id: 'f11', kind: 'text', inputType: 'text', label: 'NAP', form: 0, required: false,
        addressContext: { section: '', owners: [], unknown: false } },
      { id: 'f12', kind: 'text', inputType: 'text', label: 'Località', form: 0, required: true,
        addressContext: { section: '', owners: [], unknown: false } },
      { id: 'f13', kind: 'select', inputType: 'select', label: 'Paese', form: 0, required: true,
        options: ['Selezionare', 'Svizzera', 'Italia'], addressContext: { section: '', owners: [], unknown: false } },
      { id: 'cv', kind: 'file', inputType: 'file', label: 'Curriculum', form: 0, required: false },
    ],
  };
  const frame = { evaluate: vi.fn(async () => snapshot) };
  const page = {
    frames: () => [frame], url: () => applicationUrl,
    title: vi.fn(async () => 'Impiegato/a amministrativo - Candidatura | EOC candiDati'),
    goto: vi.fn(async () => {}), evaluate: vi.fn(async () => false), waitForLoadState: vi.fn(async () => {}),
    waitForTimeout: vi.fn(async () => {}),
  };
  const browser = { newContext: vi.fn(async () => ({ newPage: async () => page })), close: vi.fn(async () => {}) };
  const codex = vi.fn(async () => ({ actions: [], missingRequired: [] }));

  const result = await readPortalRequirements({
    channelType: 'umantis', applyUrl: postingUrl, postingUrl, language: 'it', candidateLocale: 'xx',
    job: { title: 'Impiegato a amministrativo', company: 'EOC – Ente Ospedaliero Cantonale' },
    candidate: { identity: {}, profile: {}, answers: {} }, codex, launch: async () => browser,
  });

  expect(result.handoff).toBeUndefined();
  expect(result.unreadableFields).toBeUndefined();
  expect(result.questions.map((question) => question.applicationQuestion)).toEqual(['Via', 'Località', 'Paese']);
  expect(browser.close).toHaveBeenCalledOnce();
});

it('asks only for the missing EOC residence street and permit after resolving known profile facts', async () => {
  const postingUrl = 'https://recruitingapp-2761.umantis.com/Vacancies/2806/Description/4';
  const applicationUrl = 'https://recruitingapp-2761.umantis.com/Vacancies/2806/Application/New/4';
  const processingConsent = 'Dichiaro di aver letto e compreso la Dichiarazione sulla protezione dei dati dell’EOC. Acconsento che i miei dati personali vengano trattati e conservati in conformità con tale Dichiarazione e con le normative vigenti in materia di protezione dei dati in Svizzera.';
  const retentionQuestion = 'Per quanto tempo autorizzi l’EOC a conservare i tuoi dati personali?';
  const retentionOptions = [
    'Do il mio consenso affinché i miei dati vengano memorizzati anche successivamente a una concreta richiesta di occupazione e dopo essere stato informato di offerte di lavoro interessanti.',
    'Desidero che i miei dati vengano eliminati dopo la procedura di candidatura corrente.',
  ];
  const snapshot = {
    url: applicationUrl, buttons: [], captcha: false, passwordVisible: false, errors: [],
    text: 'Assistente sociale (80–100%) - Candidatura EOC',
    fields: [
      { id: 'first-name', kind: 'text', inputType: 'text', label: 'Nome', form: 0, required: true },
      { id: 'last-name', kind: 'text', inputType: 'text', label: 'Cognome', form: 0, required: true },
      { id: 'email', kind: 'text', inputType: 'email', label: 'Indirizzo e-mail/login', form: 0, required: true },
      { id: 'phone', kind: 'text', inputType: 'tel', label: 'Telefono', form: 0, required: true },
      { id: 'street', kind: 'textarea', inputType: 'textarea', label: 'Via', form: 0, required: true,
        addressContext: { section: '', owners: [], unknown: false } },
      { id: 'postal', kind: 'text', inputType: 'text', label: 'NAP', form: 0, required: true,
        addressContext: { section: '', owners: [], unknown: false } },
      { id: 'city', kind: 'text', inputType: 'text', label: 'Località', form: 0, required: true,
        addressContext: { section: '', owners: [], unknown: false } },
      { id: 'country', kind: 'select', inputType: 'select', label: 'Paese', form: 0, required: true,
        options: ['Selezionare', 'Svizzera', 'Italia'], addressContext: { section: '', owners: [], unknown: false } },
      { id: 'nationality', kind: 'select', inputType: 'select', label: 'Nazionalità', form: 0, required: true,
        options: ['Selezionare', 'Italia', 'Svizzera'] },
      { id: 'salutation', kind: 'select', inputType: 'select', label: 'Appellativo', form: 0, required: true,
        options: ['Signora', 'Signor'] },
      { id: 'birth-date', kind: 'text', inputType: 'text', autocomplete: 'bday', label: 'Data di nascita', form: 0, required: true },
      { id: 'residence-status', kind: 'radio', inputType: 'radio', label: 'Statuto di soggiorno', form: 0, required: true,
        options: permitOptions('it') },
      { id: 'privacy', kind: 'checkbox', inputType: 'checkbox', label: processingConsent, form: 0, required: true },
      { id: 'retention', kind: 'select', inputType: 'select', label: retentionQuestion, form: 0, required: true,
        options: retentionOptions },
    ],
  };
  const frame = { evaluate: vi.fn(async () => snapshot) };
  const page = {
    frames: () => [frame], url: () => applicationUrl,
    title: vi.fn(async () => 'Assistente sociale (80–100%) - Candidatura | EOC candiDati'),
    goto: vi.fn(async () => {}), evaluate: vi.fn(async () => false), waitForLoadState: vi.fn(async () => {}),
    waitForTimeout: vi.fn(async () => {}),
  };
  const browser = { newContext: vi.fn(async () => ({ newPage: async () => page })), close: vi.fn(async () => {}) };
  const codex = vi.fn(async ({ prompt }: { prompt: string }) => {
    if (prompt.includes('You localize questions from an online job application')) {
      const start = prompt.lastIndexOf('\n\n{');
      const end = prompt.indexOf('\n\nReturn exactly one JSON object', start);
      const input = JSON.parse(prompt.slice(start + 2, end));
      return { questions: (input.questions || []).map((question: any) => ({
        id: question.id,
        sourceLocale: 'it',
        question: question.applicationQuestion,
        why: '',
        options: question.options || [],
        optionMap: question.optionMap || [],
        validationMessage: '',
      })) };
    }
    return { actions: [], missingRequired: [] };
  });
  const address = { street: '', postalCode: '6830', city: 'Lugano', country: 'Svizzera' };

  const result = await readPortalRequirements({
    channelType: 'umantis', applyUrl: postingUrl, postingUrl, language: 'it', candidateLocale: 'it',
    job: { title: 'Assistente sociale (80-100%)', company: 'EOC – Ente Ospedaliero Cantonale' },
    candidate: {
      identity: { name: 'Mario Rossi', firstName: 'Mario', lastName: 'Rossi', email: 'candidate@example.invalid', phone: '+41791234567', address },
      profile: { dateOfBirth: '1990-05-12', nationality: 'Italia', location: 'Lugano', address, workPermit: 'Permesso B' },
      answers: { salutation: 'Signor' },
    },
    codex, launch: async () => browser,
  });

  expect(result.handoff).toBeUndefined();
  expect(result.unreadableFields).toBeUndefined();
  expect(result.questions.map((question) => question.id)).toEqual(['portal_residence_address', 'work_permit']);
  expect(result.questions.map((question) => question.applicationQuestion)).toEqual(['Via', 'Statuto di soggiorno']);
  expect(browser.close).toHaveBeenCalledOnce();
});

it('infers the Umantis posting route before matching a direct Application/New form', async () => {
  const applicationUrl = 'https://recruitingapp-2761.umantis.com/Vacancies/1153/Application/New/4';
  const snapshot = {
    url: applicationUrl, buttons: [{ text: 'Avanti' }], links: [], captcha: false, passwordVisible: true, errors: [],
    text: [
      'Application Tracking System',
      "Attualmente ho un contratto con l'EOC",
      "In passato ho già lavorato per l'EOC",
    ].join('\n'),
    fields: [
      { id: 'first-name', kind: 'text', inputType: 'text', label: 'Nome', form: 0, required: true },
      { id: 'last-name', kind: 'text', inputType: 'text', label: 'Cognome', form: 0, required: true },
      { id: 'email', kind: 'text', inputType: 'email', label: 'Indirizzo e-mail/login', form: 0, required: true },
      { id: 'street', kind: 'textarea', inputType: 'textarea', label: 'Via', form: 0, required: true },
      { id: 'postal', kind: 'text', inputType: 'text', label: 'NAP', form: 0, required: true },
      { id: 'city', kind: 'text', inputType: 'text', label: 'Località', form: 0, required: true },
      { id: 'country', kind: 'select', inputType: 'select', label: 'Paese', form: 0, required: true, options: ['Selezionare', 'Svizzera'] },
      { id: 'cover', kind: 'file', inputType: 'file', label: 'Lettera di presentazione', form: 0, required: true },
      { id: 'cv', kind: 'file', inputType: 'file', label: 'Curriculum', form: 0, required: true },
    ],
  };
  const frame = { evaluate: vi.fn(async () => snapshot) };
  const page = {
    frames: () => [frame], url: () => applicationUrl,
    title: vi.fn(async () => 'Application Tracking System'),
    goto: vi.fn(async () => {}), evaluate: vi.fn(async () => false), waitForLoadState: vi.fn(async () => {}),
    waitForTimeout: vi.fn(async () => {}),
  };
  const browser = { newContext: vi.fn(async () => ({ newPage: async () => page })), close: vi.fn(async () => {}) };
  const codex = vi.fn(async () => ({ actions: [], missingRequired: [] }));

  const result = await readPortalRequirements({
    channelType: 'umantis', applyUrl: applicationUrl, postingUrl: '', language: 'it', candidateLocale: 'it',
    job: { title: 'Impiegato a amministrativo', company: 'EOC – Ente Ospedaliero Cantonale' },
    candidate: { identity: {}, profile: {}, answers: {} }, codex, launch: async () => browser,
  });

  expect(result.handoff).toBeUndefined();
  expect(result.questions.map((question) => question.applicationQuestion)).toEqual([
    'Nome', 'Cognome', 'Indirizzo e-mail/login', 'Via', 'NAP', 'Località', 'Paese',
  ]);
  expect(codex).toHaveBeenCalledOnce();
  expect(browser.close).toHaveBeenCalledOnce();
});

it('pre-reads a unique external Apply link for an allowlisted ATS form', async () => {
  const postingUrl = 'https://careers.example.test/jobs/42';
  const applicationUrl = 'https://ats.example.test/apply/42';
  const formSnapshot = {
    url: applicationUrl, buttons: [], links: [], captcha: false, passwordVisible: false, errors: [],
    text: 'Pflegefachfrau Gesundheit 80–100% (H/F) - Bewerbung',
    fields: [
      { id: 'question', kind: 'text', inputType: 'text', label: 'Do you have a license?', form: 0, required: true },
      { id: 'cv', kind: 'file', inputType: 'file', label: 'CV', form: 0, required: false },
    ],
  };
  const postingSnapshot = {
    url: postingUrl, buttons: [], captcha: false, passwordVisible: false, errors: [],
    text: 'Pflegefachfrau Gesundheit 80–100%',
    fields: [],
    links: [{ id: 'apply-link', text: 'Apply', href: applicationUrl, vacancyContext: 'Pflegefachfrau Gesundheit 80–100%', frame: 0, chrome: false }],
  };
  const job = { title: 'Operatrice sociosanitaria' };
  expect(hasVacancySpecificPostingEvidence(postingSnapshot.text, job, {
    pageUrl: postingUrl,
    pageTitle: 'Pflegefachfrau Gesundheit 80–100% | Pflegeheim Gegenteilig',
    postingUrl,
    uniqueApplicationEntryProven: true,
  })).toBe(false);
  const state = { url: postingUrl, snapshot: postingSnapshot };
  const applyLink = {
    first: () => applyLink,
    waitFor: vi.fn(async () => {}),
    getAttribute: vi.fn(async (name: string) => name === 'href' ? applicationUrl : null),
    click: vi.fn(async () => { state.url = applicationUrl; state.snapshot = formSnapshot; }),
  };
  const frame = {
    evaluate: vi.fn(async () => state.snapshot),
    locator: vi.fn(() => applyLink),
  };
  const page = {
    frames: () => [frame], url: () => state.url,
    title: vi.fn(async () => state.url === postingUrl ? 'Pflegefachfrau Gesundheit 80–100%' : 'Pflegefachfrau Gesundheit 80% (H/F) - Bewerbung'),
    goto: vi.fn(async (url: string) => {
      state.url = url;
      state.snapshot = url === postingUrl ? postingSnapshot : formSnapshot;
    }),
    evaluate: vi.fn(async (evaluate: unknown) => typeof evaluate === 'function'
      && String(evaluate).includes("querySelectorAll('h1,")
      ? state.url === postingUrl ? ['Pflegefachfrau Gesundheit 80–100%'] : []
      : false),
    waitForLoadState: vi.fn(async () => {}),
    waitForTimeout: vi.fn(async () => {}),
  };
  const context = { newPage: async () => page, waitForEvent: () => Promise.resolve(null) };
  const browser = { newContext: vi.fn(async () => context), close: vi.fn(async () => {}) };
  const codex = vi.fn(async () => ({ actions: [], missingRequired: [{ fieldId: 'question', question: 'Do you have a license?' }] }));

  const result = await readPortalRequirements({
    channelType: 'umantis', applyUrl: postingUrl, postingUrl, language: 'en', candidateLocale: 'en',
    job,
    candidate: { identity: {}, profile: {}, answers: {} }, codex, launch: async () => browser,
  });

  expect(applyLink.click).toHaveBeenCalledOnce();
  expect(result.handoff).toBeUndefined();
  expect(result.questions.map((question) => question.applicationQuestion)).toEqual(['Do you have a license?']);
  expect(browser.close).toHaveBeenCalledOnce();
});

it('batches mounted later-step ATS questions in one read-only pre-read', async () => {
  const url = 'https://jobs.lever.co/example/1/apply';
  const visible = {
    url, buttons: [], captcha: false, passwordVisible: false, errors: [], text: '',
    fields: [
      { id: 'cv', kind: 'file', label: 'CV', required: true },
      { id: 'first', kind: 'text', label: 'Why do you want this role?', required: true },
    ],
  };
  const mounted = {
    ...visible,
    fields: [...visible.fields, { id: 'later', kind: 'text', label: 'Describe a professional achievement relevant to this role?', required: true }],
  };
  const frame = {
    evaluate: vi.fn(async (_fn: unknown, options: { includeHidden?: boolean } = {}) => options.includeHidden ? mounted : visible),
  };
  const next = vi.fn();
  const page = {
    frames: () => [frame], url: () => url, goto: vi.fn(async () => {}), evaluate: vi.fn(async () => false),
    waitForLoadState: vi.fn(async () => {}), waitForTimeout: vi.fn(async () => {}), click: next,
  };
  const browser = { newContext: vi.fn(async () => ({ newPage: async () => page })), close: vi.fn(async () => {}) };
  const codex = vi.fn(async ({ prompt }: { prompt: string }) => {
    if (prompt.includes('You localize questions from an online job application')) {
      const start = prompt.lastIndexOf('\n\n{');
      const end = prompt.indexOf('\n\nReturn exactly one JSON object', start);
      const input = JSON.parse(prompt.slice(start + 2, end));
      return { questions: (input.questions || []).map((question: any) => ({
        id: question.id,
        sourceLocale: 'en',
        question: question.applicationQuestion,
        why: 'The portal requires this information.',
        options: question.options || [],
        optionMap: question.optionMap || [],
        validationMessage: 'Enter a valid answer.',
      })) };
    }
    return {
      actions: [],
      missingRequired: [
        { fieldId: 'first', question: 'Why do you want this role?', type: 'text', options: [] },
        { fieldId: 'later', question: 'Describe a professional achievement relevant to this role?', type: 'text', options: [] },
      ],
    };
  });
  const result = await readPortalRequirements({
    channelType: 'lever', applyUrl: url, language: 'en', candidateLocale: 'en',
    candidate: { identity: {}, profile: {}, answers: {} }, codex, launch: async () => browser,
  });

  expect(result.questions.map((question: any) => question.applicationQuestion)).toEqual([
    'Why do you want this role?', 'Describe a professional achievement relevant to this role?',
  ]);
  expect(frame.evaluate.mock.calls.some(([, options]) => options?.includeHidden === true)).toBe(true);
  expect(next).not.toHaveBeenCalled();
  expect(browser.close).toHaveBeenCalledOnce();
});

it('retains native fallback-language questions for review when localization is unavailable', async () => {
  const url = 'https://jobs.lever.co/example/1/apply';
  const snapshot = {
    url, buttons: [], captcha: false, passwordVisible: false, errors: [], text: '',
    fields: [
      { id: 'cv', kind: 'file', label: 'Resume / CV', required: true },
      { id: 'motivation', kind: 'text', label: 'Warum interessiert dich diese Stelle?', required: true },
    ],
  };
  const frame = { evaluate: vi.fn(async () => snapshot) };
  const page = { frames: () => [frame], url: () => url, goto: vi.fn(async () => {}),
    evaluate: vi.fn(async () => false), waitForLoadState: vi.fn(async () => {}) };
  const browser = { newContext: vi.fn(async () => ({ newPage: async () => page })), close: vi.fn(async () => {}) };
  const codex = vi.fn(async ({ prompt }: any) => String(prompt).includes('You localize questions from an online job application')
    ? { questions: [] }
    : { actions: [], missingRequired: [{ fieldId: 'motivation', question: 'Warum interessiert dich diese Stelle?' }] });
  const ctx = { channelType: 'lever', applyUrl: url, language: 'de', candidateLocale: 'it',
    candidate: { identity: {}, profile: {}, answers: {} }, codex, launch: async () => browser };

  const result = await readPortalRequirements(ctx);
  expect(result).toMatchObject({
    documents: [],
    questions: [expect.objectContaining({
      question: 'Warum interessiert dich diese Stelle?',
      applicationQuestion: 'Warum interessiert dich diese Stelle?',
      localizationStatus: 'fallback',
    })],
  });
  expect(result.handoff).toBeUndefined();
  expect(codex).toHaveBeenCalledTimes(2);
  expect(browser.close).toHaveBeenCalledOnce();
});

it('keeps a readable same-language Umantis batch usable when localization is unavailable', async () => {
  const codex = vi.fn().mockRejectedValue(new Error('translation unavailable'));
  const result = await localizePortalQuestions([
    {
      id: 'nationality', question: 'Nazionalità', applicationQuestion: 'Nazionalità',
      type: 'choice', options: ['Italia', 'Svizzera'], applicationOptions: ['Italia', 'Svizzera'],
    },
    {
      id: 'referral',
      question: 'Come è venuto a conoscenza della nostra organizzazione?',
      applicationQuestion: 'Come è venuto a conoscenza della nostra organizzazione?',
      type: 'choice', options: ['Sito aziendale', 'Altro'], applicationOptions: ['Sito aziendale', 'Altro'],
    },
  ], { candidateLocale: 'it', applicationLocale: 'de', codex });

  expect(codex).not.toHaveBeenCalled();
  expect(result).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'nationality', applicationQuestionLocale: 'it', localizationStatus: 'same_language' }),
    expect.objectContaining({ id: 'referral', applicationQuestionLocale: 'it', localizationStatus: 'same_language' }),
  ]));
  expect(result.every((question: any) => question.localizationStatus !== 'fallback')).toBe(true);
});

it('keeps long Italian country catalogues readable when localization is unavailable', async () => {
  const codex = vi.fn().mockRejectedValue(new Error('translation unavailable'));
  const countries = [
    'Italia', 'Svizzera', 'Francia', 'Germania', 'Austria', 'Spagna', 'Portogallo',
    'Belgio', 'Paesi Bassi', 'Regno Unito', 'Stati Uniti', 'Canada', 'Australia',
    'Giappone', 'Brasile', 'Argentina',
  ];
  const result = await localizePortalQuestions([
    {
      id: 'country', question: 'Paese', applicationQuestion: 'Paese',
      type: 'choice', options: countries, applicationOptions: countries,
    },
    {
      id: 'nationality', question: 'Nazionalità', applicationQuestion: 'Nazionalità',
      type: 'choice', options: countries, applicationOptions: countries,
    },
  ], { candidateLocale: 'it', applicationLocale: 'de', codex });

  expect(codex).not.toHaveBeenCalled();
  expect(result).toMatchObject([
    {
      id: 'country', applicationQuestionLocale: 'it', localizationStatus: 'same_language',
      options: countries, optionMap: countries.map((country) => ({ candidate: country, application: country })),
    },
    {
      id: 'nationality', applicationQuestionLocale: 'it', localizationStatus: 'same_language',
      options: countries, optionMap: countries.map((country) => ({ candidate: country, application: country })),
    },
  ]);
});

it('translates recognized foreign country catalogues while preserving their exact application values', async () => {
  const codex = vi.fn().mockRejectedValue(new Error('translation unavailable'));
  const applicationOptions = ['Deutschland', 'Frankreich', 'Italien', 'Österreich', 'Schweiz', 'Vereinigte Staaten'];
  const [result] = await localizePortalQuestions([{
    id: 'country', question: 'Paese', applicationQuestion: 'Paese',
    type: 'choice', options: applicationOptions, applicationOptions,
  }], { candidateLocale: 'it', applicationLocale: 'de', codex });

  expect(codex).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    question: 'Paese', localizationStatus: 'translated', applicationQuestionLocale: null,
    options: ['Germania', 'Francia', 'Italia', 'Austria', 'Svizzera', 'Stati Uniti'],
    optionMap: applicationOptions.map((application, index) => ({
      candidate: ['Germania', 'Francia', 'Italia', 'Austria', 'Svizzera', 'Stati Uniti'][index],
      application,
    })),
  });
});

it('translates known foreign nationality labels without changing the application values', async () => {
  const codex = vi.fn().mockRejectedValue(new Error('translation unavailable'));
  const applicationOptions = ['deutsch', 'französisch', 'italienisch', 'österreichisch', 'schweizerisch', 'spanisch'];
  const candidateOptions = ['tedesca', 'francese', 'italiana', 'austriaca', 'svizzera', 'spagnola'];
  const [result] = await localizePortalQuestions([{
    id: 'nationality', question: 'Nazionalità', applicationQuestion: 'Nazionalità',
    type: 'choice', options: applicationOptions, applicationOptions,
  }], { candidateLocale: 'it', applicationLocale: 'de', codex });

  expect(codex).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    localizationStatus: 'translated',
    options: candidateOptions,
    optionMap: candidateOptions.map((candidate, index) => ({ candidate, application: applicationOptions[index] })),
  });
});

it('keeps known Italian EOC Umantis fields candidate-readable when localization is unavailable', async () => {
  const codex = vi.fn().mockRejectedValue(new Error('translation unavailable'));
  const labels = [
    'Titolo accademico', 'Nome', 'Cognome', 'Data di nascita', 'Indirizzo e-mail/login',
    'Via', 'NAP', 'Località', 'Paese', 'Telefono', 'Cellulare', 'Profilo LinkedIn',
    'Profilo XING', 'Nazionalità', 'Diploma', 'Annotazioni sulla formazione',
    'Il suo diploma di riferimento è stato ottenuto',
    'Come è venuto a conoscenza della nostra organizzazione?',
    "Attualmente ho un contratto con l'EOC",
    "In passato ho già lavorato per l'EOC",
  ];
  const questions = labels.map((question, index) => ({
    id: `eoc-${index}`,
    question,
    applicationQuestion: question,
    type: question.startsWith('Come è venuto') ? 'choice' : 'text',
    options: question.startsWith('Come è venuto') ? ['Sito aziendale', 'Altro'] : [],
    applicationOptions: question.startsWith('Come è venuto') ? ['Sito aziendale', 'Altro'] : [],
  }));
  const request = await portalRequirementsForCandidate({ questions, documents: [] }, {
    candidateLocale: 'it', applicationLocale: 'de', codex,
  });

  expect(codex).not.toHaveBeenCalled();
  expect(request.questions).toHaveLength(labels.length);
  expect(request.questions.every((question: any) => question.localizationStatus === 'same_language')).toBe(true);
  expect(request.questions.map((question: any) => question.applicationQuestion)).toEqual(labels);
  expect(request.questions.find((question: any) => question.applicationQuestion.startsWith('Come è venuto'))).toMatchObject({
    options: ['Sito aziendale', 'Altro'],
    optionMap: [
      { candidate: 'Sito aziendale', application: 'Sito aziendale' },
      { candidate: 'Altro', application: 'Altro' },
    ],
  });
});

it('keeps the later Italian EOC Umantis controls candidate-readable when localization is unavailable', async () => {
  const codex = vi.fn().mockRejectedValue(new Error('translation unavailable'));
  const processingConsent = 'Dichiaro di aver letto e compreso la Dichiarazione sulla protezione dei dati dell’EOC. Acconsento che i miei dati personali vengano trattati e conservati in conformità con tale Dichiarazione e con le normative vigenti in materia di protezione dei dati in Svizzera.';
  const retentionOptions = [
    'Do il mio consenso affinché i miei dati vengano memorizzati anche successivamente a una concreta richiesta di occupazione e dopo essere stato informato di offerte di lavoro interessanti.',
    'Desidero che i miei dati vengano eliminati dopo la procedura di candidatura corrente.',
  ];
  const permitOptionsOnPage = [
    'Nazionalità svizzera', 'Permesso C', 'Permesso B', 'Permesso L',
    'Permesso F/N', 'Permesso G (frontaliere)', 'Attualmente senza permesso',
  ];
  const questions = [
    {
      id: 'title', question: 'Quale appellativo vuoi usare nei moduli di candidatura?',
      candidatePrompt: 'Quale appellativo vuoi usare nei moduli di candidatura?',
      applicationQuestion: 'Titolo', type: 'choice', options: ['Signora', 'Signor'], applicationOptions: ['Signora', 'Signor'],
    },
    {
      id: 'permit', question: permitStatusQuestion('it'), candidatePrompt: permitStatusQuestion('it'),
      applicationQuestion: 'Statuto di soggiorno', type: 'choice', options: permitOptionsOnPage, applicationOptions: permitOptionsOnPage,
    },
    {
      id: 'privacy', question: 'Confermi di aver letto e accettato l’informativa sulla protezione dei dati?',
      candidatePrompt: 'Confermi di aver letto e accettato l’informativa sulla protezione dei dati?',
      applicationQuestion: processingConsent, type: 'yes_no', options: ['Sì', 'No'], applicationOptions: ['Sì', 'No'],
    },
    {
      id: 'retention', question: 'Per quanto tempo autorizzi l’EOC a conservare i tuoi dati personali?',
      candidatePrompt: 'Per quanto tempo autorizzi l’EOC a conservare i tuoi dati personali?',
      applicationQuestion: 'Attivazione dati', type: 'choice', options: retentionOptions, applicationOptions: retentionOptions,
    },
  ];

  const request = await portalRequirementsForCandidate({ questions, documents: [] }, {
    candidateLocale: 'it', applicationLocale: 'de', codex,
  });

  expect(codex).not.toHaveBeenCalled();
  expect(request.questions).toHaveLength(questions.length);
  expect(request.questions.every((question: any) => question.localizationStatus === 'same_language')).toBe(true);
  expect(request.questions.map((question: any) => question.applicationQuestion)).toEqual([
    'Titolo', 'Statuto di soggiorno', processingConsent, 'Attivazione dati',
  ]);
  expect(request.questions[0]).toMatchObject({
    question: 'Quale appellativo vuoi usare nei moduli di candidatura?',
    options: ['Signora', 'Signor'],
    optionMap: [
      { candidate: 'Signora', application: 'Signora' },
      { candidate: 'Signor', application: 'Signor' },
    ],
  });
  expect(request.questions[1].options).toEqual(permitOptionsOnPage);
  expect(request.questions[2].options).toEqual(['Sì', 'No']);
  expect(request.questions[3].options).toEqual(retentionOptions);
});

it('keeps Italian EOC country and nationality catalogues without the localization provider', async () => {
  const codex = vi.fn().mockRejectedValue(new Error('translation unavailable'));
  const questions = [
    {
      id: 'country', question: 'Paese', applicationQuestion: 'Paese', type: 'choice',
      options: ['Selezionare', '-----------------------------------------', 'Svizzera', 'Italia', 'Germania', 'Francia'],
      applicationOptions: ['Selezionare', '-----------------------------------------', 'Svizzera', 'Italia', 'Germania', 'Francia'],
    },
    {
      id: 'nationality', question: 'Nazionalità', applicationQuestion: 'Nazionalità', type: 'choice',
      options: ['Selezionare', 'Svizzera', 'Italiana', 'Tedesca', 'Francese'],
      applicationOptions: ['Selezionare', 'Svizzera', 'Italiana', 'Tedesca', 'Francese'],
    },
  ];

  const request = await portalRequirementsForCandidate({ questions, documents: [] }, {
    candidateLocale: 'it', applicationLocale: 'it', codex,
  });

  expect(codex).not.toHaveBeenCalled();
  expect(request.questions).toEqual(questions.map((question) => expect.objectContaining({
    id: question.id,
    applicationQuestionLocale: 'it',
    localizationStatus: 'same_language',
    options: question.options,
  })));

  const foreignCodex = vi.fn().mockRejectedValue(new Error('translation unavailable'));
  const foreignOptions = ['Bitte wählen', 'Schweiz', 'Italien', 'Deutschland', 'Frankreich'];
  const translated = await portalRequirementsForCandidate({ documents: [], questions: [{
    ...questions[1],
    options: foreignOptions,
    applicationOptions: foreignOptions,
  }] }, { candidateLocale: 'it', applicationLocale: 'it', codex: foreignCodex });
  expect(foreignCodex).not.toHaveBeenCalled();
  expect(translated.questions).toEqual([expect.objectContaining({
    id: 'nationality',
    applicationQuestionLocale: null,
    localizationStatus: 'translated',
    options: ['Seleziona', 'Svizzera', 'Italia', 'Germania', 'Francia'],
    optionMap: [
      { candidate: 'Seleziona', application: 'Bitte wählen' },
      { candidate: 'Svizzera', application: 'Schweiz' },
      { candidate: 'Italia', application: 'Italien' },
      { candidate: 'Germania', application: 'Deutschland' },
      { candidate: 'Francia', application: 'Frankreich' },
    ],
  })]);

  const unknownCodex = vi.fn().mockRejectedValue(new Error('translation unavailable'));
  await expect(portalRequirementsForCandidate({ documents: [], questions: [{
    ...questions[1],
    options: ['Bitte wählen', 'Schweiz', 'Italien', 'Deutschland', 'Atlantide'],
    applicationOptions: ['Bitte wählen', 'Schweiz', 'Italien', 'Deutschland', 'Atlantide'],
  }] }, { candidateLocale: 'it', applicationLocale: 'it', codex: unknownCodex }))
    .rejects.toMatchObject({ code: 'portal_question_localization_unavailable' });
  expect(unknownCodex).toHaveBeenCalledOnce();
});

it('keeps deterministic German field copies when an unresolved same-language question shares the batch', async () => {
  const codex = vi.fn().mockRejectedValue(new Error('translation unavailable'));
  const result = await localizePortalQuestions([
    { id: 'salutation', question: 'Anrede', applicationQuestion: 'Anrede', options: [] },
    {
      id: 'skills',
      question: 'Quali requisiti e competenze hai per questa candidatura?',
      applicationQuestion: 'Quali requisiti e competenze hai per questa candidatura?',
      options: [],
    },
  ], { candidateLocale: 'it', applicationLocale: 'de', codex });

  expect(codex).not.toHaveBeenCalled();
  expect(result).toMatchObject([
    { id: 'salutation', question: 'Come preferisci essere indicato/a?', applicationQuestionLocale: 'de', localizationStatus: 'translated' },
    { id: 'skills', question: 'Quali requisiti e competenze hai per questa candidatura?', applicationQuestionLocale: 'it', localizationStatus: 'same_language' },
  ]);
});

it('keeps the federal SuccessFactors German page readable when localization is unavailable', async () => {
  const buttons = [
    'Optionen', 'Alle Abschnitte einblenden', 'Alle Abschnitte ausblenden', 'Meine Dokumente',
    'Meine persönlichen Informationen', 'Stellenspezifische Informationen', 'Bewerbungsprofil anzeigen',
    'Speichern', 'Bewerben',
  ];
  const fields = [
    ['* Anrede', []],
    ['* Vorname', []],
    ['* Nachname', []],
    ['* E-Mail-Adresse', []],
    ['* Strasse / Nr.', []],
    ['* Postleitzahl', []],
    ['* Ort', []],
    ['* Land', ['Keine Auswahl', 'Schweiz', 'Italien', 'Deutschland', 'Frankreich']],
    ['* Telefon', []],
    ['* Erstsprache', ['Keine Auswahl', 'Deutsch', 'Französisch', 'Italienisch', 'Rätoromanisch', 'Englisch', 'Andere']],
    ['Zweitsprache (bei Mehrsprachigkeit)', ['Keine Auswahl', 'Deutsch', 'Französisch', 'Italienisch', 'Rätoromanisch', 'Englisch', 'Andere']],
    ['* Korrespondenzsprache', ['Keine Auswahl', 'Deutsch', 'Französisch', 'Italienisch']],
    ['Herkunftskanton', ['Keine Auswahl', 'Bern', 'Tessin', 'Zürich']],
    ['* Wie haben Sie von dieser Stelle erfahren?', ['Keine Auswahl', 'Stellenportal Bund', 'Internet/Stellenportal', 'Zeitung', 'Soziale Medien', 'Empfehlung']],
    ['Jobsharing-Partner/-in', []],
    ['Bemerkungen', []],
    ['Geburtsdatum', []],
    ['* Haben Sie die Rekrutenschule (RS) der Schweizer Armee absolviert?', ['Ja', 'Nein']],
    ['* Haben Sie eine Unteroffiziers- oder Offiziersschule der Schweizer Armee absolviert?', ['Ja', 'Nein']],
    ['Haben Sie einen einwandfreien Leumund (Strafregister- und Betreibungsregisterauszug, beide ohne Einträge)?', ['Ja', 'Nein']],
  ];
  expect(buttons).toEqual(expect.arrayContaining(['Alle Abschnitte einblenden', 'Bewerben']));
  expect(fields.map(([label]) => label)).toContain('* Erstsprache');

  const questions = fields.map(([label, options], index) => ({
    id: `bund-${index}`,
    question: label,
    applicationQuestion: label,
    type: options.length ? 'choice' : 'text',
    options,
    applicationOptions: options,
  }));
  const codex = vi.fn().mockRejectedValue(new Error('translation unavailable'));
  const request = await portalRequirementsForCandidate({ questions, documents: [] }, {
    candidateLocale: 'it', applicationLocale: 'de', codex,
  });

  expect(codex).not.toHaveBeenCalled();
  expect(request.questions).toHaveLength(fields.length);
  expect(request.questions.every((question: any) => question.localizationStatus !== 'fallback')).toBe(true);
  expect(request.questions.find((question: any) => question.applicationQuestion === 'Erstsprache')).toMatchObject({
    question: 'Lingua madre',
    options: ['Seleziona', 'Tedesco', 'Francese', 'Italiano', 'Romancio', 'Inglese', 'Altro'],
  });
  expect(request.questions.find((question: any) => question.applicationQuestion.includes('Korrespondenzsprache'))).toMatchObject({
    question: 'Lingua di corrispondenza',
    options: ['Seleziona', 'Tedesco', 'Francese', 'Italiano'],
  });
  expect(request.questions.find((question: any) => question.applicationQuestion.includes('Rekrutenschule'))).toMatchObject({
    question: 'Hai svolto la scuola reclute (SR) dell’esercito svizzero?',
    options: ['Sì', 'No'],
  });
});

it('does not use the same-language fast path when options are in another language', async () => {
  const codex = vi.fn().mockRejectedValue(new Error('translation unavailable'));
  const result = await localizePortalQuestions([{
    id: 'skills',
    question: 'Quali requisiti e competenze hai per questa candidatura?',
    applicationQuestion: 'Quali requisiti e competenze hai per questa candidatura?',
    options: ['Ja', 'Nein'],
    applicationOptions: ['Ja', 'Nein'],
  }], { candidateLocale: 'it', applicationLocale: 'de', codex });

  expect(codex).toHaveBeenCalledOnce();
  expect(result[0]).toMatchObject({ localizationStatus: 'fallback', options: ['Sì', 'No'] });
  expect(result[0].localizationStatus).not.toBe('same_language');
});

it('detects the ATS question language even when the posting language matches the candidate locale', async () => {
  const question = 'Aus welcher Region stammt dein letzter Wohnort?';
  let prompt = '';
  const codex = vi.fn(async (request: any) => {
    prompt = request.prompt;
    return { questions: [{
      id: 'region', sourceLocale: 'de', question: 'Da quale regione proviene la tua ultima residenza?',
      why: 'Scegli la regione di provenienza.', options: ['Ticino', 'Resto della Svizzera'],
      optionMap: [
        { candidate: 'Ticino', application: 'Tessin' },
        { candidate: 'Resto della Svizzera', application: 'Übrige Schweiz' },
      ], validationMessage: '',
    }] };
  });
  const result = await localizePortalQuestions([{
    id: 'region', question, applicationQuestion: question, type: 'choice', required: true,
    options: ['Tessin', 'Übrige Schweiz'], applicationOptions: ['Tessin', 'Übrige Schweiz'],
  }], { candidateLocale: 'it', applicationLocale: 'it', codex });
  expect(codex).toHaveBeenCalledOnce();
  expect(prompt).toContain('may be wrong for the ATS form');
  expect(result[0]).toMatchObject({
    question: 'Da quale regione proviene la tua ultima residenza?',
    applicationQuestion: question,
    applicationQuestionLocale: 'de',
    localizationStatus: 'translated',
    options: ['Ticino', 'Resto della Svizzera'],
    optionMap: [
      { candidate: 'Ticino', application: 'Tessin' },
      { candidate: 'Resto della Svizzera', application: 'Übrige Schweiz' },
    ],
  });
});

it('shows a fallback instead of marking a question translated when the ATS options were not translated', async () => {
  const question = 'Welche Region ist dein Herkunftskanton?';
  const applicationOptions = ['Tessin', 'Übrige Schweiz'];
  const result = await localizePortalQuestions([{
    id: 'region', question, applicationQuestion: question, type: 'choice', required: true,
    options: applicationOptions, applicationOptions,
  }], {
    candidateLocale: 'it', applicationLocale: 'it', codex: async () => ({ questions: [{
      id: 'region', sourceLocale: 'de', question: 'Qual è il tuo cantone di provenienza?',
      why: 'Seleziona il cantone.', options: [], optionMap: [], validationMessage: '',
    }] }),
  });
  expect(result[0]).toMatchObject({
    question,
    applicationQuestion: question,
    applicationQuestionLocale: 'de',
    applicationOptions,
    options: applicationOptions,
    localizationStatus: 'fallback',
  });
});

it('keeps the exact ATS question and marks a placeholder translation as a visible fallback', async () => {
  const question = 'Welche Region ist dein Herkunftskanton?';
  const result = await localizePortalQuestions([{ id: 'q', question, applicationQuestion: question, options: [] }], {
    candidateLocale: 'it', applicationLocale: 'it', codex: async () => ({ questions: [{
      id: 'q', sourceLocale: 'de', question: PORTAL_QUESTION_PLACEHOLDERS.it, why: '', options: [], optionMap: [], validationMessage: '',
    }] }),
  });
  expect(result[0]).toMatchObject({
    question,
    applicationQuestion: question,
    applicationQuestionLocale: 'de',
    localizationStatus: 'fallback',
    why: 'Il portale richiede questa informazione.',
  });
});

it('uses the readable ATS question when applicationQuestion contains a generic placeholder', async () => {
  const question = 'Welche Region ist dein Herkunftskanton?';
  const result = await localizePortalQuestions([{
    id: 'q', question, applicationQuestion: PORTAL_QUESTION_PLACEHOLDERS.it, options: [],
  }], {
    candidateLocale: 'it', applicationLocale: 'it', codex: async () => ({ questions: [{
      id: 'q', sourceLocale: 'de', question: PORTAL_QUESTION_PLACEHOLDERS.it,
      why: '', options: [], optionMap: [], validationMessage: '',
    }] }),
  });
  expect(result[0]).toMatchObject({
    question,
    applicationQuestion: question,
    applicationQuestionLocale: 'de',
    localizationStatus: 'fallback',
  });
});

it('marks the original locale unknown when localization fails and never invents a translated question', async () => {
  const question = 'Welche Region ist dein Herkunftskanton?';
  const result = await localizePortalQuestions([{ id: 'q', question, applicationQuestion: question, options: [] }], {
    candidateLocale: 'it', applicationLocale: 'it', codex: vi.fn().mockRejectedValue(new Error('translation unavailable')),
  });
  expect(result[0]).toMatchObject({
    question,
    applicationQuestion: question,
    applicationQuestionLocale: null,
    localizationStatus: 'fallback',
    why: 'Il portale richiede questa informazione.',
  });
});

const placeholder = { id: 'unreadable', source: 'portal', question: PORTAL_QUESTION_PLACEHOLDERS.it, applicationQuestion: '', required: true, type: 'text' };
const hard = { id: 'experience', source: 'portal', question: 'Describe your international shipping experience', required: true, type: 'text' };
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
  it('does not expose a generic ATS question when a legacy draft lacks its source marker', () => {
    expect(questionsForCandidate([{ ...placeholder, source: undefined }], {})).toEqual([]);
    expect(questionsForCandidate([{ ...placeholder, source: undefined, applicationQuestion: 'What is your notice period?' }], {})[0].question)
      .toBe('What is your notice period?');
  });
});
