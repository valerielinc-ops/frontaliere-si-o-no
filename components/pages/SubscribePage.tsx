/**
 * SubscribePage — reader no-ads subscription (#3655, part 2/2 of #2961).
 *
 * Was a "coming soon" placeholder (#3654, part 1/2) reachable only via the
 * client-only AdBlockGate's `navigateTo('subscribe')` call — no nav entry,
 * no sitemap/locale-key registration, unreachable by crawlers structurally,
 * same as `admin`. That access path is unchanged; this file now renders the
 * real checkout / manage-subscription UI instead of a placeholder:
 *
 *   - signed-out visitor  → sign-in prompt (checkout requires a Firebase ID
 *                            token server-side, see functions/src/stripeReaderCore.js).
 *   - signed-in, no active entitlement → "Subscribe" → POST createReaderCheckout
 *                            → redirect to the returned Stripe Checkout URL.
 *   - signed-in, active entitlement    → "Manage subscription" → POST
 *                            createReaderBillingPortal → redirect to Stripe's
 *                            hosted Billing Portal (cancel / payment method / invoices).
 *
 * Entitlement state (services/readerEntitlement.ts) is the SAME synchronous
 * localStorage flag both Auto Ads injection points gate on
 * (components/shared/AdSenseBanner.tsx + build-plugins/constants.ts's
 * ADSENSE_LOADER_CONTENT) — never a global/per-route toggle, purely this one
 * signed-in reader's own client state (AGENTS.md Non-Negotiable #7).
 *
 * Self-contained per-locale copy (not the services/locales chunk system) —
 * same pattern as OfferwallNewsletterGate/AdBlockGate, since this page has
 * no SEO/indexing purpose that would justify the i18n-key machinery.
 */

import React, { useEffect, useState } from 'react';
import { ArrowLeft, Sparkles, LogIn, ShieldCheck, Loader2 } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { useNavigation } from '@/services/NavigationContext';
import { useAuth } from '@/services/authService';
import { Analytics } from '@/services/analytics';
import { getDistinctId } from '@/services/posthog';
import { reportCaughtError } from '@/services/errorReporter';
import {
  hasActiveReaderNoAdsEntitlement,
  onReaderEntitlementChange,
} from '@/services/readerEntitlement';

const READER_CHECKOUT_ENDPOINT =
  'https://europe-west6-frontaliere-ticino.cloudfunctions.net/createReaderCheckout';
const READER_BILLING_PORTAL_ENDPOINT =
  'https://europe-west6-frontaliere-ticino.cloudfunctions.net/createReaderBillingPortal';

type PageLocale = 'it' | 'en' | 'de' | 'fr';

interface SubscribeCopy {
  title: string;
  subtitle: string;
  price: string;
  bullets: string[];
  cancelNote: string;
  signInPrompt: string;
  signInCta: string;
  subscribeCta: string;
  manageCta: string;
  activeNote: string;
  errorGeneric: string;
  redirecting: string;
  back: string;
}

const COPY: Record<PageLocale, SubscribeCopy> = {
  it: {
    title: 'Abbonamento senza pubblicità',
    subtitle: 'Rimuovi tutta la pubblicità dal sito con un abbonamento mensile.',
    price: 'CHF 2.99 al mese',
    bullets: [
      'Nessun banner, video o interstitial pubblicitario su tutto il sito.',
      'Attivo su questo account non appena il pagamento è confermato.',
      'Disdici quando vuoi dal portale di gestione Stripe, nessun vincolo.',
    ],
    cancelNote:
      'Puoi disdire in qualsiasi momento dal pulsante "Gestisci abbonamento" qui sotto: l’addebito si ferma al termine del periodo già pagato.',
    signInPrompt: 'Accedi per attivare l’abbonamento.',
    signInCta: 'Accedi',
    subscribeCta: 'Abbonati a CHF 2.99/mese',
    manageCta: 'Gestisci abbonamento',
    activeNote: 'Il tuo abbonamento è attivo. Grazie per il supporto!',
    errorGeneric: 'Qualcosa è andato storto. Riprova tra poco.',
    redirecting: 'Reindirizzamento a Stripe…',
    back: 'Torna al sito',
  },
  en: {
    title: 'Ad-free subscription',
    subtitle: 'Remove all advertising from the site with a monthly subscription.',
    price: 'CHF 2.99 / month',
    bullets: [
      'No banner, video, or interstitial ads anywhere on the site.',
      'Active on this account as soon as payment is confirmed.',
      'Cancel anytime from Stripe’s self-serve billing portal — no fixed term.',
    ],
    cancelNote:
      'Cancel anytime with the "Manage subscription" button below: billing stops at the end of the period you already paid for.',
    signInPrompt: 'Sign in to activate the subscription.',
    signInCta: 'Sign in',
    subscribeCta: 'Subscribe for CHF 2.99/month',
    manageCta: 'Manage subscription',
    activeNote: 'Your subscription is active. Thank you for your support!',
    errorGeneric: 'Something went wrong. Please try again shortly.',
    redirecting: 'Redirecting to Stripe…',
    back: 'Back to the site',
  },
  de: {
    title: 'Werbefreies Abonnement',
    subtitle: 'Entfernen Sie mit einem monatlichen Abonnement jede Werbung von der Website.',
    price: 'CHF 2.99 pro Monat',
    bullets: [
      'Keine Banner-, Video- oder Interstitial-Werbung auf der gesamten Website.',
      'Aktiv auf diesem Konto, sobald die Zahlung bestätigt ist.',
      'Jederzeit kündbar über das Stripe-Kundenportal — keine Mindestlaufzeit.',
    ],
    cancelNote:
      'Sie können jederzeit über die Schaltfläche „Abonnement verwalten“ unten kündigen: die Abbuchung endet am Ende des bereits bezahlten Zeitraums.',
    signInPrompt: 'Melden Sie sich an, um das Abonnement zu aktivieren.',
    signInCta: 'Anmelden',
    subscribeCta: 'Für CHF 2.99/Monat abonnieren',
    manageCta: 'Abonnement verwalten',
    activeNote: 'Ihr Abonnement ist aktiv. Vielen Dank für Ihre Unterstützung!',
    errorGeneric: 'Etwas ist schiefgelaufen. Bitte versuchen Sie es in Kürze erneut.',
    redirecting: 'Weiterleitung zu Stripe…',
    back: 'Zurück zur Website',
  },
  fr: {
    title: 'Abonnement sans publicité',
    subtitle: 'Supprimez toute publicité du site avec un abonnement mensuel.',
    price: 'CHF 2.99 par mois',
    bullets: [
      'Aucune bannière, vidéo ou publicité interstitielle sur tout le site.',
      'Actif sur ce compte dès que le paiement est confirmé.',
      'Résiliable à tout moment depuis le portail Stripe — aucun engagement.',
    ],
    cancelNote:
      'Vous pouvez résilier à tout moment avec le bouton « Gérer l’abonnement » ci-dessous : le prélèvement s’arrête à la fin de la période déjà payée.',
    signInPrompt: 'Connectez-vous pour activer l’abonnement.',
    signInCta: 'Se connecter',
    subscribeCta: 'S’abonner pour CHF 2.99/mois',
    manageCta: 'Gérer l’abonnement',
    activeNote: 'Votre abonnement est actif. Merci pour votre soutien !',
    errorGeneric: 'Une erreur est survenue. Veuillez réessayer sous peu.',
    redirecting: 'Redirection vers Stripe…',
    back: 'Retour au site',
  },
};

function normalizeLocale(code?: string | null): PageLocale {
  const raw = String(code || 'it').toLowerCase().slice(0, 2);
  if (raw === 'en' || raw === 'de' || raw === 'fr') return raw;
  return 'it';
}

const SubscribePage: React.FC = () => {
  const { locale } = useTranslation();
  const { navigateTo } = useNavigation();
  const { user, loading, signIn } = useAuth();
  const copy = COPY[normalizeLocale(locale)];

  const [entitlementActive, setEntitlementActive] = useState<boolean>(() =>
    hasActiveReaderNoAdsEntitlement(),
  );
  useEffect(() => onReaderEntitlementChange(setEntitlementActive), []);

  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [portalBusy, setPortalBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleSubscribe = async () => {
    if (!user || checkoutBusy) return;
    setCheckoutBusy(true);
    setErrorMsg(null);
    Analytics.trackUIInteraction('reader_subscription', 'subscribe_page', 'checkout', 'click');
    try {
      const idToken = await user.getIdToken();
      const res = await fetch(READER_CHECKOUT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({
          successUrl: `${window.location.origin}${window.location.pathname}`,
          cancelUrl: window.location.href,
          posthogDistinctId: getDistinctId(),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        url?: string;
        alreadyActive?: boolean;
      };
      if (data.ok && data.url) {
        window.location.assign(data.url);
        return;
      }
      if (data.ok && data.alreadyActive) {
        setCheckoutBusy(false);
        return;
      }
      throw new Error('reader_checkout_failed');
    } catch (error) {
      reportCaughtError(error, 'subscribePage.checkout');
      Analytics.trackUIInteraction('reader_subscription', 'subscribe_page', 'checkout', 'error');
      setErrorMsg(copy.errorGeneric);
      setCheckoutBusy(false);
    }
  };

  const handleManageSubscription = async () => {
    if (!user || portalBusy) return;
    setPortalBusy(true);
    setErrorMsg(null);
    Analytics.trackUIInteraction('reader_subscription', 'subscribe_page', 'billing_portal', 'click');
    try {
      const idToken = await user.getIdToken();
      const res = await fetch(READER_BILLING_PORTAL_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ returnUrl: window.location.href }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; url?: string };
      if (data.ok && data.url) {
        window.location.assign(data.url);
        return;
      }
      throw new Error('reader_billing_portal_failed');
    } catch (error) {
      reportCaughtError(error, 'subscribePage.billingPortal');
      Analytics.trackUIInteraction('reader_subscription', 'subscribe_page', 'billing_portal', 'error');
      setErrorMsg(copy.errorGeneric);
      setPortalBusy(false);
    }
  };

  return (
    <div className="max-w-xl mx-auto px-4 py-16 text-center">
      <div className="mb-4 flex items-center justify-center gap-2 text-info">
        <Sparkles className="h-7 w-7" aria-hidden="true" />
      </div>
      <h1 className="text-2xl font-semibold text-heading mb-3">{copy.title}</h1>
      <p className="text-body mb-2">{copy.subtitle}</p>
      <p className="text-xl font-bold text-heading mb-6">{copy.price}</p>

      <ul className="text-left text-sm text-body mb-8 space-y-2 mx-auto max-w-sm">
        {copy.bullets.map((bullet, i) => (
          <li key={i} className="flex items-start gap-2">
            <ShieldCheck className="h-4 w-4 mt-0.5 shrink-0 text-info" aria-hidden="true" />
            <span>{bullet}</span>
          </li>
        ))}
      </ul>

      {!loading && !user && (
        <div className="mb-8">
          <p className="text-sm text-muted mb-4">{copy.signInPrompt}</p>
          <button
            type="button"
            onClick={() => { void signIn(); }}
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-on-accent hover:bg-accent-hover"
          >
            <LogIn className="h-4 w-4" aria-hidden="true" />
            {copy.signInCta}
          </button>
        </div>
      )}

      {user && (
        <div className="mb-8">
          {entitlementActive && (
            <p className="text-sm text-success mb-4">{copy.activeNote}</p>
          )}
          <button
            type="button"
            onClick={entitlementActive ? handleManageSubscription : handleSubscribe}
            disabled={checkoutBusy || portalBusy}
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-on-accent hover:bg-accent-hover disabled:opacity-60"
          >
            {(checkoutBusy || portalBusy) && (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            )}
            {checkoutBusy || portalBusy
              ? copy.redirecting
              : entitlementActive
                ? copy.manageCta
                : copy.subscribeCta}
          </button>
          {!entitlementActive && (
            <p className="text-xs text-muted mt-3">{copy.cancelNote}</p>
          )}
          {errorMsg && <p className="text-sm text-danger mt-3">{errorMsg}</p>}
        </div>
      )}

      <button
        type="button"
        onClick={() => navigateTo('calculator')}
        className="inline-flex items-center gap-2 rounded-lg border border-edge px-4 py-2.5 text-sm font-semibold text-heading hover:bg-surface-alt"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        {copy.back}
      </button>
    </div>
  );
};

export default SubscribePage;
