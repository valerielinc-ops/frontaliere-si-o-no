/**
 * ConsentNotice — the half of the consent register that the person can read.
 *
 * WHY IT IS A COMPONENT AND NOT A TRANSLATION KEY (#5712, #5718)
 * -------------------------------------------------------------
 * Before this file the two halves lived in different places and said different
 * things. `components/community/NewsletterPopup.tsx` rendered
 * `t('newsletter.consentLabel')` — translated into four languages — and stored
 * a hardcoded Italian literal; `components/shared/SubscriptionCTA.tsx` did the
 * same; ten further gates stored a formula from
 * `services/consentTexts.ts` that no JSX referenced at all. Every entry in the
 * register was therefore `displayed: false`, and honestly so.
 *
 * The fix is not a better string, it is removing the possibility of two. This
 * component renders `consentDisplayText(key, locale)`; `consentProof(key,
 * method, locale)` stores `consentDisplayText(key, locale)`. Same function,
 * same arguments, so "what was shown" and "what was recorded" are the same
 * bytes or the component is not being used.
 *
 * THE LINK, AND WHY IT DOES NOT ALTER THE TEXT
 * --------------------------------------------
 * The formula names the communications page in prose because the page is where
 * the FREQUENCY of each channel lives — the formula deliberately states none
 * (see the register's header, and #5679). Rendering that substring as an anchor
 * makes it usable without changing a character: the node's `textContent` is the
 * stored string exactly, which `tests/consent-shown-at-signup.test.tsx` asserts
 * rather than assumes.
 *
 * The name used to be the URL spelled out, one constant for all four locales,
 * which is what a URL allows and a word does not. It is now one word per locale
 * (`CONSENT_PAGE_LABELS`), 36 characters shorter in every language — on a 390px
 * job detail, where this notice renders three times on one page, that is a full
 * line back under each of them. The anchor still carries the whole name, so the
 * stored bytes are still the shown bytes.
 */
import React from 'react';
import {
  CONSENT_PAGE_PATH,
  consentDisplayText,
  consentPageLabel,
  type ConsentTextKey,
} from '@/services/consentTexts';

export interface ConsentNoticeProps {
  /** Which register entry. Must be one whose `displayed` is `true`. */
  consentKey: ConsentTextKey;
  /** The visitor's locale — the same value handed to `consentProof`. */
  locale?: string | null;
  /** Extra classes for the wrapper. Defaults keep it legible, never `text-slate-400` on light. */
  className?: string;
  /** Set when the notice labels a checkbox, so the box and the sentence are one control. */
  id?: string;
}

/**
 * Render the disclosure, linking the one word that names the channel list.
 *
 * Links the LAST STANDALONE occurrence, not every one and not a substring. The
 * label used to be a URL, which cannot appear twice in a sentence by accident
 * nor hide inside a longer token; it is now an ordinary word of the visitor's
 * language (`Condizioni`, `Terms`, …) sitting in the closing pointer. Two
 * consequences, both handled here rather than trusted to the formulas:
 *   · linking every match would put an anchor on a word a future formula
 *     happened to reuse earlier in the sentence — hence LAST;
 *   · a naive `indexOf` would match the label inside a longer word
 *     (`Precondizioni` contains `condizioni`) and split mid-word instead of
 *     failing visibly — hence the letter/digit boundaries.
 * When the label is absent the whole string is emitted as-is rather than
 * silently losing content.
 */
/**
 * Is this character part of a word? Used to reject a label that is only a
 * SUBSTRING of a longer token.
 *
 * Deliberately NOT a lookbehind (`(?<!…)`): `tests/check-client-lookbehind.test.ts`
 * forbids lookbehind anywhere in the client-bundled tree, because Safari below
 * 16.4 throws a SyntaxError while PARSING a regex literal that contains one —
 * the whole chunk dies, not the call. Unicode property escapes are fine, the
 * lookaround is not, so the boundary check reads the neighbouring characters
 * directly instead.
 */
const isWordChar = (ch: string | undefined): boolean => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);

/** Index of the last occurrence of `label` that is a whole word, or -1. */
const lastStandaloneIndex = (text: string, label: string): number => {
  if (!label) return -1;
  for (let i = text.lastIndexOf(label); i !== -1; i = text.lastIndexOf(label, i - 1)) {
    if (!isWordChar(text[i - 1]) && !isWordChar(text[i + label.length])) return i;
    // `lastIndexOf(label, -1)` clamps to 0 and would return 0 forever.
    if (i === 0) break;
  }
  return -1;
};

const ConsentNotice: React.FC<ConsentNoticeProps> = ({ consentKey, locale, className, id }) => {
  const text = consentDisplayText(consentKey, locale);
  const label = consentPageLabel(locale);
  const at = lastStandaloneIndex(text, label);
  const parts = at === -1 ? [text] : [text.slice(0, at), text.slice(at + label.length)];

  return (
    <span
      id={id}
      className={className ?? 'text-xs text-muted leading-relaxed block'}
      data-consent-key={consentKey}
    >
      {parts.map((part, i) => (
        <React.Fragment key={i}>
          {part}
          {i < parts.length - 1 && (
            <a
              href={CONSENT_PAGE_PATH}
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:no-underline text-info"
            >
              {label}
            </a>
          )}
        </React.Fragment>
      ))}
    </span>
  );
};

export default ConsentNotice;
