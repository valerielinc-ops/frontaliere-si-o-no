import React from 'react';
import ConsentNotice from './ConsentNotice';
import type { ConsentTextKey } from '@/services/consentTexts';

export interface EmailConsentCheckboxProps {
  id?: string;
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  locale?: string | null;
  consentKey: ConsentTextKey;
  className?: string;
  noticeClassName?: string;
  collapsible?: boolean;
  summary?: React.ReactNode;
}

/**
 * Compatibility wrapper for former checkbox surfaces. Registration is now
 * covered by the terms and conditions, so this keeps the disclosure slot
 * without adding a second affirmative control.
 */
export default function EmailConsentCheckbox({
  id,
  locale,
  consentKey,
  className,
  noticeClassName,
  collapsible = false,
  summary,
}: EmailConsentCheckboxProps) {
  return (
    <div id={id} className={className ?? 'block'}>
      {collapsible ? (
        <details>
          <summary className="cursor-pointer text-xs font-medium text-accent hover:underline">
            {summary}
          </summary>
          <ConsentNotice
            consentKey={consentKey}
            locale={locale}
            className={noticeClassName ?? 'mt-2 block text-xs text-muted leading-relaxed'}
          />
        </details>
      ) : (
        <ConsentNotice
          consentKey={consentKey}
          locale={locale}
          className={noticeClassName ?? 'text-xs text-muted leading-relaxed'}
        />
      )}
    </div>
  );
}
