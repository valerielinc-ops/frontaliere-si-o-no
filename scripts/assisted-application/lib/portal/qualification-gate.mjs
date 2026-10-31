/** Private, source-bound verification of factual answers before a portal mutation. */
import { createHash } from 'node:crypto';
export { nativeQualificationContext as portalQualificationContext } from '../../../../functions/src/lib/nativeQualificationContext.js';
import { codexPrompt } from '../../../../functions/src/assistedApplicationAiPrompts.js';
import { nativeFormAssessmentHash, verifyNativeFormAnswers } from '../../../../functions/src/lib/qualificationEvidence.js';
import { extractFields } from './fields.mjs';
import { nativeFormContract, nativeQuestionMetadata, withNativeMetadata, nativeScopeAllows, neutralApplicationScopePattern } from '../../../../functions/src/lib/nativeFormContract.js';
export { nativeFormContract, nativeQuestionMetadata, nativeScopeAllows };
import { readNativeControlInPage } from '../../../../functions/src/lib/nativeControlSource.js';

import { NATIVE_APPLICATION_MAX_CLAIMS, createNativeApplicationAnswerPolicy, PortalQualificationUnverified, isQualificationAction, proposedNativeAnswer } from '../../../../functions/src/lib/nativeApplicationPolicy.js';
export { PortalQualificationUnverified, isQualificationAction, proposedNativeAnswer, hasAttestedNativeRefusal, nativeApprovedDocumentPurpose } from '../../../../functions/src/lib/nativeApplicationPolicy.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const comparable = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
const VALUES = new Set(['fill', 'type', 'select', 'check', 'uncheck']);
const MAX_FIELDS = NATIVE_APPLICATION_MAX_CLAIMS;
const SEMANTIC_BUDGET_MS = 90_000;
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
export function createPortalQualificationVerifier({ context, codex, candidate }) {
  // Callers retain their objects; mutations during an awaited model call must
  // never grant permission to a different answer or newly injected Q/A.
  context = context ? { sources: ownedSources(context.sources),
    applicationIdentity: structuredClone(context.applicationIdentity || {}),
    policyAuthority: structuredClone(context.policyAuthority || null),
    localAnswerCounterHash: context.localAnswerCounterHash || null,
    docsManifest: structuredClone(context.docsManifest || []),
    answerEvidence: structuredClone(context.answerEvidence || []),
    localAnswerEvidence: structuredClone(context.localAnswerEvidence || []),
    approvedDocumentTexts: structuredClone(context.approvedDocumentTexts || {}),
    documentsCurrent: context.documentsCurrent === true,
    scope: structuredClone(context.scope || {}),
    unverifiedContext: structuredClone(context.unverifiedContext || null) } : null;
  const cache = new Map();
  const permitted = new Map();
  const policy = createNativeApplicationAnswerPolicy({ context, candidate: candidate ? structuredClone(candidate) : undefined });
  const observedTargets = new Map();
  const targetKey = (field, action, answer = proposedNativeAnswer(field, action)) => claimKey({
    fieldId: `${field.frame || 0}:${field.id}`, nativeFormContract: nativeFormContract(field), proposedAnswer: answer });
  const observeTarget = (field, action) => {
    const binding = field._nativeFrameBinding;
    if (!binding) return false;
    const key = targetKey(field, action);
    const bindings = observedTargets.get(key) || new Set();
    bindings.add(JSON.stringify(binding));
    observedTargets.set(key, bindings);
    return true;
  };
  const needs = (field, action) => {
    if (!isQualificationAction(field, action)) return false;
    const observed = observeTarget(field, action);
    return !observed || policy.needs(field, action);
  };
  const claim = (field, action, answer) => {
    if (!isQualificationAction(field, action)) return null;
    answer ??= proposedNativeAnswer(field, action);
    policy.assertValue(field, action, answer);
    if (!observeTarget(field, action)) throw new PortalQualificationUnverified('native_frame_unbound');
    const item = policy.claim(field, action, answer);
    return item ? { ...item, nativeFrameBinding: structuredClone(field._nativeFrameBinding) } : null;
  };
  const verify = async (items, scope = {}) => {
    const claims = structuredClone([...new Map(items.filter(Boolean).map(item => [JSON.stringify(item), item])).values()]);
    if (!claims.length) return;
    if (claims.length > MAX_FIELDS) throw new PortalQualificationUnverified('claim_budget');
    if (!context?.sources) throw new PortalQualificationUnverified('source_unbound');
    if (typeof codex !== 'function') throw new PortalQualificationUnverified('verifier_unavailable');
    const pageScope = structuredClone({ ...context.scope, ...scope });
    const key = nativeFormAssessmentHash({ claims, sources: context.sources, scope: pageScope, unverifiedContext: context.unverifiedContext });
    let result = cache.get(key);
    if (!result) {
      const startedAt = performance.now();
      const cancellation = AbortSignal.timeout(SEMANTIC_BUDGET_MS);
      const checks = [];
      for (let offset = 0; offset < claims.length; offset += 12) {
        const checked = await verifyNativeFormAnswers({ claims: claims.slice(offset, offset + 12), sources: context.sources, scope: pageScope,
          unverifiedContext: context.unverifiedContext,
          generate: async (system, user, schema, options) => {
            cancellation.throwIfAborted();
            const remainingMs = Math.floor(SEMANTIC_BUDGET_MS - (performance.now() - startedAt));
            if (remainingMs <= 0) throw new PortalQualificationUnverified('proof_deadline');
            let abort;
            const canceled = new Promise((_, reject) => {
              abort = () => reject(cancellation.reason);
              cancellation.addEventListener('abort', abort, { once: true });
            });
            try { return await Promise.race([codex({ prompt: codexPrompt(system, user), schema, maxTokens: options?.maxTokens,
              timeoutMs: remainingMs, signal: cancellation }), canceled]); }
            finally { cancellation.removeEventListener('abort', abort); }
          },
        });
        if (checked.status !== 'supported' || cancellation.aborted) {
          result = cancellation.aborted ? { status: 'unverified', verification: { failure: 'proof_deadline' } } : checked;
          break;
        }
        checks.push(...checked.verification.checks);
      }
      result ??= { status: 'supported', verification: { assessmentHash: key, checks } };
      // Cache and permission are published only after every chunk succeeds.
      if (result.status === 'supported' && nativeFormAssessmentHash({ claims, sources: context.sources, scope: pageScope,
        unverifiedContext: context.unverifiedContext }) === key) cache.set(key, result);
    }
    if (result.status !== 'supported' || result.verification?.assessmentHash !== key) {
      throw new PortalQualificationUnverified(result.verification?.failure || 'evidence_unverified');
    }
    for (const item of claims) permitted.set(claimKey({ ...item, scope: pageScope }), { claims, pageScope, key });
  };
  const assert = (field, action, proposedAnswer, scope = {}) => {
    policy.assertValue(field, action, proposedAnswer);
    if (!field._nativeFrameBinding || !observedTargets.get(targetKey(field, action, proposedAnswer))?.has(JSON.stringify(field._nativeFrameBinding))) {
      throw new PortalQualificationUnverified('native_frame_changed');
    }
    if (!policy.needs(field, action)) return;
    const rawClaim = policy.claim(field, action, proposedAnswer);
    const item = rawClaim ? { ...rawClaim, nativeFrameBinding: structuredClone(field._nativeFrameBinding) } : null;
    const proof = item && permitted.get(claimKey({ ...item, scope: { ...context?.scope, ...scope } }));
    if (!proof || nativeFormAssessmentHash({ claims: proof.claims, sources: context.sources,
      scope: proof.pageScope, unverifiedContext: context.unverifiedContext }) !== proof.key) throw new PortalQualificationUnverified('native_contract_changed');
  };
  return { needs, claim, verify, assert,
    refuses: policy.refuses,
  };
}

// Private target identity: a frame object, its effective URL and its current
// document clock. These tokens contain no candidate sources and never enter DTOs.
const frameTokens = new WeakMap();
let nextFrameToken = 0;
async function currentFrameBinding(frame, index) {
  if (!frame || typeof frame.url !== 'function') throw new PortalQualificationUnverified('native_frame_unbound');
  const document = await frame.evaluate(() => ({ url: location.href, timeOrigin: performance.timeOrigin })).catch(() => null);
  if (!document || typeof document.url !== 'string' || document.url !== frame.url()
    || !Number.isFinite(document.timeOrigin) || document.timeOrigin <= 0) throw new PortalQualificationUnverified('native_frame_unbound');
  if (!frameTokens.has(frame)) frameTokens.set(frame, `frame-${++nextFrameToken}`);
  return { token: frameTokens.get(frame), index, url: document.url, origin: new URL(document.url).origin, timeOrigin: document.timeOrigin };
}

/** Re-read without opening dropdowns; a detached/reordered frame is not a binding. */
export async function freshQualificationFields(page, { listboxOptions = false } = {}) {
  if (typeof page?.frames !== 'function') throw new PortalQualificationUnverified('native_reader_unavailable');
  const before = page.frames();
  const snapshot = await extractFields(page, { listboxOptions, auditSuccessful: true });
  const after = page.frames();
  if (before.length !== after.length || before.some((frame, index) => frame !== after[index])) throw new PortalQualificationUnverified('frame_changed');
  snapshot.fields = await withNativeValidation(page, snapshot.fields);
  return snapshot;
}

/** Read constraints absent from the planner's compact field projection. */
export async function withNativeValidation(page, fields) {
  const frames = page.frames();
  const bindings = await Promise.all(frames.map(currentFrameBinding));
  const result = [];
  for (const field of fields) {
    const frame = frames[field.frame || 0];
    const native = await frame?.evaluate(readNativeControlInPage, { id: field.id, kind: field.kind, widget: field.widget, nativeSelectId: field.nativeSelectId, originalLabel: field.label, formPurposePattern: neutralApplicationScopePattern }).catch(() => null);
    result.push({ ...withNativeMetadata(field, native), _nativeFrameBinding: structuredClone(bindings[field.frame || 0]) });
  }
  // A disabled/unsupported checkbox may be absent from the interactive
  // reader while its hidden fallback still leaves in FormData. Never silently
  // omit that transport merely because the visible control cannot be filled.
  for (const [index, frame] of frames.entries()) {
    const covered = result.filter(field => (field.frame || 0) === index
      && (field.nativeUncheckedSubmission || field.nativeUncheckedSubmissionUnknown)).map(field => field.id);
    const unbound = await frame.evaluate(covered => [...document.querySelectorAll('input[type="hidden"][name]')]
      .filter(hidden => hidden.form && !hidden.disabled && !hidden.matches(':disabled'))
      .some(hidden => [...hidden.form.elements].filter(control => control.matches('input[type="checkbox"]')
        && control.name === hidden.name && control.form === hidden.form)
        .some(control => !covered.includes(control.getAttribute('data-aa-id')))), covered).catch(() => true);
    if (unbound) throw new PortalQualificationUnverified('native_transport_unbound');
  }
  const afterBindings = await Promise.all(frames.map(currentFrameBinding));
  if (JSON.stringify(bindings) !== JSON.stringify(afterBindings)) throw new PortalQualificationUnverified('native_frame_changed');
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
    if (JSON.stringify(actual._nativeFrameBinding) !== JSON.stringify(field._nativeFrameBinding)) throw new PortalQualificationUnverified('native_frame_changed');
    if (actual.readOnly || actual.disabled) throw new PortalQualificationUnverified('native_readonly_action_unverified');
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

/** Existing values are also submitted facts; a model's skip is no authority. */
export function existingPortalAnswers(fields, actions = [], hasValue = field => Boolean(String(field.value || '').trim()) || field.checked === true) {
  const replaced = new Set(actions.filter(action => !['skip', 'upload'].includes(action.action)).map(action => action.fieldId));
  for (const field of fields) if (field.nativeValueUnknown) throw new PortalQualificationUnverified('native_value_unverified');
  return fields.filter(field => !replaced.has(field.id) && field.inputType !== 'password' && field.kind !== 'file'
    && field.inputType !== 'file' && (field.nativeValueUnknown || hasValue(field) || field.kind === 'checkbox' && (field.nativeUncheckedSubmission || field.nativeUncheckedSubmissionUnknown)))
    .filter(field => field.kind !== 'checkbox' || field.checked === true || field.nativeUncheckedSubmission || field.nativeUncheckedSubmissionUnknown)
    .map(field => ({ fieldId: field.id, action: field.kind === 'checkbox' ? field.checked ? 'check' : 'uncheck' : 'fill',
      value: field.kind === 'checkbox' ? field.checked ? 'Yes' : 'No' : String(field.value),
      // Only the canonical consent-only policy may omit an optional opt-in.
      // An unchecked factual box with a proven hidden No is still a claim.
      source: field.kind === 'checkbox' ? field.checked ? 'consent' : 'consent_optout' : 'portal_prefill', evidence: '' }));
}

export async function assertExistingPortalAnswers(page, verifier, scope, hasValue) {
  const current = await freshQualificationFields(page, { listboxOptions: true });
  if (current.url !== page.url() || scope.url && page.url() !== scope.url) throw new PortalQualificationUnverified('native_page_changed');
  for (const action of existingPortalAnswers(current.fields, [], hasValue)) {
    const field = uniqueNativeField(current.fields, action.fieldId);
    if (!field) throw new PortalQualificationUnverified('native_field_ambiguous');
    verifier.assert(field, action, proposedNativeAnswer(field, action), { ...scope, url: page.url() });
  }
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
        opens: !element.closest('[role="option"], [role="radio"], input[type="radio"], input[type="checkbox"]')
          && element.matches('[role="combobox"], [aria-haspopup], textarea, input:not([type="radio"]):not([type="checkbox"])') };
    });
    if (!found) return null;
    const matches = snapshot.fields.filter(field => (field.frame || 0) === frameIndex
      && (found.ids.includes(field.id) || (field.options || []).some(option => found.ids.includes(option.aaId))));
    if (matches.length !== 1) return null;
    const field = matches[0];
    let answer;
    let commits = VALUES.has(action.action);
    if (action.action === 'fill') answer = field.kind === 'textarea' ? action.value : String(action.value || '').replace(/[\r\n]+/g, ' ');
    else if (action.action === 'select') answer = proposedNativeAnswer(field, action);
    else if (action.action === 'type') answer = String(field.value || '') + String(action.value || '').replace(/[\r\n]+/g, ' ');
    else if (action.action === 'check') answer = 'Yes';
    else if (action.action === 'uncheck') answer = 'No';
    else if (action.action === 'click') {
      const options = (field.options || []).filter(option => option.aaId === found.optionId
        || (found.optionName && comparable(option.label) === comparable(found.optionName)));
      if (options.length === 1) { answer = options[0].label; commits = true; }
      else if (field.kind === 'checkbox') { answer = field.checked ? 'No' : 'Yes'; commits = true; }
      else if (!found.opens) return null;
    } else if (action.action === 'press' && !['Tab', 'Escape'].includes(action.value)) {
      // Keyboard moves can commit a different option in native selects.
      if (isQualificationAction(field, action)) return null;
    }
    return { field, commits, answer };
  } catch { return null; }
  finally { await handle?.dispose().catch(() => {}); }
}
