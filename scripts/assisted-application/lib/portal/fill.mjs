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

export function locatorFor(page, field, aaId = field.id) {
  const frame = page.frames()[field.frame || 0] || page.mainFrame();
  return frame.locator(`[data-aa-id="${aaId}"]`).first();
}

async function fillText(locator, value) {
  await locator.fill(value);
  const current = await locator.inputValue().catch(() => '');
  if (current === value) return;
  await locator.click();
  await locator.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await locator.press('Backspace');
  await locator.pressSequentially(value, { delay: TYPE_DELAY_MS });
}

async function fillCombobox(page, field, locator, value) {
  await locator.click();
  await locator.pressSequentially(value.slice(0, 40), { delay: TYPE_DELAY_MS * 2 });
  const frame = page.frames()[field.frame || 0] || page.mainFrame();
  const option = frame.getByRole('option', { name: value, exact: false }).first();
  try {
    await option.waitFor({ state: 'visible', timeout: 4000 });
    await option.click();
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
        await locator.setInputFiles(path);
      } else if (action.action === 'check' || action.action === 'uncheck') {
        await locator.setChecked(action.action === 'check');
      } else if (field.kind === 'radio') {
        const option = field.options.find((item) => item.label === action.value || item.value === action.value);
        if (!option) throw new Error('radio_option_missing');
        await locatorFor(page, field, option.aaId).check();
      } else if (field.kind === 'select') {
        await locator.selectOption({ label: action.value });
      } else if (field.kind === 'combobox') {
        await fillCombobox(page, field, locator, action.value);
      } else {
        await fillText(locator, field.maxLength ? action.value.slice(0, field.maxLength) : action.value);
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

export function findButton(buttons, pattern) {
  return buttons.find((button) => pattern.test(button.text)) || null;
}
