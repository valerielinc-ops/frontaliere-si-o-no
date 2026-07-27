/**
 * SaveSignInPromptModal — lightweight sign-in gate shown when an anonymous
 * visitor taps "save" on a job or opens the saved-jobs filter (account-gating
 * follow-up to #4466/#4467).
 *
 * Deliberately NOT the job-detail "auth gate" already in JobBoard.tsx
 * (`authGateOpen`/`handleAuthAndOpen`) — that one conflates real login with
 * an email-capture bypass and crawler allowlisting, and carries unrelated
 * side effects (auto newsletter subscribe, slug-based redirect). Saving a
 * job requires a REAL account, so this modal only offers
 * `SocialSignInButtons` (Google/LinkedIn) — no email fallback.
 *
 * Purely presentational: the parent (`JobBoard.tsx`) owns open/close state
 * and reacts to `authUser?.uid` becoming truthy to close this modal and
 * replay the pending save — `SocialSignInButtons` renders nothing once
 * signed in, so there's no completion callback to wire here.
 */

import React from 'react';
import { createPortal } from 'react-dom';
import { X, Bookmark } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import SocialSignInButtons from '@/components/shared/SocialSignInButtons';

interface SaveSignInPromptModalProps {
  locale: string;
  onDismiss: () => void;
}

export default function SaveSignInPromptModal({ locale, onDismiss }: SaveSignInPromptModalProps) {
  const { t } = useTranslation();

  return createPortal(
    <div
      className="fixed inset-0 z-[2147483600] flex items-center justify-center bg-black/40 backdrop-blur-sm px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="save-signin-prompt-title"
      onClick={onDismiss}
    >
      <div
        className="relative w-full max-w-md rounded-2xl bg-surface p-6 shadow-2xl border border-edge"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onDismiss}
          className="absolute right-3 top-3 rounded-full p-1 text-muted hover:text-heading"
          aria-label={t('jobBoard.saveAuthPrompt.dismiss')}
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </button>

        <div className="mb-3 flex items-center gap-2 text-accent">
          <Bookmark className="h-6 w-6" aria-hidden="true" />
          <h2 id="save-signin-prompt-title" className="text-lg font-semibold text-heading">
            {t('jobBoard.saveAuthPrompt.title')}
          </h2>
        </div>

        <p className="mb-4 text-sm text-muted">{t('jobBoard.saveAuthPrompt.body')}</p>

        <SocialSignInButtons locale={locale} errorContext="saveAuthPrompt" googleWidth={360} />

        <button
          type="button"
          onClick={onDismiss}
          className="mt-4 w-full text-center text-xs text-muted hover:text-heading"
        >
          {t('jobBoard.saveAuthPrompt.dismiss')}
        </button>
      </div>
    </div>,
    document.body,
  );
}
