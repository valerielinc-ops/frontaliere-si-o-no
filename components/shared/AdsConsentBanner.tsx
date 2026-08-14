/**
 * AdsConsentBanner — opt-in prompt for ADVERTISING scripts only (#5842).
 *
 * Scope is deliberately narrow, per the owner decision in #5842:
 *   - asks about Auto Ads / AdSense / GPT only;
 *   - says nothing about GA4, PostHog or Clarity, which stay covered by the
 *     honest disclosure shipped in #5832 and are NOT gated.
 * Do not turn this into a generic cookie banner without a new decision — the
 * previous one was removed on purpose (see the note in App.tsx).
 *
 * CLS: rendered as a `fixed` overlay, so it is out of document flow and cannot
 * shift the article body or any ad placeholder. It sits above the mobile tab
 * bar (`z-50`) at `z-[60]`, and reserves the mobile bar's height via padding so
 * it never covers navigation.
 *
 * The component renders `null` once a decision exists, so it appears exactly
 * once per visitor and never re-enters the layout on later page views.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from '@/services/i18n';
import { trackAdEvent } from '@/services/adAnalytics';
import {
  grantAdsConsent,
  denyAdsConsent,
  needsAdsConsentDecision,
  onAdsConsentChange,
} from '@/services/adsConsent';

type Copy = {
  title: string;
  body: string;
  accept: string;
  decline: string;
  privacy: string;
};

// Inlined rather than routed through the locale JSON files: five strings across
// four locales, and the banner must render correctly on the very first paint of
// a cold visit — before `ensureLocaleLoaded()` has resolved. A missing async
// translation would otherwise show the key, or Italian, to a German reader at
// the exact moment they are being asked to decide.
const COPY: Record<string, Copy> = {
  it: {
    title: 'Pubblicità personalizzata',
    body: 'Usiamo Google AdSense per finanziare il sito. Possiamo caricare gli script pubblicitari? Senza il tuo consenso il sito funziona lo stesso, solo senza annunci.',
    accept: 'Accetta gli annunci',
    decline: 'Continua senza annunci',
    privacy: 'Informativa privacy',
  },
  en: {
    title: 'Personalised advertising',
    body: 'We use Google AdSense to fund the site. May we load the advertising scripts? Without your consent the site works exactly the same, just without ads.',
    accept: 'Accept ads',
    decline: 'Continue without ads',
    privacy: 'Privacy policy',
  },
  de: {
    title: 'Personalisierte Werbung',
    body: 'Wir nutzen Google AdSense zur Finanzierung der Website. Dürfen wir die Werbeskripte laden? Ohne Ihre Zustimmung funktioniert die Website genauso, nur ohne Werbung.',
    accept: 'Werbung akzeptieren',
    decline: 'Ohne Werbung fortfahren',
    privacy: 'Datenschutzerklärung',
  },
  fr: {
    title: 'Publicité personnalisée',
    body: 'Nous utilisons Google AdSense pour financer le site. Pouvons-nous charger les scripts publicitaires ? Sans votre consentement, le site fonctionne de la même façon, simplement sans publicité.',
    accept: 'Accepter les publicités',
    decline: 'Continuer sans publicité',
    privacy: 'Politique de confidentialité',
  },
};

export default function AdsConsentBanner() {
  const { locale } = useTranslation();
  // Start hidden and decide in an effect: `needsAdsConsentDecision()` touches
  // localStorage, which is not available during SSR/prerender. Reading it in
  // the initial render would make the prerendered HTML disagree with the
  // hydrated tree and produce a hydration mismatch on every static page.
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    setVisible(needsAdsConsentDecision());
    // Another tab may answer while this one is open — hide in lockstep.
    return onAdsConsentChange((value) => setVisible(value === null));
  }, []);

  useEffect(() => {
    if (visible) trackAdEvent('ad_consent_shown', { slot: 'consent_banner', format: 'banner' });
  }, [visible]);

  const accept = useCallback(() => {
    grantAdsConsent();
    trackAdEvent('ad_consent_granted', { slot: 'consent_banner', format: 'banner' });
    setVisible(false);
  }, []);

  const decline = useCallback(() => {
    denyAdsConsent();
    trackAdEvent('ad_consent_denied', { slot: 'consent_banner', format: 'banner' });
    setVisible(false);
  }, []);

  if (!visible) return null;
  const copy = COPY[locale] ?? COPY.it;

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby="ads-consent-title"
      className="fixed inset-x-0 bottom-0 z-[60] border-t border-edge/50 bg-surface/98 backdrop-blur px-4 py-4 pb-[calc(env(safe-area-inset-bottom,0px)+4.5rem)] md:pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] shadow-[0_-4px_16px_rgba(0,0,0,0.12)]"
    >
      <div className="mx-auto flex max-w-4xl flex-col gap-3 sm:flex-row sm:items-center sm:gap-6">
        <div className="min-w-0 flex-1">
          <p id="ads-consent-title" className="text-sm font-semibold">
            {copy.title}
          </p>
          <p className="mt-1 text-sm opacity-80">
            {copy.body}{' '}
            <a href="/privacy" className="underline underline-offset-2">
              {copy.privacy}
            </a>
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={decline}
            className="min-h-[44px] rounded-lg border border-edge/60 px-4 text-sm font-medium"
          >
            {copy.decline}
          </button>
          <button
            type="button"
            onClick={accept}
            className="min-h-[44px] rounded-lg bg-accent px-4 text-sm font-semibold text-white"
          >
            {copy.accept}
          </button>
        </div>
      </div>
    </div>
  );
}
