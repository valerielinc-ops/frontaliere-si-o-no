/** Per-document physical group identity; no DOM/input value is written. */
export function installNativeGroupIdentityInPage() {
  const keys = new WeakMap(); let next = 0;
  Object.defineProperty(window, '__portalNativeGroupKey', { configurable: false, writable: false,
    value: node => { if (!keys.has(node)) keys.set(node, `native_group_${++next}`); return keys.get(node); } });
}

/** Read the actual native control behind an already recognized visible widget. */
export function nativeControlEvidenceInPage(fields) {
  const clean = value => String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim();
  const forms = [...document.forms];
  const annotated = [...document.querySelectorAll('[data-aa-id]')];
  const withId = [...document.querySelectorAll('[id]')];
  if (typeof window.__portalNativeGroupKey !== 'function') return [];
  const groupSelector = 'fieldset,section,article,[role=group],[role=radiogroup]';
  const ownLabels = (element, seeds = []) => {
    const referenced = clean(element.getAttribute('aria-labelledby')).split(/\s+/).filter(Boolean)
      .map(id => withId.filter(node => node.id === id));
    if (referenced.some(nodes => nodes.length !== 1)) return [];
    return [...new Set(seeds.map(node => {
      const copy = node.cloneNode(true);
      for (const child of copy.querySelectorAll?.('input,select,textarea,script,style') || []) child.remove();
      return clean(copy.textContent);
    }).concat(element.getAttribute('aria-label') || '', referenced.length
      ? referenced.map(nodes => clean(nodes[0].textContent)).join(' ') : '').map(clean).filter(Boolean))];
  };
  const ownerSeeds = element => {
    const groupedContainer = element.matches('.field,.form-group,.fieldset') && element.querySelector(groupSelector);
    const headings = [...element.children].filter(node => /^(?:LEGEND|H[1-6])$/.test(node.tagName)
      || node.getAttribute('role') === 'heading' || (node.tagName === 'LABEL' && !node.control)
      || (groupedContainer && node.tagName === 'P'));
    if (element.tagName !== 'LABEL') headings.push(...[...element.childNodes]
      .filter(node => node.nodeType === 3 && clean(node.textContent)));
    return headings;
  };
  const isNamedOwner = element => element.matches(groupSelector) || element.hasAttribute('aria-label')
    || element.hasAttribute('aria-labelledby') || ownerSeeds(element).length > 0;
  const purpose = group => {
    const labels = ownLabels(group, ownerSeeds(group));
    return labels.length === 1 ? labels[0] : '';
  };
  const closestOwner = control => {
    const form = control.form || control.closest('form');
    for (let parent = control.parentElement; parent && parent !== document.body && parent !== document.documentElement; parent = parent.parentElement) {
      if (isNamedOwner(parent)) return parent;
      if (parent === form) break;
    }
    return null;
  };
  const result = [];
  for (const field of fields) {
    if (field.frame !== 0) continue;
    const proxies = annotated.filter(element => element.getAttribute('data-aa-id') === field.id);
    if (proxies.length !== 1 || field.nativeContractUnavailable) continue;
    const proxy = proxies[0];
    let control = proxy;
    let bridged = false;
    if (field.nativeSelectId) {
      const native = withId.filter(element => element.id === field.nativeSelectId);
      if (field.widget !== 'jquery-selectmenu' || native.length !== 1 || native[0].tagName !== 'SELECT'
        || native[0].multiple || proxy.id !== `${field.nativeSelectId}-button`
        || !proxy.classList.contains('ui-selectmenu-button') || proxy.getAttribute('role') !== 'combobox'
        || proxy.getAttribute('aria-owns') !== `${field.nativeSelectId}-menu`
        || withId.filter(element => element.id === proxy.id).length !== 1
        || !native[0].form || proxy.closest('form') !== native[0].form
        || closestOwner(proxy) !== closestOwner(native[0])) continue;
      control = native[0];
      bridged = true;
    }
    if (!['INPUT', 'SELECT', 'TEXTAREA'].includes(control.tagName) || typeof control.required !== 'boolean') continue;
    const labels = ownLabels(control, [...(control.labels || [])]);
    const nativeLabelOwned = labels.length === 1 && labels[0] === clean(field.label);
    if (bridged && !nativeLabelOwned) continue;
    const label = nativeLabelOwned ? labels[0] : field.label;
    const nativeOwnerGroups = [];
    const visitedOwners = new Set();
    for (let parent = control.parentElement; parent && parent !== document.body && parent !== document.documentElement; parent = parent.parentElement) {
      visitedOwners.add(parent);
      if (isNamedOwner(parent)) nativeOwnerGroups.push({ key: window.__portalNativeGroupKey(parent), purpose: purpose(parent) });
      if (parent === control.form) break;
    }
    if (control.form && !visitedOwners.has(control.form) && isNamedOwner(control.form)) {
      nativeOwnerGroups.push({ key: window.__portalNativeGroupKey(control.form), purpose: purpose(control.form) });
    }
    const referenceNodes = [...new Set([control, ...visitedOwners, control.form, ...(control.labels || [])].filter(Boolean))];
    let nativeReferencesComplete = true;
    for (let index = 0; index < referenceNodes.length; index++) {
      if (referenceNodes.length > 512) { nativeReferencesComplete = false; break; }
      for (const attribute of ['aria-labelledby', 'aria-describedby', 'aria-details']) {
        for (const id of clean(referenceNodes[index].getAttribute?.(attribute)).split(/\s+/).filter(Boolean)) {
          const matching = withId.filter(node => node.id === id);
          if (matching.length !== 1) nativeReferencesComplete = false;
          for (const node of matching) if (!referenceNodes.includes(node)) {
            if (referenceNodes.length >= 512) { nativeReferencesComplete = false; break; }
            referenceNodes.push(node);
          }
        }
      }
    }
    const ariaRequired = control.getAttribute('aria-required');
    result.push({ id: field.id, nativeControlOwned: true, nativeLabelOwned, nativeReferencesComplete, nativeOwnerGroups, nativeControlId: control.id || '',
      nativeSelectId: bridged ? control.id : field.nativeSelectId || '', bridged,
      nativeRequired: control.required, required: control.required || ariaRequired === 'true',
      explicitlyOptional: nativeLabelOwned && !control.required && ariaRequired === 'false', form: forms.indexOf(control.form),
      name: control.getAttribute('name') || field.name || '',
      invalid: field.invalid || control.getAttribute('aria-invalid') === 'true', label,
      ...(control.tagName === 'SELECT' ? { kind: 'select', inputType: control.type,
        options: [...control.options].filter(option => !option.matches(':disabled') && !option.closest('optgroup:disabled'))
          .map(option => ({ value: option.value, label: clean(option.label ?? option.textContent),
            ...(control.required && !control.multiple && control.size <= 1 && control.options[0] === option
              && option.parentElement === control && option.value === '' ? { placeholder: true } : {}) })) } : {}) });
  }
  return result;
}

export function snapshotWithNativeControlEvidence(snapshot, evidence = []) {
  return { ...snapshot, fields: snapshot.fields.map(field => {
    if (field.frame !== 0) return field;
    const matching = evidence.filter(marker => marker.id === field.id && marker.nativeControlOwned === true);
    if (matching.length !== 1) return { ...field, nativeControlOwned: false, nativeLabelOwned: false, nativeReferencesComplete: false };
    const { id: _id, nativeRequired: _nativeRequired, explicitlyOptional: _optional, bridged: _bridged, ...contract } = matching[0];
    return { ...field, ...contract };
  }) };
}

/** Freeze the identity, label references and mutable properties read above. */
export function observeNativeControlContractInPage(refs) {
  window.__portalNativeContractChanged = false;
  const changed = (kind = 'unknown', attribute = null) => {
    if (window.__portalNativeContractChanged) return;
    window.__portalNativeContractChanged = true;
    window.__portalNativeContractChange = { kind, attribute };
    void window.__portalContractProbeNativeChanged({ kind, attribute }).catch(() => {});
  };
  const direct = [...document.querySelectorAll('[data-aa-id]')]
    .filter(element => refs.some(ref => ref.id === element.getAttribute('data-aa-id')));
  const native = [...document.querySelectorAll('select')].filter(element => refs.some(ref => ref.nativeControlOwned
    && ref.nativeSelectId && ref.nativeSelectId === element.id));
  const controls = [...new Set([...direct, ...native])];
  const forms = [...new Set(controls.map(element => element.form).filter(Boolean))];
  const allIds = [...document.querySelectorAll('[id]')];
  const groups = new Set();
  for (const control of controls) for (let parent = control.parentElement; parent && parent !== document.body && parent !== document.documentElement; parent = parent.parentElement) {
    groups.add(parent);
    if (parent === control.form) break;
  }
  const initialControls = new Set([...controls, ...forms, ...groups, ...controls.flatMap(element => [...(element.labels || [])])]);
  const referenceIds = new Set();
  const queue = [...initialControls];
  for (let index = 0; index < queue.length; index++) {
    if (queue.length > 512) { changed('reference_budget'); return; }
    for (const attribute of ['aria-labelledby', 'aria-describedby', 'aria-details']) {
      const ids = String(queue[index].getAttribute?.(attribute) || '').split(/\s+/).filter(Boolean);
      for (const id of ids) {
        referenceIds.add(id);
        const matching = allIds.filter(element => element.id === id);
        // Missing/ambiguous references are an initial unknown component, not a
        // mutation. Their IDs and all existing nodes remain watched for changes.
        for (const node of matching) if (!initialControls.has(node)) {
          if (queue.length >= 512) { changed('reference_budget'); return; }
          initialControls.add(node); queue.push(node);
        }
      }
    }
  }
  const ancestors = new Set();
  for (const control of controls) for (let parent = control.parentElement; parent; parent = parent.parentElement) ancestors.add(parent);
  if (typeof window.getComputedStyle !== 'function') { changed('visibility_unknown'); return; }
  const potential = [...document.querySelectorAll('input,select,textarea,[role=combobox],[role=checkbox],[role=radio]')]
    .filter(element => forms.includes(element.form) || forms.some(form => form.contains(element)));
  const visibilityNodes = new Set([...initialControls, ...forms, ...potential, ...ancestors]);
  for (const node of potential) for (let parent = node.parentElement; parent; parent = parent.parentElement) visibilityNodes.add(parent);
  const visibility = node => {
    const style = window.getComputedStyle(node);
    const rect = node.getBoundingClientRect?.();
    return [Boolean(node.hidden), node.getAttribute?.('aria-hidden') === 'true', style.display === 'none',
      ['hidden', 'collapse'].includes(style.visibility), style.contentVisibility === 'hidden', Number(style.opacity) === 0,
      Boolean(rect && rect.width > 0 && rect.height > 0)].join('|');
  };
  const visibleAtSnapshot = new Map([...visibilityNodes].map(node => [node, visibility(node)]));
  const visibilityChanged = () => [...visibleAtSnapshot].some(([node, before]) => visibility(node) !== before);
  Object.defineProperty(window, '__portalNativeContractStillStable', { configurable: false, writable: false,
    value: () => { if (visibilityChanged()) changed('visibility'); return !window.__portalNativeContractChanged; } });
  const rememberedIds = new Set([...referenceIds, ...[...initialControls, ...forms].map(element => element.id).filter(Boolean)]);
  const dataIds = new Set(refs.map(ref => ref.id));
  const owned = node => initialControls.has(node) || [...initialControls].some(control => control.contains?.(node))
    || forms.some(form => node === form || form.contains(node) || node.form === form);
  const identityCollision = node => [node, ...(node.querySelectorAll?.('[id],[data-aa-id]') || [])]
    .some(element => rememberedIds.has(element.id) || dataIds.has(element.getAttribute?.('data-aa-id')));
  const attributes = new Set(['required', 'aria-required', 'aria-invalid', 'disabled', 'type', 'name', 'form',
    'id', 'class', 'style', 'hidden', 'aria-hidden', 'role', 'aria-owns', 'aria-controls', 'aria-label', 'aria-labelledby', 'aria-describedby',
    'aria-details', 'multiple', 'size', 'value', 'for', 'label', 'data-aa-id']);
  const observer = new MutationObserver(records => {
    const mutation = records.find(record => {
      if (record.type === 'characterData') return owned(record.target);
      if (record.type === 'childList') return owned(record.target)
        || [...record.addedNodes, ...record.removedNodes].some(node => owned(node) || identityCollision(node)
          || forms.some(form => node.contains?.(form)) || [...initialControls].some(control => node.contains?.(control)));
      if (record.oldValue === record.target.getAttribute?.(record.attributeName)) return false;
      if (record.attributeName === 'id' && (rememberedIds.has(record.target.id) || rememberedIds.has(record.oldValue))) return true;
      if (record.attributeName === 'data-aa-id' && (dataIds.has(record.target.getAttribute?.('data-aa-id')) || dataIds.has(record.oldValue))) return true;
      return owned(record.target) && attributes.has(record.attributeName)
        || ancestors.has(record.target) && ['role', 'disabled'].includes(record.attributeName);
    });
    if (mutation) changed(mutation.type === 'attributes' ? 'attribute' : mutation.type === 'childList' ? 'child_list' : 'character_data',
      mutation.type === 'attributes' && attributes.has(mutation.attributeName) ? mutation.attributeName : null);
    else if (visibilityChanged()) changed('visibility');
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true,
    attributeOldValue: true, characterData: true });
}


const identityText = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const PERSONAL_PURPOSES = new Set(['dati personali', 'informazioni personali', 'personal information', 'personal details', 'personal data',
  'personliche daten', 'personliche angaben', 'personalien', 'personendaten', 'donnees personnelles', 'informations personnelles', 'coordonnees personnelles']);
const IDENTITY_PARTS = [
  { names: new Set(['firstname', 'givenname', 'vorname', 'nome', 'prenom']), labels: new Set(['first name', 'given name', 'vorname', 'nome', 'prenom']) },
  { names: new Set(['lastname', 'familyname', 'surname', 'nachname', 'familienname', 'cognome', 'nom']), labels: new Set(['last name', 'family name', 'surname', 'nachname', 'familienname', 'cognome', 'nom', 'nom de famille']) },
  { names: new Set(['email', 'mail', 'courriel']), labels: new Set(['email', 'e mail', 'e mail adresse', 'adresse e mail', 'indirizzo e mail', 'email address', 'e mail address', 'courriel']) },
];
const FOREIGN_IDENTITY_SCOPE = /\b(?:reference|referee|referent[ei]?|referenze|emergency|emergenza|notfallkontakt|arbeitgeber|vorgesetzt\w*|datore di lavoro|azienda|entreprise|employeur|employer|supervisor|company|newsletter|riferimento|referenz\w*)\b/;

/** Only the complete, owned personal group can substitute for missing HTML email semantics. */
export function hasNativeApplicantIdentity(fields, form, applicationTitle = '') {
  const titleText = value => String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim();
  const expectedTitle = titleText(applicationTitle);
  const owned = fields.filter(field => field.frame === 0 && field.form === form);
  if (owned.some(field => field.nativeReferencesComplete === true && (field.inputType === 'email' || /^(?:email|name|given-name|family-name)$/.test(field.autocomplete || '')))) return true;
  const groups = new Map();
  for (const field of owned) {
    const path = field.nativeOwnerGroups;
    if (!Array.isArray(path) || !path.length || !path[0].key) continue;
    const name = /(?:^|\[)([a-z][a-z_-]{0,39})\]?$/i.exec(String(field.name || ''))?.[1]?.toLowerCase().replace(/[-_]/g, '') || '';
    const label = identityText(field.label);
    const namePart = IDENTITY_PARTS.findIndex(part => part.names.has(name));
    const labelPart = IDENTITY_PARTS.findIndex(part => part.labels.has(label));
    if (namePart < 0 && labelPart < 0) continue;
    const key = path[0].key;
    if (!groups.has(key)) groups.set(key, { parts: [[], [], []], unknown: false });
    const group = groups.get(key);
    if (field.nativeReferencesComplete !== true || field.nativeControlOwned !== true || field.nativeLabelOwned !== true || field.kind !== 'text' || field.inputType !== 'text' || field.required !== true
      || !PERSONAL_PURPOSES.has(identityText(path[0].purpose))
      || path.some(owner => !owner.key || FOREIGN_IDENTITY_SCOPE.test(identityText(owner.purpose))
        || (!PERSONAL_PURPOSES.has(identityText(owner.purpose)) && (!expectedTitle || titleText(owner.purpose) !== expectedTitle)))
      || (field.section && !PERSONAL_PURPOSES.has(identityText(field.section)))
      || FOREIGN_IDENTITY_SCOPE.test(identityText(`${field.context || ''} ${field.name || ''}`))
      || namePart < 0 || namePart !== labelPart) group.unknown = true;
    else group.parts[namePart].push(field);
  }
  return [...groups.values()].some(group => !group.unknown && group.parts.every(part => part.length === 1)
    && new Set(group.parts.flat().map(field => field.id)).size === 3);
}
