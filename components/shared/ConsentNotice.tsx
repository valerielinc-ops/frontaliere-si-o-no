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
 * The formula names `frontaliereticino.ch/comunicazioni` in prose because the
 * page is where the FREQUENCY of each channel lives — the formula deliberately
 * states none (see the register's header, and #5679). Rendering that substring
 * as an anchor makes it usable without changing a character: the node's
 * `textContent` is the stored string exactly, which
 * `tests/consent-shown-at-signup.test.ts` asserts rather than assumes.
 */
import React from 'react';
import {
  CONSENT_PAGE_LABEL,
  CONSENT_PAGE_PATH,
  consentDisplayText,
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
 * Render the disclosure, linking the one substring that names the channel list.
 *
 * `split` on the label keeps the surrounding characters untouched; when the
 * label is absent (it never is today, but a future formula could drop it) the
 * whole string is emitted as-is rather than silently losing content.
 */
const ConsentNotice: React.FC<ConsentNoticeProps> = ({ consentKey, locale, className, id }) => {
  const text = consentDisplayText(consentKey, locale);
  const parts = text.split(CONSENT_PAGE_LABEL);

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
              {CONSENT_PAGE_LABEL}
            </a>
          )}
        </React.Fragment>
      ))}
    </span>
  );
};

export default ConsentNotice;
