/**
 * Form-field discovery for the portal runner. `extractFieldsInPage` runs
 * inside the page (Playwright `evaluate`) and is self-contained on purpose.
 *
 * Label resolution follows OfferOS' read-field-meta (Apache-2.0,
 * apps/extension/src/lib/autofill/read-field-meta.ts): `label[for]`,
 * `aria-labelledby`, `aria-label`, the wrapping `<label>`, the fieldset
 * legend / group question, then placeholder and name. Each visible, enabled
 * control gets a stable `data-aa-id` so the filler can find it again after
 * React re-renders (career-ops quirk: never cache element handles).
 */

/* eslint-disable no-undef -- runs in the browser */
export function extractFieldsInPage() {
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const visible = (element) => {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (element.type === 'file') return style.display !== 'none' || rect.width >= 0; // file inputs are often hidden behind a button
    return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
  };
  const textOf = (id) => {
    const node = id && document.getElementById(id);
    return node ? clean(node.innerText || node.textContent) : '';
  };
  const labelFor = (element) => {
    if (element.id) {
      const direct = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
      if (direct) return clean(direct.innerText || direct.textContent);
    }
    const labelledBy = (element.getAttribute('aria-labelledby') || '').split(/\s+/).map(textOf).filter(Boolean).join(' ');
    if (labelledBy) return labelledBy;
    if (element.getAttribute('aria-label')) return clean(element.getAttribute('aria-label'));
    const wrapping = element.closest('label');
    if (wrapping) return clean(wrapping.innerText || wrapping.textContent);
    const group = element.closest('fieldset, [role="group"], [role="radiogroup"], .field, .form-group, .application-question, li');
    const legend = group?.querySelector('legend, .label, .question, h3, h4, label');
    if (legend) return clean(legend.innerText || legend.textContent);
    return clean(element.getAttribute('placeholder') || element.getAttribute('name') || element.id);
  };
  const groupQuestion = (element) => {
    const group = element.closest('fieldset, [role="radiogroup"], [role="group"], .application-question, .field, li');
    const legend = group?.querySelector('legend, .question, .label, h3, h4');
    return clean(legend?.innerText || legend?.textContent || '');
  };
  let counter = Number(document.documentElement.getAttribute('data-aa-counter') || 0);
  const idFor = (element) => {
    if (!element.getAttribute('data-aa-id')) {
      counter += 1;
      element.setAttribute('data-aa-id', `f${counter}`);
    }
    return element.getAttribute('data-aa-id');
  };
  const fields = [];
  const radios = new Map();
  const controls = document.querySelectorAll('input, select, textarea, [role="combobox"]');
  for (const element of controls) {
    const tag = element.tagName.toLowerCase();
    const type = tag === 'input' ? (element.getAttribute('type') || 'text').toLowerCase() : tag;
    if (['hidden', 'submit', 'button', 'reset', 'image', 'search'].includes(type)) continue;
    if (element.disabled || element.readOnly || !visible(element)) continue;
    const required = element.required || element.getAttribute('aria-required') === 'true';
    if (type === 'radio') {
      const name = element.name || element.id;
      const entry = radios.get(name) || { id: idFor(element), kind: 'radio', name, label: groupQuestion(element) || labelFor(element), required, options: [] };
      entry.required = entry.required || required;
      entry.options.push({ value: element.value, label: labelFor(element), aaId: idFor(element) });
      radios.set(name, entry);
      continue;
    }
    const field = {
      id: idFor(element),
      kind: type === 'checkbox' ? 'checkbox' : type === 'file' ? 'file' : tag === 'select' ? 'select' : tag === 'textarea' ? 'textarea' : element.getAttribute('role') === 'combobox' ? 'combobox' : 'text',
      inputType: type,
      name: clean(element.getAttribute('name') || ''),
      label: labelFor(element),
      required: required || /\*\s*$/.test(labelFor(element)),
      value: type === 'file' ? '' : clean(element.value || ''),
      maxLength: Number(element.getAttribute('maxlength')) || null,
      accept: type === 'file' ? clean(element.getAttribute('accept') || '') : '',
      autocomplete: clean(element.getAttribute('autocomplete') || ''),
    };
    if (tag === 'select') {
      field.options = [...element.options].slice(0, 300).map((option) => ({ value: option.value, label: clean(option.textContent) }));
    }
    if (type === 'checkbox') field.checked = element.checked;
    fields.push(field);
  }
  for (const entry of radios.values()) fields.push(entry);
  document.documentElement.setAttribute('data-aa-counter', String(counter));
  const buttons = [...document.querySelectorAll('button, input[type="submit"], a[role="button"], [role="button"]')]
    .filter((element) => visible(element) && !element.disabled)
    .map((element) => ({ id: idFor(element), text: clean(element.innerText || element.value || element.getAttribute('aria-label') || '') }))
    .filter((button) => button.text)
    .slice(0, 60);
  // Only a CAPTCHA a person must act on counts (career-ops: fill, and hand
  // the human step over). Invisible reCAPTCHA/hCaptcha badges, present on
  // most Lever and Greenhouse forms from the start, are not a challenge.
  const captcha = [...document.querySelectorAll('iframe')].some((frame) => {
    const src = String(frame.getAttribute('src') || '');
    const rect = frame.getBoundingClientRect();
    const shown = rect.width > 40 && rect.height > 40 && window.getComputedStyle(frame).visibility !== 'hidden';
    if (!shown) return false;
    if (/recaptcha\/(api2|enterprise)\/anchor/.test(src)) return !/size=invisible/.test(src);
    if (/recaptcha\/(api2|enterprise)\/bframe/.test(src)) return true;
    if (/hcaptcha\.com/.test(src)) return /frame=(challenge|checkbox)(?!-invisible)/.test(src);
    return /challenges\.cloudflare\.com/.test(src);
  });
  const passwordVisible = [...document.querySelectorAll('input[type="password"]')].some(visible);
  return {
    url: location.href,
    title: document.title,
    fields,
    buttons,
    captcha,
    passwordVisible,
    text: clean(document.body?.innerText || '').slice(0, 300) + ' ' + clean(document.body?.innerText || '').slice(-600),
  };
}
/* eslint-enable no-undef */

/** Same-origin frames are scanned too; each frame's fields carry its index. */
export async function extractFields(page) {
  const frames = page.frames();
  const result = { url: page.url(), fields: [], buttons: [], captcha: false, passwordVisible: false, text: '', frames: [] };
  for (const [index, frame] of frames.entries()) {
    if (index > 0 && /recaptcha|hcaptcha|challenges\.cloudflare|turnstile|doubleclick|googletagmanager|youtube|vimeo/i.test(frame.url())) continue;
    let snapshot;
    try {
      snapshot = await frame.evaluate(extractFieldsInPage);
    } catch {
      continue; // cross-origin or detached
    }
    result.frames.push({ index, url: snapshot.url });
    result.fields.push(...snapshot.fields.map((field) => ({ ...field, frame: index })));
    result.buttons.push(...snapshot.buttons.map((button) => ({ ...button, frame: index })));
    result.captcha ||= snapshot.captcha;
    result.passwordVisible ||= snapshot.passwordVisible;
    if (index === 0) result.text = snapshot.text;
  }
  return result;
}
