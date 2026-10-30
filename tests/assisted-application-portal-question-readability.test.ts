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

it('keeps a radio heading owned by its field when a different question shares the form', () => {
  const { dom, snapshot } = extract('<form><div class="field"><h3>Work permit?</h3><label for="yes">Yes</label><input id="yes" name="permit" type="radio"><label for="no">No</label><input id="no" name="permit" type="radio"></div><div class="field"><label for="email">Email</label><input id="email" type="email"></div></form>');
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
