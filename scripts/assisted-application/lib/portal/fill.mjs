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
 * normal check, then a forced one, then the element's own click.
 */
async function setChoice(locator, checked) {
  try {
    await locator.setChecked(checked, { timeout: ACTION_TIMEOUT_MS });
  } catch {
    try {
      await locator.setChecked(checked, { force: true, timeout: ACTION_TIMEOUT_MS });
    } catch {
      const current = await locator.isChecked({ timeout: 2000 }).catch(() => !checked);
      if (current !== checked) await locator.evaluate((element) => element.click(), null, { timeout: 2000 });
    }
  }
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

async function fillCombobox(page, field, locator, value) {
  await locator.click({ timeout: ACTION_TIMEOUT_MS });
  await locator.pressSequentially(value.slice(0, 40), { delay: TYPE_DELAY_MS * 2 });
  const frame = page.frames()[field.frame || 0] || page.mainFrame();
  const option = frame.getByRole('option', { name: value, exact: false }).first();
  try {
    await option.waitFor({ state: 'visible', timeout: 4000 });
    await option.click({ timeout: ACTION_TIMEOUT_MS });
  } catch {
    await locator.press('Enter');
  }
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
      } else if (field.kind === 'select') {
        await locator.selectOption({ label: action.value }, { timeout: ACTION_TIMEOUT_MS });
      } else if (field.kind === 'listbox') {
        // Workday: open the listbox and click the option (OfferOS aria-driver).
        await locator.click({ timeout: ACTION_TIMEOUT_MS });
        const frame = page.frames()[field.frame || 0] || page.mainFrame();
        await frame.getByRole('option', { name: action.value, exact: true }).first().click({ timeout: 6000 });
      } else if (field.kind === 'combobox') {
        await fillCombobox(page, field, locator, action.value);
      } else {
        await fillText(locator, field.maxLength ? action.value.slice(0, field.maxLength) : action.value);
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
export const SUBMIT_RE = /(submit|send application|apply now|^apply$|absenden|bewerbung (absenden|senden|abschicken)|jetzt bewerben|invia( la)? candidatura|^invia$|candidati ora|envoyer( ma)? candidature|^envoyer$|postuler|soumettre)/i;
export const CONFIRM_RE = /(thank you for (your )?appl|thanks for applying|application (has been )?(received|submitted|sent)|we have received your|vielen dank für ihre bewerbung|ihre bewerbung (ist )?(eingegangen|erhalten|wurde (erfolgreich )?(übermittelt|gesendet))|grazie per (la tua|la sua|aver inviato)|candidatura (è stata )?(inviata|ricevuta)|merci pour votre candidature|votre candidature a (bien )?été (envoyée|reçue|transmise))/i;
export const VALIDATION_RE = /(this field is required|required field|pflichtfeld|bitte (füllen|geben) sie|campo (obbligatorio|richiesto)|champ (obligatoire|requis)|please (fill|complete|enter))/i;

/** First enabled button matching the pattern (a disabled one is returned only when asked). */
export function findButton(buttons, pattern, { includeDisabled = false } = {}) {
  return buttons.find((button) => pattern.test(button.text) && (includeDisabled || !button.disabled)) || null;
}
