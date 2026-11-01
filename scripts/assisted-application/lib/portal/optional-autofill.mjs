/** An optional parser disclosure must not block the application's own upload. */
export function markOptionalAutofillDeclineInPage() {
  const clean = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const visible = element => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden';
  };
  const ai = /\b(?:artificial intelligence|intelligenza artificiale|intelligence artificielle|kunstliche intelligenz|ai|ia|ki)\b/;
  const parser = /(?:fill|compil|riemp|ausfull|vorausfull|rempliss|auswert|evaluat|valutat|analys|parsing)/;
  const optional = /(?:no (?:effect|impact)|does not affect|non ha alcun effetto|nessun effetto|keinen einfluss|keine auswirkung|aucune incidence|sans incidence|n['’]affecte pas)/;
  const decline = /^(?:decline|reject|no,? ?(?:thanks|grazie)|nein,? ?danke|non,? ?merci|rifiutare|rifiuta|rifiuto|ablehnen|refuser)$/;
  for (const old of document.querySelectorAll('[data-aa-autofill-decline]')) old.removeAttribute('data-aa-autofill-decline');
  for (const dialog of document.querySelectorAll('[role="dialog"], dialog[open], .ui-dialog')) {
    if (!visible(dialog)) continue;
    const text = clean(dialog.innerText || dialog.textContent);
    if (!ai.test(text) || !parser.test(text) || !optional.test(text) || !/(?:application|candidatur|bewerbung)/.test(text)) continue;
    const buttons = [...dialog.querySelectorAll('button[type="button"], input[type="button"]')]
      .filter(button => visible(button) && !button.disabled && decline.test(clean(button.innerText || button.textContent || button.value)));
    if (buttons.length !== 1) continue;
    buttons[0].setAttribute('data-aa-autofill-decline', '1');
    return true;
  }
  return false;
}

/** Real UI click, scoped to a disclosure that explicitly permits proceeding without AI. */
export async function dismissOptionalAutofill(page) {
  for (const frame of typeof page.frames === 'function' ? page.frames() : []) {
    if (typeof frame.evaluate !== 'function') continue;
    const marked = await frame.evaluate(markOptionalAutofillDeclineInPage).catch(() => false);
    if (!marked) continue;
    const button = frame.locator('[data-aa-autofill-decline="1"]');
    if (typeof button?.count !== 'function') continue;
    if (await button.count() !== 1) continue;
    await button.click({ timeout: 3000 });
    if (typeof button.evaluate === 'function') await button.evaluate(element => element.removeAttribute('data-aa-autofill-decline')).catch(() => {});
    return true;
  }
  return false;
}
