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
}: EmailConsentCheckboxProps) {
  return (
    <div id={id} className={className ?? 'block'}>
      <ConsentNotice
        consentKey={consentKey}
        locale={locale}
        className={noticeClassName ?? 'text-xs text-muted leading-relaxed'}
      />
    </div>
  );
}
