/**
 * CommunicationsConsentBanner — the consent-banner slot's second panel
 * (#5842, owner direction of 2026-08-15): collect OUR communications consent
 * from a visitor the SPA can already name, once per device, with the refusal
 * falling back to the activation/subscription acts that already record proof
 * (#5902).
 *
 * WHY A SECOND PANEL AND NOT A SECTION INSIDE `AdsConsentBanner`
 * --------------------------------------------------------------
 * Two measured facts forbid the single-dialog version:
 *  - identity is NEVER known on the first paint: `useAuth` starts at idle (for
 *    LCP) and the `ac → custom token` exchange of an email arrival is async.
 *    A combined dialog would render its communications half empty and grow it
 *    under the visitor's finger;
 *  - the ads dialog's lifecycle is pinned by `tests/ads-consent-gate.test.tsx`
 *    — it disappears on the first answer and never returns. Holding it open
 *    for a second question would break that contract and slow the two-tap ads
 *    decision.
 * Same slot, strictly sequential instead: this panel never renders while the
 * ads decision is pending, so the two are never on screen together.
 *
 * WHEN IT SHOWS — every condition, and each is load-bearing:
 *  - `email` resolved (an anonymous visitor has no document to consent for);
 *  - the ads decision exists (ads panel has priority in the slot);
 *  - no answer stored on this device (once per device, either answer retires
 *    it — a consent prompt that returns on people who closed it is the
 *    invasiveness #5876 was trimmed to avoid);
 *  - the subscriber document EXISTS, carries NO proof and NO binding opt-out
 *    (`shouldOfferCommunicationsConsent`, fail-closed: a read failure means no
 *    banner, for the same reason the write path aborts).
 *
 * The formula on screen is `<ConsentNotice consentKey="communicationsOptIn">`
 * — the same function that produces the stored bytes, so what was shown and
 * what was recorded cannot drift. Accepting stamps the newsletter document
 * (`recordCommunicationsConsent`) and the travaso alerts
 * (`upgradeBackfilledAlertConsent` with this surface's own act — recording an
 * activation click that did not happen would fabricate the fact the register
 * exists to establish). Declining writes NOTHING: "not now" is not an opt-out,
 * and the organic surfaces remain.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from '@/services/i18n';
import ConsentNotice from '@/components/shared/ConsentNotice';
import { captureEvent } from '@/services/posthog';
import { needsAdsConsentDecision, onAdsConsentChange } from '@/services/adsConsent';
import { upgradeBackfilledAlertConsent } from '@/services/jobAlertService';
import {
  COMMS_CONSENT_PROMPT_STORAGE_KEY,
  COMMUNICATIONS_BANNER_CONSENT_ACT,
  recordCommunicationsConsent,
  shouldOfferCommunicationsConsent,
} from '@/services/newsletterConsentUpgrade';

type Copy = {
  title: string;
  body: string;
  accept: string;
  decline: string;
  thanks: string;
};

// Inlined for the same reason as AdsConsentBanner's copy: five strings across
// four locales, and the panel must not show a translation key (or Italian, to
// a German reader) at the exact moment a consent decision is being asked.
const COPY: Record<string, Copy> = {
  it: {
    title: 'Le nostre email',
    body: 'Questo indirizzo risulta iscritto alle nostre comunicazioni. Confermi di volerle ricevere?',
    accept: 'Sì, confermo',
    decline: 'Non ora',
    thanks: 'Registrato. Puoi cambiare idea in ogni momento dal centro preferenze.',
  },
  en: {
    title: 'Our emails',
    body: 'This address is subscribed to our communications. Do you confirm you want to receive them?',
    accept: 'Yes, I confirm',
    decline: 'Not now',
    thanks: 'Recorded. You can change your mind any time from the preference centre.',
  },
  de: {
    title: 'Unsere E-Mails',
    body: 'Diese Adresse ist für unsere Mitteilungen eingetragen. Bestätigen Sie, dass Sie sie erhalten möchten?',
    accept: 'Ja, ich bestätige',
    decline: 'Jetzt nicht',
    thanks: 'Gespeichert. Sie können Ihre Wahl jederzeit im Präferenzcenter ändern.',
  },
  fr: {
    title: 'Nos e-mails',
    body: 'Cette adresse est inscrite à nos communications. Confirmez-vous vouloir les recevoir ?',
    accept: 'Oui, je confirme',
    decline: 'Pas maintenant',
    thanks: 'Enregistré. Vous pouvez changer d’avis à tout moment depuis le centre de préférences.',
  },
};

type PromptAnswer = 'accepted' | 'dismissed';

/** Never throws: a broken localStorage reads as "not answered". */
function readPromptAnswer(): PromptAnswer | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(COMMS_CONSENT_PROMPT_STORAGE_KEY);
    return raw === 'accepted' || raw === 'dismissed' ? raw : null;
  } catch {
    return null;
  }
}

function writePromptAnswer(value: PromptAnswer): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(COMMS_CONSENT_PROMPT_STORAGE_KEY, value);
  } catch {
    /* quota / private mode — this visit still behaves as answered via state. */
  }
}

const THANKS_AUTO_DISMISS_MS = 3000;

export interface CommunicationsConsentBannerProps {
  /** The identified visitor's email (`authEmail` in App.tsx), or null while unknown. */
  email: string | null;
  /** Optional overrides (used by tests). */
  checkEligibility?: typeof shouldOfferCommunicationsConsent;
  recordConsent?: typeof recordCommunicationsConsent;
  upgradeConsent?: typeof upgradeBackfilledAlertConsent;
}

export default function CommunicationsConsentBanner({
  email,
  checkEligibility = shouldOfferCommunicationsConsent,
  recordConsent = recordCommunicationsConsent,
  upgradeConsent = upgradeBackfilledAlertConsent,
}: CommunicationsConsentBannerProps) {
  const { locale } = useTranslation();
  // Start hidden and decide in effects: the eligibility read touches
  // localStorage and Firestore, neither of which exists during SSR/prerender.
  const [visible, setVisible] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saving' | 'thanks'>('idle');

  useEffect(() => {
    if (!email) {
      setVisible(false);
      return;
    }
    if (readPromptAnswer() !== null) return;
    let cancelled = false;
    const evaluate = () => {
      if (cancelled) return;
      // The ads panel owns the slot until the visitor answers it.
      if (needsAdsConsentDecision()) {
        setVisible(false);
        return;
      }
      void checkEligibility(email).then((eligible) => {
        if (!cancelled && readPromptAnswer() === null) setVisible(eligible);
      });
    };
    evaluate();
    // Answering the ads panel frees the slot — re-evaluate without a reload.
    const off = onAdsConsentChange(() => evaluate());
    return () => {
      cancelled = true;
      off();
    };
  }, [email, checkEligibility]);

  useEffect(() => {
    if (visible && status === 'idle') captureEvent('comms_consent_shown', { surface: 'consent_banner' });
  }, [visible, status]);

  useEffect(() => {
    if (status !== 'thanks') return;
    const id = window.setTimeout(() => setVisible(false), THANKS_AUTO_DISMISS_MS);
    return () => window.clearTimeout(id);
  }, [status]);

  const accept = useCallback(async () => {
    if (!email) return;
    setStatus('saving');
    writePromptAnswer('accepted');
    captureEvent('comms_consent_accepted', { surface: 'consent_banner' });
    // The newsletter stamp is awaited so the thanks state tells the truth for
    // the common path; the alert-side upgrade stays fire-and-forget like every
    // activation CTA — a proof that fails to land must not surface an error.
    try {
      await recordConsent(email, locale);
    } catch {
      /* recordConsent never throws by contract; belt and braces. */
    }
    void upgradeConsent(email, locale, { act: COMMUNICATIONS_BANNER_CONSENT_ACT }).catch(() => {});
    setStatus('thanks');
  }, [email, locale, recordConsent, upgradeConsent]);

  const decline = useCallback(() => {
    writePromptAnswer('dismissed');
    captureEvent('comms_consent_declined', { surface: 'consent_banner' });
    setVisible(false);
  }, []);

  if (!visible) return null;
  const copy = COPY[locale] ?? COPY.it;

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby="comms-consent-title"
      className="fixed inset-x-0 bottom-0 z-[60] border-t border-edge/50 bg-surface/98 backdrop-blur px-4 py-4 pb-[calc(env(safe-area-inset-bottom,0px)+4.5rem)] md:pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] shadow-[0_-4px_16px_rgba(0,0,0,0.12)]"
    >
      <div className="mx-auto flex max-w-4xl flex-col gap-3 sm:flex-row sm:items-center sm:gap-6">
        {status === 'thanks' ? (
          <p className="min-w-0 flex-1 text-sm opacity-80">{copy.thanks}</p>
        ) : (
          <>
            <div className="min-w-0 flex-1">
              <p id="comms-consent-title" className="text-sm font-semibold">
                {copy.title}
              </p>
              <p className="mt-1 text-sm opacity-80">{copy.body}</p>
              <ConsentNotice
                consentKey="communicationsOptIn"
                locale={locale}
                className="mt-2 text-xs opacity-70 leading-relaxed block"
              />
            </div>
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                onClick={decline}
                disabled={status === 'saving'}
                className="min-h-[44px] rounded-lg border border-edge/60 px-4 text-sm font-medium disabled:opacity-50"
              >
                {copy.decline}
              </button>
              <button
                type="button"
                onClick={accept}
                disabled={status === 'saving'}
                aria-busy={status === 'saving'}
                className="min-h-[44px] rounded-lg bg-accent px-4 text-sm font-semibold text-white disabled:opacity-80"
              >
                {copy.accept}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
