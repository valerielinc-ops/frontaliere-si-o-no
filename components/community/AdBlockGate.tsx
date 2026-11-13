/**
 * Native application-concierge promotion shown to human visitors when an
 * advertising blocker is detected. The client-only gate never enters static
 * SEO HTML; crawler checks also run before its lazy chunk is loaded in App.tsx.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, X } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
import { isLikelyBot, isLikelySearchCrawler } from '@/services/botPatterns';
import { detectAdBlockDetailed } from '@/services/adBlockDetection';
import { getApplicationConciergePath, isApplicationConciergePath } from '@/services/router';
import { NEWSLETTER_SUBSCRIBED_KEY } from '@/services/newsletterCtaState';
import { JOB_ALERT_SUBSCRIBED_KEY } from '@/services/jobAlertCtaState';

type GateLocale = 'it' | 'en' | 'de' | 'fr';
type CloseReason = 'close_button' | 'continue_reading' | 'backdrop' | 'escape' | 'cta_click';

const SESSION_DISMISSAL_KEY = 'ft_native_application_offer_dismissed_v1';

const COPY: Record<GateLocale, {
  label: string;
  title: string;
  description: string;
  duration: string;
  limit: string;
  price: string;
  priceNote: string;
  disclaimer: string;
  cta: string;
  dismiss: string;
  close: string;
}> = {
  it: {
    label: 'Promozione',
    title: 'Candidature su misura per il tuo prossimo lavoro in Svizzera',
    description: 'Per 30 giorni cerchiamo posizioni compatibili con il tuo profilo e prepariamo CV, lettere e risposte personalizzate.',
    duration: '30 giorni',
    limit: 'Fino a 10 posizioni che accetti',
    price: '39,99 €',
    priceNote: 'Pagamento unico · senza rinnovo',
    disclaimer: 'Le risposte delle aziende e l’assunzione non sono garantite.',
    cta: 'Scopri il servizio',
    dismiss: 'Continua a leggere',
    close: 'Chiudi promozione',
  },
  en: {
    label: 'Promotion',
    title: 'Tailored applications for your next job in Switzerland',
    description: 'For 30 days, we look for roles that fit your profile and prepare tailored CVs, cover letters, and answers.',
    duration: '30 days',
    limit: 'Up to 10 positions you accept',
    price: '€39.99',
    priceNote: 'One-off payment · no renewal',
    disclaimer: 'Employer replies and hiring are not guaranteed.',
    cta: 'See how it works',
    dismiss: 'Continue reading',
    close: 'Close promotion',
  },
  de: {
    label: 'Anzeige',
    title: 'Passende Bewerbungen für deinen nächsten Job in der Schweiz',
    description: '30 Tage lang suchen wir Stellen, die zu deinem Profil passen, und erstellen passende Lebensläufe, Anschreiben und Antworten.',
    duration: '30 Tage',
    limit: 'Bis zu 10 Stellen, die du annimmst',
    price: '39,99 €',
    priceNote: 'Einmalige Zahlung · keine Verlängerung',
    disclaimer: 'Antworten der Unternehmen und eine Anstellung sind nicht garantiert.',
    cta: 'Service ansehen',
    dismiss: 'Weiterlesen',
    close: 'Anzeige schließen',
  },
  fr: {
    label: 'Promotion',
    title: 'Des candidatures sur mesure pour votre prochain emploi en Suisse',
    description: 'Pendant 30 jours, nous recherchons des postes compatibles avec votre profil et préparons CV, lettres de motivation et réponses personnalisés.',
    duration: '30 jours',
    limit: 'Jusqu’à 10 postes que vous acceptez',
    price: '39,99 €',
    priceNote: 'Paiement unique · sans renouvellement',
    disclaimer: 'Les réponses des entreprises et l’embauche ne sont pas garanties.',
    cta: 'Découvrir le service',
    dismiss: 'Continuer la lecture',
    close: 'Fermer la promotion',
  },
};

function normalizeLocale(code?: string | null): GateLocale {
  const raw = String(code || 'it').toLowerCase().slice(0, 2);
  if (raw === 'en' || raw === 'de' || raw === 'fr') return raw;
  return 'it';
}

function isEngagedVisitor(): boolean {
  try {
    return localStorage.getItem(NEWSLETTER_SUBSCRIBED_KEY) === 'true'
      || localStorage.getItem(JOB_ALERT_SUBSCRIBED_KEY) === 'true';
  } catch {
    return false;
  }
}

function isApplicationConciergeSurface(): boolean {
  if (typeof window === 'undefined') return true;
  const params = new URLSearchParams(window.location.search);
  return isApplicationConciergePath(window.location.pathname)
    || params.has('application_concierge')
    || params.has('application_concierge_service_id');
}

function wasDismissedThisSession(): boolean {
  try {
    return sessionStorage.getItem(SESSION_DISMISSAL_KEY) === '1';
  } catch {
    return false;
  }
}

function rememberDismissal(): void {
  try {
    sessionStorage.setItem(SESSION_DISMISSAL_KEY, '1');
  } catch {
    // The in-memory flag still prevents the offer reopening during this app visit.
  }
}

function trackOffer(action: 'impression' | 'click' | 'dismiss', detail: string): void {
  try {
    Analytics.trackUIInteraction(
      'application_concierge',
      'adblock_native_offer',
      'modal',
      action,
      detail,
      `application_concierge.adblock_native_offer.${action}`,
    );
  } catch {
    // Promotion tracking must never interrupt reading or navigation.
  }
}

const AdBlockGate: React.FC = () => {
  const { locale } = useTranslation();
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const dismissedRef = useRef(false);
  const copy = COPY[normalizeLocale(locale)];
  const offerQuery = new URLSearchParams({
    utm_source: 'frontaliere',
    utm_medium: 'native_ad',
    utm_campaign: 'application_concierge_adblock',
    utm_content: 'popup_creative_v1',
  });
  const offerHref = `${getApplicationConciergePath(normalizeLocale(locale))}?${offerQuery.toString()}`;

  const closeOffer = useCallback((reason: CloseReason) => {
    dismissedRef.current = true;
    rememberDismissal();
    setOpen(false);
    if (reason === 'cta_click') trackOffer('click', reason);
    else trackOffer('dismiss', reason);
  }, []);

  useEffect(() => {
    // Keep known automation and search crawlers out before assigning or showing
    // any promotional UI, even when a crawler executes the client application.
    if (
      isLikelyBot()
      || isLikelySearchCrawler()
      || isEngagedVisitor()
      || isApplicationConciergeSurface()
      || wasDismissedThisSession()
    ) return;

    let cancelled = false;
    void detectAdBlockDetailed().then(({ blocked, adsAllowed }) => {
      if (
        cancelled
        || !blocked
        || adsAllowed
        || isLikelyBot()
        || isLikelySearchCrawler()
        || isEngagedVisitor()
        || isApplicationConciergeSurface()
        || dismissedRef.current
        || wasDismissedThisSession()
      ) return;
      setOpen(true);
      trackOffer('impression', 'adblock_detected');
    }).catch(() => {
      // Ambiguous detection stays fail-open: never interrupt a visitor without proof.
    });

    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeButtonRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeOffer('escape');
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      restoreFocusRef.current?.focus();
    };
  }, [open, closeOffer]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[2147483647] flex items-center justify-center bg-slate-950/65 px-3 py-3 backdrop-blur-[2px] sm:px-5"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeOffer('backdrop');
      }}
    >
      <section
        ref={dialogRef}
        className="animate-gate-in relative grid max-h-[calc(100dvh-1.5rem)] w-full max-w-4xl grid-cols-1 overflow-y-auto rounded-2xl bg-surface text-heading shadow-2xl md:max-h-[calc(100dvh-3rem)] md:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="native-application-offer-title"
        aria-describedby="native-application-offer-description"
        tabIndex={-1}
      >
        <button
          ref={closeButtonRef}
          type="button"
          onClick={() => closeOffer('close_button')}
          className="absolute right-3 top-3 z-10 inline-flex h-10 w-10 items-center justify-center rounded-full border border-edge bg-surface text-heading shadow-sm transition-colors hover:bg-surface-alt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
          aria-label={copy.close}
        >
          <X size={18} aria-hidden="true" />
        </button>

        <picture className="relative block h-36 min-h-36 overflow-hidden bg-surface-raised sm:h-48 md:h-full md:min-h-[30rem]">
          <source media="(max-width: 767px)" srcSet="/images/job-search-campaign/commute-wide-v1.webp" />
          <img
            src="/images/job-search-campaign/commute-portrait-v1.webp"
            alt=""
            width={887}
            height={1774}
            loading="eager"
            decoding="async"
            className="absolute inset-0 h-full w-full object-cover object-right md:object-center md:object-[center_24%]"
          />
        </picture>

        <div className="flex min-w-0 flex-col justify-center px-5 pb-5 pt-5 sm:px-7 sm:pb-7 md:px-8 md:py-10">
          <span className="mb-4 inline-flex w-fit items-center rounded-full border border-accent/25 bg-accent-subtle px-3 py-1 text-xs font-semibold text-accent">
            {copy.label}
          </span>
          <h2 id="native-application-offer-title" className="font-display text-2xl font-semibold leading-tight tracking-[-0.025em] text-heading sm:text-3xl">
            {copy.title}
          </h2>
          <p id="native-application-offer-description" className="mt-3 text-sm leading-6 text-body sm:text-base">
            {copy.description}
          </p>

          <div className="mt-5 flex flex-wrap items-end justify-between gap-x-4 gap-y-3 border-t border-edge pt-4">
            <div className="space-y-1 text-sm text-subtle">
              <p className="font-semibold text-heading">{copy.duration}</p>
              <p>{copy.limit}</p>
            </div>
            <div className="text-left sm:text-right">
              <p className="font-display text-3xl font-bold tabular-nums leading-none text-heading">{copy.price}</p>
              <p className="mt-1 text-xs leading-5 text-subtle">{copy.priceNote}</p>
            </div>
          </div>

          <a
            href={offerHref}
            onClick={() => closeOffer('cta_click')}
            className="mt-5 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-accent px-5 py-3 text-sm font-semibold text-on-accent transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
          >
            {copy.cta}
            <ArrowRight size={18} aria-hidden="true" />
          </a>
          <p className="mt-3 text-center text-xs leading-5 text-subtle">{copy.disclaimer}</p>
          <button
            type="button"
            onClick={() => closeOffer('continue_reading')}
            className="mt-3 min-h-11 self-center px-3 text-sm font-medium text-subtle underline decoration-edge underline-offset-4 transition-colors hover:text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
          >
            {copy.dismiss}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
};

export default AdBlockGate;
