/** Capture and bind the exact native form that owns a final application click. */
export function installFinalFormGuardCaptureInPage(targetDocument = globalThis.document) {
  const document = targetDocument;
  const view = document?.defaultView || globalThis.window;
  if (!document || !view) return false;
  if (view.__frontaliereFinalFormGuardCaptureInstalled) return true;
  Object.defineProperty(view, '__frontaliereFinalFormGuardCaptureInstalled', { configurable: true, value: true });
  const capture = method => event => {
    const registry = view.__frontaliereFinalFormGuards;
    if (!registry) return;
    for (const state of Object.values(registry)) state[method]?.(event);
  };
  for (const eventName of ['pointerdown', 'mousedown', 'touchstart', 'click']) {
    view.addEventListener(eventName, capture('onClick'), true);
  }
  view.addEventListener('click', event => {
    const locks = view.__frontaliereAgentFinalClickLocks;
    if (!locks || !Object.keys(locks).length) return;
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
    const target = path.find(node => node?.nodeType === 1) || event.target;
    const control = target?.closest?.('button, a, input[type="submit"], input[type="button"], [role="button"], [role="link"], [onclick]') || target;
    const name = String(control?.getAttribute?.('aria-label') || control?.getAttribute?.('title')
      || control?.value || control?.innerText || control?.textContent || '').replace(/\s+/gu, ' ').trim();
    const sendVerb = /\b(?:submit|send|senden|absenden|abschicken|abschlie(?:ß|ss)en|invia|envoy|soumettre|finish|finali[sz]e|fertig|complete|conclud|termina|bestätig|conferm|confirm)\b/iu.test(name);
    const applicationVerb = /\b(?:apply|bewerb|candida|postul)\w*\b/iu.test(name);
    const allowedEntries = view.__frontaliereAgentAllowedEntryClicks;
    const isAllowedEntry = allowedEntries?.has(control) && !control.closest?.('form, [role="form"]')
      && applicationVerb && !sendVerb;
    if (isAllowedEntry) {
      allowedEntries.delete(control);
      return;
    }
    const finalControl = sendVerb || applicationVerb;
    if (!finalControl) return;
    const registry = view.__frontaliereFinalFormGuards || {};
    const explicitlyArmed = Object.values(registry).some(state => state.status === 'click_checked'
      && (path.includes(state.button) || state.button?.contains?.(target)));
    if (explicitlyArmed) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }, true);
  document.addEventListener('submit', event => {
    const locks = view.__frontaliereAgentFinalClickLocks;
    if (!locks || !Object.keys(locks).length) return;
    const form = event.target;
    const submitter = event.submitter;
    const registry = view.__frontaliereFinalFormGuards || {};
    const explicitlyArmed = Object.values(registry).some(state => state.status === 'click_checked'
      && state.button?.form === form);
    if (explicitlyArmed) return;
    const name = String(submitter?.getAttribute?.('aria-label') || submitter?.getAttribute?.('title')
      || submitter?.value || submitter?.innerText || submitter?.textContent || '').replace(/\s+/gu, ' ').trim();
    const finalSubmit = !submitter
      || /\b(?:submit|send|senden|absenden|abschicken|abschlie(?:ß|ss)en|invia|envoy|soumettre|finish|finali[sz]e|fertig|complete|conclud|termina|bestätig|conferm|confirm|apply|bewerb|candida|postul)\w*\b/iu.test(name);
    if (!finalSubmit) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }, true);
  return true;
}

/** Allow one explicitly authorized application-entry control outside a form. */
export function allowAgentApplicationEntryClickInPage(element, targetWindow = globalThis.window) {
  const view = targetWindow;
  const control = element?.closest?.('button, a, input[type="submit"], input[type="button"], [role="button"], [role="link"], [onclick]') || element;
  if (!view || !control || control.closest?.('form, [role="form"]')) return false;
  const allowed = view.__frontaliereAgentAllowedEntryClicks || (view.__frontaliereAgentAllowedEntryClicks = new WeakSet());
  allowed.add(control);
  return true;
}

/** Prevent agent-driven final clicks while allowing the runner's armed click. */
export function installAgentFinalClickLockInPage(token, targetWindow = globalThis.window) {
  const view = targetWindow;
  if (!view || typeof token !== 'string' || !token) return false;
  const locks = view.__frontaliereAgentFinalClickLocks || (view.__frontaliereAgentFinalClickLocks = Object.create(null));
  locks[token] = true;
  return true;
}

export function releaseAgentFinalClickLockInPage(token, targetWindow = globalThis.window) {
  const view = targetWindow;
  const locks = view?.__frontaliereAgentFinalClickLocks;
  if (!locks || typeof token !== 'string') return false;
  delete locks[token];
  return true;
}

export function armFinalFormClickGuardInPage(button, {
  token,
  expectedButtonId = '',
  expectedFormId = '',
  expectedButtonName = '',
} = {}) {
  const document = button?.ownerDocument;
  const view = document?.defaultView;
  const fail = reason => ({ ok: false, reason });
  if (!document || !view || !token || typeof token !== 'string') return fail('invalid_guard');
  // Playwright serializes this function by itself; the init script must have
  // installed the self-contained capture listener before navigation.
  if (view.__frontaliereFinalFormGuardCaptureInstalled !== true) return fail('capture_unavailable');

  const owner = button.form || button.closest?.('form');
  if (!owner) return fail('form_unlinked');
  const buttonId = String(button.getAttribute('data-aa-id') || '');
  const formId = String(owner.getAttribute('data-aa-id') || '');
  if (!buttonId || !formId || buttonId !== expectedButtonId || formId !== expectedFormId) {
    return { ...fail('form_binding_changed'), buttonId, formId };
  }
  if (button.disabled || button.getAttribute('aria-disabled') === 'true') return fail('submitter_disabled');

  const compact = value => String(value ?? '').normalize('NFC').replace(/\s+/gu, ' ').trim().slice(0, 500);
  const textFor = node => compact(node?.innerText || node?.textContent || '');
  const ownerFor = node => node?.form || node?.closest?.('form') || null;
  const secretFingerprint = value => {
    let hash = 0xcbf29ce484222325n;
    for (const character of String(value || '')) {
      hash ^= BigInt(character.codePointAt(0));
      hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    }
    return `${String(value || '').length}:${hash.toString(16)}`;
  };
  const accessibleName = node => {
    const ids = String(node?.getAttribute?.('aria-labelledby') || '').split(/\s+/u).filter(Boolean);
    const labelled = ids.map(id => textFor(document.getElementById(id))).filter(Boolean).join(' ');
    return compact(labelled || node?.getAttribute?.('aria-label') || node?.getAttribute?.('title') || node?.value || textFor(node));
  };
  const optionContract = option => ({
    value: String(option.value ?? ''),
    label: textFor(option),
    selected: Boolean(option.selected),
    disabled: Boolean(option.disabled),
  });
  const controlContract = node => {
    const tag = String(node.tagName || '').toLowerCase();
    const type = String(node.getAttribute('type') || (tag === 'textarea' ? 'textarea' : tag === 'select' ? 'select' : '')).toLowerCase();
    const labels = [
      ...(node.labels ? [...node.labels].map(textFor) : []),
      ...String(node.getAttribute('aria-labelledby') || '').split(/\s+/u).filter(Boolean).map(id => textFor(document.getElementById(id))),
      node.getAttribute('aria-label') || '', node.getAttribute('title') || '', node.getAttribute('placeholder') || '',
    ].map(compact).filter(Boolean);
    const uniqueLabels = [...new Set(labels)];
    const fieldset = node.closest?.('fieldset');
    const legend = fieldset?.querySelector?.(':scope > legend');
    const fieldsetDisabled = [];
    for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (String(ancestor.tagName || '').toLowerCase() !== 'fieldset') continue;
      const firstLegend = [...(ancestor.children || [])].find(child => String(child.tagName || '').toLowerCase() === 'legend');
      fieldsetDisabled.push(Boolean(ancestor.disabled) && !firstLegend?.contains(node));
    }
    const resolvedFormAction = node.hasAttribute?.('formaction')
      ? String(node.formAction || new URL(String(node.getAttribute('formaction') ?? ''), document.baseURI).href)
      : '';
    const value = tag === 'input' && type === 'file'
      ? [...(node.files || [])].map(file => ({
        name: String(file.name || ''), size: Number(file.size) || 0,
        type: String(file.type || ''), lastModified: Number(file.lastModified) || 0,
      }))
      : type === 'password' ? { fingerprint: secretFingerprint(node.value), present: Boolean(node.value) }
      : tag === 'select' ? [...node.options].filter(option => option.selected).map(option => String(option.value ?? ''))
        : type === 'checkbox' || type === 'radio' ? Boolean(node.checked)
          : typeof node.value === 'string' ? node.value : '';
    const attributes = {};
    for (const name of [
      'id', 'name', 'type', 'role', 'data-aa-id', 'data-control-id', 'data-semantic-id',
      'data-automation-id', 'autocomplete', 'accept', 'min', 'max', 'minlength', 'maxlength',
      'pattern', 'step', 'multiple', 'required', 'aria-required', 'aria-invalid', 'disabled',
      'readonly', 'aria-disabled', 'aria-checked', 'aria-selected', 'aria-expanded', 'form',
      'formaction', 'formmethod', 'formenctype', 'formtarget', 'formnovalidate',
    ]) {
      if (node.hasAttribute?.(name)) attributes[name] = String(node.getAttribute(name) ?? '');
    }
    const isSubmitter = node === button;
    if (isSubmitter) {
      delete attributes.disabled;
      delete attributes['aria-disabled'];
      delete attributes['aria-busy'];
    }
    return {
      tag, type, attributes,
      labels: uniqueLabels,
      context: textFor(legend),
      value,
      options: tag === 'select' ? [...node.options].map(optionContract) : [],
      text: !isSubmitter && (/^(?:button|a)$/u.test(tag) || node.getAttribute?.('role') === 'button') ? textFor(node) : '',
      disabled: !isSubmitter && Boolean(node.disabled),
      fieldsetDisabled,
      resolvedFormAction,
      required: Boolean(node.required) || String(node.getAttribute?.('aria-required') || '').trim().toLowerCase() === 'true',
    };
  };
  const isCaptchaControl = node => {
    const name = String(node?.getAttribute?.('name') || node?.name || '').toLowerCase();
    const id = String(node?.getAttribute?.('id') || node?.id || '').toLowerCase();
    const cls = String(node?.className || '').toLowerCase();
    if (/h-?captcha|recaptcha|cf-turnstile|turnstile/i.test(name)
      || /h-?captcha|recaptcha|cf-turnstile|turnstile/i.test(id)
      || /h-?captcha|g-recaptcha|cf-turnstile/i.test(cls)) {
      return true;
    }
    if (node?.hasAttribute?.('data-sitekey') || node?.hasAttribute?.('data-hcaptcha-widget-id')) {
      return true;
    }
    return false;
  };
  const isDynamicMetadataControl = node => {
    if (isCaptchaControl(node)) return true;
    const tag = String(node?.tagName || '').toLowerCase();
    const type = String(node?.getAttribute?.('type') || '').toLowerCase();
    const name = String(node?.getAttribute?.('name') || node?.name || '').toLowerCase();
    const id = String(node?.getAttribute?.('id') || node?.id || '').toLowerCase();
    if (tag === 'input' && (type === 'hidden' || !type)) {
      if (/^(?:resumestorageid|timezone|applicant-timezone|source|origin|referer|referrer|socialreferralkey|socialsource|linkedindata|accountid|timestamp|token|_token|csrf|_csrf|authenticity_token|__requestverificationtoken)$/i.test(name)) {
        return true;
      }
      if (/^(?:applicant-timezone|resumestorageid)$/i.test(id)) {
        return true;
      }
    }
    return false;
  };
  const collect = () => {
    const selector = 'input, select, textarea, button, a[href], [role="button"], [role="checkbox"], [role="radio"], [role="combobox"], [role="listbox"]';
    const controls = [...new Set([
      ...document.querySelectorAll(selector),
      ...owner.querySelectorAll(selector),
    ])].filter(node => ownerFor(node) === owner && (node === button || !isDynamicMetadataControl(node)));
    return JSON.stringify({
      page: `${view.location.origin}${view.location.pathname}${view.location.search}`,
      owner: {
        id: String(owner.getAttribute('id') || ''),
        name: String(owner.getAttribute('name') || ''),
        aaId: formId,
        action: String(owner.getAttribute('action') || ''),
        resolvedAction: String(owner.action || ''),
        method: String(owner.getAttribute('method') || 'get').toLowerCase(),
        enctype: String(owner.enctype || 'application/x-www-form-urlencoded').toLowerCase(),
        target: String(owner.getAttribute('target') || ''),
        noValidate: Boolean(owner.noValidate),
      },
      submitter: controlContract(button),
      controls: controls.map(controlContract),
    });
  };

  const contractJson = collect();
  const expectedName = compact(expectedButtonName);
  const registry = view.__frontaliereFinalFormGuards || (view.__frontaliereFinalFormGuards = Object.create(null));
  const state = { status: 'armed', contractJson, owner, button, onClick: null };
  const block = (event, status) => {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    state.status = status;
  };
  state.onClick = event => {
    if (state.status === 'blocked_before_click') {
      block(event, 'blocked_before_click');
      return;
    }
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
    const candidate = (path.includes(button) || (event.target && button.contains(event.target)))
      ? button
      : path.find(node => node && node.nodeType === 1 && (
        node === button || node.matches?.('button, input[type="submit"], input[type="button"], a[href], [role="button"]')
      ));
    if (!candidate) return;
    const sameName = expectedName && accessibleName(candidate) === expectedName;
    if (ownerFor(candidate) !== owner && candidate !== button && !sameName) return;

    const isSubmitterCandidate = candidate === button
      || candidate.matches?.('button[type="submit"], input[type="submit"]')
      || sameName;
    if (!isSubmitterCandidate) return;

    const isSecondaryFormSubmitter = candidate !== button
      && state.status === 'click_checked'
      && ownerFor(candidate) === owner
      && (isCaptchaControl(candidate) || String(candidate.type || '').toLowerCase() === 'submit');

    if (isSecondaryFormSubmitter) {
      return;
    }

    if (candidate !== button || ownerFor(candidate) !== owner || collect() !== contractJson) {
      block(event, 'blocked_before_click');
      return;
    }
    state.status = 'click_checked';
  };
  registry[token] = state;
  return { ok: true, buttonId, formId, nativeFormId: String(owner.getAttribute('id') || ''), contractJson };
}

/** Read the in-page result after Playwright dispatched the final click. */
export function readFinalFormGuardStatusInPage(_button, token) {
  const key = typeof token === 'string' ? token : typeof _button === 'string' ? _button : '';
  const view = _button?.ownerDocument?.defaultView || globalThis.window;
  return view?.__frontaliereFinalFormGuards?.[key]?.status || 'missing';
}

/** Remove event listeners after the click attempt without changing its result. */
export function clearFinalFormGuardInPage(_button, token) {
  const key = typeof token === 'string' ? token : typeof _button === 'string' ? _button : '';
  const view = _button?.ownerDocument?.defaultView || globalThis.window;
  const state = view?.__frontaliereFinalFormGuards?.[key];
  if (!state) return false;
  delete view.__frontaliereFinalFormGuards[key];
  return true;
}
