/** Private, source-bound verification of factual answers before a portal mutation. */
import { createHash } from 'node:crypto';
import { codexPrompt } from '../../../../functions/src/assistedApplicationAiPrompts.js';
import { qualificationSources, nativeFormAssessmentHash, verifyNativeFormAnswers } from '../../../../functions/src/lib/qualificationEvidence.js';
import { extractFields } from './fields.mjs';
import { addressContextContract } from '../../../../functions/src/lib/addressContextContract.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const normalized = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const comparable = value => normalized(value).toLowerCase();
const VALUES = new Set(['fill', 'type', 'select', 'check', 'uncheck']);
const MAX_FIELDS = 12;

export class PortalQualificationUnverified extends Error {
  constructor(reason = 'evidence_unverified') {
    super('portal_qualification_evidence_unverified');
    this.name = 'PortalQualificationUnverified';
    // The common flow retries this technical failure at most three times.
    this.code = 'evidence_entailment_unverified';
    // Only a bounded machine reason, never a question, answer or CV passage.
    this.reason = /^[a-z_]{1,60}$/.test(reason) ? reason : 'evidence_unverified';
  }
}

/** The source was extracted for this exact approved CV, not its tailored replacement. */
export function portalQualificationContext({ order = {}, orderId = '', draft = {}, cvBuffer, answerEvidence = [], flow = {} }) {
  const currentHash = Buffer.isBuffer(cvBuffer) ? digest(cvBuffer) : '';
  const sameCv = Boolean(currentHash && draft.cvKey && draft.cvKey === order.cvStorageKey
    && draft.sourceCvHash === currentHash);
  const sourceText = sameCv && typeof draft.factSources?.text === 'string' ? draft.factSources.text : '';
  return {
    sources: qualificationSources({ sourceText, answerEvidence }),
    answerEvidence,
    scope: { orderId, round: Number(draft.round) || 1, jobUrl: order.jobUrl || draft.job?.applyUrl || '',
      sourceCvHash: sameCv ? currentHash : null },
    // These are counter-evidence only. They never create a citable fact.
    unverifiedContext: { candidateNotes: flow.candidateNotes || order.candidateNotes || '', historicalContext: draft.factSources?.answers || '', feedback: flow.feedback || [],
      formOverrides: flow.formOverrides || {}, values: flow.answers || {} },
  };
}

/** Native contracts remain complete; an extractor cap is not an attestation. */
export function nativeFormContract(field) {
  if (!field || field.nativeContractUnavailable || typeof field.id !== 'string' || !normalized(field.label)) return null;
  const text = ['label', 'context', 'section', 'autocomplete'];
  if (text.some(key => field[key] != null && typeof field[key] !== 'string')) return null;
  // The native reader caps labels at 300. At the boundary completeness is unknown.
  if (String(field.label).length >= 300 || String(field.context || '').length >= 240
    || String(field.section || '').length >= 300 || String(field.autocomplete || '').length > 100) return null;
  if (field.options != null && !Array.isArray(field.options)) return null;
  const options = (field.options || []).map(option => typeof option === 'string' ? option : option?.label);
  if (options.some(option => typeof option !== 'string' || option.length >= 300)) return null;
  const optionKeys = options.map(comparable);
  if (new Set(optionKeys).size !== optionKeys.length) return null;
  const addressContext = addressContextContract(field);
  if (addressContext === null || addressContext?.unknown) return null;
  return { question: normalized(field.label), context: normalized(field.context), section: normalized(field.section),
    ...(addressContext === undefined ? {} : { addressContext }),
    controlType: field.inputType || field.kind || '', kind: field.kind || '',
    optionValues: (field.options || []).map(option => typeof option === 'string' ? { label: option } : { label: option.label,
      ...(option.value == null ? {} : { value: String(option.value) }) }),
    autocomplete: normalized(field.autocomplete), options, validation: field.validation || {
      ...(field.inputType ? { type: field.inputType } : {}), ...(field.required != null ? { required: field.required } : {}),
      ...(field.min != null ? { min: field.min } : {}), ...(field.max != null ? { max: field.max } : {}),
      ...(field.pattern ? { pattern: field.pattern } : {}),
    } };
}

export function isQualificationAction(field, action) {
  if (!field || !action || field.inputType === 'password' || action.action === 'upload' || action.action === 'skip') return false;
  const answer = action.action === 'check' ? 'Yes' : action.action === 'uncheck' ? 'No' : action.answer || action.value;
  if (answer == null || String(answer).trim() === '') return false;
  // All committed answers pass the gate unless a separate deterministic
  // identity/mandate/policy rule proves them. An unknown label is not a bypass.
  return true;
}

function exactAttestedAnswer(context, field, answer) {
  const contract = nativeFormContract(field);
  if (!contract) return false;
  const matched = (context?.answerEvidence || []).filter(record => {
    if (!['candidate', 'owner'].includes(record?.provenance?.actor)) return false;
    const question = record.question || {};
    const names = [question.applicationQuestion, question.question].filter(Boolean).map(comparable);
    return names.includes(comparable(contract.question))
      && comparable(question.context) === comparable(contract.context)
      && comparable(question.section) === comparable(contract.section)
      && comparable(question.autocomplete) === comparable(contract.autocomplete)
      && JSON.stringify(addressContextContract(question)) === JSON.stringify(addressContextContract(field))
      && JSON.stringify((question.options || []).map(option => comparable(typeof option === 'string' ? option : option.label))) === JSON.stringify(contract.options.map(comparable))
      && comparable(question.type) === comparable(field.inputType || field.kind)
      && JSON.stringify(Object.entries(question.validation || {}).sort()) === JSON.stringify(Object.entries(contract.validation).sort())
      && comparable(record.answer) === comparable(answer);
  });
  return matched.length === 1;
}

function hasUnverifiedCorrections(context, actualAnswer) {
  const counter = context?.unverifiedContext || {};
  const current = counter.values || {};
  const conflict = (context?.answerEvidence || []).some(record => [record.id, record.key, record.question?.id, record.question?.question, record.question?.applicationQuestion]
    .filter(Boolean).some(key => Object.hasOwn(current, key) && comparable(current[key]) !== comparable(record.answer)));
  return Boolean(normalized(counter.candidateNotes)
    || (Array.isArray(counter.feedback) ? counter.feedback.length : normalized(counter.feedback))
    || Object.keys(counter.formOverrides || {}).length || conflict
    || normalized(counter.historicalContext) && comparable(counter.historicalContext) !== comparable(actualAnswer));
}

function fieldKey(field) { return String(field.frame || 0) + ':' + field.id; }
export function proposedNativeAnswer(field, action, value = action.action === 'check' ? 'Yes' : action.action === 'uncheck' ? 'No' : action.value) {
  if (['select', 'radio', 'listbox', 'combobox'].includes(field.kind) && field.options?.length) {
    const options = field.options.filter(option => comparable(option.label) === comparable(value) || option.value != null && String(option.value) === String(value));
    if (options.length !== 1) throw new PortalQualificationUnverified('native_option_ambiguous');
    return options[0].label;
  }
  return value;
}

function validNativeValue(field, value) {
  const constraints = field.validation || {};
  const text = String(value ?? '');
  if (Number(constraints.maxlength || field.maxLength) > 0 && text.length > Number(constraints.maxlength || field.maxLength)) return false;
  if (Number(constraints.minlength) > 0 && text.length < Number(constraints.minlength)) return false;
  if (constraints.pattern) {
    try { if (!new RegExp(`^(?:${constraints.pattern})$`, 'v').test(text)) return false; } catch { return false; }
  }
  if (field.inputType === 'number' || constraints.type === 'number') {
    if (!text.trim() || !Number.isFinite(Number(text))) return false;
    const number = Number(text);
    if (constraints.min != null && number < Number(constraints.min) || constraints.max != null && number > Number(constraints.max)) return false;
    if (constraints.step && constraints.step !== 'any') {
      const step = Number(constraints.step);
      const position = (number - Number(constraints.min || 0)) / step;
      if (!(step > 0) || Math.abs(position - Math.round(position)) > 1e-8) return false;
    }
  }
  return true;
}

function claimFor(field, action, proposedAnswer) {
  proposedAnswer = proposedNativeAnswer(field, action, proposedAnswer);
  const native = nativeFormContract(field);
  if (!native || proposedAnswer == null || String(proposedAnswer).trim() === '') return null;
  return { fieldId: fieldKey(field), nativeFormContract: native, proposedAnswer };
}
const claimKey = claim => digest(JSON.stringify(claim));

function ownedSources(source) {
  if (!source) return null;
  try {
    const catalog = structuredClone(source.evidenceCatalog());
    const value = structuredClone({ verifiedDeclarations: source.verifiedDeclarations,
      verificationText: source.verificationText, modelAnswers: source.modelAnswers });
    return { ...value, evidenceCatalog: () => structuredClone(catalog),
      bind(quote, id) {
        const selected = catalog.find(entry => entry.id === id);
        if (selected?.quote.includes(quote)) return structuredClone(selected);
        const matches = catalog.filter(entry => entry.quote.includes(quote));
        return matches.length === 1 ? structuredClone(matches[0]) : null;
      } };
  } catch { return null; }
}

/** The cache is local to a single source/round and never enters the candidate object. */
export function createPortalQualificationVerifier({ context, codex, trustedAction = () => false }) {
  // Callers retain their objects; mutations during an awaited model call must
  // never grant permission to a different answer or newly injected Q/A.
  context = context ? { sources: ownedSources(context.sources),
    answerEvidence: structuredClone(context.answerEvidence || []),
    scope: structuredClone(context.scope || {}),
    unverifiedContext: structuredClone(context.unverifiedContext || null) } : null;
  const cache = new Map();
  const permitted = new Map();
  const ownAnswer = (field, action) => exactAttestedAnswer(context, field,
    action.answer || action.value || (action.action === 'check' ? 'Yes' : 'No'));
  const corrections = action => hasUnverifiedCorrections(context,
    action.answer || action.value || (action.action === 'check' ? 'Yes' : 'No'));
  const needs = (field, action) => isQualificationAction(field, action) && !trustedAction(field, action, context?.answerEvidence || [])
    && !(ownAnswer(field, action) && !corrections(action));
  const claim = (field, action, proposedAnswer = action.action === 'check' ? 'Yes' : action.action === 'uncheck' ? 'No' : action.value) => needs(field, action)
    ? (() => {
      if (ownAnswer(field, action) && corrections(action)) throw new PortalQualificationUnverified('counter_context_unresolved');
      return claimFor(field, action, proposedAnswer);
    })() : null;
  const verify = async (items, scope = {}) => {
    const claims = structuredClone(items.filter(Boolean));
    if (!claims.length) return;
    if (claims.length > MAX_FIELDS || !context?.sources || typeof codex !== 'function') throw new PortalQualificationUnverified('source_unbound');
    const pageScope = structuredClone({ ...context.scope, ...scope });
    const key = nativeFormAssessmentHash({ claims, sources: context.sources, scope: pageScope, unverifiedContext: context.unverifiedContext });
    let result = cache.get(key);
    if (!result) {
      result = await verifyNativeFormAnswers({ claims, sources: context.sources, scope: pageScope,
        unverifiedContext: context.unverifiedContext,
        generate: (system, user, schema, options) => codex({ prompt: codexPrompt(system, user), schema, maxTokens: options?.maxTokens, timeoutMs: 90_000 }),
      });
      // Unknown is retryable; never turn a raw model verdict into permission.
      if (result.status === 'supported') cache.set(key, result);
    }
    if (result.status !== 'supported' || result.verification?.assessmentHash !== key) {
      throw new PortalQualificationUnverified(result.verification?.failure || 'evidence_unverified');
    }
    for (const item of claims) permitted.set(claimKey({ ...item, scope: pageScope }), { claims, pageScope, key });
  };
  const assert = (field, action, proposedAnswer, scope = {}) => {
    if (!validNativeValue(field, proposedAnswer)) throw new PortalQualificationUnverified('native_value_invalid');
    if (!needs(field, action)) return;
    const item = claim(field, action, proposedAnswer);
    const proof = item && permitted.get(claimKey({ ...item, scope: { ...context?.scope, ...scope } }));
    if (!proof || nativeFormAssessmentHash({ claims: proof.claims, sources: context.sources,
      scope: proof.pageScope, unverifiedContext: context.unverifiedContext }) !== proof.key) throw new PortalQualificationUnverified('native_contract_changed');
  };
  return { needs, claim, verify, assert };
}

/** Re-read without opening dropdowns; a detached/reordered frame is not a binding. */
export async function freshQualificationFields(page, { listboxOptions = false } = {}) {
  if (typeof page?.frames !== 'function') throw new PortalQualificationUnverified('native_reader_unavailable');
  const before = page.frames();
  const snapshot = await extractFields(page, { listboxOptions });
  const after = page.frames();
  if (before.length !== after.length || before.some((frame, index) => frame !== after[index])) throw new PortalQualificationUnverified('frame_changed');
  snapshot.fields = await withNativeValidation(page, snapshot.fields);
  return snapshot;
}

/** Read constraints absent from the planner's compact field projection. */
export async function withNativeValidation(page, fields) {
  const frames = page.frames();
  const result = [];
  for (const field of fields) {
    const frame = frames[field.frame || 0];
    const native = await frame?.evaluate(id => {
      const nodes = [...document.querySelectorAll('[data-aa-id]')].filter(node => node.getAttribute('data-aa-id') === id);
      if (nodes.length !== 1) return null;
      const control = nodes[0];
      const values = {};
      for (const key of ['type', 'min', 'max', 'minlength', 'maxlength', 'pattern', 'step', 'required', 'aria-required', 'multiple']) {
        if (control.hasAttribute(key)) values[key] = control.getAttribute(key);
      }
      const refs = [...new Set([control.getAttribute('aria-controls'), control.getAttribute('aria-owns')]
        .filter(Boolean).flatMap(value => value.trim().split(/\s+/)))];
      const lists = refs.map(ref => [...document.querySelectorAll('[id]')].filter(node => node.id === ref))
        .filter(matches => matches.length === 1).map(matches => matches[0]).filter(node => node.getAttribute('role') === 'listbox');
      if (control.getAttribute('role') === 'listbox') lists.push(control);
      const owners = [...new Set(lists)];
      const options = owners.length === 1 ? [...owners[0].querySelectorAll('[role="option"]')]
        .filter(option => option.getAttribute('aria-disabled') !== 'true')
        .map(option => ({ label: String(option.getAttribute('aria-label') || option.textContent || '').replace(/\s+/g, ' ').trim(),
          value: option.getAttribute('data-value') ?? option.getAttribute('value') ?? option.textContent,
          aaId: option.getAttribute('data-aa-id') || '' })) : [];
      return { validation: values, ...(options.length ? { options } : {}) };
    }, field.id).catch(() => null);
    result.push({ ...field, ...(native || { nativeContractUnavailable: true }) });
  }
  if (frames.length !== page.frames().length || frames.some((frame, index) => frame !== page.frames()[index])) throw new PortalQualificationUnverified('frame_changed');
  return result;
}

export function uniqueNativeField(fields, id) {
  const found = fields.filter(field => field.id === id);
  return found.length === 1 ? found[0] : null;
}

/** Field/value/ownership are checked again after the model and after redraws. */
export function qualificationActionFence({ page, verifier, scope = {} }) {
  return async (field, action, { catalogueOpen = false } = {}) => {
    if (action.action === 'skip' || action.action === 'upload') return;
    const current = await freshQualificationFields(page, { listboxOptions: !catalogueOpen });
    if (current.url !== page.url() || scope.url && page.url() !== scope.url) throw new PortalQualificationUnverified('native_page_changed');
    const actual = uniqueNativeField(current.fields, field.id);
    if (!actual || (actual.frame || 0) !== (field.frame || 0)) throw new PortalQualificationUnverified('native_contract_changed');
    verifier.assert(actual, action, proposedNativeAnswer(actual, action), { ...scope, url: page.url() });
  };
}

/** Options belong to the exact control, never to the first menu on a page. */
export async function ownedOptionList(page, locator) {
  let handle;
  try {
    handle = await locator.elementHandle({ timeout: 6000 });
    if (!handle) throw new PortalQualificationUnverified('native_option_owner_unbound');
    const frame = await handle.ownerFrame();
    const id = await handle.evaluate(control => {
      const refs = [...new Set([control.getAttribute('aria-controls'), control.getAttribute('aria-owns')]
        .filter(Boolean).flatMap(value => value.trim().split(/\s+/)))];
      const lists = refs.map(ref => [...document.querySelectorAll('[id]')].filter(node => node.id === ref))
        .filter(matches => matches.length === 1).map(matches => matches[0])
        .filter(node => ['listbox', 'menu'].includes(node.getAttribute('role')));
      if (control.getAttribute('role') === 'listbox') lists.push(control);
      if (control.id && [...document.querySelectorAll('[id]')].filter(node => node.id === control.id).length === 1) {
        for (const list of document.querySelectorAll('[role="listbox"][aria-labelledby]')) {
          if (list.getAttribute('aria-labelledby').trim().split(/\s+/).includes(control.id)) lists.push(list);
        }
      }
      const owned = [...new Set(lists)];
      if (owned.length !== 1 || !owned[0].id || [...document.querySelectorAll('[id]')].filter(node => node.id === owned[0].id).length !== 1) return '';
      return owned[0].id;
    });
    if (!id || !frame || !page.frames().includes(frame)) throw new PortalQualificationUnverified('native_option_owner_unbound');
    return frame.locator(`[id="${String(id).replace(/["\\]/g, '\\$&')}"]`);
  } finally { await handle?.dispose().catch(() => {}); }
}

export async function ownedOption(page, locator, label) {
  const list = await ownedOptionList(page, locator);
  const option = list.getByRole('option', { name: label, exact: true });
  const count = await option.count();
  if (!count) throw new Error('option_not_found');
  if (count !== 1) throw new PortalQualificationUnverified('native_option_ambiguous');
  return option;
}

export async function verifyPortalActions(verifier, fields, actions, scope = {}) {
  const claims = [];
  for (const action of actions) {
    const field = uniqueNativeField(fields, action.fieldId);
    if (!field) {
      if (action.action !== 'skip' && action.action !== 'upload') throw new PortalQualificationUnverified('native_field_ambiguous');
      continue;
    }
    if (!verifier.needs(field, action)) continue;
    const claim = verifier.claim(field, action);
    if (!claim) throw new PortalQualificationUnverified('form_contract_unbound');
    claims.push(claim);
  }
  await verifier.verify(claims, scope);
}

/** An aria-ref must resolve to a field or one of its DOM-owned options. */
export async function agentNativeBinding(page, action, snapshot) {
  if (!/^(f\d+)?e\d+$/.test(action.ref || '')) return null;
  let handle;
  try {
    handle = await page.locator('aria-ref=' + action.ref).elementHandle({ timeout: 6000 });
    if (!handle) return null;
    const frame = await handle.ownerFrame();
    const frameIndex = page.frames().indexOf(frame);
    if (frameIndex < 0) return null;
    const found = await handle.evaluate(element => {
      const ids = new Set();
      const ancestors = [];
      for (let node = element; node; node = node.parentElement) {
        ancestors.push(node);
        if (node.getAttribute('data-aa-id')) ids.add(node.getAttribute('data-aa-id'));
        if (node.matches('form, [role="form"]')) break;
      }
      const label = element.closest('label[for]');
      if (label?.htmlFor) {
        const matches = [...document.querySelectorAll('[id]')].filter(node => node.id === label.htmlFor);
        if (matches.length !== 1) return null;
        const id = matches[0].getAttribute('data-aa-id');
        if (id) ids.add(id);
      }
      const ancestorIds = new Set(ancestors.map(node => node.id).filter(Boolean));
      for (const owner of document.querySelectorAll('[data-aa-id][aria-controls], [data-aa-id][aria-owns]')) {
        if ([owner.getAttribute('aria-controls'), owner.getAttribute('aria-owns')].filter(Boolean)
          .flatMap(value => value.trim().split(/\s+/)).some(id => ancestorIds.has(id))) ids.add(owner.getAttribute('data-aa-id'));
      }
      const option = element.closest('[role="option"], [role="radio"], input[type="radio"]');
      return { ids: [...ids], optionId: option?.getAttribute('data-aa-id') || '',
        optionName: option?.getAttribute('aria-label') || (option && option.tagName !== 'INPUT' ? option.textContent : '') || '',
        optionValue: option?.value || '', role: element.getAttribute('role') || '',
        opens: element.matches('[role="combobox"], [aria-haspopup], input:not([type="radio"]):not([type="checkbox"])') };
    });
    if (!found) return null;
    const matches = snapshot.fields.filter(field => (field.frame || 0) === frameIndex
      && (found.ids.includes(field.id) || (field.options || []).some(option => found.ids.includes(option.aaId))));
    if (matches.length !== 1) return null;
    const field = matches[0];
    let answer;
    let commits = VALUES.has(action.action);
    if (action.action === 'fill' || action.action === 'select') answer = proposedNativeAnswer(field, action);
    else if (action.action === 'type') answer = String(field.value || '') + String(action.value || '');
    else if (action.action === 'check') answer = 'Yes';
    else if (action.action === 'uncheck') answer = 'No';
    else if (action.action === 'click') {
      const options = (field.options || []).filter(option => option.aaId === found.optionId
        || (found.optionName && comparable(option.label) === comparable(found.optionName)));
      if (options.length === 1) { answer = options[0].label; commits = true; }
      else if (field.kind === 'checkbox') { answer = field.checked ? 'No' : 'Yes'; commits = true; }
      else if (!found.opens && isQualificationAction(field, action)) return null;
    } else if (action.action === 'press' && !['Tab', 'Escape'].includes(action.value)) {
      // Keyboard moves can commit a different option in native selects.
      if (isQualificationAction(field, action)) return null;
    }
    return { field, commits, answer };
  } catch { return null; }
  finally { await handle?.dispose().catch(() => {}); }
}
