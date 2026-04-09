/**
 * JobExpiredView — view for jobs found in /data/expired-jobs.json.
 *
 * Layout: orange banner → job header → truncated description →
 * Google Sign-In block → AdSense unit → related active jobs → CTA
 */

import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Building2, Calendar, Loader2, Mail, MapPin } from 'lucide-react';
import { useLocale } from '@/services/i18n';
import { renderGoogleButton, isLinkedInSignInAvailable, signInWithLinkedIn, saveAuthJobContext } from '@/services/authService';
import { reportCaughtError } from '@/services/errorReporter';
import { upsertNewsletterSubscriber } from '@/services/newsletterSubscribers';
import EmailInput, { validateEmailStrict } from '@/components/shared/EmailInput';
import AdSenseUnit from '@/components/shared/AdSenseUnit';
import type { ExpiredJob } from '@/hooks/useExpiredJob';

interface RelatedJob {
  slug: string;
  title?: string;
  titleByLocale?: Record<string, string>;
  company?: string;
  location?: string;
}

interface JobExpiredViewProps {
  job: ExpiredJob;
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
  it: 'Questa posizione non è più attiva.',
  en: 'This position is no longer active.',
  de: 'Diese Stelle ist nicht mehr aktiv.',
  fr: 'Ce poste n\'est plus actif.',
};
const SIGNUP_COPY: Record<string, string> = {
  it: 'Accedi per vedere le ultime offerte simili e ricevere alert',
  en: 'Sign in to see the latest similar jobs and receive alerts',
  de: 'Anmelden für ähnliche Stellenangebote und Benachrichtigungen',
  fr: 'Connectez-vous pour voir les offres similaires et recevoir des alertes',
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
  fr: 'Toutes les offres d\'emploi au Tessin',
};
const EXPIRED_AT_COPY: Record<string, string> = {
  it: 'Scaduta il',
  en: 'Expired on',
  de: 'Abgelaufen am',
  fr: 'Expirée le',
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

export default function JobExpiredView({ job, relatedJobs = [], onBack, hasAccess: hasAccessProp }: JobExpiredViewProps) {
  const [locale] = useLocale();
  const googleButtonRef = useRef<HTMLDivElement>(null);
  const [googleButtonReady, setGoogleButtonReady] = useState(false);
  const [linkedInAvailable, setLinkedInAvailable] = useState(false);
  const [emailInput, setEmailInput] = useState('');
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);

  // Hide login block if user is already authenticated (prop) or has email access (localStorage)
  const alreadySignedIn = hasAccessProp || !!localStorage.getItem(JOB_EMAIL_ACCESS_KEY);

  const sectionSlug = SECTION_BY_LOCALE[locale] ?? SECTION_BY_LOCALE.it;
  const prefix = PREFIX_BY_LOCALE[locale] ?? '';
  const listingPath = `${prefix}/${sectionSlug}/`.replace(/\/+/g, '/');

  const localizedTitle = job.titleByLocale?.[locale] ?? job.title;
  const description = job.descriptionByLocale?.[locale] ?? '';
  const descriptionPreview = description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);

  const expiredDate = job.expiredAt
    ? new Date(job.expiredAt).toLocaleDateString(locale === 'it' ? 'it-IT' : locale === 'de' ? 'de-CH' : locale === 'fr' ? 'fr-CH' : 'en-GB', { year: 'numeric', month: 'long', day: 'numeric' })
    : null;

  useEffect(() => {
    if (alreadySignedIn) return;
    const container = googleButtonRef.current;
    if (!container) return;
    let cancelled = false;

    sessionStorage.setItem('auth_redirect_path', window.location.pathname);

    container.innerHTML = '';
    renderGoogleButton(container, { theme: 'outline', size: 'large', text: 'signin_with' })
      .then(() => {
        if (!cancelled) setGoogleButtonReady(container.children.length > 0);
      })
      .catch((err) => {
        if (!cancelled) reportCaughtError(err, 'jobExpiredView.renderGoogleButton');
      });
    return () => { cancelled = true; };
  }, [alreadySignedIn, listingPath]);

  useEffect(() => {
    if (alreadySignedIn) return;
    isLinkedInSignInAvailable().then(setLinkedInAvailable).catch(() => {});
  }, [alreadySignedIn]);

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
        source: 'job_expired',
        sourceChannel: 'job_gate',
        sourcePage: window.location.pathname,
        sourceCta: 'job_expired_email_unlock',
        sourceComponent: 'JobExpiredView',
        sourceRouteFamily: 'job-board',
        isActive: false,
        status: 'pending',
      });
      localStorage.setItem(JOB_EMAIL_ACCESS_KEY, email.toLowerCase());
      window.location.reload();
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
          className="inline-flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
        >
          <ArrowLeft size={14} />
          {locale === 'it' ? 'Torna alla lista' : locale === 'de' ? 'Zurück zur Liste' : locale === 'fr' ? 'Retour à la liste' : 'Back to list'}
        </button>
      )}

      {/* Orange banner */}
      <div className="rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
        {BANNER_COPY[locale] ?? BANNER_COPY.it}
      </div>

      {/* Job header */}
      <div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100 leading-snug">{localizedTitle}</h1>
        <div className="flex flex-wrap gap-3 mt-2 text-sm text-slate-600 dark:text-slate-400">
          {job.company && (
            <span className="flex items-center gap-1">
              <Building2 size={14} />
              {job.company}
            </span>
          )}
          {(job.addressLocality ?? job.location) && (
            <span className="flex items-center gap-1">
              <MapPin size={14} />
              {job.addressLocality ?? job.location}
            </span>
          )}
          {expiredDate && (
            <span className="flex items-center gap-1">
              <Calendar size={14} />
              {EXPIRED_AT_COPY[locale] ?? EXPIRED_AT_COPY.it} {expiredDate}
            </span>
          )}
        </div>
      </div>

      {/* Description excerpt */}
      {descriptionPreview && (
        <p className="text-sm text-slate-700 dark:text-slate-300 leading-relaxed line-clamp-4">
          {descriptionPreview}{description.length > 400 ? '…' : ''}
        </p>
      )}

      {/* Google Sign-In block — hidden when user is already authenticated */}
      {!alreadySignedIn && (
      <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/60 p-5 text-center space-y-3">
        <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
          {SIGNUP_COPY[locale] ?? SIGNUP_COPY.it}
        </p>
        <div ref={googleButtonRef} className="flex justify-center" />
        {!googleButtonReady && (
          <a
            href={`/?redirect=${encodeURIComponent(window.location.pathname)}`}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm font-semibold text-slate-800 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
          >
            {locale === 'it' ? 'Accedi' : locale === 'de' ? 'Anmelden' : locale === 'fr' ? 'Se connecter' : 'Sign in'}
          </a>
        )}

        {linkedInAvailable && (
          <button
            type="button"
            onClick={() => { saveAuthJobContext({ slug: job.slug, company: job.company, location: job.location || job.addressLocality, category: job.sector }); signInWithLinkedIn(); }}
            className="w-full inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-[#0A66C2] hover:bg-[#004182] text-white text-sm font-semibold transition-colors"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
            {locale === 'it' ? 'Continua con LinkedIn' : locale === 'de' ? 'Mit LinkedIn fortfahren' : locale === 'fr' ? 'Continuer avec LinkedIn' : 'Continue with LinkedIn'}
          </button>
        )}

        {/* Email divider + form */}
        <div className="flex items-center gap-3">
          <div className="flex-1 h-px bg-slate-300/50 dark:bg-slate-600/50" />
          <span className="text-sm text-slate-500 dark:text-slate-400">{EMAIL_OR_COPY[locale] ?? EMAIL_OR_COPY.it}</span>
          <div className="flex-1 h-px bg-slate-300/50 dark:bg-slate-600/50" />
        </div>
        <form onSubmit={handleEmailSubmit} className="space-y-2">
          <EmailInput
            value={emailInput}
            onChange={setEmailInput}
            placeholder={EMAIL_PLACEHOLDER_COPY[locale] ?? EMAIL_PLACEHOLDER_COPY.it}
            className="w-full px-3 py-2.5 rounded-xl border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm text-slate-900 dark:text-white placeholder-slate-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          />
          <button
            type="submit"
            disabled={emailBusy || !emailInput.trim()}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white text-sm font-semibold transition-colors"
          >
            {emailBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
            {EMAIL_CTA_COPY[locale] ?? EMAIL_CTA_COPY.it}
          </button>
        </form>
        {emailError && <p className="text-sm text-red-600 dark:text-red-300">{emailError}</p>}
      </div>
      )}

      {/* AdSense */}
      <AdSenseUnit slot="5196931137" className="my-2" />

      {/* Related active jobs */}
      {relatedJobs.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">{RELATED_COPY[locale] ?? RELATED_COPY.it}</h2>
          <ul className="space-y-1.5">
            {relatedJobs.slice(0, 6).map((rj) => {
              const rjSlug = rj.slug;
              const rjTitle = rj.titleByLocale?.[locale] ?? rj.title ?? rjSlug;
              const rjPath = `${prefix}/${sectionSlug}/${rjSlug}/`.replace(/\/+/g, '/');
              return (
                <li key={rjSlug}>
                  <a
                    href={rjPath}
                    className="flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm hover:border-indigo-300 dark:hover:border-indigo-600 transition-colors"
                  >
                    <span className="flex-1 font-medium text-slate-800 dark:text-slate-100 truncate">{rjTitle}</span>
                    {rj.company && <span className="text-slate-500 dark:text-slate-400 text-xs shrink-0">{rj.company}</span>}
                    <ArrowRight size={12} className="text-slate-500 dark:text-slate-400 shrink-0" />
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
        className="inline-flex items-center gap-1.5 font-semibold text-indigo-600 dark:text-indigo-400 hover:underline text-sm"
      >
        <ArrowRight size={14} />
        {CTA_COPY[locale] ?? CTA_COPY.it}
      </a>
    </div>
  );
}
