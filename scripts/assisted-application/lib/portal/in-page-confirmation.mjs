/**
 * The page did not move after the final click, yet the application went: the employer's page swaps its form
 * for a thank-you message and sends the form with an XHR (delapaix.ch: `admin-ajax.php` → 200, the form gone,
 * «La tua candidatura è stata inviata correttamente»). Seen from the address alone that is `ambiguous`.
 *
 * The same text sits in the page source all along (a `feedback-container hide`), so its presence proves
 * nothing: only the passage from not visible to visible, WITH the form gone, no error on screen and a 2xx
 * answer to a same-origin send request of the submit phase. Anything less stays ambiguous (fail-closed).
 *
 * Pure: the live run (portal.mjs) and the reconciliation of orders already stopped on `portal_ambiguous`
 * (reconcile-inpage-confirmation.mjs) apply this one rule, to the same saved fields.
 */
import { CONFIRM_RE, REFUSED_RE, SUBMIT_RE, hasNewValidationText } from './fill.mjs';

// What CONFIRM_RE does not read: the confirmations of employer pages that speak without «your/la tua» before the
// noun (it is the shared vocabulary, extended here, never copied).
const IN_PAGE_CONFIRM_EXTRA_RE = /(?:candidatura\s+(?:è|e['’]|e)\s+stata\s+(?:correttamente\s+)?(?:inviata|inoltrata|ricevuta)|grazie\s+per\s+(?:esserti|esservi|essersi)\s+candidat[oae]|bewerbung\s+wurde\s+(?:erfolgreich\s+)?(?:gesendet|übermittelt|versendet|abgeschickt|eingereicht)|vielen\s+dank\s+für\s+(?:ihre|deine)\s+bewerbung|candidature\s+a\s+bien\s+été\s+(?:envoyée|transmise|reçue)|merci\s+(?:de|d['’]\s*)avoir\s+postulé|thank\s+you\s+for\s+(?:applying|your\s+application)|(?:your\s+)?application\s+(?:has\s+been|was)\s+(?:successfully\s+)?(?:submitted|sent|received))/iu;
// Contact and application forms that confirm the SEND («Ihre Nachricht wurde erfolgreich gesendet», STA): past
// tense only, with Unicode word edges (`\b` does not see accents). Futures («wird gesendet», «sera envoyé»),
// conditionals and negations («konnte nicht gesendet werden») have no past participle after «wurde/a été/è stato»,
// so they never match; a «nicht/non/pas» just before the match is dropped by NEGATED_BEFORE_RE.
const EDGE_L = '(?<![\\p{L}\\p{N}])';
const EDGE_R = '(?![\\p{L}\\p{N}])';
const MESSAGE_SENT_RE = new RegExp(`${EDGE_L}(?:`
  + '(?:ihre|deine)\\s+(?:nachricht|bewerbung)\\s+wurde\\s+(?:erfolgreich\\s+)?(?:gesendet|versendet|übermittelt|abgeschickt)'
  + '|(?:erfolgreich\\s+(?:gesendet|versendet|übermittelt))'
  + '|vielen\\s+dank\\s+für\\s+(?:ihre|deine)\\s+(?:nachricht|bewerbung)'
  + '|votre\\s+message\\s+a\\s+bien\\s+été\\s+(?:envoyé|transmis)e?'
  + '|message\\s+(?:envoyé|transmis)\\s+avec\\s+succès'
  + '|(?:il\\s+tuo|il\\s+suo|il\\s+vostro)\\s+messaggio\\s+(?:è|e[\'’]?)\\s+stato\\s+(?:inviato|trasmesso)(?:\\s+con\\s+successo)?'
  + '|your\\s+message\\s+(?:has\\s+been|was)\\s+(?:successfully\\s+)?(?:sent|submitted|delivered)(?:\\s+successfully)?'
  + '|message\\s+sent\\s+successfully'
  + `)${EDGE_R}`, 'iu');
const NEGATED_BEFORE_RE = /\b(?:non|not|nicht|kein|keine|pas|never|nie|n['’]a)\s+(?:\w+\s+){0,2}$/iu;

/** The confirming sentence in `text`, or ''. A negated one («non è stata inviata») is no confirmation. */
export function inPageConfirmationText(text = '') {
  const value = String(text || '').normalize('NFC').replace(/[ \t]+/gu, ' ');
  for (const pattern of [IN_PAGE_CONFIRM_EXTRA_RE, MESSAGE_SENT_RE, CONFIRM_RE]) {
    const match = new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`);
    for (let found = match.exec(value); found; found = match.exec(value)) {
      if (!NEGATED_BEFORE_RE.test(value.slice(Math.max(0, found.index - 24), found.index))) return found[0];
    }
  }
  return '';
}

const address = (value) => {
  try {
    const url = new URL(String(value || ''));
    return `${url.origin}${url.pathname.replace(/\/+$/u, '')}${url.search}`;
  } catch {
    return '';
  }
};

const hostOf = (value) => {
  try { return new URL(String(value || '')).hostname.toLowerCase(); } catch { return ''; }
};

/**
 * @param {object} input
 * @param {string|null} input.beforeText visible text right before the final click; null when it was not saved
 * @param {{url:string,text:string,errors?:string[],fields?:object[],buttons?:object[]}} input.afterSnapshot
 *   the evidence snapshot after the click (finalReviewEvidenceSnapshot)
 * @param {string} input.submissionUrl the page the final click was made on
 * @param {object[]} input.responses diagnostics.responses ({phase, host, method, status})
 * @param {boolean} [input.allowUnknownBefore] reconciliation of runs that did not save the text before the click
 * @param {string} [input.finalLabel] the label of the send control that was clicked
 * @param {string} [input.submittedFormId] the id of the form that was sent (saved with the evidence since this rule
 *   reads one form); without it the sent form is the one holding the CV upload and that send control
 * @returns {{confirmed:boolean, reason:string}}
 */
export function inPageConfirmation({ beforeText = null, afterSnapshot = null, submissionUrl = '', responses = [], allowUnknownBefore = false, finalLabel = '', submittedFormId = '' } = {}) {
  const no = (reason) => ({ confirmed: false, reason });
  if (!afterSnapshot || typeof afterSnapshot.text !== 'string') return no('no_snapshot');
  const here = address(afterSnapshot.url);
  if (!here || here !== address(submissionUrl)) return no('url_changed');
  const confirmation = inPageConfirmationText(afterSnapshot.text);
  if (!confirmation) return no('no_confirmation_text');
  if (typeof beforeText === 'string') {
    if (inPageConfirmationText(beforeText)) return no('confirmation_visible_before_click');
  } else if (!allowUnknownBefore) return no('before_click_text_unknown');
  const fields = Array.isArray(afterSnapshot.fields) ? afterSnapshot.fields : [];
  const buttons = Array.isArray(afterSnapshot.buttons) ? afterSnapshot.buttons : [];
  // ONLY the form that was sent: the page keeps its other forms (a booking widget, a newsletter, a search) and
  // their fields say nothing about it. The sent form is gone when none of ITS controls is still shown and active
  // (by its id); without that identity (older evidence) when no CV upload and no control labelled like the one
  // that was clicked is left. A label or an upload still there keeps it ambiguous.
  const live = (item) => item?.chrome !== true && item?.disabled !== true;
  const sameLabel = (text) => {
    const wanted = String(finalLabel || '').replace(/\s+/gu, ' ').trim().toLowerCase();
    return wanted ? String(text || '').replace(/\s+/gu, ' ').trim().toLowerCase() === wanted : SUBMIT_RE.test(String(text || ''));
  };
  const formStillThere = submittedFormId
    ? [...fields, ...buttons].some((item) => live(item) && item?.formId === submittedFormId && item?.inputType !== 'hidden')
      || buttons.some((button) => live(button) && sameLabel(button?.text))
    : fields.some((field) => live(field) && field?.inputType === 'file')
      || buttons.some((button) => live(button) && sameLabel(button?.text));
  if (formStillThere) return no('form_still_visible');
  if ((afterSnapshot.errors || []).length || fields.some((field) => field?.invalid === true)
    || REFUSED_RE.test(afterSnapshot.text)
    || hasNewValidationText(afterSnapshot.text, typeof beforeText === 'string' ? beforeText : '')) return no('error_visible');
  const host = hostOf(submissionUrl);
  const sends = (Array.isArray(responses) ? responses : []).filter((entry) => entry?.phase === 'submit'
    && /^(?:POST|PUT|PATCH)$/u.test(String(entry.method || '')) && String(entry.host || '').toLowerCase() === host);
  if (!sends.some((entry) => Number.isInteger(entry.status) && entry.status >= 200 && entry.status < 300)) return no('no_submit_response');
  if (sends.some((entry) => !(Number.isInteger(entry.status) && entry.status >= 200 && entry.status < 400))) return no('submit_response_failed');
  return { confirmed: true, reason: 'in_page_confirmation' };
}
