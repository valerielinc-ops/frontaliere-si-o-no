/**
 * Deterministic filler of the portal runner. Techniques from OfferOS
 * (Apache-2.0, apps/extension/src/lib/autofill/dom-fill.ts, aria-driver.ts)
 * and career-ops' "Known ATS quirks" (MIT, modes/apply.md):
 *   - React inputs: `fill`, then verify the value registered; otherwise type
 *     real keystrokes (Workday ignores values set by script);
 *   - native selects by visible label; custom comboboxes by typing and
 *     picking the matching option (react-select re-renders on each key);
 *   - radios through the chosen option's own element;
 *   - elements are looked up again for every action by their `data-aa-id`
 *     (Workable re-renders break cached handles).
 */

const TYPE_DELAY_MS = 25;
const ACTION_TIMEOUT_MS = 6000;

/**
 * Custom-styled radios and checkboxes hide the native input (Workday): the
 * normal check, then a forced one, then a real click on the label. Never a
 * script click (career-ops, Lever: a programmatic click on a box pops an
 * hCaptcha challenge in the middle of the form).
 */
async function setChoice(locator, checked) {
  try {
    await locator.setChecked(checked, { timeout: ACTION_TIMEOUT_MS });
  } catch {
    try {
      await locator.setChecked(checked, { force: true, timeout: ACTION_TIMEOUT_MS });
    } catch (error) {
      const current = await locator.isChecked({ timeout: 2000 }).catch(() => !checked);
      if (current === checked) return;
      // The label is what people click: marked in the page, then clicked in the same document (iframes too).
      const marked = await locator.evaluate((element) => {
        const label = (element.id && document.querySelector(`label[for="${CSS.escape(element.id)}"]`)) || element.closest('label');
        label?.setAttribute('data-aa-label', 'choice');
        return Boolean(label);
      }, null, { timeout: 2000 }).catch(() => false);
      if (!marked) throw error;
      const label = locator.locator('xpath=ancestor::html[1]//label[@data-aa-label="choice"]').first();
      await label.click({ timeout: ACTION_TIMEOUT_MS });
      await label.evaluate((element) => element.removeAttribute('data-aa-label')).catch(() => {});
    }
  }
}

/** The text, shortened at a sentence end (else a word end) to fit `max` characters. */
export function fitToLength(text, max) {
  const value = String(text || '');
  if (!max || value.length <= max) return value;
  const cut = value.slice(0, max);
  // The last sentence end in the second half of the limit: never a half sentence.
  let end = -1;
  for (const match of cut.matchAll(/[.!?…](?=\s|$)/g)) end = match.index + 1;
  if (end >= max * 0.5) return cut.slice(0, end).trim();
  const space = cut.lastIndexOf(' ');
  return (space > 0 ? cut.slice(0, space) : cut).replace(/[\s,;:–—-]+$/, '').trim();
}

/**
 * The choice took (career-ops: "verify each selection"): a native select
 * shows the label, a custom control shows the option's text near it.
 */
async function choiceRegistered(locator, kind, label) {
  const wanted = String(label || '').toLowerCase().trim();
  return locator.evaluate((element, { kind: fieldKind, wanted: text }) => {
    // Equal, never "contains" (review of #10715: "IT" is not "Italy").
    const same = (value) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim() === text;
    if (fieldKind === 'select') return same(element.options?.[element.selectedIndex]?.text);
    if (same(element.value) && element.getAttribute('aria-expanded') !== 'true') return true;
    // A text shown next to the control equal to the choice, never one inside a
    // list still open (NodeFilter.SHOW_TEXT = 4): an option is no proof of a choice.
    let node = element.parentElement;
    for (let depth = 0; node && depth < 4; depth += 1, node = node.parentElement) {
      const walker = document.createTreeWalker(node, 4);
      for (let shown = walker.nextNode(); shown; shown = walker.nextNode()) {
        if (!shown.parentElement?.closest('[role="listbox"], [role="option"], option, script, style') && same(shown.textContent)) return true;
      }
    }
    return false;
  }, { kind, wanted: wanted.replace(/\s+/g, ' ') }, { timeout: 2000 }).catch(() => false);
}

/** The option's own element, or (after a re-render dropped our id) the radio with that label. */
async function radioLocator(page, field, option) {
  const byId = locatorFor(page, field, option.aaId);
  if (await byId.count()) return byId;
  const frame = page.frames()[field.frame || 0] || page.mainFrame();
  return frame.getByRole('radio', { name: option.label, exact: true }).first();
}

export function locatorFor(page, field, aaId = field.id) {
  const frame = page.frames()[field.frame || 0] || page.mainFrame();
  return frame.locator(`[data-aa-id="${aaId}"]`).first();
}

async function fillText(locator, value) {
  await locator.fill(value, { timeout: ACTION_TIMEOUT_MS });
  const current = await locator.inputValue().catch(() => '');
  if (current === value) return;
  // force: Workday draws the chosen value's pill over its search box.
  await locator.click({ force: true, timeout: ACTION_TIMEOUT_MS });
  await locator.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await locator.press('Backspace');
  await locator.pressSequentially(value, { delay: TYPE_DELAY_MS });
}

/**
 * A text input that opens suggestions (Workday's "Ländervorwahl" is a search:
 * "+41" must become the option "Schweiz (+41)"): the option containing the
 * typed value is picked; with no such option the focus moves on (Tab, not
 * Escape, which would close a surrounding dialog).
 */
async function pickSuggestion(page, field, locator, value) {
  const frame = page.frames()[field.frame || 0] || page.mainFrame();
  // A search box lists its matches only after Enter.
  if (field.search) await locator.press('Enter').catch(() => {});
  await page.waitForTimeout(field.search ? 1200 : 500);
  const options = frame.locator('[role="option"]:visible');
  const texts = await options.allInnerTexts().catch(() => []);
  if (!texts.length) return;
  const needle = value.toLowerCase().trim();
  const index = texts.findIndex((text) => text.toLowerCase().includes(needle));
  if (index >= 0) await options.nth(index).click({ timeout: 4000 });
  else await locator.press('Tab').catch(() => {});
}

/**
 * Types to filter, then clicks the option that carries the value. No option,
 * no choice: Enter would take whichever option is highlighted (career-ops,
 * Workday: never pick by position), so the field fails and is planned again.
 */
async function fillCombobox(page, field, locator, value) {
  await locator.click({ timeout: ACTION_TIMEOUT_MS });
  await locator.pressSequentially(value.slice(0, 40), { delay: TYPE_DELAY_MS * 2 });
  const frame = page.frames()[field.frame || 0] || page.mainFrame();
  // The exact label only (review of #10715): "IT" never picks "Italy".
  const option = frame.getByRole('option', { name: value, exact: true }).first();
  try {
    await option.waitFor({ state: 'visible', timeout: 4000 });
  } catch {
    await locator.press('Escape').catch(() => {});
    throw new Error('option_not_found');
  }
  await option.click({ timeout: ACTION_TIMEOUT_MS });
}

/**
 * @param {import('playwright').Page} page
 * @param {Array<object>} fields snapshot fields
 * @param {Array<{fieldId:string, action:string, value:string, document:string}>} actions
 * @param {{cv:string, cover_letter:string}} files local paths
 * @returns {Promise<Array<{fieldId:string, ok:boolean, error?:string}>>}
 */
export async function applyActions(page, fields, actions, files, { pause = () => page.waitForTimeout(150 + Math.floor(Math.random() * 250)) } = {}) {
  const byId = new Map(fields.map((field) => [field.id, field]));
  const results = [];
  for (const action of actions) {
    const field = byId.get(action.fieldId);
    if (!field || action.action === 'skip') continue;
    try {
      const locator = locatorFor(page, field);
      if (action.action === 'upload') {
        const path = files[action.document];
        if (!path) throw new Error('document_unavailable');
        await locator.setInputFiles(path, { timeout: ACTION_TIMEOUT_MS });
      } else if (action.action === 'check' || action.action === 'uncheck') {
        await setChoice(locator, action.action === 'check');
      } else if (field.kind === 'radio') {
        const option = field.options.find((item) => item.label === action.value || item.value === action.value);
        if (!option) throw new Error('radio_option_missing');
        await setChoice(await radioLocator(page, field, option), true);
      } else if (['select', 'listbox', 'combobox'].includes(field.kind)) {
        if (field.kind === 'select') {
          await locator.selectOption({ label: action.value }, { timeout: ACTION_TIMEOUT_MS });
        } else if (field.kind === 'listbox') {
          // Workday: open the listbox and click the option (OfferOS aria-driver).
          await locator.click({ timeout: ACTION_TIMEOUT_MS });
          const frame = page.frames()[field.frame || 0] || page.mainFrame();
          await frame.getByRole('option', { name: action.value, exact: true }).first().click({ timeout: 6000 });
        } else {
          await fillCombobox(page, field, locator, action.value);
        }
        // A click that did not take leaves the field empty while the run goes on as if answered.
        if (!await choiceRegistered(locator, field.kind, action.value)) throw new Error('choice_not_registered');
      } else {
        // A long text is shortened at a sentence end, never cut in the middle of one.
        await fillText(locator, fitToLength(action.value, field.maxLength));
        if (field.kind === 'text' && !['email', 'password'].includes(field.inputType)) await pickSuggestion(page, field, locator, action.value);
      }
      results.push({ fieldId: field.id, ok: true });
    } catch (error) {
      results.push({ fieldId: field.id, ok: false, error: String(error?.message || error).slice(0, 120) });
    }
    await pause();
  }
  return results;
}

export const NEXT_RE = /^(next|continue|weiter|avanti|continua|prosegui|suivant|continuer|nächster schritt|save and continue|speichern und weiter|proceed)\b/i;
// JOIN's review page ends with «Conferma e applica» (giro di prova 2026-10-01):
// "confirm and apply/send" in the four languages is the final click too, as
// the WHOLE label ("Conferma e applica filtro" is a filter, not a submission).
export const SUBMIT_RE = /(submit|send application|apply now|^apply$|^confirm and (apply|send|submit)\W*$|absenden|bewerbung (absenden|senden|abschicken)|jetzt bewerben|^bestätigen und (bewerben|absenden|senden)\W*$|invia( la)? candidatura|^invia$|candidati ora|^candidati$|^applica$|^conferma e (applica|invia|candidati)\W*$|envoyer( ma)? candidature|^envoyer$|postuler|soumettre|^confirmer et (postuler|envoyer)\W*$)/i;
export const CONFIRM_RE = /(thank you for (your )?appl|thanks for applying|application (has been )?(received|submitted|sent)|we have received your|vielen dank für (ihre|deine) bewerbung|ihre bewerbung (ist )?(eingegangen|erhalten|wurde (erfolgreich )?(übermittelt|gesendet))|grazie per (la tua|la sua|aver inviato|esserti candidat)|candidatura (è stata )?(inviata|ricevuta)|merci pour votre candidature|votre candidature a (bien )?été (envoyée|reçue|transmise))/i;
export const VALIDATION_RE = /(this field is required|required field|pflichtfeld|bitte (füllen|geben) sie|campo (obbligatorio|richiesto)|champ (obligatoire|requis)|please (fill|complete|enter))/i;

/** First enabled button matching the pattern (a disabled one is returned only when asked). */
export function findButton(buttons, pattern, { includeDisabled = false } = {}) {
  return buttons.find((button) => pattern.test(button.text) && (includeDisabled || !button.disabled)) || null;
}
