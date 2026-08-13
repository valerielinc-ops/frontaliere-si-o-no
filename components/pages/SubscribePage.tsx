/**
 * SubscribePage — reader no-ads subscription (#3655, part 2/2 of #2961).
 *
 * Was a "coming soon" placeholder (#3654, part 1/2) reachable only via the
 * client-only AdBlockGate's `navigateTo('subscribe')` call — no nav entry,
 * no sitemap/locale-key registration, unreachable by crawlers structurally,
 * same as `admin`. That access path is unchanged; this file now renders the
 * real checkout / manage-subscription UI instead of a placeholder:
 *
 *   - signed-out visitor  → "Subscribe" goes straight to Stripe Checkout, no
 *                            sign-in wall (guest path — POST createReaderCheckout
 *                            without an Authorization header, see
 *                            functions/src/stripeReaderCore.js). Stripe
 *                            collects the email itself; on return, ?session_id
 *                            is exchanged via claimReaderCheckout for a
 *                            Firebase custom auth token so the payer gets
 *                            signed in automatically, no password. Signing in
 *                            first (Google/LinkedIn/email — same
 *                            SocialSignInButtons used by every other gate on
 *                            the site) is offered as a secondary option, for
 *                            visitors who already have an account and want
 *                            the subscription tied to it from the start.
 *   - signed-in, no active entitlement → "Subscribe" → POST createReaderCheckout
 *                            (with a Firebase ID token) → redirect to the
 *                            returned Stripe Checkout URL.
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
 *
 * Post-login return: no new plumbing needed. SocialSignInButtons' redirect
 * providers (LinkedIn, and Google's mobile fallback) already stash
 * `auth_redirect_path` in sessionStorage before leaving the page and restore
 * it generically in useAuth's init effect — landing back on /abbonamento/
 * with `user` set is the existing site-wide behavior, not new code here.
 */

import React, { useEffect, useState } from 'react';
import {
  ArrowLeft, Sparkles, ShieldCheck, Loader2, Check, ChevronDown,
  Zap, Ban, RefreshCw, Quote,
} from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { useNavigation } from '@/services/NavigationContext';
import { useAuth, signInWithCustomAuthToken } from '@/services/authService';
import { Analytics } from '@/services/analytics';
import { getDistinctId } from '@/services/posthog';
import { reportCaughtError } from '@/services/errorReporter';
import SocialSignInButtons from '@/components/shared/SocialSignInButtons';
import EmailInput from '@/components/shared/EmailInput';
import {
  hasActiveReaderNoAdsEntitlement,
  onReaderEntitlementChange,
} from '@/services/readerEntitlement';

const READER_CHECKOUT_ENDPOINT =
  'https://europe-west6-frontaliere-ticino.cloudfunctions.net/createReaderCheckout';
const READER_CLAIM_ENDPOINT =
  'https://europe-west6-frontaliere-ticino.cloudfunctions.net/claimReaderCheckout';
const READER_BILLING_PORTAL_ENDPOINT =
  'https://europe-west6-frontaliere-ticino.cloudfunctions.net/createReaderBillingPortal';

type PageLocale = 'it' | 'en' | 'de' | 'fr';

interface FaqItem {
  q: string;
  a: string;
}

interface SubscribeCopy {
  eyebrow: string;
  title: string;
  subtitle: string;
  price: string;
  priceNote: string;
  benefits: { icon: 'zap' | 'ban' | 'refresh'; title: string; body: string }[];
  socialProof: string;
  testimonial: string;
  testimonialAuthor: string;
  faq: FaqItem[];
  cancelNote: string;
  signInPrompt: string;
  emailLoginLabel: string;
  passwordLabel: string;
  emailLoginCta: string;
  emailLoginError: string;
  orDivider: string;
  subscribeCta: string;
  manageCta: string;
  activeNote: string;
  errorGeneric: string;
  redirecting: string;
  claiming: string;
  accountExists: string;
  back: string;
  ctaBannerTitle: string;
}

const COPY: Record<PageLocale, SubscribeCopy> = {
  it: {
    eyebrow: 'Abbonamento lettori',
    title: 'Basta pubblicità. Solo il sito.',
    subtitle: 'Un piccolo contributo mensile per navigare frontaliereticino.ch senza banner, video o interstitial — su ogni pagina, ogni volta.',
    price: 'CHF 2.99',
    priceNote: 'al mese, disdicibile quando vuoi',
    benefits: [
      { icon: 'zap', title: 'Zero pubblicità ovunque', body: 'Nessun banner, video o interstitial su tutto il sito — calcolatore, guide, offerte di lavoro, tutto.' },
      { icon: 'ban', title: 'Attivo all’istante', body: 'Il tuo account smette di vedere pubblicità nel momento stesso in cui il pagamento è confermato.' },
      { icon: 'refresh', title: 'Nessun vincolo', body: 'Disdici quando vuoi dal portale Stripe: l’addebito si ferma a fine periodo già pagato, senza penali.' },
    ],
    socialProof: 'Sostenuto da una community di oltre 2.500 frontalieri',
    testimonial: 'Uso il calcolatore ogni mese per il conguaglio: vale la pena pagare per non vedere più pubblicità mentre lo faccio.',
    testimonialAuthor: 'Frontaliere, Canton Ticino',
    faq: [
      { q: 'Cosa cambia esattamente dopo l’abbonamento?', a: 'Tutti i banner, i video pubblicitari e gli interstitial spariscono dal sito sul tuo account, su ogni pagina. Contenuti, calcolatori e dati restano identici — cambia solo l’assenza di pubblicità.' },
      { q: 'Posso disdire quando voglio?', a: 'Sì. Il pulsante "Gestisci abbonamento" apre il portale Stripe: puoi disdire in un clic, senza scrivere a nessuno. L’addebito si ferma a fine periodo già pagato.' },
      { q: 'Come pago?', a: 'Con carta di credito/debito tramite Stripe, lo stesso circuito di pagamento sicuro usato da migliaia di siti. Frontaliereticino.ch non vede né conserva mai i tuoi dati di pagamento.' },
      { q: 'L’abbonamento vale su più dispositivi?', a: 'Sì, è legato al tuo account, non al dispositivo: accedi con la stessa email/Google/LinkedIn su qualsiasi dispositivo e la pubblicità resterà disattivata.' },
    ],
    cancelNote: 'Disdici quando vuoi dal pulsante "Gestisci abbonamento" qui sotto: l’addebito si ferma al termine del periodo già pagato.',
    signInPrompt: 'Hai già un account? Accedi per ritrovare l’abbonamento su ogni dispositivo.',
    emailLoginLabel: 'La tua email',
    passwordLabel: 'Password',
    emailLoginCta: 'Accedi con email',
    emailLoginError: 'Email o password non corrette.',
    orDivider: 'oppure',
    subscribeCta: 'Abbonati a CHF 2.99/mese',
    manageCta: 'Gestisci abbonamento',
    activeNote: 'Il tuo abbonamento è attivo. Grazie per il supporto!',
    errorGeneric: 'Qualcosa è andato storto. Riprova tra poco.',
    redirecting: 'Reindirizzamento a Stripe…',
    claiming: 'Attivazione abbonamento in corso…',
    accountExists:
      'Hai già un account con questa email: il tuo abbonamento è stato attivato. Accedi qui sotto per vederlo.',
    back: 'Torna al sito',
    ctaBannerTitle: 'Pronto a navigare senza pubblicità?',
  },
  en: {
    eyebrow: 'Reader subscription',
    title: 'No more ads. Just the site.',
    subtitle: 'A small monthly contribution to browse frontaliereticino.ch without banners, video or interstitial ads — on every page, every time.',
    price: 'CHF 2.99',
    priceNote: 'per month, cancel anytime',
    benefits: [
      { icon: 'zap', title: 'Zero ads everywhere', body: 'No banners, video or interstitial ads anywhere on the site — calculator, guides, job listings, everything.' },
      { icon: 'ban', title: 'Active instantly', body: 'Your account stops seeing ads the moment payment is confirmed.' },
      { icon: 'refresh', title: 'No lock-in', body: 'Cancel anytime from Stripe’s portal: billing stops at the end of the period you already paid for, no penalties.' },
    ],
    socialProof: 'Backed by a community of 2,500+ cross-border workers',
    testimonial: 'I use the calculator every month for my tax reconciliation — worth paying to stop seeing ads while I do it.',
    testimonialAuthor: 'Cross-border worker, Ticino',
    faq: [
      { q: 'What exactly changes after subscribing?', a: 'Every banner, video ad and interstitial disappears from the site on your account, on every page. Content, calculators and data stay identical — only the ads go.' },
      { q: 'Can I cancel anytime?', a: 'Yes. The "Manage subscription" button opens Stripe’s portal: cancel in one click, no need to contact anyone. Billing stops at the end of the period you already paid for.' },
      { q: 'How do I pay?', a: 'By credit/debit card via Stripe, the same secure payment rail used by thousands of sites. Frontaliereticino.ch never sees or stores your payment details.' },
      { q: 'Does it work across devices?', a: 'Yes — it’s tied to your account, not the device. Sign in with the same email/Google/LinkedIn on any device and ads stay off.' },
    ],
    cancelNote: 'Cancel anytime with the "Manage subscription" button below: billing stops at the end of the period you already paid for.',
    signInPrompt: 'Already have an account? Sign in to keep your subscription in sync across devices.',
    emailLoginLabel: 'Your email',
    passwordLabel: 'Password',
    emailLoginCta: 'Sign in with email',
    emailLoginError: 'Incorrect email or password.',
    orDivider: 'or',
    subscribeCta: 'Subscribe for CHF 2.99/month',
    manageCta: 'Manage subscription',
    activeNote: 'Your subscription is active. Thank you for your support!',
    errorGeneric: 'Something went wrong. Please try again shortly.',
    redirecting: 'Redirecting to Stripe…',
    claiming: 'Activating your subscription…',
    accountExists: 'You already have an account with this email — your subscription is active. Sign in below to see it.',
    back: 'Back to the site',
    ctaBannerTitle: 'Ready to browse ad-free?',
  },
  de: {
    eyebrow: 'Leser-Abonnement',
    title: 'Keine Werbung mehr. Nur die Seite.',
    subtitle: 'Ein kleiner monatlicher Beitrag, um frontaliereticino.ch ohne Banner, Video- oder Interstitial-Werbung zu nutzen — auf jeder Seite, jedes Mal.',
    price: 'CHF 2.99',
    priceNote: 'pro Monat, jederzeit kündbar',
    benefits: [
      { icon: 'zap', title: 'Überall werbefrei', body: 'Keine Banner, Video- oder Interstitial-Werbung auf der gesamten Website — Rechner, Ratgeber, Stellenangebote, alles.' },
      { icon: 'ban', title: 'Sofort aktiv', body: 'Ihr Konto sieht ab dem Moment der Zahlungsbestätigung keine Werbung mehr.' },
      { icon: 'refresh', title: 'Keine Mindestlaufzeit', body: 'Jederzeit über das Stripe-Portal kündbar: die Abbuchung endet am Ende des bereits bezahlten Zeitraums, ohne Strafgebühren.' },
    ],
    socialProof: 'Unterstützt von einer Community von über 2.500 Grenzgängern',
    testimonial: 'Ich nutze den Rechner jeden Monat für meinen Lohnausgleich — es lohnt sich, dafür keine Werbung mehr zu sehen.',
    testimonialAuthor: 'Grenzgänger, Kanton Tessin',
    faq: [
      { q: 'Was ändert sich genau nach dem Abo?', a: 'Jeder Banner, jede Videowerbung und jedes Interstitial verschwindet auf Ihrem Konto von der gesamten Website, auf jeder Seite. Inhalte, Rechner und Daten bleiben identisch — nur die Werbung fällt weg.' },
      { q: 'Kann ich jederzeit kündigen?', a: 'Ja. Die Schaltfläche „Abonnement verwalten“ öffnet das Stripe-Portal: Kündigung mit einem Klick, ohne jemanden kontaktieren zu müssen. Die Abbuchung endet am Ende des bereits bezahlten Zeitraums.' },
      { q: 'Wie bezahle ich?', a: 'Per Kredit-/Debitkarte über Stripe, dieselbe sichere Zahlungsschiene, die Tausende von Websites nutzen. Frontaliereticino.ch sieht oder speichert Ihre Zahlungsdaten nie.' },
      { q: 'Gilt das Abo auf mehreren Geräten?', a: 'Ja, es ist an Ihr Konto gebunden, nicht an das Gerät: melden Sie sich mit derselben E-Mail/Google/LinkedIn auf jedem Gerät an, und die Werbung bleibt deaktiviert.' },
    ],
    cancelNote: 'Kündigen Sie jederzeit über die Schaltfläche „Abonnement verwalten“ unten: die Abbuchung endet am Ende des bereits bezahlten Zeitraums.',
    signInPrompt: 'Sie haben bereits ein Konto? Melden Sie sich an, um Ihr Abo geräteübergreifend zu nutzen.',
    emailLoginLabel: 'Ihre E-Mail',
    passwordLabel: 'Passwort',
    emailLoginCta: 'Mit E-Mail anmelden',
    emailLoginError: 'E-Mail oder Passwort falsch.',
    orDivider: 'oder',
    subscribeCta: 'Für CHF 2.99/Monat abonnieren',
    manageCta: 'Abonnement verwalten',
    activeNote: 'Ihr Abonnement ist aktiv. Vielen Dank für Ihre Unterstützung!',
    errorGeneric: 'Etwas ist schiefgelaufen. Bitte versuchen Sie es in Kürze erneut.',
    redirecting: 'Weiterleitung zu Stripe…',
    claiming: 'Abonnement wird aktiviert…',
    accountExists:
      'Für diese E-Mail existiert bereits ein Konto — dein Abonnement ist aktiv. Melde dich unten an, um es zu sehen.',
    back: 'Zurück zur Website',
    ctaBannerTitle: 'Bereit, werbefrei zu surfen?',
  },
  fr: {
    eyebrow: 'Abonnement lecteur',
    title: 'Plus de publicité. Juste le site.',
    subtitle: 'Une petite contribution mensuelle pour naviguer sur frontaliereticino.ch sans bannières, vidéos ou publicités interstitielles — sur chaque page, à chaque fois.',
    price: 'CHF 2.99',
    priceNote: 'par mois, résiliable à tout moment',
    benefits: [
      { icon: 'zap', title: 'Zéro publicité partout', body: 'Aucune bannière, vidéo ou publicité interstitielle sur tout le site — calculateur, guides, offres d’emploi, tout.' },
      { icon: 'ban', title: 'Actif instantanément', body: 'Votre compte cesse de voir de la publicité dès que le paiement est confirmé.' },
      { icon: 'refresh', title: 'Aucun engagement', body: 'Résiliable à tout moment depuis le portail Stripe : le prélèvement s’arrête à la fin de la période déjà payée, sans pénalité.' },
    ],
    socialProof: 'Soutenu par une communauté de plus de 2 500 frontaliers',
    testimonial: 'J’utilise le calculateur chaque mois pour ma régularisation fiscale — ça vaut le coup de payer pour ne plus voir de pub en le faisant.',
    testimonialAuthor: 'Frontalier, Tessin',
    faq: [
      { q: 'Qu’est-ce qui change exactement après l’abonnement ?', a: 'Toutes les bannières, publicités vidéo et interstitiels disparaissent du site sur votre compte, sur chaque page. Contenus, calculateurs et données restent identiques — seule la publicité disparaît.' },
      { q: 'Puis-je résilier à tout moment ?', a: 'Oui. Le bouton « Gérer l’abonnement » ouvre le portail Stripe : résiliez en un clic, sans contacter personne. Le prélèvement s’arrête à la fin de la période déjà payée.' },
      { q: 'Comment je paie ?', a: 'Par carte de crédit/débit via Stripe, le même circuit de paiement sécurisé utilisé par des milliers de sites. Frontaliereticino.ch ne voit ni ne conserve jamais vos données de paiement.' },
      { q: 'L’abonnement fonctionne-t-il sur plusieurs appareils ?', a: 'Oui, il est lié à votre compte, pas à l’appareil : connectez-vous avec le même email/Google/LinkedIn sur n’importe quel appareil et la publicité restera désactivée.' },
    ],
    cancelNote: 'Résiliez à tout moment avec le bouton « Gérer l’abonnement » ci-dessous : le prélèvement s’arrête à la fin de la période déjà payée.',
    signInPrompt: 'Vous avez déjà un compte ? Connectez-vous pour retrouver votre abonnement sur tous vos appareils.',
    emailLoginLabel: 'Votre email',
    passwordLabel: 'Mot de passe',
    emailLoginCta: 'Se connecter par email',
    emailLoginError: 'Email ou mot de passe incorrect.',
    orDivider: 'ou',
    subscribeCta: 'S’abonner pour CHF 2.99/mois',
    manageCta: 'Gérer l’abonnement',
    activeNote: 'Votre abonnement est actif. Merci pour votre soutien !',
    errorGeneric: 'Une erreur est survenue. Veuillez réessayer sous peu.',
    redirecting: 'Redirection vers Stripe…',
    claiming: 'Activation de l’abonnement en cours…',
    accountExists:
      'Un compte existe déjà avec cet e-mail — votre abonnement est actif. Connectez-vous ci-dessous pour le voir.',
    back: 'Retour au site',
    ctaBannerTitle: 'Prêt à naviguer sans publicité ?',
  },
};

function normalizeLocale(code?: string | null): PageLocale {
  const raw = String(code || 'it').toLowerCase().slice(0, 2);
  if (raw === 'en' || raw === 'de' || raw === 'fr') return raw;
  return 'it';
}

const BENEFIT_ICONS = { zap: Zap, ban: Ban, refresh: RefreshCw } as const;

interface RevealProps {
  children: React.ReactNode;
  className?: string;
}

/** Scroll-triggered fade+rise, respects prefers-reduced-motion via CSS (see .scroll-reveal in index.css). */
const Reveal: React.FC<RevealProps> = ({ children, className = '' }) => {
  const ref = React.useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setVisible(true); observer.disconnect(); } },
      { threshold: 0.15 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} className={`scroll-reveal ${visible ? 'scroll-reveal-visible' : ''} ${className}`}>
      {children}
    </div>
  );
};

const SubscribePage: React.FC = () => {
  const { locale } = useTranslation();
  const { navigateTo } = useNavigation();
  const { user, loading, signInEmail } = useAuth();
  const copy = COPY[normalizeLocale(locale)];

  const [entitlementActive, setEntitlementActive] = useState<boolean>(() =>
    hasActiveReaderNoAdsEntitlement(),
  );
  useEffect(() => onReaderEntitlementChange(setEntitlementActive), []);

  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [portalBusy, setPortalBusy] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [openFaq, setOpenFaq] = useState<number | null>(0);

  const [emailValue, setEmailValue] = useState('');
  const [passwordValue, setPasswordValue] = useState('');
  const [emailLoginBusy, setEmailLoginBusy] = useState(false);
  const [emailLoginError, setEmailLoginError] = useState<string | null>(null);

  // Post-payment reconciliation for the guest checkout path below: Stripe
  // redirects back here with ?session_id=... (only for guest sessions — see
  // handleCreateReaderCheckout's success_url templating). Exchange it for a
  // Firebase custom auth token via claimReaderCheckout and sign in — same
  // signInWithCustomAuthToken() the LinkedIn/newsletter autologin flows use.
  useEffect(() => {
    if (loading || user) return;
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get('session_id');
    if (!sessionId) return;

    const url = new URL(window.location.href);
    url.searchParams.delete('session_id');
    window.history.replaceState({}, '', url.toString());

    let cancelled = false;
    (async () => {
      setClaiming(true);
      setErrorMsg(null);
      try {
        const res = await fetch(READER_CLAIM_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        });
        const data = (await res.json().catch(() => ({}))) as { ok?: boolean; authToken?: string; error?: string };
        if (cancelled) return;
        if (data.error === 'account_exists') {
          // The email already belongs to an existing account — the webhook
          // already attached the entitlement to it, but we deliberately
          // never auto-sign-in to an account we didn't just create (see
          // functions/src/stripeReaderCore.js:handleClaimReaderCheckout).
          Analytics.trackUIInteraction('reader_subscription', 'subscribe_page', 'claim', 'account_exists');
          setErrorMsg(copy.accountExists);
          return;
        }
        if (!data.ok || !data.authToken) throw new Error('reader_claim_failed');
        await signInWithCustomAuthToken(data.authToken);
        Analytics.trackUIInteraction('reader_subscription', 'subscribe_page', 'claim', 'success');
      } catch (error) {
        if (cancelled) return;
        reportCaughtError(error, 'subscribePage.claimCheckout');
        Analytics.trackUIInteraction('reader_subscription', 'subscribe_page', 'claim', 'error');
        setErrorMsg(copy.errorGeneric);
      } finally {
        if (!cancelled) setClaiming(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loading, user, copy.errorGeneric, copy.accountExists]);

  const handleSubscribe = async () => {
    if (checkoutBusy) return;
    setCheckoutBusy(true);
    setErrorMsg(null);
    Analytics.trackUIInteraction('reader_subscription', 'subscribe_page', 'checkout', 'click');
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (user) {
        const idToken = await user.getIdToken();
        headers.Authorization = `Bearer ${idToken}`;
      }
      const res = await fetch(READER_CHECKOUT_ENDPOINT, {
        method: 'POST',
        headers,
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

  const handleEmailLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (emailLoginBusy || !emailValue || !passwordValue) return;
    setEmailLoginBusy(true);
    setEmailLoginError(null);
    try {
      const loggedInUser = await signInEmail(emailValue, passwordValue);
      if (!loggedInUser) setEmailLoginError(copy.emailLoginError);
    } catch (error) {
      reportCaughtError(error, 'subscribePage.emailLogin');
      setEmailLoginError(copy.emailLoginError);
    } finally {
      setEmailLoginBusy(false);
    }
  };

  const scrollToCheckout = () => {
    document.getElementById('subscribe-checkout')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  return (
    <div className="bg-surface-inverted">
      {/* Hero */}
      <section className="relative overflow-hidden px-4 pb-14 pt-16 sm:pb-20 sm:pt-24">
        <div className="pointer-events-none absolute -top-32 left-1/2 h-72 w-72 -translate-x-1/2 rounded-full bg-accent/25 blur-3xl" aria-hidden="true" />
        <div className="relative mx-auto max-w-2xl text-center">
          <button
            type="button"
            onClick={() => navigateTo('calculator')}
            className="mb-8 inline-flex items-center gap-2 rounded-full border border-white/15 px-3 py-1.5 text-xs font-medium text-on-accent/70 transition hover:bg-white/5 hover:text-on-accent"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            {copy.back}
          </button>

          <span className="mb-4 inline-flex items-center gap-1.5 rounded-full bg-accent/15 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-accent-hover">
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
            {copy.eyebrow}
          </span>

          <h1 className="mb-4 text-3xl font-extrabold leading-tight text-on-accent sm:text-5xl">
            {copy.title}
          </h1>
          <p className="mx-auto mb-8 max-w-lg text-base text-on-accent/80 sm:text-lg">
            {copy.subtitle}
          </p>

          <div className="mb-3 flex items-baseline justify-center gap-2">
            <span className="text-4xl font-extrabold text-on-accent sm:text-5xl">{copy.price}</span>
          </div>
          <p className="mb-8 text-sm text-on-accent/60">{copy.priceNote}</p>

          <button
            type="button"
            onClick={scrollToCheckout}
            className="cta-sheen animate-cta-pulse inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-accent to-accent-hover px-8 py-4 text-base font-bold text-on-accent shadow-lg transition hover:brightness-110 sm:w-auto"
          >
            <Sparkles className="h-5 w-5" aria-hidden="true" />
            {copy.subscribeCta}
          </button>

          <p className="mt-4 text-xs text-on-accent/50">{copy.socialProof}</p>
        </div>
      </section>

      {/* Benefits */}
      <section className="px-4 py-14 sm:py-20">
        <div className="mx-auto max-w-4xl">
          <Reveal className="grid gap-5 sm:grid-cols-3">
            {copy.benefits.map((benefit) => {
              const Icon = BENEFIT_ICONS[benefit.icon];
              return (
                <div key={benefit.title} className="rounded-2xl border border-white/10 bg-white/5 p-6">
                  <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-accent/20">
                    <Icon className="h-5 w-5 text-accent-hover" aria-hidden="true" />
                  </div>
                  <h3 className="mb-2 text-base font-bold text-on-accent">{benefit.title}</h3>
                  <p className="text-sm leading-relaxed text-on-accent/70">{benefit.body}</p>
                </div>
              );
            })}
          </Reveal>
        </div>
      </section>

      {/* Testimonial / social proof */}
      <section className="px-4 pb-14 sm:pb-20">
        <Reveal className="mx-auto max-w-2xl rounded-2xl border border-white/10 bg-white/5 p-8 text-center">
          <Quote className="mx-auto mb-4 h-6 w-6 text-accent-hover" aria-hidden="true" />
          <p className="mb-4 text-lg font-medium leading-relaxed text-on-accent">“{copy.testimonial}”</p>
          <p className="text-sm text-on-accent/60">{copy.testimonialAuthor}</p>
        </Reveal>
      </section>

      {/* Checkout / sign-in */}
      <section id="subscribe-checkout" className="px-4 pb-14 sm:pb-20">
        <Reveal className="mx-auto max-w-md rounded-2xl border border-white/10 bg-white/5 p-6 sm:p-8">
          {!loading && !user && claiming && (
            <div className="flex items-center justify-center gap-2 py-4 text-center text-sm text-on-accent/75">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              {copy.claiming}
            </div>
          )}

          {!loading && !user && !claiming && (
            <div>
              <div className="text-center">
                <button
                  type="button"
                  onClick={handleSubscribe}
                  disabled={checkoutBusy}
                  className="cta-sheen inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-accent to-accent-hover px-6 py-3.5 text-sm font-bold text-on-accent shadow-lg transition hover:brightness-110 disabled:opacity-60"
                >
                  {checkoutBusy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                  {checkoutBusy ? copy.redirecting : copy.subscribeCta}
                </button>
                <p className="mt-3 text-xs text-on-accent/50">{copy.cancelNote}</p>
                {errorMsg && <p className="mt-3 text-sm text-danger">{errorMsg}</p>}
              </div>

              <div className="my-5 flex items-center gap-3">
                <div className="h-px flex-1 bg-white/10" aria-hidden="true" />
                <span className="text-xs uppercase tracking-wide text-on-accent/40">{copy.orDivider}</span>
                <div className="h-px flex-1 bg-white/10" aria-hidden="true" />
              </div>

              <p className="mb-5 text-center text-sm text-on-accent/75">{copy.signInPrompt}</p>
              {/* No consent notice here, and it is a declared gap rather than an
                  oversight (#5739): signing in from this page subscribes the
                  visitor, but the write happens in App.tsx's auth listener under
                  `signInAutoSubscribe` — an Italian-only, `displayed: false`
                  formula. Rendering any of the shown formulas beside these
                  buttons would put one sentence on screen and keep another in
                  the document. See the header of SocialSignInButtons.tsx and the
                  `SIGN_IN_SURFACES` table in
                  tests/consent-shown-at-signup.test.tsx, which lists this page. */}
              <SocialSignInButtons locale={locale} errorContext="subscribePage" googleWidth={320} />

              <div className="my-5 flex items-center gap-3">
                <div className="h-px flex-1 bg-white/10" aria-hidden="true" />
                <span className="text-xs uppercase tracking-wide text-on-accent/40">{copy.orDivider}</span>
                <div className="h-px flex-1 bg-white/10" aria-hidden="true" />
              </div>

              <form onSubmit={handleEmailLogin} className="flex flex-col gap-3">
                <EmailInput
                  value={emailValue}
                  onChange={setEmailValue}
                  ariaLabel={copy.emailLoginLabel}
                  required
                  darkVariant
                />
                <input
                  type="password"
                  value={passwordValue}
                  onChange={(e) => setPasswordValue(e.target.value)}
                  placeholder={copy.passwordLabel}
                  aria-label={copy.passwordLabel}
                  required
                  className="w-full rounded-lg border border-white/15 bg-white/5 px-4 py-2.5 text-sm text-on-accent placeholder:text-on-accent/40 focus:border-accent focus:outline-none"
                />
                {emailLoginError && <p className="text-sm text-danger">{emailLoginError}</p>}
                <button
                  type="submit"
                  disabled={emailLoginBusy}
                  className="inline-flex items-center justify-center gap-2 rounded-lg border border-white/15 px-5 py-2.5 text-sm font-semibold text-on-accent transition hover:bg-white/5 disabled:opacity-60"
                >
                  {emailLoginBusy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                  {copy.emailLoginCta}
                </button>
              </form>
            </div>
          )}

          {user && (
            <div className="text-center">
              {entitlementActive && (
                <p className="mb-4 flex items-center justify-center gap-2 text-sm font-medium text-success">
                  <Check className="h-4 w-4" aria-hidden="true" />
                  {copy.activeNote}
                </p>
              )}
              <button
                type="button"
                onClick={entitlementActive ? handleManageSubscription : handleSubscribe}
                disabled={checkoutBusy || portalBusy}
                className="cta-sheen inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-accent to-accent-hover px-6 py-3.5 text-sm font-bold text-on-accent shadow-lg transition hover:brightness-110 disabled:opacity-60"
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
                <p className="mt-3 text-xs text-on-accent/50">{copy.cancelNote}</p>
              )}
              {errorMsg && <p className="mt-3 text-sm text-danger">{errorMsg}</p>}
            </div>
          )}
        </Reveal>
      </section>

      {/* FAQ */}
      <section className="px-4 pb-14 sm:pb-20">
        <Reveal className="mx-auto max-w-2xl">
          <div className="flex flex-col divide-y divide-white/10 rounded-2xl border border-white/10 bg-white/5">
            {copy.faq.map((item, i) => {
              const isOpen = openFaq === i;
              return (
                <div key={item.q}>
                  <button
                    type="button"
                    onClick={() => setOpenFaq(isOpen ? null : i)}
                    aria-expanded={isOpen}
                    className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left text-sm font-semibold text-on-accent"
                  >
                    {item.q}
                    <ChevronDown
                      className={`h-4 w-4 shrink-0 text-on-accent/50 transition-transform ${isOpen ? 'rotate-180' : ''}`}
                      aria-hidden="true"
                    />
                  </button>
                  {isOpen && (
                    <p className="px-5 pb-4 text-sm leading-relaxed text-on-accent/70">{item.a}</p>
                  )}
                </div>
              );
            })}
          </div>
        </Reveal>
      </section>

      {/* Repeated final CTA */}
      <section className="px-4 pb-16 sm:pb-24">
        <Reveal className="mx-auto max-w-2xl rounded-2xl border border-white/10 bg-gradient-to-br from-accent/20 to-transparent p-8 text-center">
          <h2 className="mb-5 text-xl font-bold text-on-accent sm:text-2xl">{copy.ctaBannerTitle}</h2>
          <button
            type="button"
            onClick={scrollToCheckout}
            className="cta-sheen inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-accent to-accent-hover px-8 py-3.5 text-base font-bold text-on-accent shadow-lg transition hover:brightness-110"
          >
            <Sparkles className="h-5 w-5" aria-hidden="true" />
            {copy.subscribeCta}
          </button>
        </Reveal>
      </section>
    </div>
  );
};

export default SubscribePage;
