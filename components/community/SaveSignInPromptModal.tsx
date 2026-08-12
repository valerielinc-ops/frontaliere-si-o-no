/**
 * SaveSignInPromptModal — lightweight sign-in gate shown when an anonymous
 * visitor taps "save" on job or opens saved-jobs filter (account-gating
 * follow-up #4466/#4467).
 *
 * Deliberately NOT job-detail "auth gate" already in JobBoard.tsx
 * (`authGateOpen`/`handleAuthAndOpen`) — one conflates real login with
 * email-capture bypass crawler allowlisting, carries unrelated
 * side effects (auto newsletter subscribe, slug-based redirect). Saving
 * job requires REAL account, so this modal offers `SocialSignInButtons`
 * (Google/LinkedIn) AND an email path. Email reuses the newsletter
 * double-opt-in (same pattern as PublisherPublishPage.tsx's gate): a NEW
 * address gets the opt-in email, which doubles as a sign-in link via
 * ?action=confirm_newsletter auto-login (wired generically in App.tsx for
 * any sourcePath — including a magic link opened in a brand new tab); an
 * EXISTING address gets a login link sent explicitly (requestConfirmationEmail
 * purpose:'login'). All three methods also subscribe to the newsletter
 * (implicit consent, owner policy, same as the publisher gate).
 *
 * Purely presentational: parent (`JobBoard.tsx`) owns open/close state
 * reacts `authUser?.uid` becoming truthy close modal replay pending save —
 * `SocialSignInButtons` renders nothing once signed in (no completion
 * callback needed there). The email path's own "sent" state is local —
 * dismissing the modal after sending does NOT cancel the pending save,
 * since the link may still be clicked later (possibly in a new tab).
 */

import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Bookmark, Mail, Loader2, AlertCircle, Shield } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import SocialSignInButtons from '@/components/shared/SocialSignInButtons';
import EmailInput, { validateEmailStrict } from '@/components/shared/EmailInput';
import { upsertNewsletterSubscriber, requestConfirmationEmail } from '@/services/newsletterSubscribers';
import { consentProof } from '@/services/consentTexts';
import ConsentNotice from '@/components/shared/ConsentNotice';
import { getFirestore } from 'firebase/firestore';
import { getApp } from '@/services/firebase';
import { Analytics } from '@/services/analytics';
import { reportCaughtError } from '@/services/errorReporter';

interface SaveSignInPromptModalProps {
  locale: string;
  onDismiss: () => void;
}

export default function SaveSignInPromptModal({ locale, onDismiss }: SaveSignInPromptModalProps) {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [emailStatus, setEmailStatus] = useState<'idle' | 'loading' | 'sent' | 'error'>('idle');
  const [emailError, setEmailError] = useState('');

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (emailStatus === 'loading') return;
    const trimmed = email.trim();
    if (!validateEmailStrict(trimmed).valid) {
      setEmailError(t('newsletter.invalidEmail'));
      setEmailStatus('error');
      return;
    }
    setEmailStatus('loading');
    setEmailError('');
    try {
      const firestore = getFirestore(await getApp());
      const upsert = await upsertNewsletterSubscriber(firestore, {
        email: trimmed,
        preferences: { exchangeRate: true, traffic: true, taxUpdates: true, tips: false },
        source: 'save_signin_prompt_email',
        sourcePage: window.location.pathname,
        sourceCta: 'save_signin_prompt_email',
        sourceComponent: 'SaveSignInPromptModal',
        sourceRouteFamily: 'community',
        locale: navigator.language || 'it-IT',
        // #5712/#5718: the notice under the form renders this exact string,
        // in this locale, and it is the one stored.
        ...consentProof('communicationsOptIn', 'email_submit', locale),
        // No `consentGiven`: this form has no consent checkbox, so nothing here
        // is an affirmative opt-in — only "was shown" is true. See the
        // `consentGiven` section of services/consentTexts.ts (#5712).
      });
      if (upsert.existed) {
        await requestConfirmationEmail(trimmed, 'login');
      }
      setEmailStatus('sent');
      Analytics.trackEvent('save_signin_prompt_email_sent', {});
    } catch (error) {
      reportCaughtError(error, 'saveSignInPrompt.emailSubmit');
      setEmailError(t('newsletter.subscribeError'));
      setEmailStatus('error');
    }
  };

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

        {emailStatus === 'sent' ? (
          <div className="flex flex-col items-center text-center py-4">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-success-subtle">
              <Mail className="h-6 w-6 text-success" aria-hidden="true" />
            </div>
            <h3 className="text-sm font-semibold text-heading">{t('jobBoard.saveAuthPrompt.checkEmailTitle')}</h3>
            <p className="mt-1 text-xs text-muted">{t('jobBoard.saveAuthPrompt.checkEmailBody')}</p>
          </div>
        ) : (
          <div className="space-y-4">
            {/* No notice above the provider buttons here, and that is not an
                oversight: this modal's own upsert covers the EMAIL branch only.
                A social sign-in from here is recorded by the global auth
                listener in App.tsx under `signInAutoSubscribe`, so rendering
                `communicationsSignIn` would show one sentence and store
                another — the exact drift `displayed` exists to expose. Moves to
                a rendered notice when App.tsx is switched over (#5726). */}
            <SocialSignInButtons locale={locale} errorContext="saveAuthPrompt" googleWidth={360} />

            <div className="flex items-center gap-3">
              <div className="flex-1 h-px bg-edge" />
              <span className="text-xs text-muted uppercase tracking-wider">{t('jobBoard.saveAuthPrompt.or')}</span>
              <div className="flex-1 h-px bg-edge" />
            </div>

            <form onSubmit={handleEmailSubmit} className="space-y-2">
              <label htmlFor="save-signin-prompt-email" className="sr-only">
                {t('newsletter.emailPlaceholder')}
              </label>
              <EmailInput
                id="save-signin-prompt-email"
                value={email}
                onChange={(val) => {
                  setEmail(val);
                  if (emailStatus === 'error') setEmailStatus('idle');
                }}
                placeholder={t('newsletter.emailPlaceholder')}
                className="w-full px-4 py-2.5 bg-surface border border-edge rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-accent text-strong text-sm"
              />
              {emailStatus === 'error' && emailError && (
                <div className="flex items-start gap-2 p-2 bg-danger-subtle rounded-lg text-danger text-xs">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>{emailError}</span>
                </div>
              )}
              <button
                type="submit"
                disabled={emailStatus === 'loading'}
                className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold text-on-accent bg-accent hover:bg-accent-hover rounded-xl transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {emailStatus === 'loading' ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" /> {t('jobBoard.saveAuthPrompt.emailCta')}
                  </>
                ) : (
                  <>
                    <Mail className="w-4 h-4" /> {t('jobBoard.saveAuthPrompt.emailCta')}
                  </>
                )}
              </button>
            </form>

            <p className="flex items-start gap-1.5 text-xs text-muted leading-relaxed">
              <Shield className="w-3.5 h-3.5 text-success shrink-0 mt-0.5" />
              <ConsentNotice consentKey="communicationsOptIn" locale={locale} />
            </p>
          </div>
        )}

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
