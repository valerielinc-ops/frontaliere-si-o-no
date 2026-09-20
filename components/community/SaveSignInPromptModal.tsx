import React from 'react';
import SignupPromptModal from './SignupPromptModal';

interface SaveSignInPromptModalProps {
  locale: string;
  onDismiss: () => void;
}

/** Compatibility boundary for the JobBoard lazy import. */
export default function SaveSignInPromptModal({ locale, onDismiss }: SaveSignInPromptModalProps) {
  return (
    <SignupPromptModal
      locale={locale}
      intent="save"
      onDismiss={onDismiss}
    />
  );
}
