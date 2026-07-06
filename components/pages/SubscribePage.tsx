/**
 * SubscribePage — placeholder CTA target for the AdBlockGate subscribe
 * option (#3654, part 1/2 of #2961).
 *
 * Hidden route (mirrors the `admin` tab precedent): no nav entry, no
 * sitemap/locale-key registration — it exists only as somewhere the gate's
 * "subscribe" button can navigate to, since the real Stripe checkout flow
 * is issue 2/2 and not built yet. No internal link on the site points here
 * except the client-only AdBlockGate's `navigateTo('subscribe')` call, so
 * it is unreachable by crawlers structurally, same as `admin`.
 *
 * Self-contained per-locale copy (not the services/locales chunk system) —
 * same pattern as OfferwallNewsletterGate/AdBlockGate, since this page has
 * no SEO/indexing purpose that would justify the i18n-key machinery.
 */

import React from 'react';
import { ArrowLeft, Sparkles } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { useNavigation } from '@/services/NavigationContext';

type PageLocale = 'it' | 'en' | 'de' | 'fr';

const COPY: Record<PageLocale, {
  title: string;
  body: string;
  comingSoon: string;
  back: string;
}> = {
  it: {
    title: 'Abbonamento senza pubblicità',
    body: 'Stiamo preparando un abbonamento che rimuove tutta la pubblicità dal sito. Questa pagina è un segnaposto: il pagamento non è ancora attivo.',
    comingSoon: 'In arrivo a breve.',
    back: 'Torna al sito',
  },
  en: {
    title: 'Ad-free subscription',
    body: 'We are preparing a subscription that removes all advertising from the site. This page is a placeholder: payment is not live yet.',
    comingSoon: 'Coming soon.',
    back: 'Back to the site',
  },
  de: {
    title: 'Werbefreies Abonnement',
    body: 'Wir bereiten ein Abonnement vor, das jede Werbung von der Website entfernt. Diese Seite ist ein Platzhalter: die Zahlung ist noch nicht aktiv.',
    comingSoon: 'Demnächst verfügbar.',
    back: 'Zurück zur Website',
  },
  fr: {
    title: 'Abonnement sans publicité',
    body: 'Nous préparons un abonnement qui supprime toute publicité du site. Cette page est un espace réservé : le paiement n’est pas encore actif.',
    comingSoon: 'Bientôt disponible.',
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
  const copy = COPY[normalizeLocale(locale)];

  return (
    <div className="max-w-xl mx-auto px-4 py-16 text-center">
      <div className="mb-4 flex items-center justify-center gap-2 text-info">
        <Sparkles className="h-7 w-7" aria-hidden="true" />
      </div>
      <h1 className="text-2xl font-semibold text-heading mb-3">{copy.title}</h1>
      <p className="text-body mb-2">{copy.body}</p>
      <p className="text-sm text-muted mb-8">{copy.comingSoon}</p>
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
