import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { createHash } from 'node:crypto';
import { planPage, evidenceSupports, mechanicallyGroundedPortalAction } from '../scripts/assisted-application/lib/portal/plan.mjs';
import { completeWithAgent, runAction } from '../scripts/assisted-application/lib/portal/agent.mjs';
import { applyActions } from '../scripts/assisted-application/lib/portal/fill.mjs';
import { createPortalQualificationVerifier, freshQualificationFields, portalQualificationContext, qualificationActionFence, nativeFormContract } from '../scripts/assisted-application/lib/portal/qualification-gate.mjs';

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
  ? { index, sourceIds: [data.sources[0].sourceId] }
  : { index, proofId: claim.proof.id, verdict: supported ? 'supported' : 'unsupported', reason: supported ? 'explicit_fact' : 'title_without_activity' }) });

/** The production extractor and ref resolver run against a real DOM, not invented field bindings. */
function portal(html = '<label for="a">Do you hold a university degree?</label><input id="a" data-ref="e1" required>') {
  const dom = new JSDOM(`<form>${html}</form>`, { url: 'https://jobs.example.test/apply', runScripts: 'outside-only' });
  const win = dom.window;
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
    trustedAction: (field: any, item: any) => mechanicallyGroundedPortalAction(candidate, field, item) });
}

describe('native form answer entailment before mutations', () => {
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

  it('does not reuse exact-QA permission when numeric validation changes', async () => {
    const p = portal('<label for="a">Years of Python experience?</label><input id="a" type="number" data-ref="e1">');
    const snapshot = await freshQualificationFields(p.page);
    const field = snapshot.fields[0];
    const source = context('', { answerEvidence: [{ id: 'own', category: 'qualification',
      question: { question: field.label, context: field.context, section: field.section, autocomplete: field.autocomplete,
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
      answerEvidence: [{ id: 'own', category: 'qualification', question: { question: field.label,
        context: field.context, section: field.section, autocomplete: field.autocomplete, options: [], type: field.inputType, validation: field.validation },
      answer: 'Yes', provenance: { actor: 'candidate', round: 1 } }] });
    const gate = verifier(async () => { throw new Error('must not override current correction'); }, source);
    expect(() => gate.claim(field, action(field.id))).toThrow();
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
      answerEvidence: [{ id: 'own', key: 'current_degree', category: 'qualification', question: { question: field.label,
        context: field.context, section: field.section, autocomplete: field.autocomplete, options: [], type: field.inputType, validation: field.validation },
      answer: 'Yes', provenance: { actor: 'candidate', round: 1 } }] });
    expect(() => verifier(async () => ({}), source).claim(field, action(field.id))).toThrow();
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
});
