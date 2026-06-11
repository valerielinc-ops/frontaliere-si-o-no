/**
 * SocialSignInButtons — Google (GIS rendered button + fallback) + LinkedIn.
 *
 * The same social-auth row used across the newsletter funnel
 * (NewsletterPopup / SubscriptionCTA / CalculatorPaywall / LeadMagnetCTA),
 * extracted into one component so new gates reuse a single implementation
 * instead of copy-pasting the markup + GIS mount effect. Renders nothing
 * once a user is authenticated.
 *
 * Auth is global (useAuth) — the parent re-renders when `user` is set, so
 * there is no completion callback here: the caller reacts to `user`.
 */

import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from '@/services/i18n';
import { reportCaughtError } from '@/services/errorReporter';
import {
  useAuth,
  renderGoogleButtonWithReadiness,
  isLinkedInSignInAvailable,
  signInWithLinkedIn,
} from '@/services/authService';

interface SocialSignInButtonsProps {
  /** Active UI locale — drives the Google button + LinkedIn label localisation. */
  locale: string;
  /** Width (px) of the rendered Google Identity button. Defaults to 320. */
  googleWidth?: number;
  /** Extra classes for the wrapper element. */
  className?: string;
  /** Error-reporting context tag (helps trace which gate raised the error). */
  errorContext?: string;
}

function linkedInLabel(locale: string): string {
  switch (locale) {
    case 'de': return 'Mit LinkedIn fortfahren';
    case 'fr': return 'Continuer avec LinkedIn';
    case 'en': return 'Continue with LinkedIn';
    default: return 'Continua con LinkedIn';
  }
}

export default function SocialSignInButtons({
  locale,
  googleWidth = 320,
  className = '',
  errorContext = 'socialSignIn',
}: SocialSignInButtonsProps) {
  const { t } = useTranslation();
  const { user, signIn: googleSignIn } = useAuth();
  const [googleButtonReady, setGoogleButtonReady] = useState(false);
  const [linkedInAvailable, setLinkedInAvailable] = useState(false);
  const googleButtonRef = useRef<HTMLDivElement>(null);

  // LinkedIn is gated behind an RC flag (client-id configured).
  useEffect(() => {
    isLinkedInSignInAvailable().then(setLinkedInAvailable).catch(() => {});
  }, []);

  // Mount the GIS rendered button once, only while unauthenticated.
  useEffect(() => {
    if (user) {
      if (googleButtonRef.current) googleButtonRef.current.innerHTML = '';
      setGoogleButtonReady(false);
      return;
    }
    let cancelled = false;
    const mount = async () => {
      if (!googleButtonRef.current || cancelled) return;
      try {
        const ready = await renderGoogleButtonWithReadiness(googleButtonRef.current, {
          theme: 'outline', size: 'large', text: 'continue_with', width: googleWidth, locale,
        });
        if (!cancelled) setGoogleButtonReady(ready);
      } catch (error) {
        if (!cancelled) {
          setGoogleButtonReady(false);
          reportCaughtError(error, `${errorContext}.renderGoogleButton`);
        }
      }
    };
    void mount();
    return () => { cancelled = true; };
  }, [user, locale, googleWidth, errorContext]);

  if (user) return null;

  return (
    <div className={`space-y-2 ${className}`.trim()}>
      {/* Google Identity rendered button (falls back to a plain button if GIS is slow/blocked) */}
      <div ref={googleButtonRef} className="flex min-h-[44px] w-full items-center justify-center overflow-hidden rounded-xl" />
      {!googleButtonReady && (
        <button
          type="button"
          onClick={() => { void googleSignIn(); }}
          className="w-full min-h-[44px] grid grid-cols-[20px_1fr_20px] items-center px-4 py-2.5 bg-surface border border-edge rounded-xl text-body text-sm font-semibold hover:bg-surface-raised transition-colors"
        >
          <svg viewBox="0 0 24 24" className="w-4 h-4" aria-hidden="true"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
          <span className="text-center">{t('newsletter.popup.googleSignIn')}</span>
          <span aria-hidden="true" />
        </button>
      )}
      {linkedInAvailable && (
        <button
          type="button"
          onClick={() => { void signInWithLinkedIn(); }}
          className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-brand-linkedin hover:bg-brand-linkedin-hover text-on-accent text-sm font-semibold transition-colors"
          aria-label={linkedInLabel(locale)}
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
          <span>{linkedInLabel(locale)}</span>
        </button>
      )}
    </div>
  );
}
