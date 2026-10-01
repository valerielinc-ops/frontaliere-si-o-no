/**
 * Compila candidatura — the page engine of the owner's fill extension.
 *
 * Owner decision 2026-10-01: when a portal refuses the robot (JOIN's
 * invisible reCAPTCHA), Valerie sends the application from her own browser.
 * This engine types what the portal runner would have typed — the fill kit
 * (functions/src/assistedApplicationFillKit.js): first the answers the runner
 * put on this very portal, worded as the portal asks, then the candidate's
 * identity, birth date and documents — and moves through the steps with the
 * portal's own "next" buttons.
 *
 * It never presses a send button. SUBMIT_RE marks the final one, which the
 * extension only highlights: the human click is what makes the application
 * Valerie's and not a robot's, the very thing an anti-bot check asks.
 *
 * The patterns are the runner's (lib/portal/fill.mjs, portal.mjs, agent.mjs);
 * tests/assisted-application-fill-extension.test.ts fails when they drift.
 * A classic script (no import/export): the extension injects it before
 * content.js, which reads `globalThis.CompilaCandidatura`.
 */
(function (root) {
  'use strict';

  const NEXT_RE = /^(next|continue|weiter|avanti|continua|prosegui|suivant|continuer|nächster schritt|save and continue|speichern und weiter|proceed)\b/i;
  const SUBMIT_RE = /(submit|send application|apply now|^apply$|^confirm and (apply|send|submit)\W*$|absenden|bewerbung (absenden|senden|abschicken)|jetzt bewerben|^bestätigen und (bewerben|absenden|senden)\W*$|invia( la)? candidatura|^invia$|candidati ora|^candidati$|^applica$|^conferma e (applica|invia|candidati)\W*$|envoyer( ma)? candidature|^envoyer$|postuler|soumettre|^confirmer et (postuler|envoyer)\W*$)/i;
  const CONFIRM_RE = /(thank you for (your )?appl|thanks for applying|application (has been )?(received|submitted|sent)|we have received your|vielen dank für (ihre|deine) bewerbung|ihre bewerbung (ist )?(eingegangen|erhalten|wurde (erfolgreich )?(übermittelt|gesendet))|grazie per (la tua|la sua|aver inviato|esserti candidat)|candidatura (è stata )?(inviata|ricevuta)|merci pour votre candidature|votre candidature a (bien )?été (envoyée|reçue|transmise))/i;
  const REFUSED_RE = /(non siamo riusciti a inviare la (tua|sua) candidatura|impossibile inviare la candidatura|we (couldn['’]?t|could not|were unable to) (submit|send) your application|your application could not be (submitted|sent)|(ihre|deine) bewerbung konnte nicht (gesendet|übermittelt|abgeschickt) werden|wir konnten (ihre|deine) bewerbung nicht (senden|übermitteln)|nous n['’]avons pas pu (envoyer|transmettre) votre candidature|votre candidature n['’]a pas pu être (envoyée|transmise))/i;
  const APPLY_RE = /(\bapply\b|bewerben\b|bewerbung starten|zur bewerbung|\bcandidati\b|\bcandidarsi\b|invia (la tua )?candidatura|\bpostuler\b|\bpostulez\b|je postule)/i;
  const NOT_ADVANCE_RE = /(\bback\b|zurück|indietro|précédent|retour|cancel|abbrechen|annulla|annuler|\bclose\b|\bschlie(ß|ss)en\b|\bchiudi\b|\bfermer\b|\bsign (in|up|out)\b|\bsign\b|log ?in|log ?out|anmeld|abmeld|accedi|\besci\b|connexion|regist|konto|account|delete|löschen|elimina|supprimer)/i;
  const COOKIE_REJECT_RE = /^(ablehnen|alle ablehnen|nur (notwendige|erforderliche)( cookies)?|reject( all)?|decline( all)?|only necessary|rifiuta( tutti| tutto)?|solo necessari|refuser( tout)?|tout refuser|continuer sans accepter)$/i;
  // «Continua con Google»: a sign-in, never the next step.
  const SOCIAL_RE = /(google|linkedin|facebook|apple|microsoft|xing|indeed|github)/i;

  // Field families, on the normalized label (accents gone, lower case).
  // German compounds («Geburtsdatum», «Telefonnummer», «Postleitzahl»): a
  // family word may start a longer word.
  const FAMILIES = [
    ['email', /\b(e ?mail|email address|indirizzo e ?mail|adresse e ?mail)\b/],
    ['birthDate', /(data di nascita|\bnascita\b|\bnato\b|\bnata\b|\bbirth|\bgeburt|naissance)/],
    ['fullName', /^(name|your name|il tuo nome|ihr name|votre nom)$|\b(full name|nome e cognome|nome completo|vor und nachname|vollstandiger name|nom complet)\b/],
    ['firstName', /\b(first name|given name|vorname|prenom|nome)\b/],
    ['lastName', /\b(last name|surname|family name|nachname|familienname|cognome|nom de famille|nom)\b/],
    ['phone', /(\bphone|\btelefon|\btelephone|\bcellulare|\bmobil|\bnatel|\bhandy|numero di telefono)/],
    ['postalCode', /(\bcap\b|\bpostal|\bzip\b|\bplz\b|\bpostleitzahl|\bnpa\b|code postal)/],
    ['city', /\b(citta|city|ort|wohnort|ville|localita|comune)\b/],
    ['street', /(\bstreet|\bvia\b|strasse|\badresse|\bindirizzo|\brue\b)/],
    ['country', /\b(paese|country|land|pays|nazione)\b/],
    ['linkedin', /\blinkedin\b/],
  ];
  // A place, not a date: «Luogo di nascita», «Geburtsort».
  const PLACE_RE = /(luogo|geburtsort|lieu de|place of)/;
  const NOT_PERSON_RE = /\b(azienda|company|firma|unternehmen|entreprise|utente|user|benutzer|referenz|reference|riferimento)/;
  const CONSENT_RE = /\b(privacy|datenschutz|informativa|termini|terms|condizioni|agb|conditions|consenso|consent|einwillig|accetto|akzeptiere|accept|j accepte)\b/;
  const MARKETING_RE = /\b(newsletter|marketing|werbung|pubblicit|promozion|promotion|offerte|angebote|job alert|talent pool|talentpool)\b/;
  const CV_RE = /\b(cv|curriculum|lebenslauf|resume)\b/;
  const LETTER_RE = /\b(lettera|cover letter|anschreiben|motivation|motivazione|lettre)\b/;

  const config = { waitMs: 3000, stepMs: 150 };

  function normalize(value) {
    return String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/[^a-z0-9@+]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /** Visible text with a space between blocks (textContent glues «b» to «Posso lavorare…»). */
  function textOf(element) {
    if (!element) return '';
    const parts = [];
    const walker = element.ownerDocument.createTreeWalker(element, 4);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.parentElement?.closest('script, style, svg, [aria-hidden="true"]')) parts.push(node.textContent);
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  function isShown(element) {
    const view = element.ownerDocument.defaultView;
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      if (node.hidden) return false;
      const style = view.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function waitFor(check, ms = config.waitMs) {
    const end = Date.now() + ms;
    for (;;) {
      const value = check();
      if (value || Date.now() > end) return value;
      await sleep(config.stepMs);
    }
  }

  function fire(element, type, init = {}) {
    const view = element.ownerDocument.defaultView;
    const Kind = type.startsWith('key') ? view.KeyboardEvent
      : /^(mouse|click|pointer)/.test(type) ? (type.startsWith('pointer') && view.PointerEvent) || view.MouseEvent : view.Event;
    element.dispatchEvent(new Kind(type, { bubbles: true, cancelable: true, composed: true, ...init }));
  }

  /** A real-looking press: the portal's own handlers run, as for a mouse. */
  function press(element) {
    element.scrollIntoView?.({ block: 'center' });
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) fire(element, type, { button: 0 });
    element.click();
  }

  /** React-safe value: the prototype setter, then the events a keyboard would raise. */
  function setValue(element, value) {
    const view = element.ownerDocument.defaultView;
    const proto = element.tagName === 'TEXTAREA' ? view.HTMLTextAreaElement.prototype
      : element.tagName === 'SELECT' ? view.HTMLSelectElement.prototype : view.HTMLInputElement.prototype;
    element.focus?.();
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, value);
    fire(element, 'input');
    fire(element, 'change');
  }

  /** The words a person reads for this control. */
  function labelOf(element) {
    const doc = element.ownerDocument;
    const byIds = (ids) => ids.split(/\s+/).map((id) => textOf(doc.getElementById(id))).join(' ').trim();
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy && byIds(labelledBy)) return byIds(labelledBy);
    if (element.id) {
      const label = doc.querySelector(`label[for="${element.id.replace(/["\\]/g, "\\$&")}"]`);
      if (label && textOf(label)) return textOf(label);
    }
    const wrapping = element.closest('label');
    if (wrapping && textOf(wrapping)) return textOf(wrapping);
    if (element.getAttribute('aria-label')) return element.getAttribute('aria-label');
    // A field group (Zag/Ark, fieldset): its own label or legend.
    const group = element.closest('[role="group"], fieldset');
    const legend = group?.querySelector('label, legend');
    if (legend && !legend.contains(element) && textOf(legend)) return textOf(legend);
    return questionOf(element) || element.getAttribute('placeholder') || element.getAttribute('name') || '';
  }

  /** The heading a control sits under (JOIN asks one question per step, in an h2). */
  function questionOf(element) {
    for (let node = element.parentElement; node && node.tagName !== 'BODY'; node = node.parentElement) {
      const headings = [...node.querySelectorAll('h1, h2, h3, h4, legend, [role="heading"]')]
        .filter((heading) => !heading.contains(element) && (heading.compareDocumentPosition(element) & 4));
      if (headings.length) return textOf(headings[headings.length - 1]);
      if (node.tagName === 'FORM') break;
    }
    return '';
  }

  // ---- What the page asks ---------------------------------------------------

  /**
   * The page's questions: text-like inputs, selects, comboboxes, files,
   * checkboxes, radio groups (native and ARIA) and date pickers.
   */
  function collect(doc) {
    const entries = [];
    const inPicker = (element) => element.closest('[data-scope="date-picker"]');
    for (const picker of doc.querySelectorAll('[data-scope="date-picker"][data-part="root"]')) {
      if (isShown(picker)) entries.push({ kind: 'date', element: picker, label: questionOf(picker) || labelOf(picker), required: true });
    }
    const controls = doc.querySelectorAll('input, textarea, select');
    const radiosByName = new Map();
    for (const element of controls) {
      const type = (element.getAttribute('type') || 'text').toLowerCase();
      if (['hidden', 'submit', 'button', 'image', 'reset', 'search', 'password'].includes(type)) continue;
      if (inPicker(element) || element.disabled || element.readOnly) continue;
      if (type !== 'file' && !isShown(element)) continue;
      const required = element.required || element.getAttribute('aria-required') === 'true' || element.hasAttribute('data-required');
      if (type === 'radio') {
        const key = element.name || element.closest('[role="radiogroup"], fieldset') || element;
        if (!radiosByName.has(key)) radiosByName.set(key, []);
        radiosByName.get(key).push(element);
        continue;
      }
      const kind = type === 'file' ? 'file' : type === 'checkbox' ? 'checkbox'
        : element.tagName === 'SELECT' ? 'select'
          : element.getAttribute('role') === 'combobox' ? 'combobox'
            : element.tagName === 'TEXTAREA' ? 'textarea' : type === 'date' ? 'native-date' : 'text';
      entries.push({ kind, element, label: labelOf(element), required, type });
    }
    for (const radios of radiosByName.values()) {
      entries.push({ kind: 'radio', element: radios[0], options: radios.map((radio) => ({ element: radio, label: labelOf(radio) })), label: questionOf(radios[0]), required: radios.some((radio) => radio.required) });
    }
    // ARIA radios (div role="radio"), grouped under the question they answer.
    const ariaGroups = new Map();
    for (const radio of doc.querySelectorAll('[role="radio"]')) {
      if (radio.tagName === 'INPUT' || !isShown(radio) || inPicker(radio)) continue;
      const group = radio.closest('[role="radiogroup"]') || radio.parentElement?.parentElement?.parentElement || radio.parentElement;
      const key = radio.closest('[role="radiogroup"]') ? group : questionOf(radio) || group;
      if (!ariaGroups.has(key)) ariaGroups.set(key, []);
      ariaGroups.get(key).push(radio);
    }
    for (const radios of ariaGroups.values()) {
      const group = radios[0].closest('[role="radiogroup"]');
      entries.push({
        kind: 'aria-radio',
        element: radios[0],
        options: radios.map((radio) => ({ element: radio, label: textOf(radio) })),
        label: (group && group.getAttribute('aria-label')) || questionOf(radios[0]),
        required: true,
      });
    }
    return entries;
  }

  function isEmpty(entry) {
    const { element } = entry;
    if (entry.kind === 'checkbox') return !element.checked;
    if (entry.kind === 'file') return !(element.files && element.files.length);
    if (entry.kind === 'radio') return !entry.options.some((option) => option.element.checked);
    if (entry.kind === 'aria-radio') return !entry.options.some((option) => option.element.getAttribute('aria-checked') === 'true');
    if (entry.kind === 'date') return element.hasAttribute('data-empty') || !element.querySelector('[data-selected], [aria-selected="true"]');
    if (entry.kind === 'combobox') {
      if (String(element.value || '').trim()) return false;
      // react-select shows the choice next to the input, or a placeholder.
      const box = comboBox(element);
      return !box || Boolean(box.querySelector('[id$="-placeholder"], [class*="placeholder"]')) || !textOf(box);
    }
    if (entry.kind === 'select') return !element.value || /^(|0|-1|null|none|select|bitte wahlen|seleziona|choisir)$/i.test(normalize(element.options[element.selectedIndex]?.text));
    return !String(element.value || '').trim();
  }

  function comboBox(input) {
    return input.closest('[data-testid*="Select"], [data-testid="CityName"], [class*="control"], [role="group"]') || input.parentElement?.parentElement || null;
  }

  // ---- What to answer ---------------------------------------------------------

  /** The kit answer whose question is this label (the runner's own wording first). */
  function kitAnswer(label, kit) {
    const wanted = normalize(label);
    if (!wanted) return null;
    const answers = kit.answers || [];
    const exact = answers.find((item) => normalize(item.question) === wanted);
    if (exact) return exact;
    // «Carica il tuo CV · Carica file»: the runner joins a heading and a label.
    return answers.find((item) => {
      const question = normalize(item.question);
      return question.length >= 6 && wanted.length >= 6 && (question.startsWith(wanted) || wanted.startsWith(question) || question.includes(` ${wanted}`));
    }) || null;
  }

  function familyOf(entry) {
    const label = normalize(entry.label);
    if (entry.type === 'email' || entry.element.getAttribute('autocomplete') === 'email') return 'email';
    if (entry.type === 'tel' || entry.element.getAttribute('autocomplete') === 'tel') return 'phone';
    const auto = entry.element.getAttribute('autocomplete') || '';
    if (auto === 'given-name') return 'firstName';
    if (auto === 'family-name') return 'lastName';
    if (NOT_PERSON_RE.test(label)) return null;
    const family = FAMILIES.find(([, pattern]) => pattern.test(label))?.[0] || null;
    return family === 'birthDate' && PLACE_RE.test(label) ? null : family;
  }

  function identityValue(family, kit) {
    const id = kit.identity || {};
    const address = id.address || {};
    const locationParts = String(id.location || '').split(',').map((part) => part.trim()).filter(Boolean);
    switch (family) {
      case 'email': return id.email;
      case 'fullName': return id.fullName;
      case 'firstName': return id.firstName;
      case 'lastName': return id.lastName;
      case 'phone': return id.phone;
      case 'postalCode': return address.postalCode;
      case 'city': return address.city || locationParts[0];
      case 'street': return address.street;
      case 'country': return address.country || (locationParts.length > 1 ? locationParts[locationParts.length - 1] : '');
      case 'linkedin': return id.linkedin;
      case 'birthDate': return kit.profile?.dateOfBirth;
      default: return '';
    }
  }

  /** The value for one entry, or null: never invented, always from the kit. */
  function answerFor(entry, kit) {
    const fromKit = kitAnswer(entry.label, kit);
    if (entry.kind === 'file') {
      const label = normalize(`${entry.label} ${fromKit?.question || ''}`);
      const accept = String(entry.element.getAttribute('accept') || '');
      if (/image|png|jpe?g/i.test(accept) && !/pdf|doc/i.test(accept)) return null;
      if (LETTER_RE.test(label) && !CV_RE.test(label)) return { document: 'coverLetter' };
      if (CV_RE.test(label) || fromKit?.source === 'documents' || CV_RE.test(normalize(questionOf(entry.element)))) return { document: 'cv' };
      return null;
    }
    if (entry.kind === 'checkbox') {
      const label = normalize(entry.label);
      // Only the required acceptance of the portal's terms: never a newsletter or a talent pool.
      return entry.required && CONSENT_RE.test(label) && !MARKETING_RE.test(label) ? { check: true } : null;
    }
    if (fromKit && fromKit.source !== 'documents') return { value: fromKit.answer };
    const family = ['text', 'textarea', 'combobox', 'select', 'native-date', 'date'].includes(entry.kind) ? familyOf(entry) : null;
    const value = family ? identityValue(family, kit) : '';
    if (value) return { value, family };
    if (entry.kind === 'textarea' && LETTER_RE.test(normalize(entry.label)) && kit.texts?.coverLetter) return { value: kit.texts.coverLetter };
    return null;
  }

  // ---- Choosing among options -------------------------------------------------

  /** The one option the answer names (equal, or the answer starts with it), else null. */
  function bestOption(options, answer) {
    const wanted = normalize(answer);
    if (!wanted) return null;
    const scored = options.map((option) => {
      const full = normalize(option.label);
      // JOIN letters its choices («a», «b»…): without the marker.
      const bare = full.replace(/^[a-z] /, '');
      let score = 0;
      if (full === wanted || bare === wanted) score = 3;
      else if (bare.length >= 3 && (wanted.startsWith(`${bare} `) || bare.startsWith(`${wanted} `))) score = 2;
      else if (wanted.length >= 6 && bare.includes(wanted)) score = 1;
      return { option, score };
    }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score);
    if (!scored.length) return null;
    if (scored.length > 1 && scored[1].score === scored[0].score) return null;
    return scored[0].option;
  }

  function optionsNear(input) {
    const doc = input.ownerDocument;
    const listId = input.getAttribute('aria-controls') || input.getAttribute('aria-owns');
    const scope = (listId && doc.getElementById(listId)) || doc;
    return [...scope.querySelectorAll('[role="option"], [id*="-option-"]')].filter(isShown)
      .map((element) => ({ element, label: textOf(element) }));
  }

  /** react-select and its kin: type to filter, click the matching option. */
  async function chooseInCombobox(input, answer) {
    const box = comboBox(input);
    if (box) press(box);
    input.focus?.();
    setValue(input, String(answer).slice(0, 40));
    const option = await waitFor(() => bestOption(optionsNear(input), answer));
    if (!option) {
      fire(input, 'keydown', { key: 'Escape' });
      return false;
    }
    press(option.element);
    await sleep(config.stepMs * 2);
    return true;
  }

  // ---- Dates ------------------------------------------------------------------

  /** «1986-09-12», «12.09.1986», «12/09/1986» → {year, month, day}. */
  function parseDate(value) {
    const text = String(value || '').trim();
    let match = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
    if (match) return { year: +match[1], month: +match[2], day: +match[3] };
    match = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(text);
    if (match) return { year: +match[3], month: +match[2], day: +match[1] };
    return null;
  }
  const iso = ({ year, month, day }) => `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

  /**
   * Zag/Ark date picker (JOIN): the day cell carries data-value="YYYY-MM-DD";
   * the year and the month are react-selects above the grid.
   */
  async function chooseDate(picker, value) {
    const date = parseDate(value);
    if (!date) return false;
    const cell = () => picker.querySelector(`[data-part="table-cell-trigger"][data-value="${iso(date)}"]:not([data-disabled])`);
    if (!cell()) {
      const trigger = picker.querySelector('[data-part="trigger"], [data-part="control"] button, [data-part="input"]');
      if (trigger && !picker.querySelector('[data-part="table"]')) press(trigger);
      const selects = [...picker.querySelectorAll('input[role="combobox"]')];
      const yearInput = selects.find((input) => /^\d{4}$/.test(textOf(comboBox(input)).trim()));
      if (yearInput) await chooseInCombobox(yearInput, String(date.year));
      const monthInput = selects.find((input) => input !== yearInput);
      if (monthInput && !cell()) {
        // The months in the page's language, in order: the n-th option.
        const box = comboBox(monthInput);
        if (box) press(box);
        fire(monthInput, 'keydown', { key: 'ArrowDown' });
        const options = await waitFor(() => { const list = optionsNear(monthInput); return list.length >= 12 ? list : null; });
        if (options) press(options[date.month - 1].element);
        await sleep(config.stepMs * 2);
      }
      // Last resort: the month arrows, a bounded number of times.
      for (let guard = 0; guard < 600 && !cell(); guard += 1) {
        const shown = picker.querySelector('[data-part="table-cell-trigger"]:not([data-outside-range])')?.getAttribute('data-value');
        if (!shown) break;
        const [year, month] = shown.split('-').map(Number);
        const forward = year * 12 + month < date.year * 12 + date.month;
        const arrow = picker.querySelector(`[data-part="${forward ? 'next' : 'prev'}-trigger"]`);
        if (!arrow) break;
        press(arrow);
        await sleep(20);
      }
    }
    const day = await waitFor(cell, 1500);
    if (!day) return false;
    press(day);
    await sleep(config.stepMs * 2);
    return true;
  }

  function formatForInput(element, value) {
    const date = parseDate(value);
    if (!date) return value;
    if ((element.getAttribute('type') || '') === 'date') return iso(date);
    const hint = String(element.getAttribute('placeholder') || '').toLowerCase();
    const sep = hint.includes('/') ? '/' : hint.includes('-') && !/^y/.test(hint) ? '-' : '.';
    if (/^y/.test(hint)) return iso(date);
    const order = /^(mm|m)[./-]/.test(hint) ? [date.month, date.day] : [date.day, date.month];
    return `${String(order[0]).padStart(2, '0')}${sep}${String(order[1]).padStart(2, '0')}${sep}${date.year}`;
  }

  /** A phone field that shows its country prefix apart (JOIN: «+39» button): the number without it. */
  function phoneFor(element, phone) {
    const prefix = element.getAttribute('data-value') || textOf(element.parentElement?.parentElement?.querySelector('[aria-haspopup="dialog"], [aria-haspopup="listbox"]'));
    const clean = String(phone).replace(/\s+/g, ' ').trim();
    if (/^\+\d{1,4}$/.test(String(prefix).trim()) && clean.replace(/\s/g, '').startsWith(prefix.trim())) {
      return clean.replace(/\s/g, '').slice(prefix.trim().length);
    }
    return clean;
  }

  // ---- Filling ----------------------------------------------------------------

  /**
   * Fills one entry. getFile(document) resolves to a File (the extension
   * downloads it from the kit's signed link).
   * @returns {Promise<boolean>} true when the page now holds the answer
   */
  async function fillEntry(entry, answer, { getFile }) {
    const { element } = entry;
    switch (entry.kind) {
      case 'file': {
        const file = await getFile(answer.document);
        if (!file) return false;
        const view = element.ownerDocument.defaultView;
        const transfer = new view.DataTransfer();
        transfer.items.add(file);
        element.files = transfer.files;
        fire(element, 'input');
        fire(element, 'change');
        return true;
      }
      case 'checkbox':
        if (!element.checked) press(element);
        return element.checked;
      case 'radio': {
        const option = bestOption(entry.options, answer.value);
        if (!option) return false;
        if (!option.element.checked) press(option.element);
        return option.element.checked;
      }
      case 'aria-radio': {
        const option = bestOption(entry.options, answer.value);
        if (!option) return false;
        press(option.element);
        return true;
      }
      case 'select': {
        const option = bestOption([...element.options].map((item) => ({ element: item, label: item.text })), answer.value);
        if (!option) return false;
        setValue(element, option.element.value);
        return true;
      }
      case 'combobox':
        return chooseInCombobox(element, answer.value);
      case 'date':
        return chooseDate(element, answer.value);
      default: {
        let value = String(answer.value);
        if (entry.kind === 'native-date' || answer.family === 'birthDate') value = formatForInput(element, value);
        if (answer.family === 'phone' || entry.type === 'tel') value = phoneFor(element, value);
        const max = Number(element.getAttribute('maxlength')) || 0;
        if (max > 0 && value.length > max) value = value.slice(0, max);
        setValue(element, value);
        return String(element.value) === value;
      }
    }
  }

  function buttons(doc) {
    return [...doc.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"], a[href]')]
      .filter(isShown)
      .map((element) => ({ element, text: (textOf(element) || element.getAttribute('value') || element.getAttribute('aria-label') || '').trim() }))
      .filter((button) => button.text);
  }
  const isDisabled = (element) => element.disabled || element.getAttribute('aria-disabled') === 'true';

  /** The step button (never a send, a sign-in, a way back or out). */
  function nextButton(doc) {
    return buttons(doc).find((button) => NEXT_RE.test(button.text) && !SUBMIT_RE.test(button.text)
      && !SOCIAL_RE.test(button.text) && !NOT_ADVANCE_RE.test(button.text) && button.element.tagName !== 'A') || null;
  }
  /** The send button: highlighted for Valerie, never pressed. */
  function finalButton(doc) {
    return buttons(doc).find((button) => SUBMIT_RE.test(button.text) && button.element.tagName !== 'A') || null;
  }

  /**
   * One pass on the page: answers every empty question the kit can answer.
   * @returns {Promise<{filled:string[], missing:Array<{label:string, answer:string}>, failed:string[], entries:number}>}
   */
  async function fillPage(doc, kit, { getFile, attempts, uploaded = new Set() }) {
    const filled = [];
    const missing = [];
    const failed = [];
    const entries = collect(doc);
    for (const entry of entries) {
      if (!isEmpty(entry)) continue;
      const answer = answerFor(entry, kit);
      const documentKey = answer?.document ? `${doc.defaultView.location.pathname}|${answer.document}` : '';
      if (documentKey && uploaded.has(documentKey)) continue;
      if (!answer) {
        if (entry.required) missing.push({ label: entry.label || entry.kind, answer: '' });
        continue;
      }
      // At most twice per control: a portal that clears it again is left to Valerie.
      const tries = (attempts.get(entry.element) || 0) + 1;
      attempts.set(entry.element, tries);
      if (tries > 2) {
        failed.push(entry.label);
        if (entry.required) missing.push({ label: entry.label, answer: answer.value || answer.document || '' });
        continue;
      }
      const ok = await fillEntry(entry, answer, { getFile }).catch(() => false);
      if (ok && documentKey) uploaded.add(documentKey);
      (ok ? filled : failed).push(entry.label || entry.kind);
      if (!ok && entry.required) missing.push({ label: entry.label, answer: answer.value || answer.document || '' });
    }
    return { filled, missing, failed, entries: entries.length };
  }

  /**
   * What the page is: the posting (start the application), a step, the last
   * page, the confirmation. «Candidarsi» is pressed only on the posting,
   * before this tab saw any application form (sawForm): on a review page with
   * no field, «Invia candidatura» is the send button, never a start.
   */
  function pageState(doc, { sawForm = false } = {}) {
    const text = textOf(doc.body);
    if (CONFIRM_RE.test(text)) return { kind: 'confirmed' };
    if (REFUSED_RE.test(text)) return { kind: 'refused' };
    const next = nextButton(doc);
    const required = collect(doc).filter((entry) => entry.required).length;
    if (!sawForm && !next && !required) {
      const start = buttons(doc).find((button) => APPLY_RE.test(button.text) && !SOCIAL_RE.test(button.text)
        && !/^(conferma|confirm|bestatig|confirmer|invia|send|absenden|envoyer|submit)/i.test(normalize(button.text)));
      if (start) return { kind: 'posting', start: start.element };
    }
    const final = finalButton(doc);
    if (next && !(final && isDisabled(next.element))) return { kind: 'step', next: next.element, nextDisabled: isDisabled(next.element), final: final?.element || null };
    if (final) return { kind: 'final', final: final.element };
    return { kind: 'unknown' };
  }

  /** A cookie banner in the way: refuse the non-essential cookies when offered. */
  function cookieRefusal(doc) {
    return buttons(doc).find((button) => COOKIE_REJECT_RE.test(button.text))?.element || null;
  }

  /** What changes when the portal moves to another step. */
  function pageSignature(doc) {
    return `${doc.defaultView.location.pathname}|${collect(doc).map((entry) => `${entry.kind}:${normalize(entry.label)}`).join('|')}`;
  }

  root.CompilaCandidatura = {
    NEXT_RE, SUBMIT_RE, CONFIRM_RE, REFUSED_RE, APPLY_RE, NOT_ADVANCE_RE, COOKIE_REJECT_RE,
    config, normalize, textOf, labelOf, questionOf, collect, isEmpty, answerFor, bestOption,
    parseDate, formatForInput, phoneFor, fillEntry, fillPage, pageState, cookieRefusal,
    pageSignature, nextButton, finalButton, press, setValue, sleep,
  };
})(globalThis);
