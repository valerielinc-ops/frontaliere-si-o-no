import React, { useEffect, useMemo } from 'react';
import { ArrowRight, BellRing } from 'lucide-react';
import { Analytics } from '@/services/analytics';
import { buildPath, type ActiveTab } from '@/services/router';
import type { Locale } from '@/services/i18n';
import { getContextualConversionContext } from '@/services/conversionContext';

type ContextualConversionCardProps = {
 locale: Locale;
 path?: string;
 activeTab?: ActiveTab;
};

const SECONDARY_LABELS: Record<Locale, Record<'fuel' | 'border' | 'health' | 'editorial' | 'guide', string>> = {
 it: {
  fuel: 'Calcola il tuo netto',
  border: 'Apri la guida al traffico',
  health: 'Apri il comparatore LAMal',
  editorial: 'Calcola il tuo netto',
  guide: 'Calcola il tuo netto',
 },
 en: {
  fuel: 'Calculate your take-home pay',
  border: 'Open the border guide',
  health: 'Open the LAMal comparison',
  editorial: 'Calculate your take-home pay',
  guide: 'Calculate your take-home pay',
 },
 de: {
  fuel: 'Nettolohn berechnen',
  border: 'Grenzverkehr-Ratgeber öffnen',
  health: 'LAMal-Vergleich öffnen',
  editorial: 'Nettolohn berechnen',
  guide: 'Nettolohn berechnen',
 },
 fr: {
  fuel: 'Calculer votre salaire net',
  border: 'Ouvrir le guide du trafic',
  health: 'Ouvrir le comparateur LAMal',
  editorial: 'Calculer votre salaire net',
  guide: 'Calculer votre salaire net',
 },
};

function secondaryPath(kind: 'fuel' | 'border' | 'health' | 'editorial' | 'guide', locale: Locale): string {
 if (kind === 'border') return buildPath({ activeTab: 'guida', guidaSubTab: 'border' }, locale);
 if (kind === 'health') return buildPath({ activeTab: 'confronti', confrontiSubTab: 'health' }, locale);
 return buildPath({ activeTab: 'calculator' }, locale);
}

const ContextualConversionCard: React.FC<ContextualConversionCardProps> = ({ locale, path, activeTab }) => {
 const context = useMemo(
  () => getContextualConversionContext(
   path || (typeof window !== 'undefined' ? window.location.pathname : '/'),
   locale,
  ),
  [locale, path],
 );

 useEffect(() => {
  if (!context) return;
  Analytics.trackUIInteraction(
   'conversion',
   context.kind,
   'contextual_card',
   'view',
   context.source,
   `contextual.${context.kind}.newsletter`,
  );
 }, [context?.kind, context?.source]);

 if (!context) return null;

 const nextPath = secondaryPath(context.kind, locale);
 const secondaryLabel = SECONDARY_LABELS[locale][context.kind];
 const source = context.source;

 const trackClick = (ctaId: string, targetUrl: string, label: string) => {
  Analytics.trackCtaClick(ctaId, {
   targetUrl,
   component: 'ContextualConversionCard',
   section: context.kind,
   label,
  });
 };

 return (
  <section
   className="my-8 rounded-2xl border border-info-border bg-info-subtle p-5 sm:p-6"
   data-testid="contextual-conversion-card"
   data-conversion-surface={source}
   data-active-tab={activeTab || undefined}
  >
   <div className="flex items-start gap-3">
    <span className="mt-0.5 rounded-xl bg-info-strong p-2 text-on-accent" aria-hidden="true">
     <BellRing size={18} />
    </span>
    <div className="min-w-0">
     <h2 className="font-display text-lg font-bold text-heading sm:text-xl">{context.heading}</h2>
     <p className="mt-2 max-w-2xl text-sm leading-6 text-body">{context.body}</p>
    </div>
   </div>
   <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
    <a
     href="#footer-newsletter"
     onClick={() => trackClick(`${source}.newsletter`, '#footer-newsletter', context.cta)}
     className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-info-strong px-4 py-2.5 text-sm font-bold text-on-accent transition-colors hover:bg-info-strong-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info focus-visible:ring-offset-2"
    >
     {context.cta}
     <ArrowRight size={16} aria-hidden="true" />
    </a>
    <a
     href={nextPath}
     onClick={() => trackClick(`${source}.next_tool`, nextPath, secondaryLabel)}
     className="inline-flex min-h-11 items-center justify-center rounded-xl px-3 py-2.5 text-sm font-semibold text-info underline decoration-info/40 underline-offset-4 transition-colors hover:text-info-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info focus-visible:ring-offset-2"
    >
     {secondaryLabel}
    </a>
   </div>
   <div className="sr-only" aria-hidden="true">{context.newsletterHeading} — {context.newsletterSubtitle}</div>
  </section>
 );
};

export default ContextualConversionCard;
