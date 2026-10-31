import { nativeFieldFromContract } from '../functions/src/lib/nativeFormContract.js';
import { nativeQuestionText } from '../functions/src/lib/nativeQuestionText.js';
import { candidateIdentityRole, isCandidateIdentityTarget, createCandidateIdentityContract } from '../functions/src/lib/candidateIdentityContract.js';
import { individualApplicationOriginQuestion } from '../functions/src/lib/applicationOrigin.js';
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { createHash } from 'node:crypto';
import { planPage, evidenceSupports, mechanicallyGroundedPortalAction } from '../scripts/assisted-application/lib/portal/plan.mjs';
import { completeWithAgent, runAction } from '../scripts/assisted-application/lib/portal/agent.mjs';
import { applyActions } from '../scripts/assisted-application/lib/portal/fill.mjs';
import { submitViaPortal } from '../scripts/assisted-application/lib/portal/portal.mjs';
import { createPortalQualificationVerifier, freshQualificationFields, portalQualificationContext, qualificationActionFence, nativeFormContract, existingPortalAnswers, assertExistingPortalAnswers } from '../scripts/assisted-application/lib/portal/qualification-gate.mjs';

const sha = (text: any) => createHash('sha256').update(text).digest('hex');
const candidate = { identity: { firstName: 'Test', email: 'test@example.test' }, profile: { headline: 'Senior IT Manager' }, answers: {} };
const action = (fieldId: string, value = 'Yes') => ({ fieldId, action: 'fill', value, document: 'none', source: 'profile', evidence: 'Senior IT Manager' });
const context = (text = 'Senior IT Manager', extra: any = {}) => {
  const bytes = Buffer.from(text);
  return portalQualificationContext({ order: { cvStorageKey: 'original', jobUrl: 'https://jobs.example.test/job' }, orderId: 'test-order',
    draft: { round: 1, cvKey: 'original', sourceCvHash: sha(bytes), factSources: { text } }, cvBuffer: bytes, ...extra });
};
const payload = (prompt: string) => JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n{"') + 2, prompt.lastIndexOf('\n\nReturn exactly')));
const judgement = (data: any, supported: boolean) => ({ assessments: data.claims.map((claim: any, index: number) => data.sources
  ? { index, sourceIds: [data.sourceColumns ? data.sources[0][0] : data.sources[0].sourceId] }
  : { index, proofId: claim.proof.id, verdict: supported ? 'supported' : 'unsupported', reason: supported ? 'explicit_fact' : 'title_without_activity' }) });

/** The production extractor and ref resolver run against a real DOM, not invented field bindings. */
function portal(html = '<label for="a">Do you hold a university degree?</label><input id="a" data-ref="e1" required>') {
  const dom = new JSDOM(`<form aria-label="Your application">${html}</form>`, { url: 'https://jobs.example.test/apply', runScripts: 'outside-only' });
  const win = dom.window;
  const computedStyle = win.getComputedStyle.bind(win);
  win.getComputedStyle = (element: Element) => computedStyle(element);
  Object.defineProperty(win.HTMLElement.prototype, 'innerText', { get() { return this.textContent || ''; } });
  win.Element.prototype.getBoundingClientRect = () => ({ width: 50, height: 25, top: 0, left: 0, right: 50, bottom: 25, x: 0, y: 0, toJSON() {} });
  (win as any).CSS ||= { escape: (s: string) => s.replace(/["\\]/g, '\\$&') };
  const evaluate = (fn: any, arg: any) => win.eval(`(${fn.toString()})(${JSON.stringify(arg) ?? 'undefined'})`);
  let mutations = 0;
  let page: any;
  const frame = { evaluate: async (fn: any, arg: any) => evaluate(fn, arg), url: () => win.location.href, locator: (selector: string) => locator(selector) };
  const locator = (selector: string, label?: string): any => {
    const css = selector.startsWith('aria-ref=') ? `[data-ref="${selector.slice(9)}"]` : selector;
    const nodes = () => [...win.document.querySelectorAll(css)].filter(node => label == null || node.textContent === label);
    const node = () => nodes()[0];
    const evaluateNode = (fn: any, arg: any) => win.eval(`(${fn.toString()})(globalThis.__target, ${JSON.stringify(arg) ?? 'undefined'})`);
    return { first() { return this; },
      allInnerTexts: async () => nodes().map(node => node.textContent), count: async () => nodes().length,
      getByRole: (role: string, options: any = {}) => locator(`${css} [role="${role}"]`, options.name),
      locator: (child: string) => locator(`${css} ${child}`),
      waitFor: async () => { if (!node()) throw new Error('not found'); },
      pressSequentially: async (value: string) => { (node() as any).value = ((node() as any).value || '') + value; },
      press: async () => {},
      evaluate: async (fn: any, arg: any) => { (win as any).__target = node(); return evaluateNode(fn, arg); },
      elementHandle: async () => ({ ownerFrame: async () => frame, dispose: async () => {},
        evaluate: async (fn: any) => { (win as any).__target = node(); return evaluateNode(fn, undefined); } }),
      fill: async (value: string) => { mutations++; (node() as any).value = value; },
      click: async () => { mutations++; (node() as any).click(); },
      inputValue: async () => (node() as any)?.value || '',
      isVisible: async () => Boolean(node()), isEnabled: async () => Boolean(node()),
    };
  };
  page = { frames: () => [frame], url: () => win.location.href, title: async () => 'Application', locator,
    ariaSnapshot: async () => '- textbox "Degree" [ref=e1]', waitForTimeout: async () => {}, keyboard: { press: async () => {} } };
  return { page, win, mutations: () => mutations, close: () => dom.window.close() };
}

function verifier(codex: any, source = context()) {
  return createPortalQualificationVerifier({ context: source, codex,
    candidate: candidate });
}

describe('native form answer entailment before mutations', () => {
  it('does not interpret a skipped option as an answer, while retaining its actual prefilled value for audit', async () => {
    const p = portal('<label for="a">Do you hold a degree?</label><select id="a"><option value="yes">Yes</option><option value="no">No</option></select>');
    const field = (await freshQualificationFields(p.page)).fields[0];
    const gate = verifier(async () => { throw new Error('skip is not an answer'); });
    const skipped = { fieldId: field.id, action: 'skip', value: '' };
    expect(gate.needs(field, skipped)).toBe(false);
    expect(gate.claim(field, skipped)).toBeNull();
    expect(existingPortalAnswers([field], [skipped])).toHaveLength(1);
    p.close();
  });

  it('does not omit an unknown native value even when the compact reader returns empty', () => {
    expect(() => existingPortalAnswers([{ id: 'overflow', kind: 'textarea', value: '', nativeValueUnknown: true }]))
      .toThrowError(expect.objectContaining({ code: 'evidence_entailment_unverified', reason: 'native_value_unverified' }));
  });

  it('preserves only the positively proven native placeholder marker in the contract', () => {
    const field = { id: 'choice', label: 'Qualification', kind: 'select', inputType: 'select', nativeOwnedScopes: [], options: [
      { label: 'Select', value: '', placeholder: true }, { label: 'None', value: '', placeholder: false }], validation: {} };
    expect(nativeFormContract(field)?.optionValues).toEqual([
      { label: 'Select', value: '', placeholder: true }, { label: 'None', value: '' }]);
    const native = nativeFormContract(field);
    expect(nativeFormContract(nativeFieldFromContract(native, { id: 'decoded' }))).toEqual(native);
    expect(nativeFieldFromContract({ ...native, ownedScopes: [{ kind: 'group', names: [], unknown: true }] })).toBeNull();
  });

  it('never equates an authentic IT title with holding a degree', async () => {
    expect(evidenceSupports('Do you hold a university degree?', 'Yes', 'Senior IT Manager')).toBe(false);
    const p = portal();
    const snapshot = await freshQualificationFields(p.page);
    let calls = 0;
    const codex = async ({ prompt }: any) => ++calls === 1 ? { actions: [action(snapshot.fields[0].id)], missingRequired: [] }
      : judgement(payload(prompt), false);
    await expect(planPage({ page: p.page, snapshot, candidate, codex, qualificationVerifier: verifier(codex) }))
      .rejects.toMatchObject({ code: 'evidence_entailment_unverified' });
    expect(calls).toBe(3); // planner, source selector, independent adjudicator
    expect(p.mutations()).toBe(0);
    p.close();
  });

  it('allows an independently supported degree and fences the actual action', async () => {
    const p = portal();
    const snapshot = await freshQualificationFields(p.page);
    let calls = 0;
    const codex = async ({ prompt }: any) => ++calls === 1 ? { actions: [action(snapshot.fields[0].id)], missingRequired: [] }
      : judgement(payload(prompt), true);
    const gate = verifier(codex, context('Bachelor degree in Computer Science, completed in 2015.'));
    const plan = await planPage({ page: p.page, snapshot, candidate, codex, qualificationVerifier: gate });
    await applyActions(p.page, snapshot.fields, plan.actions, {}, { pause: async () => {}, beforeAction: qualificationActionFence({ page: p.page, verifier: gate }) });
    expect(p.mutations()).toBe(1);
    p.close();
  });

  it.each(['No', '5'])('verifies the actual negative/numerical value %s and native unit/constraint', async value => {
    const p = portal('<label for="a">How many years of clinical experience do you have?</label><input id="a" data-ref="e1" type="number" min="5" step="1">');
    const snapshot = await freshQualificationFields(p.page);
    let native: any;
    let calls = 0;
    const codex = async ({ prompt }: any) => ++calls === 1 ? { actions: [action(snapshot.fields[0].id, value)], missingRequired: [] }
      : (native = payload(prompt), judgement(native, false));
    await expect(planPage({ page: p.page, snapshot, candidate, codex, qualificationVerifier: verifier(codex, context('8 years of IT experience.')) }))
      .rejects.toMatchObject({ code: 'evidence_entailment_unverified' });
    expect(native.claims[0]).toMatchObject({ proposedAnswer: value, nativeFormContract: { question: snapshot.fields[0].label, validation: { min: '5', step: '1' } } });
    p.close();
  });

  it('checks quoted-agent refs against the actual DOM question, not its invented question', async () => {
    const p = portal();
    let actual: any;
    let calls = 0;
    const codex = async ({ prompt }: any) => ++calls === 1 ? { status: 'act', reason: '', actions: [{ ref: 'e1', action: 'fill', value: 'Yes', document: 'none', question: 'Are you an IT manager?', context: '', answer: 'Yes', source: 'profile', evidence: 'Senior IT Manager' }], questions: [], advanceRef: '', submitRef: '' }
      : (actual = payload(prompt), judgement(actual, false));
    await expect(completeWithAgent({ page: p.page, hint: 'custom', candidate, codex, qualificationVerifier: verifier(codex) }))
      .rejects.toMatchObject({ code: 'evidence_entailment_unverified' });
    expect(actual.claims[0].nativeFormContract.question).toBe('Do you hold a university degree?');
    expect(p.mutations()).toBe(0);
    p.close();
  });

  it.each(['timeout', 'schema'])('holds technical judge %s without asking a false qualification question', async kind => {
    const p = portal();
    const snapshot = await freshQualificationFields(p.page);
    let calls = 0;
    const codex = async () => { if (++calls === 1) return { actions: [action(snapshot.fields[0].id)], missingRequired: [] }; if (kind === 'timeout') throw new Error('timeout'); return {}; };
    await expect(planPage({ page: p.page, snapshot, candidate, codex, qualificationVerifier: verifier(codex) })).rejects.toMatchObject({ code: 'evidence_entailment_unverified' });
    expect(p.mutations()).toBe(0);
    p.close();
  });

  it('invalidates permission when a native qualifier changes after verification', async () => {
    const p = portal();
    const snapshot = await freshQualificationFields(p.page);
    const gate = verifier(async ({ prompt }: any) => judgement(payload(prompt), true), context('Bachelor degree.'));
    const item = action(snapshot.fields[0].id);
    await gate.verify([gate.claim(snapshot.fields[0], item)], { url: p.page.url() });
    p.win.document.querySelector('label')!.textContent = 'Do you hold a doctorate in medicine?';
    await expect(applyActions(p.page, snapshot.fields, [item], {}, { pause: async () => {}, beforeAction: qualificationActionFence({ page: p.page, verifier: gate }) }))
      .rejects.toMatchObject({ code: 'evidence_entailment_unverified' });
    expect(p.mutations()).toBe(0);
    p.close();
  });

  it('omits replaced/missing CV bytes but retains separately attested answers', () => {
    const source = context('University degree.', { cvBuffer: Buffer.from('replacement'), answerEvidence: [{ id: 'own', category: 'qualification', question: { question: 'Degree?' }, answer: 'Yes', provenance: { actor: 'candidate', round: 1 } }] });
    expect(source.sources.evidenceCatalog().filter((item: any) => item.kind === 'cv_original')).toHaveLength(0);
    expect(source.scope.sourceCvHash).toBe(sha(Buffer.from('replacement')));
    expect(source.scope.sourceUnbound).toBe(true);
    expect(source.documentsCurrent).toBe(false);
    expect(source.scope.cvLanguageProfile).toBeNull();
    expect(source.sources.evidenceCatalog().some((item: any) => item.kind === 'candidate_answer')).toBe(true);
  });

  it('rechecks an identity exemption after redraw instead of writing it into a qualification', async () => {
    const p = portal('<label for="a">First name</label><input id="a" data-ref="e1">');
    const snapshot = await freshQualificationFields(p.page);
    const item = { ...action(snapshot.fields[0].id, 'Test'), source: 'identity' };
    const gate = verifier(async () => { throw new Error('must not call judge'); });
    expect(gate.needs(snapshot.fields[0], item)).toBe(false);
    p.win.document.querySelector('label')!.textContent = 'Which university degree do you hold?';
    await expect(qualificationActionFence({ page: p.page, verifier: gate })(snapshot.fields[0], item))
      .rejects.toMatchObject({ code: 'evidence_entailment_unverified' });
    expect(p.mutations()).toBe(0);
    p.close();
  });

  it('rejects an identical control on a different URL with the same main Frame object', async () => {
    const p = portal();
    const snapshot = await freshQualificationFields(p.page);
    const item = action(snapshot.fields[0].id);
    const gate = verifier(async ({ prompt }: any) => judgement(payload(prompt), true), context('Bachelor degree.'));
    const scope = { url: p.page.url() };
    await gate.verify([gate.claim(snapshot.fields[0], item)], scope);
    p.win.history.pushState({}, '', '/another-application');
    await expect(qualificationActionFence({ page: p.page, verifier: gate, scope })(snapshot.fields[0], item))
      .rejects.toMatchObject({ code: 'evidence_entailment_unverified' });
    expect(p.mutations()).toBe(0);
    p.close();
  });

  it('does not upgrade a legacy partial QA into a full native owned-scope shortcut', async () => {
    const p = portal('<fieldset aria-label="Education"><label for="a">Do you hold a degree?</label><input id="a"></fieldset>');
    const field = (await freshQualificationFields(p.page)).fields[0];
    const legacy = { id: 'legacy', category: 'qualification', question: { question: field.label,
      context: field.context, section: field.section, autocomplete: field.autocomplete,
      options: [], type: field.inputType, validation: field.validation }, answer: 'Yes', provenance: { actor: 'candidate', round: 1 } };
    const gate = createPortalQualificationVerifier({ context: { ...context(), answerEvidence: [legacy] } });
    expect(gate.needs(field, action(field.id))).toBe(true);
    expect(gate.claim(field, action(field.id))).not.toBeNull();
    p.close();
  });

  it.each(['frame_url', 'frame_object', 'document_clock'])('does not reuse a proof after %s changes behind a stable main URL', async change => {
    const p = portal();
    const mainUrl = p.page.url();
    p.page.url = () => mainUrl;
    const snapshot = await freshQualificationFields(p.page);
    const gate = verifier(async ({ prompt }: any) => judgement(payload(prompt), true), context('Bachelor degree.'));
    const item = action(snapshot.fields[0].id);
    await gate.verify([gate.claim(snapshot.fields[0], item)], { url: mainUrl });
    if (change === 'frame_url') p.win.history.pushState({}, '', '/another-frame-application');
    if (change === 'frame_object') { const replacement = { ...p.page.frames()[0] }; p.page.frames = () => [replacement]; }
    if (change === 'document_clock') Object.defineProperty(p.win.performance, 'timeOrigin', { value: p.win.performance.timeOrigin + 1, configurable: true });
    await expect(qualificationActionFence({ page: p.page, verifier: gate, scope: { url: mainUrl } })(snapshot.fields[0], item))
      .rejects.toMatchObject({ code: 'evidence_entailment_unverified', reason: 'native_frame_changed' });
    expect(p.mutations()).toBe(0);
    p.close();
  });

  it('never physically clicks an ambiguous radio option without a proposed answer', async () => {
    const p = portal('<fieldset><legend>Do you hold a university degree?</legend><label><input type="radio" name="degree" aria-label="Yes" data-ref="e1" value="a">Yes</label><label><input type="radio" name="degree" value="b">Yes</label></fieldset>');
    await expect(completeWithAgent({ page: p.page, hint: 'application', candidate, maxRounds: 1,
      qualificationVerifier: verifier(async () => { throw new Error('ambiguous native radio must not reach evidence model'); }),
      codex: async () => ({ status: 'act', reason: '', questions: [], advanceRef: '', submitRef: '', actions: [
        { ref: 'e1', action: 'click', value: '', question: 'Do you hold a university degree?', source: 'profile', evidence: 'Senior IT Manager', document: 'none' }] }) }))
      .rejects.toMatchObject({ code: 'evidence_entailment_unverified', reason: 'native_field_unbound' });
    expect(p.mutations()).toBe(0);
    p.close();
  });

  it('does not reuse exact-QA permission when numeric validation changes', async () => {
    const p = portal('<label for="a">Years of Python experience?</label><input id="a" type="number" data-ref="e1">');
    const snapshot = await freshQualificationFields(p.page);
    const field = snapshot.fields[0];
    const source = context('', { answerEvidence: [{ id: 'own', category: 'qualification',
      question: { question: field.label, originalNativeContract: nativeFormContract(field), context: field.context, section: field.section, autocomplete: field.autocomplete,
        options: [], type: field.inputType, validation: field.validation }, answer: '3', provenance: { actor: 'candidate', round: 1 } }] });
    const gate = verifier(async () => { throw new Error('must not judge an unverified redraw'); }, source);
    const item = action(field.id, '3');
    expect(gate.needs(field, item)).toBe(false);
    p.win.document.querySelector('input')!.setAttribute('min', '5');
    await expect(qualificationActionFence({ page: p.page, verifier: gate })(field, item))
      .rejects.toMatchObject({ code: 'evidence_entailment_unverified' });
    expect(p.mutations()).toBe(0);
    p.close();
  });

  it('holds an exact attested answer with a new unverified correction', async () => {
    const p = portal();
    const snapshot = await freshQualificationFields(p.page);
    const field = snapshot.fields[0];
    const source = context('Bachelor degree.', { flow: { candidateNotes: 'Correction: I have not completed my degree.' },
      answerEvidence: [{ id: 'own', category: 'qualification', question: { question: field.label, originalNativeContract: nativeFormContract(field),
        context: field.context, section: field.section, autocomplete: field.autocomplete, options: [], type: field.inputType, validation: field.validation },
      answer: 'Yes', provenance: { actor: 'candidate', round: 1 } }] });
    let observed: any;
    const gate = verifier(async ({ prompt }: any) => (observed = payload(prompt), judgement(observed, false)), source);
    const claim = gate.claim(field, action(field.id));
    expect(claim).not.toBeNull();
    await expect(gate.verify([claim])).rejects.toMatchObject({ code: 'evidence_entailment_unverified' });
    expect(observed.unverifiedContext.flowNotes || observed.unverifiedContext.candidateNotes).toContain('not completed');
    expect(p.mutations()).toBe(0);
    p.close();
  });

  it('verifies synthesized profile autofill without a first-planner quotation', async () => {
    const p = portal('<label for="a">Do you speak German at C1 level?</label><input id="a" data-ref="e1">');
    const snapshot = await freshQualificationFields(p.page);
    const nativeCandidate = { ...candidate, profile: { languages: [{ language: 'German', level: 'C1' }] } };
    let calls = 0;
    let native: any;
    const codex = async ({ prompt }: any) => ++calls === 1 ? { actions: [], missingRequired: [] }
      : (native = payload(prompt), judgement(native, false));
    const gate = createPortalQualificationVerifier({ context: context('Senior IT Manager'), codex });
    await expect(planPage({ page: p.page, snapshot, candidate: nativeCandidate, codex, qualificationVerifier: gate }))
      .rejects.toMatchObject({ code: 'evidence_entailment_unverified' });
    expect(native.claims[0].nativeFormContract.question).toBe(snapshot.fields[0].label);
    expect(p.mutations()).toBe(0);
    p.close();
  });

  it('selects Yes only inside the current combobox even when another Yes precedes it', async () => {
    const p = portal('<label for="b">Do you need sponsorship?</label><input id="b" role="combobox" aria-controls="list-b">'
      + '<div id="list-b" role="listbox"><div role="option">Yes</div><div role="option">No</div></div>'
      + '<label for="a">Do you hold a university degree?</label><input id="a" role="combobox" aria-controls="list-a" data-ref="e1">'
      + '<div id="list-a" role="listbox"><div role="option">Yes</div><div role="option">No</div></div>');
    const selected: string[] = [];
    for (const id of ['list-a', 'list-b']) p.win.document.querySelector(`#${id} [role="option"]`)!.addEventListener('click', () => selected.push(id));
    const result = await runAction(p.page, { ref: 'e1', action: 'select', value: 'Yes', answer: 'Yes',
      question: 'Do you hold a university degree?', context: '', source: 'profile', evidence: 'Bachelor degree.' });
    expect(result).toEqual({ ok: true });
    expect(selected).toEqual(['list-a']);
    p.close();
  });

  it('binds native address ownership even when flattened labels remain identical', () => {
    const field = { id: 'city', label: 'City', context: 'City · City', section: '', kind: 'text', options: [],
      addressContext: { section: '', owners: ['Candidate contact'], unknown: false } };
    const original = nativeFormContract(field);
    expect(nativeFormContract({ ...field, addressContext: { ...field.addressContext, owners: ['Employer address'] } })).not.toEqual(original);
    expect(nativeFormContract({ ...field, addressContext: { ...field.addressContext, unknown: true } })).toBeNull();
    expect(nativeFormContract({ ...field, addressContext: null })).toBeNull();
    expect(nativeFormContract({ ...field, addressContext: undefined })).toBeNull();
    expect(nativeFormContract({ id: 'city', label: 'City', context: 'City · City', section: '', kind: 'text', options: [] }))
      .not.toEqual(original);
  });

  it('holds an exact Q/A when its current answer-map value contradicts the attestation', async () => {
    const p = portal();
    const snapshot = await freshQualificationFields(p.page);
    const field = snapshot.fields[0];
    const source = context('Bachelor degree.', { flow: { answers: { current_degree: 'No' } },
      answerEvidence: [{ id: 'own', key: 'current_degree', category: 'qualification', question: { question: field.label, originalNativeContract: nativeFormContract(field),
        context: field.context, section: field.section, autocomplete: field.autocomplete, options: [], type: field.inputType, validation: field.validation },
      answer: 'Yes', provenance: { actor: 'candidate', round: 1 } }] });
    expect(() => verifier(async () => ({}), source).claim(field, action(field.id))).toThrow();
    p.close();
  });

  it('routes unrelated producer history to the blind judge without blanket-tainting a confirmed degree', async () => {
    const p = portal();
    const snapshot = await freshQualificationFields(p.page);
    const field = snapshot.fields[0];
    const originalNativeContract = nativeFormContract(field);
    const source = context('', { draft: { round: 1, cvKey: 'original', sourceCvHash: sha(Buffer.from('')),
      factSources: { text: '', answers: ['3 months', 'Switzerland'].join('\n') } }, answerEvidence: [{ id: 'degree',
      key: 'degree', category: 'qualification', question: { question: field.label, originalNativeContract,
        context: field.context, section: field.section, autocomplete: field.autocomplete, options: [], type: 'yes_no' },
      answer: 'Yes', provenance: { actor: 'candidate', round: 1 } }] });
    let calls = 0;
    let observed: any;
    const gate = verifier(async ({ prompt }: any) => { calls++; observed = payload(prompt); return judgement(observed, true); }, source);
    const item = action(field.id);
    const claim = gate.claim(field, item);
    expect(claim).not.toBeNull();
    await gate.verify([claim], { url: p.page.url() });
    gate.assert(field, item, 'Yes', { url: p.page.url() });
    expect(calls).toBe(2);
    expect(observed.unverifiedContext.historicalContext).toBe('3 months\nSwitzerland');
    expect(p.mutations()).toBe(0);
    p.close();
  });

  it('preserves typed contact identity and requested soft defaults without new facts', async () => {
    const p = portal('<label for="a">First name</label><input id="a" data-ref="e1">');
    const snapshot = await freshQualificationFields(p.page);
    const codex = async () => ({ actions: [{ ...action(snapshot.fields[0].id, 'Test'), source: 'identity', evidence: '' }], missingRequired: [] });
    const plan = await planPage({ page: p.page, snapshot, candidate, codex });
    expect(plan.actions[0].value).toBe('Test');
    expect(mechanicallyGroundedPortalAction(candidate, { label: 'Notice period', kind: 'text', options: [] }, { action: 'fill', value: '3 months', source: 'policy_default' })).toBe(true);
    p.close();
  });

  it('verifies an agent checkbox click as its actual Yes commit under the same pure consent rule', async () => {
    const p = portal('<label for="a">I agree to the Privacy Policy</label><input id="a" type="checkbox" data-ref="e1">');
    let calls = 0;
    await completeWithAgent({ page: p.page, hint: 'application', candidate, maxRounds: 1,
      qualificationVerifier: createPortalQualificationVerifier({ context: context('IT manager'), candidate }),
      codex: async () => { calls++; return { status: 'act', reason: '', questions: [], advanceRef: '', submitRef: '', actions: [
        { ref: 'e1', action: 'click', value: '', question: 'I agree to the Privacy Policy', source: 'consent', evidence: '', document: 'none' }], }; } });
    expect((p.win.document.querySelector('#a') as HTMLInputElement).checked).toBe(true);
    expect(calls).toBe(1);
    p.close();
  });

  it('uses an attested native No as a veto even if a policy callback would grant Yes', async () => {
    const p = portal('<label for="a">I agree to the privacy policy for this application</label><input id="a" type="checkbox" data-ref="e1">');
    const snapshot = await freshQualificationFields(p.page);
    const field = snapshot.fields[0];
    const source = context('', { answerEvidence: [{ id: 'privacy', category: 'form_preference', answer: 'No',
      question: { question: field.label, context: field.context, section: field.section, autocomplete: field.autocomplete,
        type: 'yes_no', options: ['Yes', 'No'] }, provenance: { actor: 'candidate', round: 1 } }] });
    const gate = createPortalQualificationVerifier({ context: source, candidate,
      codex: async () => { throw new Error('cannot override a refusal with a model'); } });
    expect(gate.refuses(field)).toBe(true);
    expect(() => gate.claim(field, { fieldId: field.id, action: 'check', value: '', source: 'consent' }))
      .toThrowError(expect.objectContaining({ code: 'evidence_entailment_unverified', reason: 'native_attested_refusal' }));
    expect(p.mutations()).toBe(0);
    p.close();
  });

  it.each(['planner_skip', 'agent_done'])('does not endorse a prechecked degree via %s', async mode => {
    const p = portal('<label for="a">Do you hold a university degree?</label><input id="a" type="checkbox" checked data-ref="e1">');
    const snapshot = await freshQualificationFields(p.page);
    let calls = 0;
    const codex = async ({ prompt }: any) => ++calls === 1
      ? mode === 'planner_skip' ? { actions: [{ ...action(snapshot.fields[0].id), action: 'skip' }], missingRequired: [] }
        : { status: 'done', reason: '', actions: [], questions: [], advanceRef: '', submitRef: '' }
      : judgement(payload(prompt), false);
    const gate = verifier(codex);
    const run = mode === 'planner_skip' ? planPage({ page: p.page, snapshot, candidate, codex, qualificationVerifier: gate })
      : completeWithAgent({ page: p.page, hint: 'review', candidate, codex, qualificationVerifier: gate });
    await expect(run).rejects.toMatchObject({ code: 'evidence_entailment_unverified' });
    expect(calls).toBe(3);
    expect(p.mutations()).toBe(0);
    p.close();
  });

  it('never exempts a prechecked consent with unknown ownership', async () => {
    const p = portal('<label for="a">I agree to the privacy policy</label><input id="a" type="checkbox" checked data-ref="e1">');
    const snapshot = await freshQualificationFields(p.page);
    const field = { ...snapshot.fields[0], consentOwnershipUnknown: true };
    const gate = createPortalQualificationVerifier({ context: context(), candidate,
      codex: async () => { throw new Error('unknown ownership is not a factual claim'); } });
    const item = { fieldId: field.id, action: 'check', value: 'Yes', source: 'consent' };
    expect(gate.needs(field, item)).toBe(true);
    expect(() => gate.claim(field, item)).toThrowError(expect.objectContaining({ reason: 'form_contract_unbound' }));
    expect(() => gate.assert(field, item, 'Yes')).toThrow();
    expect(p.mutations()).toBe(0);
    p.close();
  });

  it.each(['submission_already_sent', 'submission_claim_changed'])('propagates final %s through the actual portal loop without clicking', async code => {
    const p = portal('<label for="a">First name</label><input id="a" data-ref="e1" value="Test" required>'
      + '<label for="surname">Last name</label><input id="surname" value="User" required>'
      + '<label for="email">Email</label><input id="email" type="email" value="test@example.test" required>'
      + '<button type="submit">Submit application</button>');
    const page = p.page;
    page.evaluate = async (fn: any, arg: any) => p.win.eval(`(${fn.toString()})(${JSON.stringify(arg) ?? 'undefined'})`);
    page.goto = async () => ({ status: () => 200 });
    page.waitForLoadState = async () => {};
    page.on = page.off = () => {};
    page.screenshot = async () => Buffer.from('synthetic');
    let contextClosed = false;
    const context = { pages: () => [], on() {}, off() {}, newPage: async () => page,
      close: async () => { contextClosed = true; } };
    const browser = { newContext: async () => context, close: async () => {}, version: () => '130' };
    const sentinel = Object.assign(new Error(code), { code, record: { state: 'sent', attemptId: 'another-attempt' } });
    let callbacks = 0;
    await expect(submitViaPortal({ applyUrl: page.url(), channelType: 'lever', skipPostingCheck: true,
      candidate: { ...candidate, identity: { ...candidate.identity, lastName: 'User' } }, files: {},
      codex: async () => ({ actions: [], missingRequired: [] }), launch: async () => browser,
      onBeforeSubmit: async () => { callbacks++; throw sentinel; } }))
      .rejects.toBe(sentinel);
    expect(callbacks).toBe(1);
    expect(p.mutations()).toBe(0);
    expect(contextClosed).toBe(true);
    p.close();
  });
  it('normalizes only a DOM-proven standalone live counter, preserving numeric prose and the maximum', async () => {
    expect(nativeQuestionText('Write 100/500 characters describing your experience')).toContain('100/500');
    expect(nativeQuestionText('0/200 chars')).toBe('0/200 chars');
    expect(nativeQuestionText('0/200 chars', { currentLength: 0, maxLength: 200 })).toBe('max 200 chars');
    const p = portal('<label for="a">Motivation <span>0/200 chars</span></label><textarea id="a" maxlength="200"></textarea>');
    const first = (await freshQualificationFields(p.page)).fields[0];
    (p.win.document.querySelector('textarea') as HTMLTextAreaElement).value = 'abcdef';
    p.win.document.querySelector('span')!.textContent = '6/200 chars';
    const second = (await freshQualificationFields(p.page)).fields[0];
    expect(nativeFormContract(first)).toEqual(nativeFormContract(second));
    p.win.document.querySelector('textarea')!.setAttribute('maxlength', '400');
    p.win.document.querySelector('span')!.textContent = '6/400 chars';
    expect(nativeFormContract((await freshQualificationFields(p.page)).fields[0])).not.toEqual(nativeFormContract(first));
    p.close();
  });

  it('preserves full long questions and their own conditions without sibling-label truncation', async () => {
    const question = 'Please read this question carefully. '.repeat(12) + 'Do you hold an accredited university degree?';
    const p = portal(`<fieldset><legend>Application</legend><label for="a">${question}</label><input id="a" aria-describedby="condition"><p id="condition">Only an accredited academic degree qualifies.</p>${Array.from({ length: 20 }, (_, index) => `<label for="other${index}">Other unrelated field</label><input id="other${index}">`).join('')}</fieldset>`);
    const contract = nativeFormContract((await freshQualificationFields(p.page)).fields[0]);
    expect(contract.question).toBe(question);
    expect(contract.context).toContain('Only an accredited academic degree qualifies.');
    expect(contract.context).not.toContain('Other unrelated field');
    p.close();
  });

  it('does not graft native select semantics from another form or fieldset', async () => {
    const p = portal('<fieldset><label for="a">Own question</label><button id="a-button" class="ui-selectmenu-button" aria-owns="a-menu" data-aa-id="proxy">Open</button></fieldset><fieldset><label for="a">Other question</label><select id="a"><option value="yes">Yes</option></select></fieldset>');
    const { withNativeValidation } = await import('../scripts/assisted-application/lib/portal/qualification-gate.mjs');
    const fields = await withNativeValidation(p.page, [{ id: 'proxy', frame: 0, widget: 'jquery-selectmenu', nativeSelectId: 'a', kind: 'combobox', label: 'Own question' }]);
    expect(fields[0].nativeContractUnavailable).toBe(true);
    expect(fields[0].originalNativeContract).toBeNull();
    p.close();
  });

  it('allows only current byte-identical approved document transport under a pure native purpose', async () => {
    const p = portal('<label for="a">Motivation</label><textarea id="a"></textarea>');
    const field = (await freshQualificationFields(p.page)).fields[0];
    const privateContext = { ...context('Bachelor degree.'), documentsCurrent: true, approvedDocumentTexts: { coverLetter: 'Approved letter.', motivation: '', whyCompany: '' } };
    const gate = verifier(async () => { throw new Error('must not infer approved transport'); }, privateContext);
    expect(gate.claim(field, action(field.id, 'Approved letter.'))).toBeNull();
    expect(gate.claim(field, action(field.id, 'Different text.'))).not.toBeNull();
    const withCondition = { ...field, section: 'Explain your C1 German professional experience' };
    expect(gate.claim(withCondition, action(field.id, 'Approved letter.'))).not.toBeNull();
    p.win.document.querySelector('textarea')!.setAttribute('aria-describedby', 'hard');
    p.win.document.querySelector('form')!.insertAdjacentHTML('beforeend', '<p id="hard">Explain your C1 German professional experience</p>');
    expect(gate.claim((await freshQualificationFields(p.page)).fields[0], action(field.id, 'Approved letter.'))).not.toBeNull();
    p.close();
  });

  it.each([0, false, 'No', 'Non accetto'])('never overrides the exact native consent refusal %s with a mandate default', async answer => {
    const p = portal('<label for="a">I agree to the Privacy Policy</label><input id="a" type="checkbox" required>');
    const field = (await freshQualificationFields(p.page)).fields[0];
    const receipt = { version: 'native-answer-confirmation-v1', id: 'confirmation-' + 'a'.repeat(64), contractHash: 'b'.repeat(64),
      question: { originalNativeContract: nativeFormContract(field) }, answer, category: 'local_answer', scope: 'job',
      provenance: { actor: 'candidate', orderId: 'test-order', round: 1 } };
    const gate = createPortalQualificationVerifier({ context: { ...context(), localAnswerEvidence: [receipt] }, candidate });
    expect(gate.refuses(field)).toBe(true);
    expect(() => gate.claim(field, { fieldId: field.id, action: 'check', source: 'consent' }))
      .toThrowError(expect.objectContaining({ code: 'evidence_entailment_unverified' }));
    p.close();
  });

  it('confirms pure local optional consent only for its intact original contract and current round', async () => {
    const p = portal('<label for="a">I agree to receive WhatsApp messages</label><input id="a" type="checkbox">');
    const field = (await freshQualificationFields(p.page)).fields[0];
    const receipt = { version: 'native-answer-confirmation-v1', id: 'confirmation-' + 'a'.repeat(64), contractHash: 'b'.repeat(64),
      question: { originalNativeContract: nativeFormContract(field) }, answer: true, category: 'local_answer', scope: 'job',
      provenance: { actor: 'candidate', orderId: 'test-order', round: 1 } };
    const gate = createPortalQualificationVerifier({ context: { ...context(), localAnswerEvidence: [receipt] } });
    expect(gate.claim(field, { fieldId: field.id, action: 'check', source: 'answers' })).toBeNull();
    expect(gate.claim({ ...field, label: 'I agree to the Privacy Policy' }, { fieldId: field.id, action: 'check', source: 'answers' })).not.toBeNull();
    const stale = createPortalQualificationVerifier({ context: { ...context(), localAnswerEvidence: [{ ...receipt, provenance: { ...receipt.provenance, round: 2 } }] } });
    expect(stale.claim(field, { fieldId: field.id, action: 'check', source: 'answers' })).not.toBeNull();
    p.close();
  });

  it('defaults only a pure individual application-origin question and preserves a contrary local attestation', async () => {
    const text = 'Is this application submitted by a recruitment agency?';
    expect(individualApplicationOriginQuestion(text)).toBe(true);
    expect(individualApplicationOriginQuestion('Have you worked for a recruitment agency?')).toBe(false);
    const p = portal(`<label for="a">${text}</label><select id="a"><option>Yes</option><option>No</option></select>`);
    const field = (await freshQualificationFields(p.page)).fields[0];
    const item = { fieldId: field.id, action: 'select', value: 'No', source: 'rule' };
    expect(mechanicallyGroundedPortalAction(candidate, field, item)).toBe(true);
    expect(mechanicallyGroundedPortalAction(candidate, { ...field, section: 'Confirm that you hold a degree' }, item)).toBe(false);
    const receipt = { question: { originalNativeContract: nativeFormContract(field) }, answer: 'Yes', provenance: { actor: 'candidate' } };
    const gate = createPortalQualificationVerifier({ context: { ...context(), localAnswerEvidence: [receipt] },
      candidate: candidate });
    expect(() => gate.claim(field, item)).toThrowError(expect.objectContaining({ reason: 'native_attested_answer_conflict' }));
    p.close();
  });

  it('uses displayed native option labels and excludes disabled optgroups', async () => {
    const p = portal('<label for="a">Do you hold a degree?</label><select id="a"><option value="v" label="Yes">No</option><optgroup label="Disabled" disabled><option value="n">No</option></optgroup></select>');
    const field = (await freshQualificationFields(p.page)).fields[0];
    expect(nativeFormContract(field).options).toEqual(['Yes']);
    expect(nativeFormContract(field).optionValues).toEqual([{ label: 'Yes', value: 'v' }]);
    p.close();
  });

  it('gates an unchecked factual checkbox when a proven successful hidden fallback submits No', async () => {
    const p = portal('<input type="hidden" name="sponsorship" value="No"><label for="a">Do you require employer sponsorship?</label><input id="a" type="checkbox" name="sponsorship" value="Yes">');
    expect(new p.win.FormData(p.win.document.querySelector('form')!).getAll('sponsorship')).toEqual(['No']);
    const field = (await freshQualificationFields(p.page)).fields[0];
    const [submission] = existingPortalAnswers([field]);
    expect(submission).toMatchObject({ action: 'uncheck', value: 'No' });
    const gate = verifier(async ({ prompt }: any) => judgement(payload(prompt), false), context('I require employer sponsorship.'));
    const claim = gate.claim(field, submission);
    expect(claim).toMatchObject({ proposedAnswer: 'No' });
    await expect(gate.verify([claim])).rejects.toMatchObject({ code: 'evidence_entailment_unverified' });
    const record = { question: { originalNativeContract: nativeFormContract(field) }, answer: 'No', provenance: { actor: 'candidate' } };
    const own = createPortalQualificationVerifier({ context: { ...context(), answerEvidence: [record] } });
    expect(own.claim(field, submission)).toBeNull();
    expect(p.mutations()).toBe(0);
    p.close();
  });

  it('does not invent No for a plain unchecked checkbox or a disabled hidden fallback', async () => {
    const p = portal('<input type="hidden" name="sponsorship" value="No" disabled><label for="a">Do you require employer sponsorship?</label><input id="a" type="checkbox" name="sponsorship" value="Yes">');
    expect([...new p.win.FormData(p.win.document.querySelector('form')!).entries()]).toEqual([]);
    expect(existingPortalAnswers((await freshQualificationFields(p.page)).fields)).toEqual([]);
    p.close();
  });

  it('audits successful fallback transport even when its disabled native checkbox cannot be mutated', async () => {
    const p = portal('<input type="hidden" name="sponsorship" value="No"><label for="a">Do you require employer sponsorship?</label><input id="a" type="checkbox" name="sponsorship" value="Yes" disabled>');
    expect(new p.win.FormData(p.win.document.querySelector('form')!).getAll('sponsorship')).toEqual(['No']);
    const field = (await freshQualificationFields(p.page)).fields[0];
    expect(field.disabled).toBe(true);
    expect(field.auditOnly).toBe(true);
    expect(existingPortalAnswers([field])[0]).toMatchObject({ action: 'uncheck', value: 'No' });
    p.close();
  });

  it('holds duplicate hidden fallbacks and lets only the pure consent policy omit a marketing opt-in', async () => {
    const p = portal('<input type="hidden" name="news" value="No"><label for="a">I agree to receive marketing messages</label><input id="a" type="checkbox" name="news" value="Yes">');
    const field = (await freshQualificationFields(p.page)).fields[0];
    const [optout] = existingPortalAnswers([field]);
    expect(mechanicallyGroundedPortalAction(candidate, field, optout)).toBe(true);
    p.win.document.querySelector('form')!.insertAdjacentHTML('beforeend', '<input type="hidden" name="news" value="No">');
    const ambiguous = (await freshQualificationFields(p.page)).fields[0];
    expect(nativeFormContract(ambiguous)).toBeNull();
    await expect(planPage({ page: p.page, snapshot: { fields: [ambiguous] }, candidate,
      codex: async () => ({ actions: [], missingRequired: [] }), qualificationVerifier: verifier(async () => ({})) }))
      .rejects.toMatchObject({ code: 'evidence_entailment_unverified', reason: 'form_contract_unbound' });
    p.close();
  });

  it('verifies the rendered text rather than authorizing an approved letter before truncation', async () => {
    const p = portal('<label for="a">Motivation</label><textarea id="a" maxlength="12"></textarea>');
    const snapshot = await freshQualificationFields(p.page);
    const approved = 'My approved motivation letter has several sentences.';
    const source = { ...context('Bachelor degree.'), documentsCurrent: true, approvedDocumentTexts: { coverLetter: approved } };
    let calls = 0;
    let seen: any;
    const codex = async ({ prompt }: any) => ++calls === 1 ? { actions: [action(snapshot.fields[0].id, approved)], missingRequired: [] }
      : (seen = payload(prompt), judgement(seen, false));
    await expect(planPage({ page: p.page, snapshot, candidate, codex, qualificationVerifier: verifier(codex, source) }))
      .rejects.toMatchObject({ code: 'evidence_entailment_unverified' });
    expect(seen.claims[0].proposedAnswer).not.toBe(approved);
    expect(seen.claims[0].proposedAnswer.length).toBeLessThanOrEqual(12);
    expect(p.mutations()).toBe(0);
    p.close();
  });

  it('renders a known own phone to its native national-length control before the gate', async () => {
    const p = portal('<label for="code">Country phone code</label><input id="code" value="Switzerland"><label for="a">Phone number</label><input id="a" type="tel" maxlength="9">');
    const snapshot = await freshQualificationFields(p.page);
    const field = snapshot.fields.find((field: any) => field.label === 'Phone number');
    const ownCandidate = { ...candidate, identity: { ...candidate.identity, phone: '+41791234567' } };
    let calls = 0;
    const gate = createPortalQualificationVerifier({ context: context(), candidate: ownCandidate });
    const plan = await planPage({ page: p.page, snapshot, candidate: ownCandidate, qualificationVerifier: gate,
      codex: async () => { calls++; return { actions: [action(field.id, '+41791234567')], missingRequired: [] }; } });
    expect(plan.actions[0].value).toBe('791234567');
    expect(calls).toBe(1);
    await applyActions(p.page, snapshot.fields, plan.actions, {}, { pause: async () => {}, beforeAction: qualificationActionFence({ page: p.page, verifier: gate }) });
    expect((p.win.document.querySelector('#a') as HTMLInputElement).value).toBe('791234567');
    p.close();
  });

  it('routes a changed origin counter through the blind judge without erasing the attested primary', async () => {
    const p = portal();
    const field = (await freshQualificationFields(p.page)).fields[0];
    const record = { id: 'global-attested', question: { originalNativeContract: nativeFormContract(field) }, answer: 'Yes', provenance: { actor: 'candidate' } };
    const origin = { answerIds: [record.id], changedSinceConfirmation: true, confirmedHash: 'a', currentHash: 'b', context: { candidateNotes: 'Unrelated phone update.' } };
    const privateContext = { ...context(), answerEvidence: [record], unverifiedContext: { answerOrigins: [origin] } };
    const gate = createPortalQualificationVerifier({ context: privateContext });
    expect(gate.claim(field, action(field.id))).not.toBeNull();
    expect(privateContext.answerEvidence).toEqual([record]);
    p.close();
  });

  it.each([false, true])('audits a successful readonly factual value before final submit (supported=%s)', async supported => {
    const p = portal('<label for="a">Do you hold a university degree?</label><input id="a" name="degree" value="Yes" readonly required>');
    const snapshot = await freshQualificationFields(p.page);
    expect(snapshot.fields[0]).toMatchObject({ auditOnly: true, readOnly: true, value: 'Yes' });
    let calls = 0;
    const codex = async ({ prompt }: any) => ++calls === 1 ? { actions: [], missingRequired: [] } : judgement(payload(prompt), supported);
    const gate = verifier(codex, context(supported ? 'Bachelor degree in Computer Science.' : 'Senior IT Manager'));
    const run = planPage({ page: p.page, snapshot, candidate, codex, qualificationVerifier: gate });
    if (supported) {
      expect((await run).actions).toEqual([]);
      await assertExistingPortalAnswers(p.page, gate, { url: p.page.url() });
    } else await expect(run).rejects.toMatchObject({ code: 'evidence_entailment_unverified' });
    expect(calls).toBe(3);
    expect(p.mutations()).toBe(0);
    p.close();
  });

  it('captures a plain restriction owned by the one native question without an ARIA reference', async () => {
    const p = portal('<fieldset><legend>Education</legend><label for="a">Do you hold a university degree?</label><p>Only University X degrees qualify.</p><input id="a" name="degree" required></fieldset>');
    const field = (await freshQualificationFields(p.page)).fields[0];
    expect(nativeFormContract(field).context).toContain('Only University X degrees qualify.');
    expect(field.originalNativeContract).toEqual(nativeFormContract(field));
    p.close();
  });

  it('never lets privacy mandate defaults erase a plain group qualification', async () => {
    const p = portal('<fieldset><legend>Application</legend><label for="a">I agree to the Privacy Policy</label><p>I confirm that I hold a university degree.</p><input id="a" type="checkbox" required></fieldset>');
    const field = (await freshQualificationFields(p.page)).fields[0];
    expect(field.ownConsentText).toContain('I confirm that I hold a university degree.');
    expect(mechanicallyGroundedPortalAction(candidate, field, { action: 'check', source: 'consent' })).toBe(false);
    p.close();
  });

  it('does not assign unassociated restrictions from a shared question group', async () => {
    const p = portal('<fieldset><legend>Education</legend><label for="a">Do you hold a university degree?</label><p>Only University X degrees qualify.</p><input id="a" name="degree"><label for="b">Institution</label><input id="b" name="institution"></fieldset>');
    const field = (await freshQualificationFields(p.page)).fields[0];
    expect(field.nativeContractUnavailable).toBe(true);
    expect(nativeFormContract(field)).toBeNull();
    p.close();
  });

  it('can use an intact job-local hard-answer receipt without a global user profile', async () => {
    const p = portal();
    const field = (await freshQualificationFields(p.page)).fields[0];
    const receipt = { version: 'native-answer-confirmation-v1', id: 'confirmation-' + 'a'.repeat(64), contractHash: 'b'.repeat(64),
      question: { originalNativeContract: nativeFormContract(field) }, answer: 'Yes', category: 'local_answer', scope: 'job',
      provenance: { actor: 'candidate', orderId: 'test-order', round: 1 } };
    const gate = createPortalQualificationVerifier({ context: { ...context(), answerEvidence: [], localAnswerEvidence: [receipt] } });
    expect(gate.claim(field, action(field.id))).toBeNull();
    expect(gate.claim({ ...field, label: 'Do you hold a doctorate in medicine?' }, action(field.id))).not.toBeNull();
    p.close();
  });

  it.each(['Reference', 'Employer', 'Spouse', 'Reference · Personal data', 'Unknown household account'])('never uses own contact identity for %s ownership', async owner => {
    const p = portal(`<fieldset aria-label="${owner}"><label for="a">Your email</label><input id="a" type="email" autocomplete="email"></fieldset>`);
    const field = (await freshQualificationFields(p.page)).fields[0];
    const contract = nativeFormContract(field);
    expect(candidateIdentityRole(contract)).toBe('email');
    expect(isCandidateIdentityTarget(contract)).toBe(false);
    expect(mechanicallyGroundedPortalAction(candidate, field, action(field.id, candidate.identity.email))).toBe(false);
    p.close();
  });

  it.each(['Dati personali', 'Persönliche Angaben', 'Informations personnelles', 'Applicant contact details'])('allows a complete own email caption in %s', async owner => {
    const p = portal(`<fieldset aria-label="${owner}"><label for="a">Email address</label><input id="a" type="email" autocomplete="email"></fieldset>`);
    const field = (await freshQualificationFields(p.page)).fields[0];
    expect(isCandidateIdentityTarget(nativeFormContract(field))).toBe(true);
    expect(mechanicallyGroundedPortalAction(candidate, field, action(field.id, candidate.identity.email))).toBe(true);
    p.close();
  });

  it('requires an actual positive actor and preserves the same pure policy in the browser realm', async () => {
    const p = portal('<label for="a">Email</label><input id="a" type="email" autocomplete="email">');
    p.win.document.querySelector('form')!.removeAttribute('aria-label');
    const unowned = nativeFormContract((await freshQualificationFields(p.page)).fields[0]);
    expect(isCandidateIdentityTarget(unowned)).toBe(false);
    const factory = p.win.eval(`(${createCandidateIdentityContract.toString()})`);
    const browser = factory({ nativeQuestionText: p.win.eval(`(${nativeQuestionText.toString()})`) });
    expect(browser.isCandidateIdentityTarget(unowned)).toBe(false);
    p.win.document.querySelector('label')!.textContent = 'Your email';
    const self = nativeFormContract((await freshQualificationFields(p.page)).fields[0]);
    expect(isCandidateIdentityTarget(self)).toBe(true);
    expect(browser.isCandidateIdentityTarget(self)).toBe(true);
    expect(isCandidateIdentityTarget({ ...self, ownedScopes: undefined })).toBe(false);
    expect(isCandidateIdentityTarget({ ...self, ownedScopes: [{ kind: 'group', names: [], unknown: true }] })).toBe(false);
    p.close();
  });

  it('does not treat contact-preference checkboxes or qualified email clauses as identity purposes', async () => {
    const p = portal('<label for="a">Your email</label><input id="a" type="checkbox">');
    expect(isCandidateIdentityTarget(nativeFormContract((await freshQualificationFields(p.page)).fields[0]))).toBe(false);
    p.close();
    const q = portal('<label for="a">Your email, if you hold a university degree</label><input id="a" type="email">');
    expect(isCandidateIdentityTarget(nativeFormContract((await freshQualificationFields(q.page)).fields[0]))).toBe(false);
    q.close();
  });

  it('does not assign ARIA containers containing foreign controls or foreign labels to the current question', async () => {
    const p = portal('<label for="a">Do you hold a university degree?</label><input id="a" aria-describedby="shared"><div id="shared"><label for="other">Only University X degrees qualify.</label><input id="other"></div>');
    expect(nativeFormContract((await freshQualificationFields(p.page)).fields[0])).toBeNull();
    p.close();
  });

});
