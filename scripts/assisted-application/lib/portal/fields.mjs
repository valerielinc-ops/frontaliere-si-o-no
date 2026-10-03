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
  // Personio marks a required field "Geschlecht* (erforderlich)" without the `required` attribute.
  const REQUIRED_LABEL = /\*|\((erforderlich|pflichtfeld|required|obbligatorio|obligatoire)\)/i;
  // Ids a framework generates, which say nothing to the planner: React's
  // useId (":r3:", "_r_3_", "«r3»"), MUI's "mui-12", "input-7", hex ids.
  const GENERATED_ID_RE = /(^|[:_«])r_?[0-9a-z]{1,4}_?[:»]|_r_\d+_|^(mui|input|field|file|upload)[-_:]?\d+$|^[a-f0-9-]{16,}$/i;
  const visible = (element) => {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (element.type === 'file') return style.display !== 'none' || rect.width >= 0; // file inputs are often hidden behind a button
    const shown = style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    if (shown || !['checkbox', 'radio'].includes(element.type)) return shown;
    // Custom-styled checkbox/radio: the native input is hidden, its label is what people click.
    const label = (element.id && document.querySelector(`label[for="${CSS.escape(element.id)}"]`)) || element.closest('label');
    if (!label) return false;
    const labelRect = label.getBoundingClientRect();
    return labelRect.width > 0 && labelRect.height > 0;
  };
  const DIALOG_SELECTOR = 'dialog, [role="dialog"], [aria-modal="true"]';
  const dialogIdFor = (element) => {
    const dialog = element.closest(DIALOG_SELECTOR);
    if (!dialog) return '';
    let id = dialog.getAttribute('data-aa-dialog-id');
    if (!id) {
      const counter = Number(document.documentElement.getAttribute('data-aa-dialog-counter') || 0) + 1;
      id = `d${counter}`;
      dialog.setAttribute('data-aa-dialog-id', id);
      document.documentElement.setAttribute('data-aa-dialog-counter', String(counter));
    }
    return id;
  };
  const dialogMeta = (element) => {
    const dialogId = dialogIdFor(element);
    return { dialog: Boolean(dialogId), dialogId };
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
    const legend = group?.querySelector('legend, .label, .question, h3, h4, label, [class*="label"], [class*="question"], [class*="title"]');
    if (legend && !legend.contains(element)) return clean(legend.innerText || legend.textContent);
    const placeholder = element.getAttribute('placeholder');
    if (placeholder) return clean(placeholder);
    // Last resort: the closest container's own text before the control.
    const container = element.closest('li, .field, .form-group, [class*="question"], [class*="field"]');
    const text = container ? clean((container.innerText || '').split('\n')[0]) : '';
    if (text) return text;
    // The first of name and id that is not generated ("input-7" never hides "email-address").
    const names = [element.getAttribute('name'), element.id].map(clean).filter(Boolean);
    const technical = names.find((value) => !GENERATED_ID_RE.test(value));
    if (technical) return technical;
    // No label, only a generated id (JOIN's CV drop zone: "file:_r_3_:input"):
    // the heading the control sits under and the text of its zone say what it
    // is ("Carica il tuo CV · Carica file"). Giro di prova 2026-10-01.
    return [...new Set([headingBefore(element), zoneText(element)].filter(Boolean))].join(' · ') || names[0] || '';
  };
  // A heading of another step a portal keeps in the page, hidden, names nothing.
  const shown = (node) => {
    if (node.closest('[hidden], [aria-hidden="true"]')) return false;
    const style = window.getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };
  // Node.DOCUMENT_POSITION_FOLLOWING, without relying on the global Node.
  const FOLLOWING = 4;
  // A heading inside another section of the page (a step, a dialog, a tab
  // the field is not in) names nothing in this one.
  const SECTIONS = 'section, article, fieldset, dialog, [role="dialog"], [role="tabpanel"], [role="region"]';
  const headingBefore = (element) => {
    let found = '';
    for (const heading of document.querySelectorAll('h1, h2, h3, h4, legend')) {
      const section = heading.closest(SECTIONS);
      if (section && !section.contains(element)) continue;
      // eslint-disable-next-line no-bitwise
      if ((heading.compareDocumentPosition(element) & FOLLOWING) && shown(heading)) found = clean(heading.innerText || heading.textContent);
    }
    return found;
  };
  // The words of the control's own zone (NodeFilter.SHOW_TEXT = 4): the text
  // nearest before it, else the first after it, so two unnamed fields in one
  // zone never share the first one's question.
  const zoneText = (element) => {
    let node = element.parentElement;
    for (let depth = 0; node && depth < 4; depth += 1, node = node.parentElement) {
      const walker = document.createTreeWalker(node, 4);
      let before = '';
      let after = '';
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        // Never from inside a control: a select's first option is an answer, not a question.
        if (text.parentElement?.closest('select, option, textarea, [role="listbox"], [role="option"], h1, h2, h3, h4, legend')) continue;
        const value = clean(text.textContent);
        if (!value) continue;
        // eslint-disable-next-line no-bitwise
        if (text.compareDocumentPosition(element) & FOLLOWING) before = value;
        else if (!after) after = value;
      }
      const words = before || after;
      if (words) return words.slice(0, 80);
    }
    return '';
  };
  const groupQuestion = (element) => {
    const group = element.closest('fieldset, [role="radiogroup"], [role="group"], .application-question, .field, li');
    const legend = group?.querySelector('legend, .question, .label, h3, h4');
    return clean(legend?.innerText || legend?.textContent || '');
  };
  // Ids stay unique per document: a component that clones a node (Personio
  // resets its file input that way) copies data-aa-id too, so every copy after
  // the first one gets a new id.
  const seen = new Set();
  for (const element of document.querySelectorAll('[data-aa-id]')) {
    const id = element.getAttribute('data-aa-id');
    if (seen.has(id)) element.removeAttribute('data-aa-id');
    else seen.add(id);
  }
  let counter = Number(document.documentElement.getAttribute('data-aa-counter') || 0);
  const idFor = (element) => {
    if (!element.getAttribute('data-aa-id')) {
      counter += 1;
      element.setAttribute('data-aa-id', `f${counter}`);
    }
    return element.getAttribute('data-aa-id');
  };
  // A limit the form states only in words or with a counter ("max. 500
  // caratteri", "0 / 1000"): shortened by us at a sentence end rather than cut
  // by the portal mid-sentence (career-ops counts the final answer).
  const statedLimit = (element) => {
    const described = (element.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent || '').join(' ');
    const zone = `${described} ${element.parentElement?.parentElement?.textContent || ''}`.slice(0, 2000);
    const words = /(?:max(?:imum|imal)?\.?|massimo|höchstens|jusqu'à|bis zu|up to|fino a)\s*(\d{2,5})\s*(?:characters|chars|caratteri|zeichen|caractères)/i.exec(zone);
    // A counter only from the field's own description: "Step 1 / 12" is no limit.
    const counter = /\b\d{1,5}\s*\/\s*(\d{2,5})\b/.exec(described);
    return Number(words?.[1] || counter?.[1]) || null;
  };
  const fields = [];
  // JOIN's date picker is a question made of two comboboxes and a grid of day
  // buttons. Treat the widget as one field: exposing its implementation
  // controls separately gives the planner two generated questions and leaves
  // the disabled next button untouched.
  const datePickerSelector = '[data-scope="date-picker"][data-part="root"]';
  for (const picker of document.querySelectorAll(datePickerSelector)) {
    if (!visible(picker)) continue;
    const label = clean(picker.getAttribute('aria-label') || headingBefore(picker) || zoneText(picker));
    const selected = picker.querySelector('[data-part="table-cell-trigger"][data-selected], [data-part="table-cell-trigger"][aria-selected="true"]')?.getAttribute('data-value') || '';
    fields.push({
      id: idFor(picker),
      kind: 'date',
      ...dialogMeta(picker),
      inputType: 'date',
      name: clean(picker.getAttribute('name') || ''),
      label,
      required: picker.getAttribute('aria-required') !== 'false' && !picker.hasAttribute('data-optional'),
      value: clean(selected),
      search: false,
      maxLength: null,
      accept: '',
      autocomplete: clean(picker.getAttribute('autocomplete') || ''),
      invalid: picker.getAttribute('aria-invalid') === 'true',
    });
  }
  const radios = new Map();
  const controls = document.querySelectorAll('input, select, textarea, [role="combobox"]');
  for (const element of controls) {
    const tag = element.tagName.toLowerCase();
    const type = tag === 'input' ? (element.getAttribute('type') || 'text').toLowerCase() : tag;
    if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) continue;
    // The site's own search box is not part of the application; Workday's
    // "selectinput" (a search box that picks an option) is.
    if (type === 'search' && element.getAttribute('data-uxi-widget-type') !== 'selectinput') continue;
    if (element.closest(datePickerSelector)) continue;
    if (element.disabled || element.readOnly || !visible(element)) continue;
    const required = element.required || element.getAttribute('aria-required') === 'true';
    if (type === 'radio') {
      const name = element.name || element.id;
      const question = groupQuestion(element);
      const entry = radios.get(name) || { id: idFor(element), kind: 'radio', ...dialogMeta(element), name, label: question || labelFor(element), required, value: '', options: [] };
      // Required natively on any option, or by the group's own label ("Geschlecht* (erforderlich)").
      entry.required = entry.required || required || Boolean(question && REQUIRED_LABEL.test(question));
      entry.options.push({ value: element.value, label: labelFor(element), aaId: idFor(element) });
      // The chosen option, so a page planned again does not choose it again.
      if (element.checked) entry.value = labelFor(element);
      radios.set(name, entry);
      continue;
    }
    // Workday's "selectinput" is a search box whose chosen value is a pill next to it.
    const multiselectId = element.getAttribute('data-uxi-multiselect-id');
    const pills = multiselectId
      ? [...document.querySelectorAll(`[data-uxi-widget-type="selectinputlistitem"][data-uxi-multiselect-id="${CSS.escape(multiselectId)}"]`)].map((item) => clean(item.innerText)).filter(Boolean)
      : [];
    const field = {
      id: idFor(element),
      kind: type === 'checkbox' ? 'checkbox' : type === 'file' ? 'file' : tag === 'select' ? 'select' : tag === 'textarea' ? 'textarea' : element.getAttribute('role') === 'combobox' ? 'combobox' : 'text',
      ...dialogMeta(element),
      inputType: type,
      name: clean(element.getAttribute('name') || ''),
      label: labelFor(element),
      required: required || REQUIRED_LABEL.test(labelFor(element)),
      value: type === 'file' ? '' : pills.length ? pills.join(', ') : clean(element.value || ''),
      search: element.getAttribute('data-uxi-widget-type') === 'selectinput' || element.getAttribute('enterkeyhint') === 'search',
      maxLength: Number(element.getAttribute('maxlength')) > 0 ? Number(element.getAttribute('maxlength')) : (tag === 'textarea' || type === 'text' ? statedLimit(element) : null),
      accept: type === 'file' ? clean(element.getAttribute('accept') || '') : '',
      autocomplete: clean(element.getAttribute('autocomplete') || ''),
      invalid: element.getAttribute('aria-invalid') === 'true',
    };
    if (tag === 'select') {
      field.options = [...element.options].slice(0, 300).map((option) => ({ value: option.value, label: clean(option.textContent) }));
    }
    if (type === 'checkbox') field.checked = element.checked;
    fields.push(field);
  }
  for (const entry of radios.values()) fields.push(entry);
  // ARIA radio groups without a native input (JOIN's option cards,
  // <div role="radio" aria-checked>): one field per group, its question from
  // the group's label or the heading before it, each option by its own text
  // without the "a"/"b" badge. Giro di prova 2026-10-01 ("Qual è il suo stato
  // di autorizzazione al lavoro per Svizzera?" read as no field at all).
  const ariaGroups = new Map();
  for (const element of document.querySelectorAll('[role="radio"]')) {
    if (element.tagName.toLowerCase() === 'input' || element.getAttribute('aria-disabled') === 'true' || !visible(element)) continue;
    let container = element.closest('[role="radiogroup"]');
    for (let node = element.parentElement; !container && node && node !== document.body; node = node.parentElement) {
      if (node.querySelectorAll('[role="radio"]').length > 1) container = node;
    }
    container ||= element.parentElement;
    const words = [];
    const walker = document.createTreeWalker(element, 4);
    for (let text = walker.nextNode(); text && words.length < 2; text = walker.nextNode()) {
      const value = clean(text.textContent);
      if (value.length > 1) words.push(value);
    }
    const label = clean(element.getAttribute('aria-label') || textOf(element.getAttribute('aria-labelledby')) || words.join(' — '));
    if (!label) continue;
    let entry = ariaGroups.get(container);
    if (!entry) {
      const question = clean(container.getAttribute('aria-label') || textOf(container.getAttribute('aria-labelledby'))) || groupQuestion(element) || headingBefore(element);
      entry = { id: idFor(container), kind: 'radio', ...dialogMeta(container), name: '', label: question, required: container.getAttribute('aria-required') === 'true' || REQUIRED_LABEL.test(question), value: '', options: [] };
      ariaGroups.set(container, entry);
    }
    entry.options.push({ value: label, label, aaId: idFor(element) });
    if (element.getAttribute('aria-checked') === 'true') entry.value = label;
  }
  for (const entry of ariaGroups.values()) if (entry.options.length) fields.push(entry);
  // Workday-style dropdowns are buttons that open a listbox (OfferOS
  // aria-driver): a field whose options are read later by opening it.
  for (const element of document.querySelectorAll('button[aria-haspopup="listbox"], [role="button"][aria-haspopup="listbox"]')) {
    if (element.disabled || !visible(element)) continue;
    const label = labelFor(element);
    // The site's own language menu is not part of the application.
    if (/language.?selector|sprachauswahl/i.test(`${label} ${element.getAttribute('data-automation-id') || ''}`)) continue;
    fields.push({
      id: idFor(element),
      kind: 'listbox',
      ...dialogMeta(element),
      inputType: 'listbox',
      name: clean(element.getAttribute('name') || ''),
      label: label === clean(element.innerText) ? groupQuestion(element) || label : label,
      required: element.getAttribute('aria-required') === 'true' || REQUIRED_LABEL.test(label),
      value: clean(element.innerText || element.textContent),
      invalid: element.getAttribute('aria-invalid') === 'true',
    });
  }
  const buttons = [...document.querySelectorAll('button, input[type="submit"], a[role="button"], [role="button"]')]
    .filter((element) => visible(element) && element.getAttribute('aria-haspopup') !== 'listbox')
    .map((element) => ({
      id: idFor(element),
      ...dialogMeta(element),
      text: clean(element.innerText || element.value || element.getAttribute('aria-label') || ''),
      disabled: Boolean(element.disabled) || element.getAttribute('aria-disabled') === 'true',
      href: element.tagName === 'A' && /^https?:/.test(element.href || '') ? element.href : '',
    }))
    .filter((button) => button.text)
    .slice(0, 60);
  // Saved after the buttons got their ids too, or the next scan hands them out again.
  document.documentElement.setAttribute('data-aa-counter', String(counter));
  // Only a CAPTCHA a person must act on counts (career-ops: fill, and hand
  // the human step over). Invisible reCAPTCHA/hCaptcha badges, present on
  // most Lever and Greenhouse forms from the start, are not a challenge.
  const answered = (name) => {
    const responses = [...document.querySelectorAll(`[name="${name}"]`)];
    return responses.length > 0 && responses.every((field) => String(field.value || '').trim());
  };
  const captcha = [...document.querySelectorAll('iframe')].some((frame) => {
    const src = String(frame.getAttribute('src') || '');
    const rect = frame.getBoundingClientRect();
    const shown = rect.width > 40 && rect.height > 40 && window.getComputedStyle(frame).visibility !== 'hidden';
    if (!shown) return false;
    if (/recaptcha\/(api2|enterprise)\/anchor/.test(src)) return !/size=invisible/.test(src) && !answered('g-recaptcha-response');
    if (/recaptcha\/(api2|enterprise)\/bframe/.test(src)) return !answered('g-recaptcha-response');
    if (/hcaptcha\.com/.test(src)) return /frame=(challenge|checkbox)(?!-invisible)/.test(src) && !answered('h-captcha-response');
    // DataDome (SmartRecruiters): a full-page challenge or block, never solved by the runner.
    if (/challenges\.cloudflare\.com/.test(src)) return !answered('cf-turnstile-response');
    return /captcha-delivery\.com/.test(src);
  });
  const passwordVisible = [...document.querySelectorAll('input[type="password"]')].some(visible);
  // The form's own validation messages, read back to the planner when a page does not advance.
  // A framework's route announcer is no message on the form: Next.js reads the
  // page title as role="alert" (JOIN, 2026-10-01). Only the announcer itself is
  // left out: a visually hidden validation message still counts (review of #10707).
  const ROUTE_ANNOUNCER = '#__next-route-announcer__, next-route-announcer, #gatsby-announcer, [id*="route-announcer" i]';
  // Rendered, whatever its size: a message styled for screen readers only
  // (1 px, or 0) is still the form's reason (second review of #10707).
  const rendered = (element) => (typeof element.checkVisibility === 'function'
    ? element.checkVisibility({ visibilityProperty: true })
    : window.getComputedStyle(element).display !== 'none' && window.getComputedStyle(element).visibility !== 'hidden');
  const errors = [...new Set([...document.querySelectorAll('[role="alert"], [data-automation-id*="error" i], [class*="error-message" i], [class*="errorMessage"], .error, .invalid-feedback')]
    .filter((element) => rendered(element) && !element.closest(ROUTE_ANNOUNCER))
    .map((element) => clean(element.innerText || element.textContent).slice(0, 160))
    .filter(Boolean))].slice(0, 8);
  return {
    url: location.href,
    title: document.title,
    fields,
    buttons,
    captcha,
    passwordVisible,
    errors,
    text: clean(document.body?.innerText || '').slice(0, 300) + ' ' + clean(document.body?.innerText || '').slice(-600),
  };
}
/* eslint-enable no-undef */

/** Open a listbox button, read its options, close it again. */
export async function readListboxOptions(frame, aaId) {
  const button = frame.locator(`[data-aa-id="${aaId}"]`).first();
  try {
    await button.click({ timeout: 5000 });
    // Only the open list, but all of it: Workday keeps the options of a list
    // opened before in the DOM (hidden), and a long list scrolls.
    const list = frame.locator('[role="listbox"]:visible').last();
    const hasList = await list.waitFor({ state: 'visible', timeout: 4000 }).then(() => true, () => false);
    const options = hasList ? list.locator('[role="option"]') : frame.locator('[role="option"]:visible');
    await options.first().waitFor({ state: 'attached', timeout: 4000 });
    const labels = (await options.allInnerTexts()).map((text) => text.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 300);
    await button.press('Escape').catch(() => {});
    return labels.map((label) => ({ value: label, label }));
  } catch {
    await frame.page().keyboard.press('Escape').catch(() => {});
    return [];
  }
}

/**
 * Same-origin frames are scanned too; each frame's fields carry its index.
 * `listboxOptions` opens every listbox to read its options: only for a page
 * about to be planned, since the Escape that closes a list also closes a modal
 * (Workday's apply dialog).
 */
export async function extractFields(page, { listboxOptions = true } = {}) {
  const frames = page.frames();
  const result = { url: page.url(), fields: [], buttons: [], captcha: false, passwordVisible: false, errors: [], text: '', frames: [] };
  for (const [index, frame] of frames.entries()) {
    if (index > 0 && /recaptcha|hcaptcha|challenges\.cloudflare|turnstile|captcha-delivery|doubleclick|googletagmanager|youtube|vimeo/i.test(frame.url())) continue;
    let snapshot;
    try {
      snapshot = await frame.evaluate(extractFieldsInPage);
    } catch {
      continue; // cross-origin or detached
    }
    for (const field of listboxOptions ? snapshot.fields.filter((item) => item.kind === 'listbox').slice(0, 15) : []) {
      field.options = await readListboxOptions(frame, field.id);
    }
    result.frames.push({ index, url: snapshot.url });
    result.fields.push(...snapshot.fields.map((field) => ({ ...field, frame: index })));
    result.buttons.push(...snapshot.buttons.map((button) => ({ ...button, frame: index })));
    result.captcha ||= snapshot.captcha;
    result.passwordVisible ||= snapshot.passwordVisible;
    result.errors.push(...snapshot.errors);
    if (index === 0) result.text = snapshot.text;
  }
  return result;
}
