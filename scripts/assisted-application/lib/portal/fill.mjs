import { isNationalityField, nationalityLabelOf, nationalityOf } from '../../../../functions/src/lib/permitStatus.js';

/**
 * Deterministic filler of the portal runner. Techniques, no code taken, from
 * OfferOS (Apache-2.0, apps/extension/src/lib/autofill/dom-fill.ts, aria-driver.ts)
 * and career-ops' "Known ATS quirks" (MIT, modes/apply.md):
 *   - React inputs: `fill`, then verify the value registered; otherwise type
 *     real keystrokes (Workday ignores values set by script);
 *   - native selects by visible label; custom comboboxes by typing and
 *     picking the matching option (react-select re-renders on each key);
 *   - radios through the chosen option's own element;
 *   - elements are looked up again for every action by their `data-aa-id`
 *     (Workable re-renders break cached handles).
 */

import { extractFields } from './fields.mjs';

const TYPE_DELAY_MS = 25;
const ACTION_TIMEOUT_MS = 6000;
// How long a search box gets to list its matches after Enter: they come with a request.
const SUGGESTIONS_TIMEOUT_MS = 5000;
// A file sent as soon as it is chosen: how long it may travel, and how long nothing must be in flight.
const UPLOAD_SETTLE_MS = 45_000;
const UPLOAD_QUIET_MS = 700;

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

/**
 * A choice that redrew the form takes its control with it: Workday's «Country» draws the name and address
 * fields anew, the button that was pressed is another element, and choiceRegistered finds nothing to look
 * at (2026-10-07: the country was set and reported as not registered). The field of the same name, read
 * again, says whether the choice took.
 */
async function choiceShownAfterRedraw(page, field, label) {
  // The redraw follows the choice by a moment (a request on Workday): three seconds for it.
  for (let waited = 0; waited <= 3000; waited += 500) {
    if (tidy(await valueShownNow(page, field)) === tidy(label)) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

const tidy = (value) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();

/** What the field of that name and kind shows in a fresh reading of the page ('' when it is not there). */
async function valueShownNow(page, field) {
  const fresh = await extractFields(page, { listboxOptions: false }).catch(() => null);
  return String(fresh?.fields.find((candidate) => candidate.kind === field.kind && candidate.label === field.label)?.value || '');
}

/** A search box (fields.mjs `search`) already holds the answer: its chosen value names what would be typed. */
export function searchHolds(shown, value) {
  return Boolean(tidy(value)) && tidy(shown).includes(tidy(value));
}

const normalizedChoice = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * A SuccessFactors combobox can paint the selected label before writing the
 * value that its form actually submits. If an associated hidden control exists,
 * require that control to carry the same label before the action is complete;
 * controls without such a companion use the visible choice as their commit.
 */
async function choiceCommitted(locator, field, label) {
  if (!await choiceRegistered(locator, field.kind, label)) return false;
  const wanted = normalizedChoice(label);
  return locator.evaluate((element, { field: snapshot, wanted: expected }) => {
    const same = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase() === expected;
    const visibleId = String(element.id || snapshot.id || '').trim();
    const visibleName = String(element.getAttribute('name') || snapshot.name || '').trim();
    const baseId = visibleId.replace(/(?:[-_:](?:in|input|select))$/i, '');
    const roots = [
      element.closest('[role="group"], .field, .form-group, .application-question, li'),
      element.form,
    ].filter(Boolean);
    const hidden = [...new Set(roots.flatMap((root) => [...root.querySelectorAll('input[type="hidden"], select')]))];
    const related = hidden.filter((candidate) => {
      const candidateId = String(candidate.id || '').trim();
      const candidateName = String(candidate.getAttribute('name') || '').trim();
      if (visibleName && candidateName === visibleName) return true;
      if (visibleId && (candidateId === visibleId || candidate.getAttribute('data-aa-for') === visibleId)) return true;
      return Boolean(baseId && candidateId.startsWith(baseId));
    });
    return !related.length || related.some((candidate) => same(candidate.value || candidate.getAttribute('data-value')));
  }, { field, wanted }, { timeout: 2000 }).catch(() => false);
}

/**
 * SuccessFactors sometimes gives a nationality picklist a country name in
 * the form language while the planner used the candidate's wording (for
 * example «italiana» vs «italienne»). This is safe only for nationality
 * fields: the shared catalogue maps both labels to the same country code.
 */
export function nationalityOptionLabel(value, options, language = '') {
  const wanted = nationalityOf(value)?.code;
  if (!wanted) return '';
  const matches = [...new Set((options || []).map((option) => String(option || '').replace(/\s+/g, ' ').trim()))]
    .filter((option) => nationalityOf(option)?.code === wanted);
  if (matches.length === 1) return matches[0];
  const preferred = nationalityLabelOf(wanted, language);
  const preferredKey = normalizedChoice(preferred).replace(/\s*\((?:eu|ue|efta|aele|aels)\)\s*$/i, '');
  return preferredKey ? matches.find((option) => normalizedChoice(option).replace(/\s*\((?:eu|ue|efta|aele|aels)\)\s*$/i, '') === preferredKey) || '' : '';
}

const nationalityFieldLanguage = (label) => {
  const text = String(label || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (/\bnationalite\b|citoyennete/.test(text)) return 'fr';
  if (/staatsangeh|staatsburg/.test(text)) return 'de';
  if (/nazionalit|cittadinanz/.test(text)) return 'it';
  return 'en';
};

const nationalitySearchQuery = (value, label) => {
  const code = nationalityOf(value)?.code;
  const canonical = nationalityLabelOf(code, nationalityFieldLanguage(label)) || value;
  return String(canonical || '').normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z]{4,}/i)?.[0]?.slice(0, 4) || '';
};

const readOwnedListEntries = async (options) => (await options.allInnerTexts())
  .map((label, index) => ({ label: String(label).replace(/\s+/g, ' ').trim(), index }))
  .filter(({ label }) => Boolean(label));

async function waitForNationalityOption(page, options, value, language) {
  const deadline = Date.now() + 5000;
  let entries = [];
  for (;;) {
    entries = await readOwnedListEntries(options);
    const selectedLabel = nationalityOptionLabel(value, entries.map(({ label }) => label), language);
    if (selectedLabel) return { entries, selectedLabel };
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { entries, selectedLabel: '' };
    await page.waitForTimeout(Math.min(200, remaining));
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
  const options = frame.locator('[role="option"]:visible');
  const needle = value.toLowerCase().trim();
  if (field.search) {
    // A search box answers after Enter and a request. Workday's takes the only match by itself («+41»
    // becomes the chosen «Switzerland (+41)» 0.3 s after Enter, measured 2026-10-07): the box is answered
    // when it SHOWS the value. A match is clicked only while it does not, never the chosen one again
    // (read 1.2 s after Enter, the first «option» with «+41» was the value just chosen). Five seconds
    // for it; then what is typed is no answer, and the field says so instead of leaving «+41» next to
    // the code the form had picked by itself.
    await locator.press('Enter').catch(() => {});
    for (const deadline = Date.now() + SUGGESTIONS_TIMEOUT_MS; Date.now() < deadline;) {
      await page.waitForTimeout(300);
      if (searchHolds(await valueShownNow(page, field), value)) return;
      const texts = await options.allInnerTexts().catch(() => []);
      const index = texts.findIndex((text) => text.toLowerCase().includes(needle));
      if (index >= 0) await options.nth(index).click({ timeout: 4000 }).catch(() => {});
    }
    if (searchHolds(await valueShownNow(page, field), value)) return;
    await locator.press('Tab').catch(() => {});
    throw new Error('suggestion_not_chosen');
  }
  // A plain input shows its suggestions at once or has none.
  await page.waitForTimeout(500);
  const texts = await options.allInnerTexts().catch(() => []);
  if (!texts.length) return;
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

/** SuccessFactors' picklist: open it, wait for its options to load, click the one named. */
async function chooseInOwnedList(page, field, locator, value) {
  const frame = page.frames()[field.frame || 0] || page.mainFrame();
  const list = frame.locator(`[id="${String(field.ownedList).replace(/["\\]/g, '\\$&')}"]`);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt) {
      await locator.press('Escape').catch(() => {});
      await page.waitForTimeout(250);
    }
    await locator.click({ timeout: ACTION_TIMEOUT_MS });
    const options = list.getByRole('option');
    try {
      await options.first().waitFor({ state: 'visible', timeout: 10_000 });
    } catch {
      await locator.press('Escape').catch(() => {});
      throw new Error('option_not_found');
    }
    let entries = await readOwnedListEntries(options);
    const findSelectedLabel = () => {
      const labels = entries.map(({ label }) => label);
      const exact = entries.find(({ label }) => normalizedChoice(label) === normalizedChoice(value));
      return exact?.label || (isNationalityField(field.label) ? nationalityOptionLabel(value, labels, nationalityFieldLanguage(field.label)) : '');
    };
    let selectedLabel = findSelectedLabel();
    // Some SuccessFactors picklists do not expose the complete catalogue when
    // opened; they only fetch the matching page after keystrokes. Nationality
    // is safe to filter by a short country prefix, then resolve the localized
    // option («italiana» → «italienne»/«Italie») by the shared catalogue.
    if (!selectedLabel && isNationalityField(field.label)) {
      const query = nationalitySearchQuery(value, field.label);
      if (query) {
        await Promise.resolve(locator.press('ControlOrMeta+A')).catch(() => {});
        await Promise.resolve(locator.press('Backspace')).catch(() => {});
        await Promise.resolve(locator.pressSequentially(query, { delay: TYPE_DELAY_MS * 2, timeout: ACTION_TIMEOUT_MS })).catch(() => {});
        const filtered = await waitForNationalityOption(page, options, value, nationalityFieldLanguage(field.label));
        entries = filtered.entries;
        selectedLabel = filtered.selectedLabel || findSelectedLabel();
      }
    }
    if (!selectedLabel) {
      await locator.press('Escape').catch(() => {});
      throw new Error('option_not_found');
    }
    const selected = entries.find(({ label }) => normalizedChoice(label) === normalizedChoice(selectedLabel));
    if (!selected) {
      await locator.press('Escape').catch(() => {});
      throw new Error('option_not_found');
    }
    await options.nth(selected.index).click({ timeout: ACTION_TIMEOUT_MS });
    // SuccessFactors writes the choice into the input a moment after the
    // click (Coop, 2026-10-03: «Nein» was there, the check had looked too
    // early). A Rolex picklist can also re-render once before committing the
    // choice, so give it one bounded retry instead of reporting a false
    // choice_not_registered and submitting a blank nationality.
    const deadline = Date.now() + 5000;
    for (;;) {
      if (await choiceRegistered(locator, field.kind, selectedLabel)) {
        // The visible text can be updated before SuccessFactors commits the
        // hidden form value. A real blur makes that delayed commit deterministic
        // without using Enter (which can submit the form on this ATS).
        await Promise.resolve(locator.press('Tab')).catch(() => {});
        const commitDeadline = Date.now() + 5000;
        for (;;) {
          if (await choiceCommitted(locator, field, selectedLabel)) return selectedLabel;
          const remaining = commitDeadline - Date.now();
          if (remaining <= 0) break;
          await page.waitForTimeout(Math.min(200, remaining));
        }
      }
      if (Date.now() >= deadline) break;
      await page.waitForTimeout(Math.min(200, Math.max(0, deadline - Date.now())));
    }
  }
  throw new Error('choice_not_registered');
}

/** SAP UI5's date picker: its own input, in its shadow root, in the pattern it states. */
async function fillUi5Date(locator, field, value) {
  const date = parsePortalDate(value);
  if (!date) throw new Error('date_unreadable');
  const pattern = /dd/.test(field.datePattern || '') && /MM/.test(field.datePattern) && /yyyy/.test(field.datePattern) ? field.datePattern : 'dd.MM.yyyy';
  const text = pattern.replace('yyyy', String(date.year)).replace('MM', String(date.month).padStart(2, '0')).replace('dd', String(date.day).padStart(2, '0'));
  const input = locator.locator('input').first();
  await input.fill(text, { timeout: ACTION_TIMEOUT_MS });
  // Committed by leaving the field (its change), never by Enter: on Coop's
  // SuccessFactors an Enter submitted the form (run 37118242131: the page came
  // back with its sections closed and nothing kept), outside the submission guard.
  await input.press('Tab').catch(() => {});
  for (let waited = 0; ; waited += 200) {
    if (await locator.evaluate((element) => String(element.value || ''), null, { timeout: 2000 }).catch(() => '') === text) return;
    if (waited >= 2000) throw new Error('date_not_registered');
    await locator.page().waitForTimeout(200);
  }
}

/** "YYYY-MM-DD", "DD.MM.YYYY" and "DD/MM/YYYY" → a date picker target. */
function parsePortalDate(value) {
  const text = String(value || '').trim();
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (match) return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  match = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(text);
  return match ? { year: Number(match[3]), month: Number(match[2]), day: Number(match[1]) } : null;
}

const portalDateIso = ({ year, month, day }) => `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

async function comboContext(combo) {
  return combo.evaluate((element) => {
    const box = element.closest('[data-testid*="Select"], [data-testid="DatePickerInput"], [role="group"]')
      || element.parentElement?.parentElement || element.parentElement;
    return `${element.value || ''} ${box?.innerText || box?.textContent || ''}`.replace(/\s+/g, ' ').trim();
  }).catch(() => '');
}

/** The popup owned by a combobox, never an unrelated visible list in the frame. */
async function popupOwnedByCombo(frame, combo) {
  const relations = await Promise.all(['aria-controls', 'aria-owns'].map((attribute) => combo.getAttribute(attribute)));
  const ids = [...new Set(relations.flatMap((value) => String(value || '').split(/\s+/).filter(Boolean)))];
  for (const id of ids) {
    const escapedId = id.replace(/["\\]/g, '\\$&');
    const popup = frame.locator(`[id="${escapedId}"]`).first();
    if (await popup.count()) return popup;
  }
  return null;
}

async function chooseDatePickerYear(frame, combo, year) {
  try {
    await combo.click({ timeout: ACTION_TIMEOUT_MS });
    await combo.press('Control+A').catch(() => {});
    await combo.press('Backspace').catch(() => {});
    await combo.pressSequentially(String(year), { delay: TYPE_DELAY_MS * 2, timeout: ACTION_TIMEOUT_MS });
    const popup = await popupOwnedByCombo(frame, combo);
    if (!popup) throw new Error('date_picker_popup_unowned');
    const option = popup.getByRole('option', { name: String(year), exact: true }).first();
    await option.waitFor({ state: 'visible', timeout: 4000 });
    await option.click({ timeout: ACTION_TIMEOUT_MS });
    return true;
  } catch {
    await combo.press('Escape').catch(() => {});
    return false;
  }
}

async function chooseDatePickerMonth(frame, combo, month) {
  try {
    await combo.click({ timeout: ACTION_TIMEOUT_MS });
    await combo.press('ArrowDown').catch(() => {});
    // JOIN portals the month menu outside the date-picker root. Follow the
    // combobox's relation instead of indexing every visible option in the
    // frame, where another open list can shift the month index.
    const popup = await popupOwnedByCombo(frame, combo);
    if (!popup) throw new Error('date_picker_popup_unowned');
    const options = popup.locator('[role="option"]:visible');
    await options.nth(month - 1).waitFor({ state: 'visible', timeout: 4000 });
    await options.nth(month - 1).click({ timeout: ACTION_TIMEOUT_MS });
    return true;
  } catch {
    await combo.press('Escape').catch(() => {});
    return false;
  }
}

/** Fill the JOIN/Zag date picker without exposing its internal controls as answers. */
async function fillDatePicker(page, field, locator, value) {
  const date = parsePortalDate(value);
  if (!date || date.month < 1 || date.month > 12 || date.day < 1 || date.day > 31) throw new Error('invalid_date');
  const wanted = portalDateIso(date);
  const frame = page.frames()[field.frame || 0] || page.mainFrame();
  const target = () => locator.locator(`[data-value="${wanted}"]:not([data-disabled]):not([data-outside-range])`).first();
  const targetVisible = async () => await target().count() > 0 && await target().isVisible().catch(() => false);

  if (!await targetVisible()) {
    const combos = locator.locator('input[role="combobox"]');
    const comboCount = await combos.count();
    const values = await Promise.all(Array.from({ length: comboCount }, (_, index) => combos.nth(index).inputValue().catch(() => '')));
    const contexts = await Promise.all(Array.from({ length: comboCount }, (_, index) => comboContext(combos.nth(index))));
    const yearIndex = values.findIndex((value) => value.trim() === String(date.year)) >= 0
      ? values.findIndex((value) => value.trim() === String(date.year))
      : contexts.findIndex((context) => context.trim() === String(date.year));
    const year = yearIndex >= 0 ? combos.nth(yearIndex) : comboCount >= 2 ? combos.nth(0) : null;
    const month = comboCount >= 2 ? combos.nth(yearIndex >= 0 ? (yearIndex === 0 ? 1 : 0) : 1) : null;
    if (year) await chooseDatePickerYear(frame, year, date.year);
    if (month && !await targetVisible()) await chooseDatePickerMonth(frame, month, date.month);
  }

  // Comboboxes are the fast path; month arrows are a bounded fallback for
  // portals that expose the grid but not usable option menus.
  for (let attempt = 0; attempt < 600 && !await targetVisible(); attempt += 1) {
    const shown = await locator.locator('[data-part="table-cell-trigger"]:visible:not([data-outside-range])').first().getAttribute('data-value').catch(() => '');
    if (!shown) break;
    const [year, month] = shown.split('-').map(Number);
    const forward = year * 12 + month < date.year * 12 + date.month;
    const arrow = locator.locator(`[data-part="${forward ? 'next' : 'prev'}-trigger"]`).first();
    const namedArrow = locator.getByRole('button', { name: forward ? /next month/i : /previous month/i }).first();
    const control = (await arrow.count()) ? arrow : namedArrow;
    if (!await control.count()) break;
    await control.click({ timeout: ACTION_TIMEOUT_MS });
    await page.waitForTimeout(20);
  }
  if (!await targetVisible()) throw new Error('date_not_found');
  await target().click({ timeout: ACTION_TIMEOUT_MS });
}

async function dateRegistered(locator, value) {
  const date = parsePortalDate(value);
  if (!date) return false;
  const wanted = portalDateIso(date);
  return locator.evaluate((element, expected) => {
    const selected = element.querySelector('[data-part="table-cell-trigger"][data-selected], [data-part="table-cell-trigger"][aria-selected="true"]')?.getAttribute('data-value');
    const hidden = [...element.querySelectorAll('input')].some((input) => input.value === expected);
    return selected === expected || hidden;
  }, wanted, { timeout: 2000 }).catch(() => false);
}

/**
 * @param {import('playwright').Page} page
 * @param {Array<object>} fields snapshot fields
 * @param {Array<{fieldId:string, action:string, value:string, document:string}>} actions
 * @param {{cv:string, cover_letter:string}} files local paths (a requested document, extra_N: its paths)
 * @returns {Promise<Array<{fieldId:string, ok:boolean, error?:string, files?:number}>>} files: how many files an upload set
 */
/**
 * Chooses the files and waits for what that started. umantis (2026-10-03)
 * sends a file as soon as it is chosen, one at a time: the letter was still
 * at 15% when the CV went in and the send button was reached. The requests the
 * choice starts (never a plain GET: an image, a script) are followed until
 * none has been in flight for UPLOAD_QUIET_MS — bounded, and a short pause on
 * a form that sends its files with the submit.
 */
export async function chooseFiles(page, locator, paths, { settleMs = UPLOAD_SETTLE_MS, quietMs = UPLOAD_QUIET_MS, now = Date.now } = {}) {
  const inFlight = new Set();
  const started = (request) => { if (request.method() !== 'GET') inFlight.add(request); };
  const ended = (request) => { inFlight.delete(request); };
  page.on('request', started);
  page.on('requestfinished', ended);
  page.on('requestfailed', ended);
  try {
    await locator.setInputFiles(paths, { timeout: ACTION_TIMEOUT_MS });
    const deadline = now() + settleMs;
    let quietSince = now();
    while (now() < deadline) {
      if (inFlight.size) quietSince = now();
      else if (now() - quietSince >= quietMs) break;
      await page.waitForTimeout(150);
    }
  } finally {
    page.off('request', started);
    page.off('requestfinished', ended);
    page.off('requestfailed', ended);
  }
}

/** The local paths of one document: the CV, the letter, or the files of a requested document (extra_N). */
export function documentPaths(files, document) {
  const value = files?.[document];
  return (Array.isArray(value) ? value : [value]).filter((path) => typeof path === 'string' && path);
}

export async function applyActions(page, fields, actions, files, { pause = () => page.waitForTimeout(150 + Math.floor(Math.random() * 250)) } = {}) {
  const byId = new Map(fields.map((field) => [field.id, field]));
  const results = [];
  for (const action of actions) {
    const field = byId.get(action.fieldId);
    if (!field || action.action === 'skip') continue;
    // How many files an upload set, for the record of what left (submit.mjs).
    let uploaded = 0;
    try {
      const locator = locatorFor(page, field);
      if (action.action === 'upload') {
        const paths = documentPaths(files, action.document);
        if (!paths.length) throw new Error('document_unavailable');
        // Every file of a requested document when the input takes several, else the first.
        const multiple = paths.length > 1 && await locator.evaluate((element) => Boolean(element.multiple)).catch(() => false);
        await chooseFiles(page, locator, multiple ? paths : paths[0]);
        uploaded = multiple ? paths.length : 1;
      } else if (action.action === 'check' || action.action === 'uncheck') {
        await setChoice(locator, action.action === 'check');
      } else if (field.kind === 'radio') {
        const option = field.options.find((item) => item.label === action.value || item.value === action.value);
        if (!option) throw new Error('radio_option_missing');
        await setChoice(await radioLocator(page, field, option), true);
      } else if (['select', 'listbox', 'combobox'].includes(field.kind)) {
        let selectedLabel = action.value;
        if (field.kind === 'select') {
          const exact = (field.options || []).find((option) => normalizedChoice(option.label) === normalizedChoice(action.value));
          selectedLabel = exact?.label || (isNationalityField(field.label) ? nationalityOptionLabel(action.value, (field.options || []).map((option) => option.label), nationalityFieldLanguage(field.label)) : '');
          if (!selectedLabel) throw new Error('option_not_found');
          await locator.selectOption({ label: selectedLabel }, { timeout: ACTION_TIMEOUT_MS });
        } else if (field.kind === 'listbox') {
          // Workday: open the listbox and click the option (OfferOS dom-fill, fillListboxButton).
          await locator.click({ timeout: ACTION_TIMEOUT_MS });
          const frame = page.frames()[field.frame || 0] || page.mainFrame();
          await frame.getByRole('option', { name: action.value, exact: true }).first().click({ timeout: 6000 });
        } else if (field.selectLike) {
          selectedLabel = await chooseInOwnedList(page, field, locator, action.value);
        } else {
          await fillCombobox(page, field, locator, action.value);
        }
        // A click that did not take leaves the field empty while the run goes on as if answered.
        const registered = field.selectLike
          ? await choiceCommitted(locator, field, selectedLabel)
          : await choiceRegistered(locator, field.kind, selectedLabel);
        if (!registered && !await choiceShownAfterRedraw(page, field, selectedLabel)) throw new Error('choice_not_registered');
      } else if (field.kind === 'date') {
        await fillDatePicker(page, field, locator, action.value);
        if (!await dateRegistered(locator, action.value)) throw new Error('date_not_registered');
      } else if (field.widget === 'ui5-date') {
        await fillUi5Date(locator, field, action.value);
      } else if (field.search && searchHolds(field.value, action.value)) {
        // The search box already holds this answer (Workday sets the phone code with the country): typed
        // and chosen again, it would be the chosen value that gets clicked.
      } else {
        // A long text is shortened at a sentence end, never cut in the middle of one.
        await fillText(locator, fitToLength(action.value, field.maxLength));
        if (field.kind === 'text' && !['email', 'password'].includes(field.inputType)) await pickSuggestion(page, field, locator, action.value);
      }
      results.push({ fieldId: field.id, ok: true, ...(uploaded ? { files: uploaded } : {}) });
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
// SuccessFactors' application page sends with a bare «Bewerben» (Coop, 2026-10-02).
// A confirmation speaks to the candidate («Sie haben sich / Du hast dich
// erfolgreich beworben»): a page's prose about others never confirms (review of #10980).
export const SUBMIT_RE = /(submit|send application|apply now|^apply$|^confirm and (apply|send|submit)\W*$|absenden|bewerbung (absenden|senden|abschicken)|jetzt bewerben|^bewerben$|^bestätigen und (bewerben|absenden|senden)\W*$|invia( la)? candidatura|^invia$|candidati ora|^candidati$|^applica$|^conferma e (applica|invia|candidati)\W*$|envoyer( ma)? candidature|^envoyer$|postuler|soumettre|^confirmer et (postuler|envoyer)\W*$)/i;
export const CONFIRM_RE = /(thank you (very much |so much )?for (your )?appl|many thanks for (your )?appl|thanks for applying|application (has been )?(received|submitted|sent)|we have received your|you have successfully applied|vielen dank für (ihre|deine) bewerbung|(ihre|deine) bewerbung (ist )?(eingegangen|erhalten|wurde (erfolgreich )?(übermittelt|gesendet|eingereicht))|\b(sie haben sich|du hast dich) erfolgreich (auf [^.]{0,80} )?beworben|grazie per (la tua|la sua|aver inviato|esserti candidat)|candidatura (è stata )?(inviata|ricevuta)|ti sei candidat[oa] con successo|merci pour votre candidature|votre candidature a (bien )?été (envoyée|reçue|transmise)|vous avez postulé avec succès)/i;
// The portal itself says the application did NOT go (JOIN, giro di prova
// 2026-10-01: «Non siamo riusciti a inviare la tua candidatura. Riprova.»).
export const REFUSED_RE = /(non siamo riusciti a inviare la (tua|sua) candidatura|impossibile inviare la candidatura|we (couldn['’]?t|could not|were unable to) (submit|send) your application|your application could not be (submitted|sent)|(ihre|deine) bewerbung konnte nicht (gesendet|übermittelt|abgeschickt) werden|wir konnten (ihre|deine) bewerbung nicht (senden|übermitteln)|nous n['’]avons pas pu (envoyer|transmettre) votre candidature|votre candidature n['’]a pas pu être (envoyée|transmise))/i;
// SuccessFactors (Coop, 2026-10-03): «Bitte korrigieren Sie die folgenden Fehler.», «Anrede ist erforderlich».
export const VALIDATION_RE = /(this field is required|required field|is required|pflichtfeld|bitte (füllen|geben|korrigieren) sie|ist erforderlich|campo (obbligatorio|richiesto)|è obbligatori[oa]|correggi gli errori|champ (obligatoire|requis)|est (obligatoire|requis)|corrigez les erreurs|please (fill|complete|enter|correct))/i;

/**
 * First enabled button matching the pattern (a disabled one is returned only when asked). One of the page's
 * own before one of the site's header, navigation or footer (`chrome`, fields.mjs): of two «Sign In» the
 * form's link is the one meant, and the header's is pressed only when it is the only one.
 */
export function findButton(buttons, pattern, { includeDisabled = false } = {}) {
  const matching = buttons.filter((button) => pattern.test(button.text) && (includeDisabled || !button.disabled));
  return matching.find((button) => !button.chrome) || matching[0] || null;
}
