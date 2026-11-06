import React from 'react';
import SignupPromptModal from './SignupPromptModal';
import type { JobBoardFilterAlertHandoff } from './JobBoardFilterAlertCta';

interface JobAlertAuthPromptModalProps {
  locale: string;
  handoff: JobBoardFilterAlertHandoff;
  onDismiss: () => void;
}

/** Auth gate for a parked job-board filter alert intent. */
export default function JobAlertAuthPromptModal({
  locale,
  handoff,
  onDismiss,
}: JobAlertAuthPromptModalProps) {
  return (
    <SignupPromptModal
      locale={locale}
      intent="alert"
      keyword={handoff.config.keywords.join(', ')}
      onDismiss={onDismiss}
    />
  );
}
