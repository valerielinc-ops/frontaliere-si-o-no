/**
 * JobOrphanView — view for slugs with no metadata in expired-jobs.json.
 *
 * Shown for GSC orphan slugs, legacy URLs, or true 404s that have a static
 * HTML page (from orphan soft-landing generation) but no job data available.
 *
 * Layout: grey banner → derived title → Sign-In block → AdSense → CTA
 */

import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { useLocale } from '@/services/i18n';
import { renderGoogleButton } from '@/services/authService';
import { reportCaughtError } from '@/services/errorReporter';
import AdSenseUnit from '@/components/shared/AdSenseUnit';

interface JobOrphanViewProps {
  slug: string;
  onBack?: () => void;
}

const SECTION_BY_LOCALE: Record<string, string> = {
  it: 'cerca-lavoro-ticino',
  en: 'find-jobs-ticino',
  de: 'jobs-im-tessin',
  fr: 'trouver-emploi-tessin',
};
const PREFIX_BY_LOCALE: Record<string, string> = { it: '', en: '/en', de: '/de', fr: '/fr' };

const BANNER_COPY: Record<string, string> = {
  it: 'Questo annuncio non è più disponibile o non è stato trovato.',
  en: 'This job listing is no longer available or was not found.',
  de: 'Diese Stellenanzeige ist nicht mehr verfügbar oder wurde nicht gefunden.',
  fr: 'Cette offre n\'est plus disponible ou n\'a pas été trouvée.',
};
const SIGNUP_COPY: Record<string, string> = {
  it: 'Accedi per ricevere offerte simili via email',
  en: 'Sign in to receive similar job alerts by email',
  de: 'Anmelden für ähnliche Stellenangebote per E-Mail',
  fr: 'Connectez-vous pour recevoir des alertes d\'emplois similaires',
};
const CTA_COPY: Record<string, string> = {
  it: 'Tutte le offerte di lavoro in Ticino',
  en: 'All job openings in Ticino',
  de: 'Alle offenen Stellen im Tessin',
  fr: 'Toutes les offres d\'emploi au Tessin',
};

/** Derive a human-readable title from a slug (best-effort). */
function slugToTitle(slug: string): string {
  return slug
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .slice(0, 80);
}

export default function JobOrphanView({ slug, onBack }: JobOrphanViewProps) {
  const [locale] = useLocale();
  const googleButtonRef = useRef<HTMLDivElement>(null);
  const [googleButtonReady, setGoogleButtonReady] = useState(false);

  const prefix = PREFIX_BY_LOCALE[locale] ?? '';
  const sectionSlug = SECTION_BY_LOCALE[locale] ?? SECTION_BY_LOCALE.it;
  const listingPath = `${prefix}/${sectionSlug}/`.replace(/\/+/g, '/');
  const derivedTitle = slugToTitle(slug);

  useEffect(() => {
    const container = googleButtonRef.current;
    if (!container) return;
    let cancelled = false;
    container.innerHTML = '';
    renderGoogleButton(container, { theme: 'outline', size: 'large', text: 'signin_with' })
      .then(() => {
        if (!cancelled) setGoogleButtonReady(container.children.length > 0);
      })
      .catch((err) => {
        if (!cancelled) reportCaughtError(err, 'jobOrphanView.renderGoogleButton');
      });
    return () => { cancelled = true; };
  }, []);

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

      {/* Grey banner */}
      <div className="rounded-xl bg-slate-100 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 px-4 py-3 text-sm text-slate-700 dark:text-slate-300">
        {BANNER_COPY[locale] ?? BANNER_COPY.it}
      </div>

      {/* Derived title */}
      <h1 className="text-xl font-bold text-slate-800 dark:text-slate-100 leading-snug">{derivedTitle}</h1>

      {/* Sign-In block */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/60 p-5 text-center space-y-3">
        <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
          {SIGNUP_COPY[locale] ?? SIGNUP_COPY.it}
        </p>
        <div ref={googleButtonRef} className="flex justify-center" />
        {!googleButtonReady && (
          <a
            href={`/?redirect=${encodeURIComponent(listingPath)}`}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm font-semibold text-slate-800 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
          >
            {locale === 'it' ? 'Accedi' : locale === 'de' ? 'Anmelden' : locale === 'fr' ? 'Se connecter' : 'Sign in'}
          </a>
        )}
      </div>

      {/* AdSense */}
      <AdSenseUnit slot="5196931137" className="my-2" />

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
