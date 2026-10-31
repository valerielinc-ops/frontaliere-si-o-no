/** Shared final-control source and posting binding. No field claim grants a click capability. */
export const SUBMIT_RE = /(submit|send application|apply now|^apply$|^confirm and (apply|send|submit)\W*$|absenden|^senden$|bewerbung (absenden|senden|abschicken)|jetzt bewerben|^bewerben$|^bestätigen und (bewerben|absenden|senden)\W*$|invia( la)? candidatura|^invia(?:re)?$|candidati ora|^candidati$|^applica$|^conferma e (applica|invia|candidati)\W*$|envoyer( ma)? candidature|^envoyer$|postuler|soumettre|^confirmer et (postuler|envoyer)\W*$)/i;
export const REVIEW_INSTRUCTIONS_RE = /((?:please )?review (?:the |your )?information).{0,600}((?:select|click|press).{0,50}(?:submit|apply).{0,80}(?:finali[sz]e|send|submit|complete).{0,40}(?:application|candidature))/i;

/** Primary portal metadata. Numeric path components never identify a job without this proof. */

export function avatureProtocolMatches(protocol, value) {
  try {
    const url = new URL(value); const quote = protocol?.quoted;
    return Boolean(protocol?.vendor === 'avature' && /^[1-9]\d{0,15}$/.test(protocol.portalId)
      && /^\/[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(protocol.namespace) && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(protocol.page)
      && quote?.portalId === protocol.portalId && `/${quote.urlPath}` === protocol.namespace && quote.page === protocol.page
      && quote.applicationName === 'customPortal' && quote.applicationCode === `customPortal_${protocol.portalId}`
      && (!protocol.sourceTitle || (protocol.page === 'JobDetail' && typeof protocol.sourceTitle === 'string'
        && quote.sourceTitle === protocol.sourceTitle && quote.titleSource === 'unique-h1'))
      && url.protocol === 'https:' && !url.username && !url.password && url.origin === protocol.origin && url.pathname === protocol.path
      && url.pathname.startsWith(`${protocol.namespace}/`) && url.pathname.slice(protocol.namespace.length + 1).split('/')[0] === protocol.page);
  } catch { return false; }
}

export function avaturePostingJobKey(value, protocol) {
  if (protocol?.page !== 'JobDetail' || !avatureProtocolMatches(protocol, value)) return null;
  const match = new RegExp(`^${protocol.namespace}/JobDetail/[^/]+/([1-9][0-9]{0,15})/?$`).exec(new URL(value).pathname);
  return match?.[1] || null;
}

export function avaturePortalDirectory(value, protocol) {
  try {
    const url = new URL(value);
    return avatureProtocolMatches(protocol, `${protocol.origin}${protocol.path}`) && url.origin === protocol.origin
      && url.pathname.startsWith(`${protocol.namespace}/`) ? `${protocol.namespace}/` : null;
  } catch { return null; }
}

export function sameAvaturePortal(source, current, url) {
  return avatureProtocolMatches(source, `${source?.origin}${source?.path}`) && avatureProtocolMatches(current, url)
    && source.portalId === current.portalId && source.namespace === current.namespace && source.origin === current.origin;
}


function parsed(value) {
  try { return new URL(value); } catch { return null; }
}

/** Only explicit posting keys bind a route. Account IDs/application IDs are not job IDs. */
export function portalJobKey(value, protocol = null) {
  const url = parsed(value);
  if (!url) return null;
  const entries = [...url.searchParams.entries()].filter(([key]) => /^(?:jobid|job_id|requisitionid|requisition_id|postingid)$/i.test(key));
  if (entries.length > 1 || (entries.length === 1 && !/^[a-z0-9_-]{1,100}$/i.test(entries[0][1]))) return null;
  const quotedPathKey = avaturePostingJobKey(value, protocol);
  if (quotedPathKey && entries.length === 1 && entries[0][1] !== quotedPathKey) return null;
  return entries[0]?.[1] || quotedPathKey || null;
}

export const NATIVE_APPLICATION_TARGET_VERSION = 'native-application-target-v1';
const INLINE_FORM_SUBMIT_RE = /^\s*(?:javascript:\s*)?this\s*\.\s*closest\s*\(\s*(['"])form\1\s*\)\s*\.\s*submit\s*\(\s*\)\s*;\s*return\s+false\s*;?\s*$/;
const COMPILED_INLINE_HANDLER_RE = /^function\s+onclick\s*\(\s*event\s*\)\s*\{([\s\S]{0,256})\}\s*$/;
export const NATIVE_APPLICATION_TARGET_SCHEMA = Object.freeze({
  version: NATIVE_APPLICATION_TARGET_VERSION,
  jobNames: Object.freeze(['jobid', 'job_id', 'requisitionid', 'requisition_id', 'postingid']),
  instanceNames: Object.freeze(['applicationid', 'application_id', 'applicantid', 'applicant_id', 'candidateid', 'candidate_id', 'profileid', 'profile_id']),
  operationNames: Object.freeze(['action', 'operation', 'intent', 'event', 'eventid', '_eventid', 'submit', 'command']),
  reviewPatternSource: REVIEW_INSTRUCTIONS_RE.source,
  inlineHandlerPatternSource: INLINE_FORM_SUBMIT_RE.source,
  compiledHandlerPatternSource: COMPILED_INLINE_HANDLER_RE.source,
});

/** Only the trusted document_start/new-document host calls this installer. No DOM or candidate data is read. */
export function installNativeApplicationPrimitivesInPage() {
  const key = '__assistedNativeApplicationPrimitivesV1';
  if (Object.hasOwn(window, key)) return false;
  const ownKeys = Reflect.ownKeys; const descriptor = Object.getOwnPropertyDescriptor;
  const isArray = Array.isArray; const hasOwn = Object.prototype.hasOwnProperty; const apply = Reflect.apply;
  const tagGetter = descriptor(Element.prototype, 'tagName').get;
  const ownerGetter = descriptor(Node.prototype, 'ownerDocument').get;
  const connectedGetter = descriptor(Node.prototype, 'isConnected').get;
  const handlerGetter = descriptor(HTMLElement.prototype, 'onclick').get;
  const shadowGetter = descriptor(Element.prototype, 'shadowRoot').get;
  const textGetter = descriptor(Node.prototype, 'textContent').get;
  const innerTextGetter = descriptor(HTMLElement.prototype, 'innerText')?.get;
  const bodyGetter = descriptor(Document.prototype, 'body').get;
  const documentUrlGetter = descriptor(Document.prototype, 'URL').get;
  const defaultViewGetter = descriptor(Document.prototype, 'defaultView').get;
  const baseGetter = descriptor(Node.prototype, 'baseURI').get;
  const parentElementGetter = descriptor(Node.prototype, 'parentElement').get;
  const nodeTypeGetter = descriptor(Node.prototype, 'nodeType').get;
  const idGetter = descriptor(Element.prototype, 'id').get;
  const childrenGetter = descriptor(Element.prototype, 'children').get;
  const documentChildrenGetter = descriptor(Document.prototype, 'children').get;
  const fragmentChildrenGetter = descriptor(DocumentFragment.prototype, 'children').get;
  const childNodesGetter = descriptor(Node.prototype, 'childNodes').get;
  const validGetter = descriptor(ValidityState.prototype, 'valid').get;
  const parentPrototype = Object.getPrototypeOf;
  const inlineAnchorPrototype = HTMLAnchorElement.prototype;
  const inlineFormPrototype = HTMLFormElement.prototype;
  const inlineLineage = [];
  for (const start of [inlineAnchorPrototype, inlineFormPrototype]) {
    let prototype = start;
    while (prototype) {
      const parent = parentPrototype(prototype);
      inlineLineage[inlineLineage.length] = { prototype, parent };
      prototype = parent;
    }
  }
  function inlineLineageIntact(control, form) {
    if (parentPrototype(control) !== inlineAnchorPrototype || parentPrototype(form) !== inlineFormPrototype) return false;
    for (let index = 0; index < inlineLineage.length; index += 1) {
      const saved = inlineLineage[index];
      if (parentPrototype(saved.prototype) !== saved.parent) return false;
    }
    return true;
  }
  const controlGetters = Object.create(null);
  for (const [tag, prototype] of [['INPUT', HTMLInputElement.prototype], ['BUTTON', HTMLButtonElement.prototype],
    ['A', HTMLAnchorElement.prototype], ['FORM', HTMLFormElement.prototype], ['SELECT', HTMLSelectElement.prototype], ['TEXTAREA', HTMLTextAreaElement.prototype],
    ['OPTION', HTMLOptionElement.prototype], ['OPTGROUP', HTMLOptGroupElement.prototype], ['LABEL', HTMLLabelElement.prototype]]) {
    const getters = Object.create(null);
    for (const field of ['form', 'type', 'name', 'value', 'disabled', 'readOnly', 'required', 'multiple', 'checked', 'selected', 'label', 'labels', 'htmlFor', 'control', 'size', 'maxLength', 'validity', 'options', 'files', 'href', 'target', 'action', 'method', 'enctype', 'elements', 'formAction', 'formMethod', 'formTarget', 'formEnctype']) {
      const getter = descriptor(prototype, field)?.get;
      if (getter) getters[field] = getter;
    }
    controlGetters[tag] = Object.freeze(getters);
  }
  Object.freeze(controlGetters);
  function property(node, field) {
    if (field === 'tagName') return apply(tagGetter, node, []);
    if (field === 'ownerDocument') return apply(ownerGetter, node, []);
    if (field === 'isConnected') return apply(connectedGetter, node, []);
    if (field === 'onclick') return apply(handlerGetter, node, []);
    if (field === 'shadowRoot') return apply(shadowGetter, node, []);
    if (field === 'body') return apply(bodyGetter, node, []);
    if (field === 'documentUrl') return apply(documentUrlGetter, node, []);
    if (field === 'defaultView') return apply(defaultViewGetter, node, []);
    if (field === 'baseURI') return apply(baseGetter, node, []);
    if (field === 'parentElement') return apply(parentElementGetter, node, []);
    if (field === 'nodeType') return apply(nodeTypeGetter, node, []);
    if (field === 'id') return apply(idGetter, node, []);
    if (field === 'valid') return apply(validGetter, node, []);
    const getters = controlGetters[apply(tagGetter, node, [])];
    const getter = getters && getters[field];
    return getter ? apply(getter, node, []) : undefined;
  }
  function resolvesTo(node, field, method) {
    let current = node;
    for (let depth = 0; current && depth < 20; depth += 1) {
      const own = descriptor(current, field);
      if (own) return apply(hasOwn, own, ['value']) && own.value === method;
      current = parentPrototype(current);
    }
    return false;
  }
  function text(node) {
    if (innerTextGetter) {
      try { const value = apply(innerTextGetter, node, []); if (value) return value; } catch { /* Non-HTML ARIA name source. */ }
    }
    return apply(textGetter, node, []);
  }
  const docQuery = Document.prototype.querySelectorAll;
  const shadowQuery = ShadowRoot.prototype.querySelectorAll;
  const elementQuery = Element.prototype.querySelectorAll;
  function query(root, selector) {
    try { return apply(docQuery, root, [selector]); } catch { /* Native brand check. */ }
    try { return apply(shadowQuery, root, [selector]); } catch { /* Native brand check. */ }
    return apply(elementQuery, root, [selector]);
  }
  const guards = [];
  function watch(object, fields) {
    for (let index = 0; index < fields.length; index += 1) guards[guards.length] = { object, field: fields[index], expected: descriptor(object, fields[index]) };
  }
  watch(window, ['Object', 'Array', 'String', 'RegExp', 'JSON', 'URL', 'URLSearchParams', 'Reflect', 'Element', 'Node', 'HTMLElement', 'structuredClone',
    'HTMLInputElement', 'HTMLButtonElement', 'HTMLAnchorElement', 'HTMLFormElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'getComputedStyle']);
  watch(Object, ['assign', 'getOwnPropertyDescriptor', 'isFrozen', 'keys', 'entries', 'fromEntries', 'hasOwn', 'freeze', 'getPrototypeOf']);
  watch(JSON, ['stringify']);
  watch(Array, ['isArray']);
  watch(Object.prototype, ['toJSON', 'toString', 'valueOf', Symbol.toPrimitive]);
  watch(Array.prototype, ['filter', 'map', 'flatMap', 'sort', 'some', 'includes', 'push', 'join', 'toJSON', Symbol.iterator]);
  watch(String.prototype, ['normalize', 'replace', 'trim', 'toLowerCase', 'split', 'includes', 'localeCompare', 'startsWith', 'slice']);
  watch(RegExp.prototype, ['exec', 'test', Symbol.replace]);
  watch(Element.prototype, ['closest', 'matches', 'getAttribute', 'hasAttribute', 'getClientRects', 'querySelectorAll']);
  watch(Document.prototype, ['querySelectorAll']);
  watch(ShadowRoot.prototype, ['querySelectorAll']);
  watch(NodeList.prototype, ['length', Symbol.iterator]);
  if (typeof DOMRectList !== 'undefined') watch(DOMRectList.prototype, ['length']);
  const descriptorFields = ['value', 'get', 'set', 'writable', 'configurable', 'enumerable'];
  function intact() {
    for (let index = 0; index < guards.length; index += 1) {
      const saved = guards[index]; const current = descriptor(saved.object, saved.field); const expected = saved.expected;
      if (!current || !expected) { if (current !== expected) return false; continue; }
      for (let fieldIndex = 0; fieldIndex < descriptorFields.length; fieldIndex += 1) {
        const field = descriptorFields[fieldIndex];
        const currentOwn = apply(hasOwn, current, [field]); const expectedOwn = apply(hasOwn, expected, [field]);
        if (currentOwn !== expectedOwn || (currentOwn && current[field] !== expected[field])) return false;
      }
    }
    return true;
  }
  const collectionLength = descriptor(HTMLCollection.prototype, 'length').get;
  const collectionItem = HTMLCollection.prototype.item;
  const nodeListLength = descriptor(NodeList.prototype, 'length').get;
  const nodeListItem = NodeList.prototype.item;
  const fileLength = descriptor(FileList.prototype, 'length').get;
  const fileItem = FileList.prototype.item;
  const fileName = descriptor(File.prototype, 'name').get;
  const fileModified = descriptor(File.prototype, 'lastModified').get;
  const blobSize = descriptor(Blob.prototype, 'size').get;
  const blobType = descriptor(Blob.prototype, 'type').get;
  const blobArrayBuffer = Blob.prototype.arrayBuffer;
  function elements(form) {
    const collection = property(form, 'elements'); const length = apply(collectionLength, collection, []);
    if (length > 1000) return null;
    const output = [];
    for (let index = 0; index < length; index += 1) output[index] = apply(collectionItem, collection, [index]);
    return output;
  }
  function nodes(collection) {
    if (!collection) return [];
    let length; let item;
    try { length = apply(nodeListLength, collection, []); item = nodeListItem; }
    catch { length = apply(collectionLength, collection, []); item = collectionItem; }
    if (length > 5000) return null;
    const output = [];
    for (let index = 0; index < length; index += 1) output[index] = apply(item, collection, [index]);
    return output;
  }
  function children(node) {
    try { return nodes(apply(childrenGetter, node, [])); } catch { /* Native brand check. */ }
    try { return nodes(apply(documentChildrenGetter, node, [])); } catch { /* Native brand check. */ }
    return nodes(apply(fragmentChildrenGetter, node, []));
  }
  function childNodes(node) { return nodes(apply(childNodesGetter, node, [])); }
  function files(control) {
    const collection = property(control, 'files');
    if (!collection) return [];
    const length = apply(fileLength, collection, []);
    if (length > 100) return null;
    const output = [];
    for (let index = 0; index < length; index += 1) output[index] = apply(fileItem, collection, [index]);
    return output;
  }
  function options(control) {
    const collection = property(control, 'options');
    if (!collection) return null;
    const length = apply(collectionLength, collection, []);
    if (length > 5000) return null;
    const output = [];
    for (let index = 0; index < length; index += 1) output[index] = apply(collectionItem, collection, [index]);
    return output;
  }
  function fileMetadata(file) {
    return { name: apply(fileName, file, []), size: apply(blobSize, file, []), type: apply(blobType, file, []), lastModified: apply(fileModified, file, []) };
  }
  function fileBytes(file) { return blobArrayBuffer ? apply(blobArrayBuffer, file, []) : null; }
  function sameOwnData(left, right) {
    let nodes = 0;
    function same(a, b, depth) {
      if (++nodes > 10000 || depth > 20) return false;
      if (a === b) return true;
      if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || isArray(a) !== isArray(b)) return false;
      const aKeys = ownKeys(a); const bKeys = ownKeys(b);
      if (aKeys.length !== bKeys.length) return false;
      for (let index = 0; index < aKeys.length; index += 1) {
        const field = aKeys[index];
        if (typeof field !== 'string') return false;
        const ownA = descriptor(a, field); const ownB = descriptor(b, field);
        if (!ownA || !ownB || !apply(hasOwn, ownA, ['value']) || !apply(hasOwn, ownB, ['value'])
          || !same(ownA.value, ownB.value, depth + 1)) return false;
      }
      return true;
    }
    return same(left, right, 0);
  }
  const primitives = Object.freeze({ closest: Element.prototype.closest, submit: HTMLFormElement.prototype.submit,
    click: HTMLElement.prototype.click, apply, sameOwnData, property, elements, nodes, children, childNodes, options, files, fileMetadata, fileBytes, intact, inlineLineageIntact, resolvesTo, text, query, URL,
    getAttribute: Element.prototype.getAttribute, hasAttribute: Element.prototype.hasAttribute, matches: Element.prototype.matches,
    getClientRects: Element.prototype.getClientRects, getComputedStyle: window.getComputedStyle,
    cssValue: CSSStyleDeclaration.prototype.getPropertyValue,
    functionSource: Function.prototype.toString, RegExp, regexpExec: RegExp.prototype.exec,
    urlHref: Object.getOwnPropertyDescriptor(URL.prototype, 'href').get,
    urlHash: Object.getOwnPropertyDescriptor(URL.prototype, 'hash').set });
  Object.defineProperty(window, key, { value: primitives, writable: false, configurable: false, enumerable: false });
  return true;
}

/** Transport parsing preserves every raw observation; it grants no ownership. */
export function cloneNativeApplicationTarget(value) {
  let nodes = 0;
  function clone(input, depth = 0) {
    if (++nodes > 10000 || depth > 12) throw new Error('target_bounds');
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'string') { if (input.length > 16384) throw new Error('target_bounds'); return input; }
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (!input || typeof input !== 'object') throw new Error('target_json');
    if (Array.isArray(input)) {
      if (input.length > 1000) throw new Error('target_bounds');
      return input.map(child => clone(child, depth + 1));
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error('target_json');
    const entries = Object.entries(input);
    if (entries.length > 1000) throw new Error('target_bounds');
    const output = {};
    for (const [key, child] of entries) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('target_json');
      output[key] = clone(child, depth + 1);
    }
    return output;
  }
  try {
    const target = clone(value);
    if (target?.version !== NATIVE_APPLICATION_TARGET_VERSION || !target.control || !target.destination || !target.overrides
      || !Object.hasOwn(target, 'form') || new TextEncoder().encode(JSON.stringify(target)).byteLength > 131072) return null;
    return target;
  } catch { return null; }
}

/** Serialized in the DOM realm. References stay private and are never proof JSON. */
export function holdNativeApplicationTargetInPage(control) {
  // Window.window is the unforgeable Window reference. A page can replace
  // globalThis or Object inspection helpers without replacing this stash.
  const primitives = window.__assistedNativeApplicationPrimitivesV1 || null;
  return { control, form: primitives ? primitives.property(control, 'form')
    || (primitives.property(control, 'tagName') === 'A' ? primitives.apply(primitives.closest, control, ['form']) : null) : null,
    primitives,
    handler: primitives ? primitives.property(control, 'onclick') : null, document: primitives ? primitives.property(control, 'ownerDocument') : null, view: window };
}

/**
 * One source reader for Node and the browser continuation. In activation mode
 * the last read and native activation run in the same JavaScript turn, using
 * the captured references. It never searches for a replacement control.
 */
function readNativeApplicationSourceInPage(witness, options = {}) {
  const attribute = (node, name) => witness?.primitives
    ? witness.primitives.apply(witness.primitives.getAttribute, node, [name]) : node.getAttribute(name);
  const querySource = (root, selector) => witness?.primitives ? witness.primitives.query(root, selector) : root.querySelectorAll(selector);
  function readProtocol() {
    const meta = name => {
      const nodes = querySource(document, `meta[name="${name}"]`);
      return nodes.length === 1 ? String(attribute(nodes[0], 'content') || '').trim() : '';
    };
    const portalId = meta('avature.portal.id');
    const urlPath = meta('avature.portal.urlPath');
    const page = meta('avature.portal.page');
    const boot = querySource(document, 'portal-data#synapserBootstrap');
    if (!/^[1-9]\d{0,15}$/.test(portalId) || !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(urlPath)
      || !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(page) || boot.length !== 1) return null;
    const applicationName = attribute(boot[0], 'data-applicationName') || '';
    const applicationCode = attribute(boot[0], 'data-applicationCode') || '';
    if (applicationName !== 'customPortal' || applicationCode !== `customPortal_${portalId}`) return null;
    const namespace = `/${urlPath}`;
    if (location.protocol !== 'https:' || !location.pathname.startsWith(`${namespace}/`)
      || location.pathname.slice(namespace.length + 1).split('/')[0] !== page) return null;
    const headings = page === 'JobDetail' ? [...querySource(document, 'h1')] : [];
    const sourceTitle = headings.length === 1 ? String((witness?.primitives ? witness.primitives.text(headings[0]) : headings[0].textContent) || '').normalize('NFC').replace(/\s+/g, ' ').trim() : '';
    const title = sourceTitle && sourceTitle.length <= 500 ? sourceTitle : '';
    return { vendor: 'avature', portalId, namespace, page, origin: location.origin, path: location.pathname,
      ...(title ? { sourceTitle: title } : {}),
      quoted: { portalId, urlPath, page, applicationName, applicationCode, ...(title ? { sourceTitle: title, titleSource: 'unique-h1' } : {}) } };
  }
  if (!witness?.control && !options.schema && !options.activate) return readProtocol();
  const schema = options.schema;
  const changed = () => options.activate ? { activated: false, reason: 'post_arm_target_changed' } : null;
  if (!schema?.version || typeof schema.reviewPatternSource !== 'string' || !schema.reviewPatternSource
    || !Array.isArray(schema.jobNames) || !Array.isArray(schema.instanceNames) || !Array.isArray(schema.operationNames)) return changed();
  const control = witness?.control;
  const primitives = witness?.primitives;
  if (!primitives || window.__assistedNativeApplicationPrimitivesV1 !== primitives || !primitives.intact()) return changed();
  const hasAttribute = (node, name) => primitives.apply(primitives.hasAttribute, node, [name]);
  const matches = (node, selector) => primitives.apply(primitives.matches, node, [selector]);
  if (!control || witness.document !== document || witness.view !== window
    || primitives.property(control, 'ownerDocument') !== witness.document
    || (primitives.property(control, 'form') || (primitives.property(control, 'tagName') === 'A' ? primitives.apply(primitives.closest, control, ['form']) : null)) !== witness.form
    || primitives.property(control, 'onclick') !== witness.handler || !primitives.property(control, 'isConnected')) return changed();
  const clean = value => String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim();
  const httpUrl = value => {
    try {
      const url = new primitives.URL(value, primitives.property(document, 'baseURI'));
      primitives.apply(primitives.urlHash, url, ['']);
      return primitives.apply(primitives.urlHref, url, []);
    } catch { return ''; }
  };
  const roots = [document];
  for (let index = 0; index < roots.length; index += 1) {
    for (const element of primitives.query(roots[index], '*')) {
      const shadowRoot = primitives.property(element, 'shadowRoot');
      if (shadowRoot) roots.push(shadowRoot);
    }
  }
  const all = selector => roots.flatMap(root => [...primitives.query(root, selector)]);
  const aaId = attribute(control, 'data-aa-id') || '';
  const lookupCount = aaId ? all('[data-aa-id]').filter(node => attribute(node, 'data-aa-id') === aaId).length : 1;
  if (lookupCount !== 1) return changed();
  let ambiguousLabel = false;
  const labelled = clean(attribute(control, 'aria-labelledby')).split(' ').filter(Boolean).map(id => {
    const nodes = all('[id]').filter(node => attribute(node, 'id') === id);
    if (nodes.length !== 1) { ambiguousLabel = true; return ''; }
    const name = clean(primitives.text(nodes[0]));
    if (!name) ambiguousLabel = true;
    return name;
  }).filter(Boolean).join(' ');
  if (ambiguousLabel || (hasAttribute(control, 'aria-labelledby') && !labelled)) return changed();
  const tag = primitives.property(control, 'tagName').toLowerCase();
  let compiledHandlerSource = '';
  if (tag === 'a' && witness.form && attribute(control, 'onclick')
    && (!primitives.inlineLineageIntact(control, witness.form) || !primitives.resolvesTo(control, 'closest', primitives.closest)
      || !primitives.resolvesTo(witness.form, 'submit', primitives.submit))) return changed();
  if (tag === 'a' && witness.form && attribute(control, 'onclick')) {
    if (typeof witness.handler !== 'function') return changed();
    const source = primitives.apply(primitives.functionSource, witness.handler, []);
    const wrapper = primitives.apply(primitives.regexpExec, new primitives.RegExp(schema.compiledHandlerPatternSource), [source]);
    if (!wrapper || !primitives.apply(primitives.regexpExec, new primitives.RegExp(schema.inlineHandlerPatternSource), [wrapper[1]])) return changed();
    compiledHandlerSource = source;
  }
  const type = tag === 'a' ? 'link' : String(primitives.property(control, 'type') || '').toLowerCase();
  const label = clean(labelled || attribute(control, 'aria-label') || primitives.text(control)
    || (tag === 'input' ? primitives.property(control, 'value') : '') || attribute(control, 'title'));
  if (label.length > 300 || String(primitives.property(control, 'value') || '').length > 2000) return changed();
  const form = witness.form;
  const formElements = form ? primitives.elements(form) : [];
  if (!formElements) return changed();
  let hasFiles = false;
  for (let index = 0; index < formElements.length; index += 1) {
    const element = formElements[index];
    if (primitives.property(element, 'type') !== 'file' || primitives.property(element, 'disabled') || matches(element, ':disabled')) continue;
    const currentFiles = primitives.files(element);
    if (!currentFiles) return changed();
    if (currentFiles.length) hasFiles = true;
  }
  const reviewMatch = source => new RegExp(schema.reviewPatternSource, 'i').exec(clean(source));
  const formReview = form ? reviewMatch(primitives.text(form)) : null;
  const body = primitives.property(document, 'body');
  const pageReview = formReview || reviewMatch(body ? primitives.text(body) : '');
  const reviewEvidence = pageReview ? `${pageReview[1]} ${pageReview[2]}` : '';
  const reviewScope = formReview ? 'form' : pageReview ? 'document' : '';
  const jobKeys = []; const instanceKeys = []; const operationKeys = [];
  let invalidKeys = false;
  const appendKey = (node, submitter = false) => {
    const name = String(primitives.property(node, 'name') || ''); const key = name.toLowerCase();
    const destination = schema.jobNames.includes(key) ? jobKeys : schema.instanceNames.includes(key) ? instanceKeys : schema.operationNames.includes(key) ? operationKeys : null;
    const type = primitives.property(node, 'type');
    if (!destination || (!submitter && destination !== jobKeys && type !== 'hidden')) return;
    if (type === 'file' || primitives.property(node, 'multiple') || (submitter && type === 'image')) { invalidKeys = true; return; }
    const value = String(primitives.property(node, 'value') || '');
    if (value.length > 2000 || (destination === jobKeys && !/^[a-z0-9_-]{1,100}$/i.test(value))) { invalidKeys = true; return; }
    destination.push({ name, value });
  };
  if (form) {
    const elements = formElements;
    for (const element of elements) {
      const type = primitives.property(element, 'type');
      if (element === control || primitives.property(element, 'form') !== form || primitives.property(element, 'disabled') || matches(element, ':disabled')
        || ['submit', 'image', 'button', 'reset'].includes(type)
        || (['checkbox', 'radio'].includes(type) && !primitives.property(element, 'checked'))) continue;
      appendKey(element);
    }
    appendKey(control, true);
  }
  for (const entries of [jobKeys, instanceKeys, operationKeys]) entries.sort((a, b) => a.name.localeCompare(b.name) || a.value.localeCompare(b.value));
  const overrides = {
    actionPresent: hasAttribute(control, 'formaction'), methodPresent: hasAttribute(control, 'formmethod'),
    targetPresent: hasAttribute(control, 'formtarget'), enctypePresent: hasAttribute(control, 'formenctype'),
  };
  const formAction = form ? httpUrl(primitives.property(form, 'action')) : '';
  const action = overrides.actionPresent
    ? httpUrl(typeof primitives.property(control, 'formAction') === 'string' ? primitives.property(control, 'formAction') : attribute(control, 'formaction') || primitives.property(document, 'documentUrl')) : formAction;
  const method = String(overrides.methodPresent ? primitives.property(control, 'formMethod') || attribute(control, 'formmethod') : form && primitives.property(form, 'method') || '').toLowerCase();
  const browsingTarget = String(overrides.targetPresent ? primitives.property(control, 'formTarget') || attribute(control, 'formtarget') || '' : form && primitives.property(form, 'target') || '');
  const enctype = String(overrides.enctypePresent ? primitives.property(control, 'formEnctype') || attribute(control, 'formenctype') : form && primitives.property(form, 'enctype') || '').toLowerCase();
  overrides.action = overrides.actionPresent ? action : ''; overrides.method = overrides.methodPresent ? method : '';
  overrides.target = overrides.targetPresent ? browsingTarget : ''; overrides.enctype = overrides.enctypePresent ? enctype : '';
  let destination = { kind: 'unsupported', url: '', method: '', target: '', enctype: '' };
  if (tag === 'a') destination = { kind: 'link', url: String(primitives.property(control, 'href') || ''), method: 'get', target: String(primitives.property(control, 'target') || ''), enctype: '' };
  else if (form && ((tag === 'button' && type === 'submit') || (tag === 'input' && ['submit', 'image'].includes(type)))) {
    destination = { kind: 'native_submit', url: action, method, target: browsingTarget, enctype };
  }
  const rects = primitives.apply(primitives.getClientRects, control, []); const style = primitives.getComputedStyle(control);
  const target = {
    version: schema.version,
    documentUrl: httpUrl(primitives.property(document, 'documentUrl')),
    protocol: readProtocol(),
    reviewEvidence, reviewScope,
    control: { aaId, htmlId: attribute(control, 'id') || '', name: String(primitives.property(control, 'name') || ''), value: String(primitives.property(control, 'value') || ''),
      tag, type, label, href: tag === 'a' ? String(primitives.property(control, 'href') || '') : '', rawHref: attribute(control, 'href'),
      inlineHandler: attribute(control, 'onclick') || '', compiledHandlerSource, formRelation: tag === 'a' && form ? 'closest' : form ? 'native' : '', lookupCount,
      connected: primitives.property(control, 'isConnected'), disabled: Boolean(primitives.property(control, 'disabled')) || matches(control, ':disabled') || attribute(control, 'aria-disabled') === 'true',
      visible: rects.length > 0 && primitives.apply(primitives.cssValue, style, ['display']) !== 'none' && primitives.apply(primitives.cssValue, style, ['visibility']) !== 'hidden'
        && !primitives.apply(primitives.closest, control, ['[hidden], [aria-hidden="true"], [inert]']) },
    form: form ? { aaId: attribute(form, 'data-aa-id') || '', htmlId: attribute(form, 'id') || '', name: primitives.property(form, 'name') || '',
      markerCount: attribute(form, 'data-aa-id') ? all('[data-aa-id]').filter(node => attribute(node, 'data-aa-id') === attribute(form, 'data-aa-id')).length : 1,
      action: formAction, method: String(primitives.property(form, 'method') || '').toLowerCase(), target: String(primitives.property(form, 'target') || ''), enctype: String(primitives.property(form, 'enctype') || '').toLowerCase(),
      controls: formElements.filter(node => ['INPUT', 'BUTTON', 'SELECT', 'TEXTAREA'].includes(primitives.property(node, 'tagName'))
        && !['hidden', 'button', 'reset'].includes(primitives.property(node, 'type'))).map(node => ({ tag: primitives.property(node, 'tagName').toLowerCase(),
        type: String(primitives.property(node, 'type') || '').toLowerCase(), name: String(primitives.property(node, 'name') || ''), autocomplete: String(attribute(node, 'autocomplete') || '') }))
        .sort((a, b) => `${a.tag}\u0000${a.type}\u0000${a.name}\u0000${a.autocomplete}`.localeCompare(`${b.tag}\u0000${b.type}\u0000${b.name}\u0000${b.autocomplete}`)),
      hasFiles, jobKeys, instanceKeys, operationKeys, invalidKeys } : null,
    overrides, destination,
  };
  if (!primitives.intact()) return changed();
  if (!options.activate) return target;
  if (!options.expectedTarget || !primitives.sameOwnData(target, options.expectedTarget)
    || target.control.disabled || !target.control.visible || !target.control.connected) return changed();
  // Use the native method on this exact reference, not an overridable property
  // or a selector/name lookup that could activate a replacement node.
  primitives.apply(primitives.click, control, []);
  return { activated: true };
}

// Both entry points serialize the same source, including its one metadata reader.
export { readNativeApplicationSourceInPage as readPortalProtocolInPage, readNativeApplicationSourceInPage as readNativeApplicationTargetInPage };

function targetDecision(reason, posting = null, binding = null) {
  return { version: NATIVE_APPLICATION_TARGET_VERSION, owned: Boolean(binding), reason,
    ...(posting ? { posting } : {}), ...(binding ? { binding } : {}) };
}

export function canonicalNativeApplicationFrameUrl(value) {
  const url = parsed(value);
  if (!url || url.protocol !== 'https:' || url.username || url.password) return null;
  url.hash = '';
  return url.href;
}

export function normalizedNativeApplicationPath(pathname) {
  try {
    const value = decodeURIComponent(pathname).replace(/\\/g, '/');
    return /%[0-9a-f]{2}|[\u0000-\u001f\u007f]/i.test(value) ? null : value;
  } catch { return null; }
}

/** Shared known-mutation fence for primary public reads and the protected read-only verifier. */
export function isReadOnlyPrimarySourceUrl(value) {
  const url = parsed(value);
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.hash) return false;
  const pathname = normalizedNativeApplicationPath(url.pathname);
  return Boolean(pathname && !/(?:^|\/)(?:(?:application)?(?:submit|finali[sz]e|save|withdraw|delete|remove|cancel|apply|send)|cancelapplication)(?:\/|$)/i.test(pathname)
    && ![...url.searchParams.keys()].some(key => NATIVE_APPLICATION_TARGET_SCHEMA.operationNames.includes(key.toLowerCase()) || /^(?:send|withdraw|delete|cancel)$/i.test(key)));
}

/** A closed primary-source adapter, never an evaluator for arbitrary inline JavaScript. */
export function primaryInlineFormSubmitHandler(value) {
  return typeof value === 'string' && value.length <= 256
    && INLINE_FORM_SUBMIT_RE.test(value);
}

export function primaryCompiledInlineFormSubmitHandler(value) {
  if (typeof value !== 'string' || value.length > 512) return false;
  const wrapper = COMPILED_INLINE_HANDLER_RE.exec(value);
  return Boolean(wrapper && primaryInlineFormSubmitHandler(wrapper[1]));
}

function applicationControls(controls) {
  return Array.isArray(controls) && controls.some(node => node.tag === 'input' && node.type === 'file')
    && controls.some(node => node.type === 'email' || /^(?:email|name|given-name|family-name)$/.test(node.autocomplete)
      || (node.tag === 'input' && node.type === 'text' && /(?:^|[\[_.-])(?:e-?mail|mail|first_?name|last_?name|vorname|nachname|nome|cognome)(?:$|[\]_.-])/i.test(node.name)));
}

function primaryControlMetadata(raw) {
  if (!raw || typeof raw.tag !== 'string' || !['input', 'button', 'select', 'textarea'].includes(raw.tag)) return null;
  const attr = String(raw.type || '').toLowerCase();
  const inputs = ['button', 'checkbox', 'color', 'date', 'datetime-local', 'email', 'file', 'hidden', 'image', 'month', 'number', 'password', 'radio', 'range', 'reset', 'search', 'submit', 'tel', 'text', 'time', 'url', 'week'];
  const type = raw.tag === 'input' ? (inputs.includes(attr) ? attr : 'text')
    : raw.tag === 'button' ? (['button', 'reset', 'submit'].includes(attr) ? attr : 'submit')
      : raw.tag === 'select' ? (raw.multiple ? 'select-multiple' : 'select-one') : 'textarea';
  if (String(raw.name || '').length > 2000 || String(raw.autocomplete || '').length > 2000) return null;
  return { tag: raw.tag, type, name: String(raw.name || ''), autocomplete: String(raw.autocomplete || '') };
}

/** DOM and parse5 producers supply raw records; this is their only semantic decoder. */
export function primaryApplicationProtocolFromRecords(records) {
  const sourceUrl = canonicalNativeApplicationFrameUrl(records?.sourceUrl);
  if (!sourceUrl || sourceUrl !== records.sourceUrl || !Array.isArray(records.headings) || records.headings.length !== 1
    || typeof records.headings[0] !== 'string' || !Array.isArray(records.forms) || records.forms.length > 100) return null;
  const sourceTitle = records.headings[0].normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!sourceTitle || sourceTitle.length > 500) return null;
  const matches = [];
  for (const raw of records.forms) {
    if (!raw || String(raw.method || '').toLowerCase() !== 'post' || !Array.isArray(raw.controls) || raw.controls.length > 1000
      || !Array.isArray(raw.submitters) || raw.submitters.length > 100) continue;
    let action;
    try { action = new URL(raw.action || sourceUrl, sourceUrl).href; } catch { continue; }
    if (action !== sourceUrl) continue;
    const controls = raw.controls.map(primaryControlMetadata);
    if (controls.some(node => !node)) continue;
    const catalog = controls.filter(node => !['hidden', 'button', 'reset'].includes(node.type))
      .sort((a, b) => `${a.tag}\u0000${a.type}\u0000${a.name}\u0000${a.autocomplete}`.localeCompare(`${b.tag}\u0000${b.type}\u0000${b.name}\u0000${b.autocomplete}`));
    if (!applicationControls(catalog)) continue;
    if (raw.submitters.filter(node => SUBMIT_RE.test(String(node?.label || '').trim())).length !== 1) continue;
    for (const submitter of raw.submitters) {
      const label = String(submitter?.label || '').normalize('NFC').replace(/\s+/g, ' ').trim();
      if (!label || label.length > 300 || !SUBMIT_RE.test(label)) continue;
      const inline = submitter.tag === 'a' && submitter.href === '#' && submitter.formRelation === 'closest'
        && primaryInlineFormSubmitHandler(submitter.inlineHandler);
      const native = ['button', 'input'].includes(submitter.tag) && submitter.formRelation === 'native'
        && primaryControlMetadata(submitter)?.type === 'submit' && !submitter.inlineHandler;
      // Overrides are not guessed from a public control's default properties.
      if ((!inline && !native) || String(submitter.name || '').length > 2000 || String(submitter.value || '').length > 2000
        || submitter.formAction != null || submitter.formMethod != null
        || submitter.formTarget != null || submitter.formEnctype != null) continue;
      matches.push({ vendor: inline ? 'primary_inline_form_submit' : 'primary_native_form_submit', origin: new URL(sourceUrl).origin,
        path: new URL(sourceUrl).pathname, sourceTitle, form: { action, method: 'post', controls: catalog },
        submitter: { tag: submitter.tag, type: inline ? 'link' : 'submit', label, href: inline ? '#' : '',
          inlineHandler: inline ? submitter.inlineHandler : '', formRelation: inline ? 'closest' : 'native',
          name: String(submitter.name || ''), value: String(submitter.value || '') } });
    }
  }
  if (matches.length !== 1) return null;
  return { ...matches[0], quoted: records };
}

function primaryPostingProtocolMatches(protocol, sourceUrl) {
  if (!['primary_inline_form_submit', 'primary_native_form_submit'].includes(protocol?.vendor)) return false;
  const rebuilt = primaryApplicationProtocolFromRecords(protocol.quoted);
  return Boolean(rebuilt && rebuilt.quoted.sourceUrl === sourceUrl && JSON.stringify(rebuilt) === JSON.stringify(protocol));
}

function targetPosting(expected) {
  const source = parsed(expected?.applyUrl);
  const jobKey = portalJobKey(expected?.applyUrl, expected?.sourceProtocol);
  if (!source || source.protocol !== 'https:' || source.username || source.password || source.hash
    || (!jobKey && [...source.searchParams.keys()].some(key => NATIVE_APPLICATION_TARGET_SCHEMA.jobNames.includes(key.toLowerCase())))) return null;
  const primaryForm = primaryPostingProtocolMatches(expected?.sourceProtocol, source.href);
  if (expected?.sourceProtocol && !primaryForm && !avaturePortalDirectory(source.href, expected.sourceProtocol)) return null;
  return { origin: source.origin, directory: avaturePortalDirectory(source.href, expected?.sourceProtocol)
    || source.pathname.slice(0, source.pathname.lastIndexOf('/') + 1), jobKey,
    ...(!jobKey ? { sourceUrl: source.href } : {}) };
}

/** A title may interpret a structural heading only after URL/job authority exists. */
function sourceAuthorityData(expected) {
  const posting = targetPosting(expected);
  const protocol = expected?.sourceProtocol;
  const title = value => String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!posting || !(avaturePostingJobKey(expected?.applyUrl, protocol) || primaryPostingProtocolMatches(protocol, expected.applyUrl)) || !protocol?.sourceTitle
    || !title(expected?.jobTitle) || title(expected.jobTitle) !== protocol.sourceTitle) return null;
  return { ...posting, sourceTitle: protocol.sourceTitle,
    urlSignature: JSON.stringify({ sourceUrl: canonicalNativeApplicationFrameUrl(expected.applyUrl), ...posting }) };
}

/** Semantic identity after full primary revalidation; unrelated public form nonces do not identify this application. */
export function nativeApplicationSourceAuthority(expected) {
  const authority = sourceAuthorityData(expected);
  if (!authority) return null;
  const protocol = expected.sourceProtocol;
  const semantic = protocol.vendor === 'avature'
    ? { vendor: protocol.vendor, portalId: protocol.portalId, namespace: protocol.namespace, page: protocol.page, origin: protocol.origin, path: protocol.path }
    : { vendor: protocol.vendor, form: protocol.form, submitter: protocol.submitter };
  const sourceFingerprint = JSON.stringify({ version: NATIVE_APPLICATION_TARGET_VERSION, authority, protocol: semantic });
  return { ...authority, sourceFingerprint };
}

export function nativeApplicationSourceFingerprint(expected) {
  return nativeApplicationSourceAuthority(expected)?.sourceFingerprint || null;
}

function targetEntryKey(entries, names) {
  if (!Array.isArray(entries) || entries.length > 1 || entries.some(entry => !names.includes(String(entry?.name || '').toLowerCase())
    || !/^[a-z0-9_-]{1,100}$/i.test(String(entry?.value || '')))) return { invalid: true, key: null };
  return { invalid: false, key: entries[0]?.value || null };
}

/** Expected context is server/runner-owned. A target's own quote/flags never supply it. */
export function validateNativeApplicationTarget({ target, expected } = {}) {
  const posting = targetPosting(expected);
  if (!posting) return targetDecision('target_unbound_posting');
  if (target?.version !== NATIVE_APPLICATION_TARGET_VERSION) return targetDecision('target_missing');
  const control = target.control; const form = target.form;
  let effect = target.destination;
  if (!control || !effect || control.lookupCount !== 1 || !control.connected || control.disabled || !control.visible
    || !SUBMIT_RE.test(String(control.label || ''))) return targetDecision('target_control_unknown');
  const primaryForm = primaryPostingProtocolMatches(expected?.sourceProtocol, expected?.applyUrl);
  const inline = primaryForm && expected.sourceProtocol.vendor === 'primary_inline_form_submit';
  if (inline) {
    const quoted = expected.sourceProtocol;
    if (!form || control.tag !== 'a' || control.type !== 'link' || control.rawHref !== '#' || control.formRelation !== 'closest'
      || control.inlineHandler !== quoted.submitter.inlineHandler || !primaryInlineFormSubmitHandler(control.inlineHandler)
      || !primaryCompiledInlineFormSubmitHandler(control.compiledHandlerSource)
      || control.label !== quoted.submitter.label || control.name !== quoted.submitter.name || control.value !== quoted.submitter.value
      || effect.kind !== 'link' || effect.url !== control.href || parsed(control.href)?.origin !== posting.origin
      || JSON.stringify(form.controls) !== JSON.stringify(quoted.form.controls)) return targetDecision('target_primary_handler_unknown');
    effect = { kind: 'primary_inline_form_submit', url: form.action, method: form.method, target: form.target, enctype: form.enctype };
  }
  const frame = parsed(target.documentUrl); const destination = parsed(effect.url);
  if (!frame || !destination || frame.protocol !== 'https:' || destination.protocol !== 'https:'
    || frame.username || frame.password || destination.username || destination.password || destination.hash
    || frame.origin !== posting.origin || destination.origin !== posting.origin) return targetDecision('target_foreign_destination');
  if (expected?.sourceProtocol?.vendor === 'avature' && !sameAvaturePortal(expected.sourceProtocol, target.protocol, target.documentUrl)) return targetDecision('target_protocol_unknown');
  if (posting.sourceUrl && (frame.href !== posting.sourceUrl || destination.href !== posting.sourceUrl)) return targetDecision('target_source_url_mismatch');
  if (primaryForm && (frame.href !== expected.applyUrl || destination.href !== expected.applyUrl)) return targetDecision('target_source_url_mismatch');
  if ([frame, destination].some(url => url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1) !== posting.directory)) return targetDecision('target_namespace_unknown');
  if (effect.target && effect.target.toLowerCase() !== '_self') return targetDecision('target_browsing_context_unknown');
  // An application intent cannot grant account, alert or destructive actions.
  const destinationPath = normalizedNativeApplicationPath(destination.pathname);
  if (!destinationPath || /(?:^|\/)(?:application)?(?:login|signin|sign-in|register|registration|profile|subscribe|unsubscribe|newsletter|alerts?|withdraw|delete|remove|cancel)(?:\/|$)/i.test(destinationPath)
    || /withdraw|delete|remove|cancel|subscribe|newsletter|login|register/i.test(String(control.name || ''))
    || [...destination.searchParams.entries()].some(([key, value]) => /^(?:action|operation|intent|command)$/i.test(key) && /withdraw|delete|remove|cancel|subscribe|register|login/i.test(value))) return targetDecision('target_non_application_action');
  const frameKey = portalJobKey(frame.href); const destinationKey = portalJobKey(destination.href);
  const hasKey = url => [...url.searchParams.keys()].some(key => NATIVE_APPLICATION_TARGET_SCHEMA.jobNames.includes(key.toLowerCase()));
  if ((hasKey(frame) && !frameKey) || (hasKey(destination) && !destinationKey)) return targetDecision('target_ambiguous_job');
  let formKey = null;
  if (effect.kind === 'native_submit' || inline) {
    if (!form || (!inline && (!['button', 'input'].includes(control.tag) || !['submit', 'image'].includes(control.type)))
      || effect.method !== 'post' || form.invalidKeys || form.markerCount !== 1
      || (form.hasFiles && effect.enctype !== 'multipart/form-data')) return targetDecision('target_native_effect_unknown');
    const overrides = target.overrides;
    if (!overrides || ['action', 'method', 'target', 'enctype'].some(key => typeof overrides[`${key}Present`] !== 'boolean'
      || (inline && overrides[`${key}Present`])
      || effect[key === 'action' ? 'url' : key] !== (overrides[`${key}Present`] ? overrides[key] : form[key]))) return targetDecision('target_native_effect_unknown');
    const binding = targetEntryKey(form.jobKeys, NATIVE_APPLICATION_TARGET_SCHEMA.jobNames);
    if (binding.invalid) return targetDecision('target_ambiguous_job');
    formKey = binding.key;
    if (!posting.sourceUrl && !destinationKey && !formKey) return targetDecision('target_unbound_destination');
    if (posting.sourceUrl && formKey) return targetDecision('target_unattested_body_job');
    const review = REVIEW_INSTRUCTIONS_RE.test(String(target.reviewEvidence || ''))
      && (target.reviewScope === 'form' || (target.reviewScope === 'document' && destination.href === target.documentUrl));
    const applicationForm = applicationControls(form.controls);
    if (!review && !applicationForm) return targetDecision('target_application_purpose_unknown');
    if (posting.sourceUrl && !applicationForm) return targetDecision('target_application_purpose_unknown');
    if (primaryForm && (JSON.stringify(form.controls) !== JSON.stringify(expected.sourceProtocol.form.controls)
      || control.tag !== expected.sourceProtocol.submitter.tag || control.label !== expected.sourceProtocol.submitter.label)) return targetDecision('target_primary_form_changed');
    if (!Array.isArray(form.operationKeys) || form.operationKeys.some(entry => !NATIVE_APPLICATION_TARGET_SCHEMA.operationNames.includes(String(entry?.name || '').toLowerCase())
      || /withdraw|delete|remove|cancel|subscribe|register|login/i.test(String(entry?.value || '')))) return targetDecision('target_non_application_action');
    if (!Array.isArray(form.instanceKeys) || form.instanceKeys.length > 20 || form.instanceKeys.some(entry => !NATIVE_APPLICATION_TARGET_SCHEMA.instanceNames.includes(String(entry?.name || '').toLowerCase())
      || typeof entry?.value !== 'string' || entry.value.length > 2000)) return targetDecision('target_owner_unknown');
  } else if (effect.kind === 'link') {
    if (control.tag !== 'a' || control.type !== 'link' || effect.method !== 'get' || form || control.href !== effect.url
      || !destinationKey || !REVIEW_INSTRUCTIONS_RE.test(String(target.reviewEvidence || ''))
      || destination.href === expected.applyUrl || destination.href === target.documentUrl
      || /(?:^|\/)(?:application)?(?:review|preview|summary|confirmation|methods|form|jobdetail)\/?$/i.test(destination.pathname)) return targetDecision('target_native_effect_unknown');
  } else return targetDecision('target_native_effect_unknown');
  if (posting.jobKey && [frameKey, destinationKey, formKey].some(key => key && key !== posting.jobKey)) return targetDecision('target_job_mismatch');
  if (!posting.sourceUrl && !frameKey && !formKey) return targetDecision('target_unbound_frame');
  return targetDecision('owned_application_target', posting, { ...target, frameUrl: canonicalNativeApplicationFrameUrl(target.documentUrl), effectiveDestination: effect });
}

/** Automated selection is unique; it never falls back to a different label or frame. */
export function selectNativeApplicationTarget(buttons, expected) {
  const owned = (buttons || []).filter(button => !button.chrome && !button.disabled).map(control => ({ control,
    decision: validateNativeApplicationTarget({ target: control.nativeTarget, expected }) }))
    .filter(({ control, decision }) => decision.owned && control.id === decision.binding.control.aaId);
  if (owned.length !== 1) return targetDecision(owned.length > 1 ? 'target_control_ambiguous' : 'target_control_unknown');
  return { ...owned[0].decision, control: owned[0].control };
}
