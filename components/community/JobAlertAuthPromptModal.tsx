import React from 'react';
import SignupPromptModal from './SignupPromptModal';

interface JobAlertAuthPromptModalProps {
  locale: string;
  keyword: string;
  onDismiss: () => void;
}

/** Auth gate for a parked job-board filter alert intent. */
export default function JobAlertAuthPromptModal({
  locale,
  keyword,
  onDismiss,
}: JobAlertAuthPromptModalProps) {
  return (
    <SignupPromptModal
      locale={locale}
      intent="alert"
      keyword={keyword}
      onDismiss={onDismiss}
    />
  );
}
