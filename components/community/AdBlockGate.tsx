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
import { emitAdDiagnostic } from '@/services/adDiagnostics';
import { isLikelyBot, isLikelySearchCrawler } from '@/services/botPatterns';
import { detectAdBlockDetailed } from '@/services/adBlockDetection';
import { getApplicationConciergePath, isApplicationConciergePath } from '@/services/router';
import { NEWSLETTER_SUBSCRIBED_KEY } from '@/services/newsletterCtaState';
import { JOB_ALERT_SUBSCRIBED_KEY } from '@/services/jobAlertCtaState';

type GateLocale = 'it' | 'en' | 'de' | 'fr';
type CloseReason = 'close_button' | 'continue_reading' | 'backdrop' | 'escape' | 'cta_click';

const SESSION_DISMISSAL_KEY = 'ft_native_application_offer_dismissed_v1';
const SESSION_SHOWN_KEY = 'ft_native_application_offer_seen_v1';

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
  allowlistTitle: string;
  allowlistIntro: string;
  allowlistInstructions: string;
  allowlistStepOne: string;
  allowlistStepTwo: string;
  allowlistNote: string;
  allowlistReload: string;
  dismiss: string;
  close: string;
}> = {
  it: {
    label: 'Promozione',
    title: 'Lavoro in Svizzera? Lo cerchiamo noi per te.',
    description: 'Per 30 giorni troviamo offerte adatte al tuo mestiere e prepariamo le candidature per te.',
    duration: '30 giorni',
    limit: 'Fino a 10 posizioni che accetti',
    price: '39,99 €',
    priceNote: 'Pagamento unico · senza rinnovo',
    disclaimer: 'Le risposte delle aziende e l’assunzione non sono garantite.',
    cta: 'Scopri il servizio',
    allowlistTitle: 'Vuoi continuare a leggere con gli annunci?',
    allowlistIntro: 'Apri il menu del blocco pubblicità o le protezioni del browser per questa pagina. Solo tu puoi consentire il sito nelle impostazioni.',
    allowlistInstructions: 'Come consentire gli annunci',
    allowlistStepOne: 'Apri l’icona del blocco pubblicità vicino alla barra degli indirizzi. In Chrome, se non la vedi, controlla il menu delle estensioni.',
    allowlistStepTwo: 'Scegli “Consenti gli annunci”, “Metti in pausa su questo sito” o l’opzione equivalente, poi torna qui.',
    allowlistNote: 'Le etichette cambiano in base al browser e all’estensione.',
    allowlistReload: 'Ho consentito gli annunci — ricarica',
    dismiss: 'Continua a leggere',
    close: 'Chiudi promozione',
  },
  en: {
    label: 'Promotion',
    title: 'Want to work in Switzerland? We’ll look for you.',
    description: 'For 30 days, we find openings that fit your profession and prepare the applications for you.',
    duration: '30 days',
    limit: 'Up to 10 positions you accept',
    price: '€39.99',
    priceNote: 'One-off payment · no renewal',
    disclaimer: 'Employer replies and hiring are not guaranteed.',
    cta: 'See how it works',
    allowlistTitle: 'Want to keep reading with ads?',
    allowlistIntro: 'Open your ad blocker or browser protection settings for this page. Only you can allow this site in those settings.',
    allowlistInstructions: 'How to allow ads',
    allowlistStepOne: 'Open the ad-blocker icon near the address bar. In Chrome, check the extensions menu if you do not see it.',
    allowlistStepTwo: 'Choose “Allow ads”, “Pause on this site”, or the equivalent option, then return here.',
    allowlistNote: 'Labels vary by browser and extension.',
    allowlistReload: 'I allowed ads — reload',
    dismiss: 'Continue reading',
    close: 'Close promotion',
  },
  de: {
    label: 'Anzeige',
    title: 'Arbeit in der Schweiz? Wir suchen für dich.',
    description: '30 Tage lang finden wir passende Stellen für deinen Beruf und bereiten deine Bewerbungen vor.',
    duration: '30 Tage',
    limit: 'Bis zu 10 Stellen, die du annimmst',
    price: '39,99 €',
    priceNote: 'Einmalige Zahlung · keine Verlängerung',
    disclaimer: 'Antworten der Unternehmen und eine Anstellung sind nicht garantiert.',
    cta: 'Service ansehen',
    allowlistTitle: 'Möchtest du mit Werbung weiterlesen?',
    allowlistIntro: 'Öffne für diese Seite das Menü deines Werbeblockers oder den Browserschutz. Nur du kannst die Website dort freigeben.',
    allowlistInstructions: 'So erlaubst du Werbung',
    allowlistStepOne: 'Öffne das Symbol des Werbeblockers neben der Adressleiste. In Chrome findest du es gegebenenfalls im Erweiterungsmenü.',
    allowlistStepTwo: 'Wähle „Werbung erlauben“, „Auf dieser Website pausieren“ oder eine ähnliche Option und kehre hierher zurück.',
    allowlistNote: 'Die Bezeichnungen hängen vom Browser und der Erweiterung ab.',
    allowlistReload: 'Werbung erlaubt — neu laden',
    dismiss: 'Weiterlesen',
    close: 'Anzeige schließen',
  },
  fr: {
    label: 'Promotion',
    title: 'Un emploi en Suisse ? Nous le cherchons pour vous.',
    description: 'Pendant 30 jours, nous trouvons des offres adaptées à votre métier et préparons vos candidatures.',
    duration: '30 jours',
    limit: 'Jusqu’à 10 postes que vous acceptez',
    price: '39,99 €',
    priceNote: 'Paiement unique · sans renouvellement',
    disclaimer: 'Les réponses des entreprises et l’embauche ne sont pas garanties.',
    cta: 'Découvrir le service',
    allowlistTitle: 'Vous souhaitez continuer avec les annonces ?',
    allowlistIntro: 'Ouvrez le menu de votre bloqueur de publicités ou les protections du navigateur pour cette page. Vous seul pouvez autoriser le site dans ces réglages.',
    allowlistInstructions: 'Comment autoriser les annonces',
    allowlistStepOne: 'Ouvrez l’icône du bloqueur près de la barre d’adresse. Dans Chrome, regardez dans le menu des extensions si elle n’apparaît pas.',
    allowlistStepTwo: 'Choisissez « Autoriser les annonces », « Suspendre sur ce site » ou l’option équivalente, puis revenez ici.',
    allowlistNote: 'Les intitulés varient selon le navigateur et l’extension.',
    allowlistReload: 'J’ai autorisé les annonces — recharger',
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

/** Inline fallback slots own recovery when the page has room to render them. */
function hasUsableInlineHouseSlot(): boolean {
  if (typeof document === 'undefined' || typeof window === 'undefined') return false;
  return Array.from(document.querySelectorAll<HTMLElement>('[data-house]')).some((frame) => {
    if (!frame.hasAttribute('data-ft-house-blocker-only') && !frame.querySelector('[data-ft-house-google],ins[data-ad-slot]')) return false;
    for (let node: HTMLElement | null = frame; node; node = node.parentElement) {
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number.parseFloat(style.opacity) === 0) {
        return false;
      }
    }
    return frame.getBoundingClientRect().width >= 160;
  });
}

function wasDismissedThisSession(): boolean {
  try {
    return sessionStorage.getItem(SESSION_DISMISSAL_KEY) === '1';
  } catch {
    return false;
  }
}

function wasShownThisSession(): boolean {
  if (typeof window === 'undefined') return false;
  if ((window as Window & { __ftNativeApplicationOfferShown?: boolean }).__ftNativeApplicationOfferShown) return true;
  try {
    return sessionStorage.getItem(SESSION_SHOWN_KEY) === '1';
  } catch {
    return false;
  }
}

function rememberShown(): void {
  if (typeof window !== 'undefined') {
    (window as Window & { __ftNativeApplicationOfferShown?: boolean }).__ftNativeApplicationOfferShown = true;
  }
  try {
    sessionStorage.setItem(SESSION_SHOWN_KEY, '1');
  } catch {
    // The window flag still coordinates both first-party promotion surfaces during this page visit.
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

  const reloadAfterAllowlist = useCallback(() => {
    emitAdDiagnostic('ad_recovery_action', { action: 'allowlist_recheck', reason: 'adblock_detected' });
    window.location.reload();
  }, []);

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
      || hasUsableInlineHouseSlot()
      || wasDismissedThisSession()
      || wasShownThisSession()
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
        || hasUsableInlineHouseSlot()
        || dismissedRef.current
        || wasDismissedThisSession()
        || wasShownThisSession()
      ) return;
      rememberShown();
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
        'a[href], button:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
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

          <section className="mt-5 rounded-xl border border-edge bg-surface-raised p-4 sm:p-5" aria-labelledby="native-application-allowlist-title">
            <h3 id="native-application-allowlist-title" className="font-semibold text-heading">{copy.allowlistTitle}</h3>
            <p className="mt-2 text-sm leading-6 text-body">{copy.allowlistIntro}</p>
            <details
              className="mt-3 rounded-lg border border-edge bg-surface px-3 py-2 text-sm text-body"
              onToggle={(event) => {
                if (event.currentTarget.open) {
                  emitAdDiagnostic('ad_recovery_action', { action: 'allowlist_help_open', reason: 'adblock_detected' });
                }
              }}
            >
              <summary className="cursor-pointer py-1 font-medium text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">{copy.allowlistInstructions}</summary>
              <ol className="mt-2 list-decimal space-y-2 pl-5 leading-5">
                <li>{copy.allowlistStepOne}</li>
                <li>{copy.allowlistStepTwo}</li>
              </ol>
              <p className="mt-2 text-xs leading-5 text-subtle">{copy.allowlistNote}</p>
            </details>
            <button
              type="button"
              onClick={reloadAfterAllowlist}
              className="mt-3 inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-on-accent transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
            >
              {copy.allowlistReload}
            </button>
          </section>

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
            className="mt-5 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-lg border border-accent bg-surface px-5 py-3 text-sm font-semibold text-accent transition-colors hover:bg-accent-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
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
