/**
 * JobBridgeView — view for job pages where the URL has changed (bridge pages).
 *
 * Shown when window.__BRIDGE_TARGET_SLUG__ is set by the plugin's static HTML
 * template, meaning the old slug is still indexed by Google but the job is
 * active under a new slug. Redirects automatically after a countdown.
 *
 * Layout: blue banner → countdown + direct link → job header →
 * Google Sign-In → AdSense → related jobs → CTA
 */

import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Building2, Loader2, Mail, MapPin } from 'lucide-react';
import { useLocale } from '@/services/i18n';
import { renderGoogleButton, isLinkedInSignInAvailable, signInWithLinkedIn, saveAuthJobContext } from '@/services/authService';
import { reportCaughtError } from '@/services/errorReporter';
import { upsertNewsletterSubscriber } from '@/services/newsletterSubscribers';
import EmailInput, { validateEmailStrict } from '@/components/shared/EmailInput';
import AdSenseUnit from '@/components/shared/AdSenseUnit';

interface RelatedJob {
  slug: string;
  title?: string;
  titleByLocale?: Record<string, string>;
  company?: string;
  location?: string;
}

interface BridgeJobData {
  title?: string;
  titleByLocale?: Record<string, string>;
  company?: string;
  location?: string;
}

interface JobBridgeViewProps {
  targetSlug: string;
  jobData?: BridgeJobData;
  relatedJobs?: RelatedJob[];
  onBack?: () => void;
  /** When true the user is already authenticated — hide the sign-in block. */
  hasAccess?: boolean;
}

const SECTION_BY_LOCALE: Record<string, string> = {
  it: 'cerca-lavoro-ticino',
  en: 'find-jobs-ticino',
  de: 'jobs-im-tessin',
  fr: 'trouver-emploi-tessin',
};
const PREFIX_BY_LOCALE: Record<string, string> = { it: '', en: '/en', de: '/de', fr: '/fr' };

const BANNER_COPY: Record<string, string> = {
  it: 'Questo annuncio è stato aggiornato — ti portiamo alla versione corrente.',
  en: 'This job listing has been updated — redirecting you to the current version.',
  de: 'Diese Stellenanzeige wurde aktualisiert — Sie werden zur aktuellen Version weitergeleitet.',
  fr: "Cette offre a été mise à jour — vous allez être redirigé vers la version actuelle.",
};
const REDIRECT_COPY: Record<string, string> = {
  it: 'Reindirizzamento in {n} secondi…',
  en: 'Redirecting in {n} seconds…',
  de: 'Weiterleitung in {n} Sekunden…',
  fr: 'Redirection dans {n} secondes…',
};
const GO_NOW_COPY: Record<string, string> = {
  it: "Vai all'annuncio aggiornato",
  en: 'Go to updated listing',
  de: 'Zur aktuellen Stelle',
  fr: "Voir l'offre mise à jour",
};
const SIGNUP_COPY: Record<string, string> = {
  it: 'Accedi per ricevere offerte simili via email',
  en: 'Sign in to receive similar job alerts by email',
  de: 'Anmelden für ähnliche Stellenangebote per E-Mail',
  fr: "Connectez-vous pour recevoir des alertes d'emplois similaires",
};
const RELATED_COPY: Record<string, string> = {
  it: 'Offerte simili attive',
  en: 'Similar active jobs',
  de: 'Ähnliche offene Stellen',
  fr: 'Postes similaires ouverts',
};
const CTA_COPY: Record<string, string> = {
  it: 'Tutte le offerte di lavoro in Ticino',
  en: 'All job openings in Ticino',
  de: 'Alle offenen Stellen im Tessin',
  fr: "Toutes les offres d'emploi au Tessin",
};

const EMAIL_OR_COPY: Record<string, string> = {
  it: 'oppure con email',
  en: 'or with email',
  de: 'oder mit E-Mail',
  fr: 'ou par email',
};
const EMAIL_PLACEHOLDER_COPY: Record<string, string> = {
  it: 'La tua email',
  en: 'Your email',
  de: 'Ihre E-Mail',
  fr: 'Votre email',
};
const EMAIL_CTA_COPY: Record<string, string> = {
  it: 'Sblocca con email',
  en: 'Unlock with email',
  de: 'Mit E-Mail freischalten',
  fr: 'Débloquer par email',
};

const JOB_EMAIL_ACCESS_KEY = 'ft_job_email';
const COUNTDOWN_SECONDS = 3;

export default function JobBridgeView({ targetSlug, jobData, relatedJobs = [], onBack, hasAccess: hasAccessProp }: JobBridgeViewProps) {
  const [locale] = useLocale();
  const googleButtonRef = useRef<HTMLDivElement>(null);
  const [googleButtonReady, setGoogleButtonReady] = useState(false);
  const [linkedInAvailable, setLinkedInAvailable] = useState(false);
  const [countdown, setCountdown] = useState(COUNTDOWN_SECONDS);
  const [emailInput, setEmailInput] = useState('');
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);

  // Hide login block if user is already authenticated (prop) or has email access (localStorage)
  const alreadySignedIn = hasAccessProp || !!localStorage.getItem(JOB_EMAIL_ACCESS_KEY);

  const prefix = PREFIX_BY_LOCALE[locale] ?? '';
  const sectionSlug = SECTION_BY_LOCALE[locale] ?? SECTION_BY_LOCALE.it;
  const targetPath = `${prefix}/${sectionSlug}/${targetSlug}/`.replace(/\/+/g, '/');
  const listingPath = `${prefix}/${sectionSlug}/`.replace(/\/+/g, '/');
  const localizedTitle = jobData?.titleByLocale?.[locale] ?? jobData?.title;

  // Countdown redirect
  useEffect(() => {
    if (countdown <= 0) {
      window.location.href = targetPath;
      return;
    }
    const timer = setTimeout(() => setCountdown((n) => n - 1), 1000);
    return () => clearTimeout(timer);
  }, [countdown, targetPath]);

  useEffect(() => {
    const container = googleButtonRef.current;
    if (!container) return;
    let cancelled = false;

    // Save redirect path so One Tap / Google Sign-In navigates to the target job after auth
    sessionStorage.setItem('auth_redirect_path', targetPath);

    container.innerHTML = '';
    renderGoogleButton(container, { theme: 'outline', size: 'large', text: 'signin_with' })
      .then(() => {
        if (!cancelled) setGoogleButtonReady(container.children.length > 0);
      })
      .catch((err) => {
        if (!cancelled) reportCaughtError(err, 'jobBridgeView.renderGoogleButton');
      });
    return () => { cancelled = true; };
  }, [targetPath]);

  useEffect(() => {
    isLinkedInSignInAvailable().then(setLinkedInAvailable).catch(() => {});
  }, []);

  const redirectCopy = (REDIRECT_COPY[locale] ?? REDIRECT_COPY.it).replace('{n}', String(countdown));

  const handleEmailSubmit = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    const email = emailInput.trim();
    if (!email || !validateEmailStrict(email).valid) return;
    setEmailBusy(true);
    setEmailError(null);
    try {
      const [{ getFirestore }, { getApp }] = await Promise.all([
        import('firebase/firestore'),
        import('@/services/firebase'),
      ]);
      const firestore = getFirestore(await getApp());
      await upsertNewsletterSubscriber(firestore, {
        email,
        source: 'job_bridge',
        sourceChannel: 'job_gate',
        sourcePage: window.location.pathname,
        sourceCta: 'job_bridge_email_unlock',
        sourceComponent: 'JobBridgeView',
        sourceRouteFamily: 'job-board',
        isActive: false,
        status: 'pending',
      });
      localStorage.setItem(JOB_EMAIL_ACCESS_KEY, email.toLowerCase());
      window.location.href = targetPath;
    } catch {
      setEmailError(locale === 'it' ? 'Errore, riprova.' : 'Error, please retry.');
    } finally {
      setEmailBusy(false);
    }
  };

  return (
    <div className="space-y-5 max-w-2xl mx-auto">
      {onBack && (
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-sm text-subtle hover:text-slate-900 dark:hover:text-slate-100"
        >
          <ArrowLeft size={14} />
          {locale === 'it' ? 'Torna alla lista' : locale === 'de' ? 'Zurück zur Liste' : locale === 'fr' ? 'Retour à la liste' : 'Back to list'}
        </button>
      )}

      {/* Blue banner */}
      <div className="rounded-xl bg-stripe-50 dark:bg-stripe-900/20 border border-stripe-200 dark:border-stripe-700 px-4 py-3 text-sm text-stripe-800 dark:text-stripe-300">
        {BANNER_COPY[locale] ?? BANNER_COPY.it}
      </div>

      {/* Countdown + direct link */}
      <div className="flex flex-col items-start gap-2">
        <p className="text-sm text-muted">{redirectCopy}</p>
        <a
          href={targetPath}
          className="inline-flex items-center gap-1.5 font-semibold text-stripe-600 dark:text-stripe-400 hover:underline text-sm"
        >
          <ArrowRight size={14} />
          {GO_NOW_COPY[locale] ?? GO_NOW_COPY.it}
        </a>
      </div>

      {/* Job header */}
      {localizedTitle && (
        <div>
          <h1 className="text-xl font-bold text-slate-800 dark:text-slate-100 leading-snug">{localizedTitle}</h1>
          <div className="flex flex-wrap gap-3 mt-2 text-sm text-subtle">
            {jobData?.company && (
              <span className="flex items-center gap-1">
                <Building2 size={14} />
                {jobData.company}
              </span>
            )}
            {jobData?.location && (
              <span className="flex items-center gap-1">
                <MapPin size={14} />
                {jobData.location}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Google Sign-In block — hidden when user is already authenticated */}
      {!alreadySignedIn && (
      <div className="rounded-xl border border-edge bg-surface-alt/60 p-5 text-center space-y-3">
        <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
          {SIGNUP_COPY[locale] ?? SIGNUP_COPY.it}
        </p>
        <div ref={googleButtonRef} className="flex justify-center" />
        {!googleButtonReady && (
          <a
            href={`/?redirect=${encodeURIComponent(listingPath)}`} className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg border border-slate-300 dark:border-slate-600 bg-surface text-sm font-semibold text-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors" > {locale === 'it' ? 'Accedi' : locale === 'de' ? 'Anmelden' : locale === 'fr' ? 'Se connecter' : 'Sign in'} </a> )} {linkedInAvailable && ( <button type="button" onClick={() => { saveAuthJobContext({ slug: targetSlug, company: jobData?.company, location: jobData?.location }); signInWithLinkedIn(); }} className="w-full inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-[#0A66C2] hover:bg-[#004182] text-white text-sm font-semibold transition-colors" > <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg> {locale === 'it' ? 'Continua con LinkedIn' : locale === 'de' ? 'Mit LinkedIn fortfahren' : locale === 'fr' ? 'Continuer avec LinkedIn' : 'Continue with LinkedIn'} </button> )} {/* Email divider + form */} <div className="flex items-center gap-3"> <div className="flex-1 h-px bg-slate-300/50 dark:bg-slate-600/50" /> <span className="text-sm text-muted">{EMAIL_OR_COPY[locale] ?? EMAIL_OR_COPY.it}</span> <div className="flex-1 h-px bg-slate-300/50 dark:bg-slate-600/50" /> </div> <form onSubmit={handleEmailSubmit} className="space-y-2"> <EmailInput value={emailInput} onChange={setEmailInput} placeholder={EMAIL_PLACEHOLDER_COPY[locale] ?? EMAIL_PLACEHOLDER_COPY.it} className="w-full px-3 py-2.5 rounded-xl border border-slate-300 dark:border-slate-600 bg-surface text-sm text-heading dark:text-white placeholder-slate-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-stripe-500" /> <button type="submit" disabled={emailBusy || !emailInput.trim()} className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-stripe-600 hover:bg-stripe-700 disabled:opacity-60 text-white text-sm font-semibold transition-colors" > {emailBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />} {EMAIL_CTA_COPY[locale] ?? EMAIL_CTA_COPY.it} </button> </form> {emailError && <p className="text-sm text-red-600 dark:text-red-300">{emailError}</p>} </div> )} {/* AdSense */} <AdSenseUnit slot="5196931137" className="my-2" /> {/* Related active jobs */} {relatedJobs.length > 0 && ( <div className="space-y-2"> <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">{RELATED_COPY[locale] ?? RELATED_COPY.it}</h2> <ul className="space-y-1.5"> {relatedJobs.slice(0, 6).map((rj) => { const rjSlug = rj.slug; const rjTitle = rj.titleByLocale?.[locale] ?? rj.title ?? rjSlug; const rjPath = `${prefix}/${sectionSlug}/${rjSlug}/`.replace(/\/+/g, '/');
              return (
                <li key={rjSlug}>
                  <a
                    href={rjPath}
                    className="flex items-center gap-2 rounded-lg border border-edge bg-surface px-3 py-2 text-sm hover:border-stripe-300 dark:hover:border-stripe-600 transition-colors"
                  >
                    <span className="flex-1 font-medium text-slate-800 dark:text-slate-100 truncate">{rjTitle}</span>
                    {rj.company && <span className="text-muted text-xs shrink-0">{rj.company}</span>}
                    <ArrowRight size={12} className="text-muted shrink-0" />
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* CTA */}
      <a
        href={listingPath}
        className="inline-flex items-center gap-1.5 font-semibold text-stripe-600 dark:text-stripe-400 hover:underline text-sm"
      >
        <ArrowRight size={14} />
        {CTA_COPY[locale] ?? CTA_COPY.it}
      </a>
    </div>
  );
}
