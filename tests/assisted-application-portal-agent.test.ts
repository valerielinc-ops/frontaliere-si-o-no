import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AGENT_SCHEMA,
  advanceName,
  agentSystemPrompt,
  agentUserText,
  compactSnapshot,
  completeWithAgent,
  guardAgentStep,
  refusal,
  withoutSecrets,
} from '../scripts/assisted-application/lib/portal/agent.mjs';
import { isoDates, knownAnswer, knownValuesOf, planSystemPrompt } from '../scripts/assisted-application/lib/portal/plan.mjs';
import { machineLabel } from '../scripts/assisted-application/lib/portal/portal.mjs';

const act = (action: Record<string, string>) => ({ ref: 'e5', action: 'click', value: '', document: 'none', question: '', answer: '', source: 'widget', ...action });
const turn = (status: string, actions: any[] = [], questions: any[] = []) => ({ status, reason: '', advanceRef: '', actions, questions });

describe('portal agentic fallback (career-ops: snapshot with refs)', () => {
  // Giro di prova 2026-10-01 on JOIN: "Quando sei nato?" is a calendar of day buttons.
  it('never lets the model invent a birth date: the question goes to the candidate, with every move on it', () => {
    const empty = { answers: {}, profile: {}, portalQuestionsAnswered: [] };
    const guarded = guardAgentStep(turn('act', [
      act({ ref: 'e45', action: 'select', value: '1985', question: 'Quando sei nato?', answer: '1985-01-01', source: 'rule' }),
      act({ ref: 'e46', action: 'click', question: 'Quando sei nato?', source: 'widget' }),
      act({ ref: 'e60', action: 'click', question: 'Accetto l’informativa privacy', source: 'consent' }),
    ]), empty);
    expect(guarded.status).toBe('needs_candidate');
    expect(guarded.questions).toEqual([expect.objectContaining({ question: 'Quando sei nato?', type: 'date' })]);
    expect(guarded.actions.map((action: any) => action.ref)).toEqual(['e60']);

    // The candidate's answer, in another format, is used on the next run.
    const answered = { answers: { portal_quando_sei_nato: '12.05.1990' }, profile: {}, portalQuestionsAnswered: [{ question: 'Quando sei nato?', answer: '12.05.1990' }] };
    const run = guardAgentStep(turn('act', [act({ ref: 'e238', question: 'Quando sei nato?', answer: '1990-05-12', source: 'answers' })]), answered);
    expect(run).toMatchObject({ status: 'act', questions: [] });
    expect(run.actions).toHaveLength(1);
  });

  // Review of #10707: calling the answer a widget move must not get past the guard.
  it('runs a widget move on a sensitive question only when the page grounded it in the candidate data', () => {
    const empty = { answers: {}, profile: {}, portalQuestionsAnswered: [] };
    const sneaky = guardAgentStep(turn('act', [act({ ref: 'e1', question: 'Geburtsdatum', answer: '', value: '', source: 'widget' })]), empty);
    expect(sneaky).toMatchObject({ status: 'needs_candidate', actions: [] });

    // Grounded in an earlier turn of the same page: the day click on the next snapshot runs.
    const known = { answers: {}, profile: { dateOfBirth: '1990-05-12' }, portalQuestionsAnswered: [] };
    const grounded = new Set<string>();
    guardAgentStep(turn('act', [act({ ref: 'e45', action: 'select', value: '1990', question: 'Geburtsdatum', answer: '1990-05-12', source: 'profile' })]), known, grounded);
    const day = guardAgentStep(turn('act', [act({ ref: 'e238', question: 'Geburtsdatum', source: 'widget' })]), known, grounded);
    expect(day).toMatchObject({ status: 'act', questions: [] });
    expect(day.actions).toHaveLength(1);
  });

  it('presses an unusual step button only when its name says next step', () => {
    expect(advanceName('Salva e prosegui')).toBe(true);
    expect(advanceName('Vai al passo successivo')).toBe(true);
    expect(advanceName('Nächste Seite')).toBe(true);
    // Review of #10707: a Cancel, a Back, a sign-in or a final action never.
    for (const name of ['Cancel', 'Indietro', 'Zurück', 'Accedi e continua', 'Invia e continua', 'Weiter zur Bewerbung absenden', 'OK', '']) {
      expect(advanceName(name)).toBe(false);
    }
  });

  it('ends the fallback, not the run, when Codex fails', async () => {
    const page = {
      url: () => 'https://jobs.example/apply',
      title: async () => 'Apply',
      ariaSnapshot: async () => '- button "Choose 12 May 1990" [ref=e1]',
      waitForTimeout: async () => {},
    };
    const result = await completeWithAgent({ page, hint: 'next_disabled', candidate: null, candidateLocale: 'it', codex: async () => { throw new Error('timeout'); } });
    expect(result).toMatchObject({ status: 'stuck', calls: 1 });
    expect(result.reason).toContain('timeout');
  });

  it('never asks again what the candidate answered, even in other words', () => {
    const answered = { answers: {}, profile: {}, portalQuestionsAnswered: [{ question: 'Quando sei nato?', answer: '1990-05-12' }] };
    const asked = guardAgentStep(turn('needs_candidate', [], [{ question: 'Qual è la tua data di nascita?', why: '', type: 'date', options: [] }]), answered);
    // Nothing new to ask: the owner looks instead of a loop of questions.
    expect(asked).toMatchObject({ status: 'stuck', questions: [] });
  });

  it('turns an empty act into done and drops malformed refs', () => {
    expect(guardAgentStep(turn('act', [act({ ref: 'button#send' })]), null)).toMatchObject({ status: 'done', actions: [] });
    expect(guardAgentStep({ ...turn('done'), advanceRef: 'e9' }, null).advanceRef).toBe('e9');
    expect(guardAgentStep({ ...turn('done'), advanceRef: '>> css=button' }, null).advanceRef).toBe('');
  });

  it('keeps the final submit, Next, links, passwords and stray keys away from the model', () => {
    const button = { button: true, name: '', submits: false, leaves: false, inList: false, editable: false, tag: 'button', inputType: '' };
    expect(refusal({ action: 'click' }, { ...button, name: 'Invia candidatura' })).toBe('final_submit_reserved');
    expect(refusal({ action: 'click' }, { ...button, name: 'Bewerbung abschließen' })).toBe('final_submit_reserved');
    expect(refusal({ action: 'click' }, { ...button, name: 'Avanti', submits: true })).toBe('final_submit_reserved');
    expect(refusal({ action: 'click' }, { ...button, name: 'Continua' })).toBe('navigation_reserved');
    expect(refusal({ action: 'click' }, { ...button, name: 'Informativa', leaves: true })).toBe('link_reserved');
    expect(refusal({ action: 'click' }, { ...button, name: 'Choose sabato 12 maggio 1990' })).toBe('');
    // A consent box that says "confirm" is ticked like any other: the names are checked on buttons only.
    expect(refusal({ action: 'click' }, { ...button, button: false, tag: 'input', inputType: 'checkbox', name: 'I confirm my data is complete' })).toBe('');
    expect(refusal({ action: 'fill' }, { ...button, button: false, tag: 'input', inputType: 'password', editable: true })).toBe('password_reserved');
    // Enter submits a form from a text box: only inside a list or a combobox.
    expect(refusal({ action: 'press', value: 'Enter' }, { ...button, button: false, tag: 'input', editable: true })).toBe('key_refused');
    expect(refusal({ action: 'press', value: 'Enter' }, { ...button, button: false, tag: 'input', editable: true, inList: true })).toBe('');
    expect(refusal({ action: 'press', value: ' ' }, { ...button, button: false, tag: 'div', inList: true })).toBe('key_refused');
    expect(refusal({ action: 'fill' }, { ...button, button: false, tag: 'div' })).toBe('not_editable');
  });

  it('reads dates in the usual formats and matches them to the candidate data', () => {
    expect([...isoDates('nato il 12.5.1990, o 1990-05-12, o 12/05/1990')]).toEqual(['1990-05-12']);
    const known = knownValuesOf({ answers: { dob: '12.05.1990' }, profile: {}, portalQuestionsAnswered: [] });
    expect(knownAnswer(known, '1990-05-12')).toBe(true);
    expect(knownAnswer(known, '1990-05-13')).toBe(false);
    expect(knownAnswer(known, '')).toBe(false);
    expect(knownAnswer(null, 'anything')).toBe(true);
  });

  it('shares the planner rules, asks in the candidate’s language and uses a strict schema', () => {
    const prompt = agentSystemPrompt('de');
    expect(prompt).toContain('Never press the button that sends the application');
    expect(prompt).toContain('date of birth');
    expect(prompt).toContain('in German');
    expect(planSystemPrompt('it')).toContain('date of birth');
    const strict = (schema: any): boolean => schema.type !== 'object'
      || (schema.additionalProperties === false && Object.keys(schema.properties).every((key) => schema.required.includes(key) && strict(schema.properties[key]))
        && Object.values(schema.properties).every((value: any) => value.type !== 'array' || strict(value.items)));
    expect(strict(AGENT_SCHEMA)).toBe(true);
    const text = agentUserText({ url: 'https://x', title: '', snapshot: '- button "OK" [ref=e1]', candidate: { identity: {} }, hint: 'next_disabled' });
    expect(JSON.parse(text.slice(0, text.indexOf('\n\nPage snapshot:'))).agentPage.hint).toMatch(/disabled/);
  });

  it('compacts the snapshot: no link targets, no bare images, a bounded size', () => {
    const snapshot = ['- link "Home" [ref=e2]:', '  - /url: https://x', '  - img [ref=e3]', '- img "Logo" [ref=e4]', '- button "OK" [ref=e5]'].join('\n');
    expect(compactSnapshot(snapshot)).toBe(['- link "Home" [ref=e2]:', '- img "Logo" [ref=e4]', '- button "OK" [ref=e5]'].join('\n'));
    expect(compactSnapshot('x'.repeat(50), 10)).toBe(`${'x'.repeat(10)}\n… (snapshot truncated)`);
    // Cut at a line end: never an element without its ref.
    expect(compactSnapshot('- button "A" [ref=e1]\n- button "B" [ref=e2]', 30)).toBe('- button "A" [ref=e1]\n… (snapshot truncated)');
  });

  it('strikes a password the runner typed out of the snapshot the model gets', () => {
    const snapshot = '- textbox "Password" [ref=e7]: Xy12abcdefghAa7!\n- button "Submit final application" [ref=e9]';
    expect(withoutSecrets(snapshot, ['Xy12abcdefghAa7!', ''])).toBe('- textbox "Password" [ref=e7]: [password]\n- button "Submit final application" [ref=e9]');
    expect(withoutSecrets(snapshot)).toBe(snapshot);
  });

  it('tells generated names from questions', () => {
    expect(machineLabel('select-input-_r_p_')).toBe(true);
    expect(machineLabel('file:_r_3_:input')).toBe(true);
    expect(machineLabel('')).toBe(true);
    expect(machineLabel('Quando sei nato?')).toBe(false);
    expect(machineLabel('email-address')).toBe(false);
  });

  // The fallback reads the page through Playwright's own snapshot for models (as Playwright MCP does):
  // an upgrade that renames it must fail here, not silently turn the fallback off (dry run 36822777464:
  // 1.63 dropped the private call the first version used).
  it('finds the AI snapshot in the installed Playwright', () => {
    const require = createRequire(import.meta.url);
    // Not among the package's exports: the files themselves, by their path.
    const root = path.dirname(require.resolve('playwright-core/package.json'));
    const types = readFileSync(path.join(root, 'types/types.d.ts'), 'utf8');
    const legacy = path.join(root, 'lib/client/page.js');
    const publicMode = /ariaSnapshot\(options\?: \{[^}]*mode\?: "ai"/.test(types);
    const privateCall = existsSync(legacy) && readFileSync(legacy, 'utf8').includes('async _snapshotForAI(');
    expect(publicMode || privateCall).toBe(true);
  });
});
