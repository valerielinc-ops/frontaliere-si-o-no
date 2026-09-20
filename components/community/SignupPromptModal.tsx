/**
 * Shared account gate for actions that need a signed-in visitor.
 *
 * Saving a job and following an employer expose the same three entry points:
 * Google, LinkedIn, and a passwordless email link. Keeping the email branch
 * here makes the disclosure, unified registration write, and access-link
 * request one reusable operation.
 */

import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, BellRing, Bookmark, Loader2, Mail, Shield, X } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import SocialSignInButtons from '@/components/shared/SocialSignInButtons';
import EmailInput, { validateEmailStrict } from '@/components/shared/EmailInput';
import EmailConsentCheckbox from '@/components/shared/EmailConsentCheckbox';
import { requestConfirmationEmail, upsertUnifiedEmailSubscriber } from '@/services/newsletterSubscribers';
import { getFirestore } from 'firebase/firestore';
import { getApp } from '@/services/firebase';
import { Analytics } from '@/services/analytics';
import { reportCaughtError } from '@/services/errorReporter';

export type SignupPromptIntent = 'save' | 'follow';

export interface SignupPromptModalProps {
  locale: string;
  intent: SignupPromptIntent;
  company?: string | null;
  onDismiss: () => void;
  /** Override the email write for a parent test seam or alternate flow. */
  submitEmail?: (email: string) => Promise<void>;
  /** Called after the access email request succeeds. */
  onEmailRequested?: (email: string) => void | Promise<void>;
  onEmailError?: (error: unknown) => void;
}

function pagePath(): string {
  return typeof window !== 'undefined' ? window.location.pathname : '';
}

function browserLocale(): string {
  return typeof navigator !== 'undefined' ? navigator.language || 'it-IT' : 'it-IT';
}

export default function SignupPromptModal({
  locale,
  intent,
  company,
  onDismiss,
  submitEmail,
  onEmailRequested,
  onEmailError,
}: SignupPromptModalProps) {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [emailStatus, setEmailStatus] = useState<'idle' | 'loading' | 'sent' | 'error'>('idle');
  const [emailError, setEmailError] = useState('');
  const isFollow = intent === 'follow';
  const companyName = company?.trim() || t('jobAlert.companyFollow.cta');
  const title = isFollow
    ? t('jobAlert.companyFollow.authPrompt.title', { company: companyName })
    : t('jobBoard.saveAuthPrompt.title');
  const body = isFollow
    ? t('jobAlert.companyFollow.authPrompt.body', { company: companyName })
    : t('jobBoard.saveAuthPrompt.body');
  const successBody = isFollow
    ? t('jobAlert.companyFollow.authPrompt.checkEmailBody', { company: companyName })
    : t('jobBoard.saveAuthPrompt.checkEmailBody');
  const emailLabel = isFollow
    ? t('jobAlert.companyFollow.emailLabel')
    : t('newsletter.emailPlaceholder');
  const titleId = `signup-prompt-${intent}-title`;
  const bodyId = `signup-prompt-${intent}-body`;

  const submitDefaultEmail = async (trimmed: string): Promise<void> => {
    const firestore = getFirestore(await getApp());
    const upsert = await upsertUnifiedEmailSubscriber(firestore, {
      email: trimmed,
      source: isFollow ? 'company_follow_button' : 'save_signin_prompt_email',
      sourceChannel: isFollow ? 'company_follow_unified' : 'saved_job_unified',
      sourcePage: pagePath(),
      sourceCta: isFollow ? 'company_follow_button' : 'save_signin_prompt_email',
      sourceComponent: isFollow ? 'CompanyFollowButton' : 'SaveSignInPromptModal',
      sourceRouteFamily: isFollow ? 'company-follow' : 'community',
      locale: isFollow ? locale : browserLocale(),
      ...(isFollow ? { jobContext: { company: companyName } } : {}),
    });

    // A new email-only registration already receives the DOI link from the
    // unified upsert. Existing proof needs the separate passwordless access
    // link so the pending save/follow can be replayed after authentication.
    if (upsert.status !== 'pending' || upsert.hadConfirmationProof) {
      await requestConfirmationEmail(trimmed, 'login');
    }
  };

  const handleEmailSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (emailStatus === 'loading') return;
    const trimmed = email.trim().toLowerCase();
    if (!validateEmailStrict(trimmed).valid) {
      setEmailError(t('newsletter.invalidEmail'));
      setEmailStatus('error');
      return;
    }

    setEmailStatus('loading');
    setEmailError('');
    try {
      if (submitEmail) await submitEmail(trimmed);
      else await submitDefaultEmail(trimmed);
      await onEmailRequested?.(trimmed);
      setEmailStatus('sent');
      Analytics.trackEvent(
        isFollow ? 'company_follow_prompt_email_sent' : 'save_signin_prompt_email_sent',
        { intent },
      );
    } catch (error) {
      reportCaughtError(error, `signupPrompt.${intent}.emailSubmit`);
      onEmailError?.(error);
      setEmailError(t('newsletter.subscribeError'));
      setEmailStatus('error');
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[2147483600] flex items-center justify-center bg-black/40 px-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      onClick={(event) => { if (event.target === event.currentTarget) onDismiss(); }}
    >
      <div
        className="relative w-full max-w-md rounded-xl border border-edge bg-surface p-5 shadow-2xl sm:p-6"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          onClick={onDismiss}
          className="absolute right-3 top-3 rounded-lg p-2 text-muted transition-colors hover:bg-surface-raised hover:text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          aria-label={t('jobBoard.saveAuthPrompt.dismiss')}
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </button>

        <div className="mb-3 flex items-center gap-2 pr-8 text-accent">
          {isFollow ? (
            <BellRing className="h-6 w-6 shrink-0" aria-hidden="true" />
          ) : (
            <Bookmark className="h-6 w-6 shrink-0" aria-hidden="true" />
          )}
          <h2 id={titleId} className="text-lg font-semibold text-heading">
            {title}
          </h2>
        </div>

        <p id={bodyId} className="mb-4 text-sm text-muted">{body}</p>

        {emailStatus === 'sent' ? (
          <div className="flex flex-col items-center py-4 text-center" role="status" aria-live="polite">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-success-subtle">
              <Mail className="h-6 w-6 text-success" aria-hidden="true" />
            </div>
            <h3 className="text-sm font-semibold text-heading">
              {t('jobBoard.saveAuthPrompt.checkEmailTitle')}
            </h3>
            <p className="mt-1 text-xs text-muted">{successBody}</p>
          </div>
        ) : (
          <div className="space-y-4">
            <SocialSignInButtons
              locale={locale}
              errorContext={`signupPrompt.${intent}`}
              googleWidth={360}
            />

            <div className="flex items-center gap-3">
              <div className="h-px flex-1 bg-edge" />
              <span className="text-xs uppercase tracking-wider text-muted">
                {t('jobBoard.saveAuthPrompt.or')}
              </span>
              <div className="h-px flex-1 bg-edge" />
            </div>

            <form onSubmit={handleEmailSubmit} className="space-y-2">
              <label htmlFor={`signup-prompt-email-${intent}`} className="sr-only">
                {emailLabel}
              </label>
              <EmailInput
                id={`signup-prompt-email-${intent}`}
                value={email}
                onChange={(value) => {
                  setEmail(value);
                  if (emailStatus === 'error') {
                    setEmailStatus('idle');
                    setEmailError('');
                  }
                }}
                placeholder={t('newsletter.emailPlaceholder')}
                ariaLabel={emailLabel}
                className="w-full rounded-xl border border-edge bg-surface px-4 py-2.5 text-sm text-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              />
              {emailStatus === 'error' && emailError && (
                <div className="flex items-start gap-2 rounded-lg bg-danger-subtle p-2 text-xs text-danger" role="alert">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>{emailError}</span>
                </div>
              )}
              <button
                type="submit"
                disabled={emailStatus === 'loading'}
                aria-busy={emailStatus === 'loading'}
                className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl bg-accent px-5 py-2.5 text-sm font-semibold text-on-accent transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-60"
              >
                {emailStatus === 'loading' ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    {t('jobBoard.saveAuthPrompt.emailCta')}
                  </>
                ) : (
                  <>
                    <Mail className="h-4 w-4" aria-hidden="true" />
                    {t('jobBoard.saveAuthPrompt.emailCta')}
                  </>
                )}
              </button>
            </form>

            <div className="flex items-start gap-1.5 text-xs leading-relaxed text-muted">
              <Shield className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" aria-hidden="true" />
              <EmailConsentCheckbox
                id={`signup-prompt-consent-${intent}`}
                consentKey="communicationsOptIn"
                locale={locale}
                className="block"
                noticeClassName="text-[10px] leading-snug text-muted"
              />
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={onDismiss}
          className="mt-4 min-h-[32px] w-full text-center text-xs text-muted transition-colors hover:text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {t('jobBoard.saveAuthPrompt.dismiss')}
        </button>
      </div>
    </div>,
    document.body,
  );
}
