import React, { useEffect, useRef } from 'react';
import SignupPromptModal from './SignupPromptModal';
import type { JobBoardFilterAlertHandoff } from './JobBoardFilterAlertCta';
import { Analytics } from '@/services/analytics';

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
  // The parent decides to open this lazy modal before React has mounted it.
  // Count the handoff only after the portal has committed, and keep the guard
  // keyed to the handoff object so StrictMode/effect replays cannot duplicate it.
  const promptShownForHandoffRef = useRef<JobBoardFilterAlertHandoff | null>(null);
  useEffect(() => {
    if (promptShownForHandoffRef.current === handoff) return;
    promptShownForHandoffRef.current = handoff;
    Analytics.trackJobAlertAuthHandoff(
      'job_board_filters',
      'prompt_shown',
      handoff.config.keywords.join(', '),
    );
  }, [handoff]);

  return (
    <SignupPromptModal
      locale={locale}
      intent="alert"
      keyword={handoff.config.keywords.join(', ')}
      onDismiss={onDismiss}
    />
  );
}
