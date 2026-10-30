import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { extractFieldsInPage } from '../scripts/assisted-application/lib/portal/fields.mjs';
import { guardPlan } from '../scripts/assisted-application/lib/portal/plan.mjs';
import { localizePortalQuestions, portalRequirementsFromMissingRequired, readPortalRequirements, readPortalQuestions } from '../scripts/assisted-application/lib/portal/portal.mjs';
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

it('routes unreadable source labels to a technical hold instead of manufacturing a required question', () => {
  const result = portalRequirementsFromMissingRequired([{ id: 'f1', kind: 'checkbox', label: '', required: true }], [{ fieldId: 'f1', question: '' }]);
  expect(result.questions).toEqual([]);
  expect(result.unreadableFields).toEqual(['f1']);
  expect(portalRequirementsFromMissingRequired([{ id: 'f1', kind: 'text', label: '', required: true }],
    [{ fieldId: 'f1', question: 'A plausible but invented question?' }])).toMatchObject({ questions: [], unreadableFields: ['f1'] });
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
